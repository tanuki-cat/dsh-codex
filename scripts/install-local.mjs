/**
 * Install this plugin into the local web profile.
 *
 * The plugin contributes a settings-page surface, not a provider route: it
 * needs an installed package and nothing in cordis.patch.yml. The script
 * therefore installs the tarball, removes any llm-chatgpt entry an earlier
 * version left behind, and verifies that the plugin's module still imports.
 *
 * It writes only to $DSH_HOME/profiles/<profile>, backs that profile up first,
 * and restores the patch if verification fails.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureSchemaBaseline, validateInstalledSchema } from './install-validation.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
const profile = 'web'
const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const directory = join(home, 'profiles', profile)
const patchFile = join(directory, 'cordis.patch.yml')
const tarball = join(project, `dsh-llm-chatgpt-${manifest.version}.tgz`)
const run = (args, options = {}) => spawnSync('dsh', args, { encoding: 'utf8', ...options })
const ownedIdLine = /^(\s*)(?:-\s+)?id:\s*llm-chatgpt\s*$/

/** Indentation width of one line, or -1 for a blank line. */
function columnOf(line) {
  return line.search(/\S/)
}

/**
 * Drop every entry that configured this plugin, at any nesting depth.
 *
 * Versions before 0.3.0 declared a chatgpt-plan provider through
 * cordis.patch.yml. This build declares nothing there, so a leftover entry
 * would configure a route no adapter serves.
 */
function dropOwnedEntries(lines) {
  const kept = []
  for (let index = 0; index < lines.length;) {
    const marker = ownedIdLine.exec(lines[index])
    if (marker === null) { kept.push(lines[index]); index += 1; continue }
    const indent = marker[1].length
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
    if (header === null) { kept.push(lines[index]); index += 1; continue }
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

try {
  const versionResult = run(['--version'])
  if (versionResult.error || versionResult.status !== 0) throw new Error('无法读取本机 dsh 版本。')
  const runtimeVersion = versionResult.stdout.trim()
  if (!manifest.peerDependencies['@deepseek-ai/dsh-credentials'].split(' || ').includes(runtimeVersion)) {
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
    if (!existsSync(current)) continue
    const saved = join(backup, filename)
    copyFileSync(current, saved)
    chmodSync(saved, 0o600)
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
  const lines = dropEmptyInserts(dropOwnedEntries(currentPatch.split('\n')))
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
  const nextPatch = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  const removed = originalPatch.split('\n').filter(line => ownedIdLine.test(line)).length
  if (removed > 0) console.log(`已移除 ${removed} 个 llm-chatgpt 配置项：本版本不再声明 provider 路由。`)
  const patchChanged = nextPatch !== currentPatch
  if (patchChanged) writeFileSync(patchFile, nextPatch, { mode: 0o600 })
  let schemaResult
  try {
    // Config and schema output can contain private values; keep them out of
    // terminal logs. The plugin declares no profile entry, so this only proves
    // the composition still resolves — the schema comparison below is what
    // proves the plugin's module imports.
    const configCheck = run(['--profile', profile, '--dump-config'], { maxBuffer: 16 * 1024 * 1024 })
    if (configCheck.error || configCheck.status !== 0) throw new Error('--dump-config 验证失败。')
    schemaResult = validateInstalledSchema(baseline, run(['--profile', profile, '--dump-config-schema'], { maxBuffer: 16 * 1024 * 1024 }))
  } catch (error) {
    if (patchChanged) writeFileSync(patchFile, originalPatch, { mode: 0o600 })
    throw new Error(`${error.message} ${patchChanged ? '已恢复安装前的 patch' : '原有配置未改动'}。插件包仍已安装，备份可用于排查。`)
  }
  console.log(`已将 dsh-llm-chatgpt ${manifest.version} 安装到 web profile，组合配置和插件模块导入检查通过。`)
  if (!schemaResult.complete) console.log('原有 profile 的 schema 导出仍不完整；本插件未引入新增 schema 诊断。')
  console.log('重启 dsh web 后，在「设置 → 模型」的 openai-codex 卡片上点击登录。')
} catch (error) {
  console.error(error.code === 'EPERM' || error.code === 'EACCES'
    ? '当前进程无权写入 web profile，请在本机普通终端中运行此脚本。'
    : error.message)
  process.exitCode = 1
}
