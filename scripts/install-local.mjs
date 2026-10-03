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
  const installed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (installed.dependencies?.['dsh-llm-chatgpt']?.startsWith('file:') && /(?:^|\n)\s*-\s*id:\s*llm-chatgpt\s*(?:\n|$)/.test(originalPatch)) {
    console.log('检测到已安装的 llm-chatgpt 配置；本次更新包并保留该配置。')
  }
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
  const hasEntry = /(?:^|\n)\s*-\s*id:\s*llm-chatgpt\s*(?:\n|$)/.test(currentPatch)
  let nextPatch = currentPatch
  if (!hasEntry) {
    const addition = readFileSync(join(project, 'examples', 'cordis.patch.yml'), 'utf8')
    nextPatch = `${currentPatch}${currentPatch.endsWith('\n') || !currentPatch ? '' : '\n'}\n${addition}`
  }
  if (proxyUrl !== undefined || extraModels !== undefined) {
    const override = `- id: llm-chatgpt\n  name: dsh-llm-chatgpt\n  config:\n`
      + (proxyUrl === undefined ? '' : `    proxyUrl: ${JSON.stringify(proxyUrl)}\n`)
      + (extraModels === undefined ? '' : `    extraModels: ${JSON.stringify(extraModels)}\n`)
    if (!nextPatch.endsWith(override)) nextPatch = `${nextPatch}${nextPatch.endsWith('\n') ? '' : '\n'}\n${override}`
  }
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
