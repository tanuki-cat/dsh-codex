import { spawnSync } from 'node:child_process'
import { accessSync, constants, copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureSchemaBaseline, validateInstalledSchema } from './install-validation.mjs'
import { normalizeProxyUrl } from '../src/proxy.js'
import { normalizeExtraModels } from '../src/model-catalog.js'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
const profile = 'web'
const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const directory = join(home, 'profiles', profile)
const patchFile = join(directory, 'cordis.patch.yml')
const tarball = join(project, `dsh-llm-chatgpt-${manifest.version}.tgz`)
const run = (args, options = {}) => spawnSync('dsh', args, { encoding: 'utf8', ...options })
const templateLines = readFileSync(join(project, 'examples', 'cordis.patch.yml'), 'utf8').split('\n')
// The installer owns this entry, so the template's manual-merge guidance is
// recognized in existing patches and never written into a generated profile.
const templateNotes = new Set(templateLines.filter(line => line.startsWith('#')).map(line => line.trimEnd()))
const template = templateLines.filter(line => !templateNotes.has(line.trimEnd())).join('\n').replace(/\n+$/, '\n')
const ownedIdLine = /^(\s*)(?:-\s+)?id:\s*llm-chatgpt\s*$/

/** Indentation width of `line`, or -1 for a blank line. */
function columnOf(line) {
  return line.search(/\S/)
}

/**
 * Drop every entry that configures this plugin, at any nesting depth. Appending
 * a fresh block per install left several same-id entries behind, and the loader
 * then applied each one as a separate configuration layer.
 */
function dropOwnedEntries(lines) {
  const kept = []
  for (let index = 0; index < lines.length;) {
    const marker = ownedIdLine.exec(lines[index])
    if (marker === null && !templateNotes.has(lines[index].trimEnd())) {
      kept.push(lines[index])
      index += 1
      continue
    }
    const indent = marker === null ? columnOf(lines[index]) : marker[1].length
    index += 1
    while (index < lines.length) {
      const column = columnOf(lines[index])
      if (column !== -1 && column <= indent) break
      index += 1
    }
  }
  return kept
}

/** Drop `- insert:` wrappers whose child list became empty. */
function dropEmptyInserts(lines) {
  const kept = []
  for (let index = 0; index < lines.length;) {
    const header = /^(\s*)-\s*insert:\s*$/.exec(lines[index])
    if (header === null) {
      kept.push(lines[index])
      index += 1
      continue
    }
    const indent = header[1].length
    let end = index + 1
    while (end < lines.length) {
      const column = columnOf(lines[end])
      if (column !== -1 && column <= indent) break
      end += 1
    }
    const body = lines.slice(index + 1, end)
    if (body.some(line => /^\s*-\s/.test(line))) kept.push(lines[index], ...body)
    index = end
  }
  return kept
}

/** Read the configuration rows the previous installs wrote. */
function readChatgptConfig(lines) {
  const config = {}
  for (const line of lines) {
    const proxy = /^\s*proxyUrl:\s*"([^"]*)"\s*$/.exec(line)
    if (proxy !== null && config.proxyUrl === undefined) config.proxyUrl = proxy[1]
    const models = /^\s*extraModels:\s*(\[[^\]]*\])\s*$/.exec(line)
    if (models === null || config.extraModels !== undefined) continue
    try { config.extraModels = JSON.parse(models[1]) } catch { /* Unreadable rows cannot merge and are dropped with their entry. */ }
  }
  return config
}

/** Insert the tuned rows into the template, keeping the template as the shape authority. */
function withConfig(block, config) {
  const extras = [
    ...config.proxyUrl === undefined ? [] : [`proxyUrl: ${JSON.stringify(config.proxyUrl)}`],
    ...config.extraModels === undefined ? [] : [`extraModels: ${JSON.stringify(config.extraModels)}`],
  ]
  const lines = block.trimEnd().split('\n')
  if (extras.length === 0) return `${lines.join('\n')}\n`
  const anchor = lines.findIndex(line => /^\s*requestTimeoutMs:/.test(line))
  if (anchor === -1) throw new Error('examples/cordis.patch.yml 缺少 requestTimeoutMs 锚点，未更改 cordis.patch.yml。')
  const indent = /^\s*/.exec(lines[anchor])[0]
  lines.splice(anchor + 1, 0, ...extras.map(line => indent + line))
  return `${lines.join('\n')}\n`
}

/** Replace the plugin's enable block with one freshly templated entry. */
function rewritePatch(text, config) {
  const kept = dropEmptyInserts(dropOwnedEntries(text.split('\n')))
  while (kept.length > 0 && kept.at(-1).trim() === '') kept.pop()
  const head = kept.length === 0 ? '' : `${kept.join('\n')}\n\n`
  return `${head}${withConfig(template, config)}`
}

try {
  const args = process.argv.slice(2)
  if (args.length % 2 !== 0) throw new Error('用法：node scripts/install-local.mjs [--proxy http://127.0.0.1:7890] [--model gpt-6.1-sol]')
  const supplied = new Map()
  for (let index = 0; index < args.length; index += 2) {
    if (!['--proxy', '--model'].includes(args[index]) || supplied.has(args[index])) {
      throw new Error('用法：node scripts/install-local.mjs [--proxy http://127.0.0.1:7890] [--model gpt-6.1-sol]')
    }
    supplied.set(args[index], args[index + 1])
  }
  const proxyUrl = supplied.has('--proxy') ? normalizeProxyUrl(supplied.get('--proxy')) : undefined
  const extraModels = supplied.has('--model') ? normalizeExtraModels([supplied.get('--model')]) : undefined
  const versionResult = run(['--version'])
  if (versionResult.error || versionResult.status !== 0) throw new Error('无法读取本机 dsh 版本。')
  const runtimeVersion = versionResult.stdout.trim()
  if (!manifest.peerDependencies['@deepseek-ai/dsh-llm'].split(' || ').includes(runtimeVersion)) {
    throw new Error(`插件未声明支持本机 DSH ${runtimeVersion}，安装已停止。`)
  }
  if (!existsSync(join(directory, 'package.json'))) throw new Error(`现有 web profile 不存在：${directory}`)
  accessSync(directory, constants.W_OK)
  accessSync(tarball, constants.R_OK)
  const originalPatch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  // A whole-profile schema may already be incomplete before this plugin exists.
  const baseline = captureSchemaBaseline(run(['--profile', profile, '--dump-config-schema'], { maxBuffer: 16 * 1024 * 1024 }))
  const backup = join(directory, '.chatgpt-install-backups', new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  for (const filename of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
    const current = join(directory, filename)
    if (existsSync(current)) {
      const saved = join(backup, filename)
      copyFileSync(current, saved)
      chmodSync(saved, 0o600)
    }
  }
  console.log(`已备份 profile 配置：${backup}`)
  const installedPackage = join(directory, 'node_modules', 'dsh-llm-chatgpt', 'package.json')
  const existingVersion = existsSync(installedPackage) ? JSON.parse(readFileSync(installedPackage, 'utf8')).version : undefined
  if (existingVersion === manifest.version) {
    console.log(`插件 ${manifest.version} 已安装，跳过重复安装，继续检查启用配置。`)
  } else {
    const operation = run(['plugin', '--profile', profile, 'add', tarball], { stdio: 'inherit' })
    if (operation.error || operation.status !== 0) throw new Error('dsh 插件安装失败；未更改 cordis.patch.yml。')
  }
  if (!existsSync(installedPackage) || JSON.parse(readFileSync(installedPackage, 'utf8')).version !== manifest.version) {
    throw new Error('未找到匹配版本的已安装插件，未更改 cordis.patch.yml。')
  }
  const currentPatch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  if (currentPatch !== originalPatch) throw new Error('安装期间 profile 配置发生变化，请检查后重新运行。')
  const previous = readChatgptConfig(currentPatch.split('\n'))
  const previousCount = currentPatch.split('\n').filter(line => ownedIdLine.test(line)).length
  if (previousCount > 0) {
    console.log(previousCount > 1
      ? `检测到 ${previousCount} 个重复的 llm-chatgpt 条目；本次合并为一个，保留已设置的配置项。`
      : '检测到已存在的 llm-chatgpt 配置；本次更新为单个条目，保留已设置的配置项。')
  }
  const proxy = proxyUrl ?? previous.proxyUrl
  const models = extraModels === undefined ? previous.extraModels : [...new Set([...(previous.extraModels ?? []), ...extraModels])]
  const nextPatch = rewritePatch(currentPatch, {
    ...proxy === undefined || proxy === '' ? {} : { proxyUrl: proxy },
    ...models === undefined || models.length === 0 ? {} : { extraModels: models },
  })
  const patchChanged = nextPatch !== currentPatch
  if (patchChanged) writeFileSync(patchFile, nextPatch, { mode: 0o600 })
  let schemaResult
  try {
    // Config and schema output can contain private values; keep them out of terminal logs.
    const configCheck = run(['--profile', profile, '--dump-config'], { maxBuffer: 16 * 1024 * 1024 })
    if (configCheck.error || configCheck.status !== 0 || !configCheck.stdout.includes('dsh-llm-chatgpt')) {
      throw new Error('--dump-config 验证失败。')
    }
    schemaResult = validateInstalledSchema(baseline, run(['--profile', profile, '--dump-config-schema'], { maxBuffer: 16 * 1024 * 1024 }))
  } catch (error) {
    if (patchChanged) writeFileSync(patchFile, originalPatch, { mode: 0o600 })
    throw new Error(`${error.message} ${patchChanged ? '已恢复安装前的 patch' : '原有配置未改动'}。插件包仍已安装，备份可用于排查。`)
  }
  console.log(`已将 dsh-llm-chatgpt ${manifest.version} 安装到 web profile，组合配置和插件模块导入检查通过。`)
  if (!schemaResult.complete) console.log('原有 profile 的 schema 导出仍不完整；本插件未引入新增 schema 诊断。')
  console.log('重启 dsh web 后，在会话中执行 /chatgpt-plan-login。')
} catch (error) {
  console.error(error.code === 'EPERM' || error.code === 'EACCES'
    ? '当前进程无权写入 web profile，请在本机普通终端中运行此脚本。'
    : error.message)
  process.exitCode = 1
}
