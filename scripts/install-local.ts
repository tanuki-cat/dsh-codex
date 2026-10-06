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
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureSchemaBaseline, validateInstalledSchema } from './install-validation.ts'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
const profile = 'web'
const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const directory = join(home, 'profiles', profile)
const patchFile = join(directory, 'cordis.patch.yml')
const tarball = join(project, `dsh-llm-chatgpt-${manifest.version}.tgz`)
const run = (args: string[], options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> = {}) => spawnSync('dsh', args, { encoding: 'utf8', ...options })
const ownedId = /^(?:"llm-chatgpt"|'llm-chatgpt'|llm-chatgpt)\s*(?:#.*)?$/

/** Whether one mapping field at an exact indentation owns this plugin id. */
function isOwnedIdField(line: string, indent: number, item: boolean) {
  if (line.search(/\S/) !== indent) return false
  let value = line.slice(indent)
  if (item) {
    if (!value.startsWith('-')) return false
    value = value.slice(1).trimStart()
  } else if (value.startsWith('-')) return false
  if (!value.startsWith('id:')) return false
  return ownedId.test(value.slice(3).trimStart())
}

/** Whether one sequence-item mapping directly identifies this plugin. */
function ownsEntry(block: string[], indent: number) {
  return isOwnedIdField(block[0], indent, true)
    || block.slice(1).some(line => isOwnedIdField(line, indent + 2, false))
}

/** Remove owned children from one top-level `- insert:` operation. */
function cleanInsert(block: string[]) {
  const starts = []
  for (let index = 1; index < block.length; index += 1) {
    const match = /^(\s+)-\s*\S/.exec(block[index])
    if (match) starts.push({ index, indent: match[1].length })
  }
  if (starts.length === 0) return { lines: block, removed: 0 }
  const childIndent = Math.min(...starts.map(start => start.indent))
  const children = starts.filter(start => start.indent === childIndent).map(start => start.index)
  const kept = block.slice(0, children[0])
  let removed = 0
  for (let position = 0; position < children.length; position += 1) {
    const start = children[position]
    const end = children[position + 1] ?? block.length
    const child = block.slice(start, end)
    if (ownsEntry(child, childIndent)) removed += 1
    else kept.push(...child)
  }
  const hasChildren = kept.slice(1).some(line => line.search(/\S/) === childIndent && line.slice(childIndent).startsWith('-'))
  return { lines: removed > 0 && !hasChildren ? [] : kept, removed }
}

/**
 * Remove only Cordis entries owned by this plugin.
 *
 * Matching is intentionally limited to top-level entries and direct children
 * of a top-level insert operation. An unrelated nested object may legally use
 * the same id and must never be deleted by this migration.
 */
function dropOwnedEntries(lines: string[]) {
  const kept = []
  let removed = 0
  for (let index = 0; index < lines.length;) {
    if (!/^-\s*\S/.test(lines[index])) { kept.push(lines[index]); index += 1; continue }
    let end = index + 1
    while (end < lines.length && !/^-\s*\S/.test(lines[end])) end += 1
    const block = lines.slice(index, end)
    if (ownsEntry(block, 0)) removed += 1
    else if (/^-\s*insert:\s*(?:#.*)?$/.test(block[0])) {
      const cleaned = cleanInsert(block)
      kept.push(...cleaned.lines)
      removed += cleaned.removed
    } else kept.push(...block)
    index = end
  }
  return { lines: kept, removed }
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
  const cleaned = dropOwnedEntries(currentPatch.split('\n'))
  const lines = cleaned.lines
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  const nextPatch = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  const removed = cleaned.removed
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
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${patchChanged ? '已恢复安装前的 patch' : '原有配置未改动'}。插件包仍已安装，备份可用于排查。`)
  }
  console.log(`已将 dsh-llm-chatgpt ${manifest.version} 安装到 web profile，组合配置和插件模块导入检查通过。`)
  if (!schemaResult.complete) console.log('原有 profile 的 schema 导出仍不完整；本插件未引入新增 schema 诊断。')
  console.log('重启 dsh web 后，在「设置 → 模型」的 openai-codex 卡片上点击登录。')
} catch (error) {
  console.error((error instanceof Error && 'code' in error && error.code === 'EPERM') || (error instanceof Error && 'code' in error && error.code === 'EACCES')
    ? '当前进程无权写入 web profile，请在本机普通终端中运行此脚本。'
    : error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
