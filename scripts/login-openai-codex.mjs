#!/usr/bin/env node
/**
 * One-shot OAuth sign-in for the official openai-codex provider.
 *
 * DSH registers pi-ai's provider logins on the authorization seam, but no
 * surface calls them: the Models page sign-in slot belongs to the DeepSeek
 * account and the provider-card slot has no registrant. This script drives the
 * same pi-ai flow the seam would and commits its credential to the harness
 * store, so the route authenticates without a companion UI plugin.
 *
 * It writes one record - llm-pi-ai/openai-codex - through the same
 * cross-process lock the running Harness uses, so a Harness that is already up
 * picks the change up by watching the file.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const providerId = 'openai-codex'
const recordKey = 'llm-pi-ai/' + providerId

/** Resolve the installed DSH that owns the pi-ai build this script drives. */
function dshRoot() {
  const declared = process.env.DSH_INSTALL_ROOT
  if (declared !== undefined) return resolve(declared)
  const prefixes = ['/opt/homebrew/lib/node_modules/@deepseek-ai/dsh', '/usr/local/lib/node_modules/@deepseek-ai/dsh']
  for (const candidate of prefixes) {
    if (existsSync(join(candidate, 'package.json'))) return resolve(candidate)
  }
  throw new Error('未找到已安装的 DSH；请设置 DSH_INSTALL_ROOT 指向 @deepseek-ai/dsh 安装目录。')
}

const installed = dshRoot()
const require = createRequire(join(installed, 'package.json'))
// pi-ai's exports map omits ./auth/*, so its OAuth module is reached by path.
const piDir = join(installed, 'node_modules', '@earendil-works', 'pi-ai')
const piModule = specifier => import(pathToFileURL(join(piDir, 'dist', specifier)).href)

const { openaiCodexOAuth } = await piModule('auth/oauth/openai-codex.js')
const { withFileLock, writeFileAtomic } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)

const home = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
const credentialsFile = join(home, '.credentials.yaml')

/**
 * The proxy the login must use: this process's environment first, then the
 * $DSH_HOME/.env file the launcher reads. A standalone script does not go
 * through the launcher, so without the file fallback a proxy set there would
 * silently not apply here.
 * @returns the proxy URL, or undefined for a direct connection.
 */
async function resolveProxy() {
  const fromProcess = process.env.https_proxy ?? process.env.HTTPS_PROXY
    ?? process.env.http_proxy ?? process.env.HTTP_PROXY
  if (fromProcess) return fromProcess
  let text
  try { text = await readFile(join(home, '.env'), 'utf8') } catch { return undefined }
  for (const line of text.split('\n')) {
    const match = /^\s*(?:https_proxy|HTTPS_PROXY|http_proxy|HTTP_PROXY)\s*=\s*(.+?)\s*$/.exec(line)
    if (match) return match[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

// Route the login through the same proxy policy the Harness applies. Without
// this the token exchange cannot reach auth.openai.com on a network that
// requires the proxy.
const proxyUrl = await resolveProxy()
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = await import(pathToFileURL(require.resolve('undici')).href)
  setGlobalDispatcher(new ProxyAgent(proxyUrl))
  console.log('已配置代理。')
}

const controller = new AbortController()
process.on('SIGINT', () => controller.abort())

/** Answer pi-ai's method choice and let the loopback callback win the race. */
const interaction = {
  signal: controller.signal,
  notify(event) {
    if (event.type === 'auth_url') console.log('\n在浏览器中完成登录：\n' + event.url + '\n')
    else if (event.type === 'info' || event.type === 'progress') console.log(event.message)
    else if (event.type === 'device_code') console.log('在 ' + event.verificationUri + ' 输入代码：' + event.userCode)
  },
  async prompt(request) {
    if (request.type === 'select') return request.options[0].id
    // The manual-code prompt races the loopback callback; keeping it pending
    // lets whichever finishes first win, exactly as the browser flow intends.
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('prompt aborted'))
      request.signal?.addEventListener('abort', abort, { once: true })
      controller.signal.addEventListener('abort', abort, { once: true })
    })
  },
}

console.log('开始 OpenAI Codex 登录…')
let credential
try {
  credential = await openaiCodexOAuth.login(interaction)
} catch (error) {
  console.error('登录失败：' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}

// pi-ai renders optional members as explicit undefined; the credential store
// refuses those as unrepresentable, so strip them before committing.
const payload = Object.fromEntries(Object.entries(credential).filter(([, value]) => value !== undefined))

const { parseDocument, Document } = await import(pathToFileURL(require.resolve('yaml')).href)
await withFileLock(credentialsFile, async () => {
  let text
  try { text = await readFile(credentialsFile, 'utf8') } catch { text = undefined }
  const document = text === undefined ? new Document({}) : parseDocument(text)
  document.setIn(['version'], 1)
  document.setIn(['records', recordKey], { kind: 'grant', payload })
  await writeFileAtomic(credentialsFile, document.toString(), { mode: 0o600, dirMode: 0o700 })
}, { waitMs: 30_000 })

console.log('\n已写入凭据：' + recordKey)
console.log('账户：' + credential.accountId)
console.log('过期时间：' + new Date(credential.expires).toISOString())
console.log('\n下一步：在 profile 的 llm-pi-ai providers 下声明 openai-codex 路由，然后重启 dsh。')
