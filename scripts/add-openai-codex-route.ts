#!/usr/bin/env node
/**
 * Declare the openai-codex route inside the profile's llm-pi-ai providers map.
 *
 * The pi-ai adapter registers exactly the routes the providers dict declares,
 * so a signed-in provider with no profile is not selectable. This script adds
 * that one route, inheriting every catalog default - endpoint, protocol, and
 * the eight Codex models - and reports instead of rewriting when it is already
 * there, so a second run is a no-op.
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const provider = 'openai-codex'
const profile = 'web'
/** Provider entry indentation inside the llm-pi-ai config block. */
const PROVIDER_INDENT = '      '
const COMMENT_INDENT = PROVIDER_INDENT + '  '

const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const patchFile = join(home, 'profiles', profile, 'cordis.patch.yml')

if (!existsSync(patchFile)) {
  console.error('未找到 profile 配置：' + patchFile)
  process.exit(1)
}
const lines = (await readFile(patchFile, 'utf8')).split('\n')

const start = lines.findIndex(line => line === '- id: llm-pi-ai')
if (start === -1) {
  console.error('profile 中没有 llm-pi-ai 配置项；请先按 README 添加该插件。')
  process.exit(1)
}
// The entry runs until the next top-level list item.
let end = start + 1
while (end < lines.length && !/^- /.test(lines[end])) end += 1

let providersAt = -1
for (let index = start; index < end; index += 1) {
  if (/^    providers:\s*$/.test(lines[index])) { providersAt = index; break }
}
if (providersAt === -1) {
  console.error('llm-pi-ai 配置项没有 providers 字典；请手工添加后再运行。')
  process.exit(1)
}

// Existing provider keys sit one level below 'providers:'.
const routeLine = PROVIDER_INDENT + provider + ':'
const existing = (() => {
  for (let index = providersAt + 1; index < end; index += 1) {
    if (lines[index] === routeLine) return index
  }
  return -1
})()
if (existing !== -1) {
  console.log('已存在 ' + provider + ' 路由（第 ' + (existing + 1) + ' 行）；未做改动。')
  process.exit(0)
}

// Catalog defaults supply endpoint, protocol and models; apiKeyEnv stays unset
// so the stored OAuth sign-in is what authenticates the route. A value is
// required: the schema types this map as a dict of profiles and refuses null.
const block = [
  routeLine,
  COMMENT_INDENT + '# Catalog route: endpoint, protocol and models come from the installed',
  COMMENT_INDENT + '# pi-ai catalog. No apiKeyEnv, so the stored OAuth sign-in from',
  COMMENT_INDENT + '# scripts/login-openai-codex.ts authenticates this route.',
  COMMENT_INDENT + 'reasoning: medium',
]
const next = [...lines.slice(0, providersAt + 1), ...block, ...lines.slice(providersAt + 1)]

const backup = join(dirname(patchFile), '.chatgpt-install-backups', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(backup, { recursive: true, mode: 0o700 })
copyFileSync(patchFile, join(backup, 'cordis.patch.yml'))
chmodSync(join(backup, 'cordis.patch.yml'), 0o600)

await writeFile(patchFile, next.join('\n'), { mode: 0o600 })
console.log('已在 llm-pi-ai 的 providers 下声明 ' + provider + ' 路由。')
console.log('已备份原配置：' + backup)
console.log('重启 dsh 后即可在模型选择器中选择 ' + provider + '。')
