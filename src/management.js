import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readRegistration } from './auth.js'

export const MANAGEMENT_GLOBAL = '__DSH_CHATGPT_MANAGEMENT__'

export function createManagement(ctx, key, adapter, config) {
  let current = { state: 'idle', loginUrl: undefined, error: undefined }
  let active
  let closed = false
  const publicError = error => error?.name === 'AbortError' ? 'Login cancelled.' : 'ChatGPT connection failed. Check your connection and account permissions, then try again.'
  async function status() {
    const record = await ctx.credentials.readRecord(key)
    const account = record ? readRegistration(record) : undefined
    return {
      ...current, ...config,
      connected: Boolean(account?.accessToken && account?.refreshToken),
      email: account?.email,
    }
  }
  function start() {
    if (closed) throw new Error('ChatGPT management is closed.')
    if (active || ctx.authorization.describe(key)?.inFlight) throw new Error('A ChatGPT login is already running.')
    const controller = new AbortController()
    let readyResolve, readyReject
    const ready = new Promise((ok, fail) => { readyResolve = ok; readyReject = fail })
    current = { state: 'pending', loginUrl: undefined, error: undefined }
    const attempt = { controller, job: undefined }
    active = attempt
    attempt.job = Promise.resolve().then(() => ctx.authorization.begin({ key, signal: controller.signal, interaction: {
      notify(notice) {
        if (active !== attempt || !notice.url) return
        const url = new URL(notice.url)
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/login') {
          readyReject(new Error('Unexpected login URL.'))
          controller.abort()
          return
        }
        current = { state: 'pending', loginUrl: notice.url, error: undefined }
        readyResolve({ loginUrl: notice.url })
      },
      async prompt() { throw new Error('Unexpected ChatGPT prompt.') },
    } })).then(outcome => {
      if (active === attempt) current = { state: outcome.status === 'authorized' ? 'authorized' : 'cancelled', loginUrl: undefined, error: undefined }
      readyReject(new Error('Login ended before opening the browser.'))
    }, error => {
      if (active === attempt) current = { state: 'failed', loginUrl: undefined, error: publicError(error),
        errorCode: error?.code === 'TRANSPORT' && config.proxyUrl ? 'PROXY_CONNECTION' : 'CONNECTION' }
      readyReject(new Error(publicError(error)))
    }).finally(() => { if (active === attempt) active = undefined })
    return ready
  }
  async function cancel() {
    active?.controller.abort()
    ctx.authorization.cancel(key)
    await active?.job
    if (current.state === 'pending') current = { state: 'cancelled', loginUrl: undefined, error: undefined }
  }
  return {
    status, start, cancel,
    async models() { return adapter.listModels(config.provider) },
    async signOut(logout) {
      await cancel()
      await logout()
      current = { state: 'idle', loginUrl: undefined, error: undefined }
    },
    async dispose() { closed = true; await cancel() },
  }
}

export function trustedManagementRequest(req, token, trustedHosts = []) {
  const host = req.headers.host
  const authorization = req.headers['x-dsh-chatgpt-token']
  if (typeof host !== 'string' || typeof authorization !== 'string') return false
  const received = Buffer.from(authorization)
  const expected = Buffer.from(token)
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false
  try {
    const authority = new URL(`http://${host}`)
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) return false
    const parts = authority.hostname.split('.')
    const loopback = authority.hostname === 'localhost' || authority.hostname === '[::1]'
      || (parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255))
    const trusted = trustedHosts.some(entry => {
      const value = new URL(`http://${entry}`)
      return value.port ? value.host === authority.host : value.hostname === authority.hostname
    })
    if (!loopback && !trusted) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    return origin === undefined || (typeof origin === 'string' && new URL(origin).host === authority.host)
  } catch { return false }
}

export function registerManagement(ctx, manager, provider, logout) {
  const token = randomBytes(32).toString('hex')
  const path = `/chatgpt-management/${provider}`
  ctx.on('webserver/index-inject', table => {
    // A computed index script merges instances without exposing OAuth credentials.
    table.push({ kind: 'script', placement: 'head', text: `globalThis.${MANAGEMENT_GLOBAL}=Object.assign(globalThis.${MANAGEMENT_GLOBAL}||{},${JSON.stringify({ [provider]: { path, token } })});` })
  })
  const dispose = ctx.webServer.register({ kind: 'prefix', path, async handler(req, res) {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    const reply = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)) }
    if (!trustedManagementRequest(req, token, ctx.webRuntime.trustedHosts)) { reply(403, { error: 'Request refused.' }); return }
    const operation = new URL(req.url, 'http://127.0.0.1').pathname.slice(path.length)
    if ((req.method !== 'GET' || !['/status', '/models'].includes(operation))
      && (req.method !== 'POST' || !['/login', '/cancel', '/logout'].includes(operation))) {
      reply(405, { error: 'Unsupported management operation.' }); return
    }
    try {
      let result
      if (operation === '/status') result = await manager.status()
      else if (operation === '/models') result = { models: await manager.models() }
      else if (operation === '/login') result = await manager.start()
      else if (operation === '/cancel') { await manager.cancel(); result = await manager.status() }
      else { await manager.signOut(logout); result = await manager.status() }
      reply(200, result)
    } catch {
      reply(400, { error: 'ChatGPT operation failed. Check your connection and account permissions, then retry.' })
    }
  } })
  ctx.effect(() => () => { dispose(); return manager.dispose() }, 'chatgpt management routes')
}
