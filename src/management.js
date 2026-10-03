import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readRegistration } from './auth.js'
import { CODEX_KEY, CODEX_PROVIDER, beginCodexLogin, codexFlow, forgetCodexLogin, readCodexAccount } from './codex.js'

export const MANAGEMENT_GLOBAL = '__DSH_CHATGPT_MANAGEMENT__'

/**
 * The official openai-codex sign-in, as the settings page drives it.
 *
 * It owns one attempt at a time, mirroring the seam's own exclusion, so two
 * page tabs cannot prompt the same human twice. Notices are kept as the latest
 * one seen; the page polls them rather than holding a stream open, which keeps
 * the management surface a plain request/response route.
 * @param ctx - the plugin context carrying the authorization and credential seams.
 * @returns the codex operations the management route exposes.
 */
export function createCodexManagement(ctx) {
  let current = { state: 'idle', notice: undefined, error: undefined }
  let active
  let closed = false
  const publicError = error => error?.name === 'AbortError'
    ? 'Sign-in cancelled.'
    : 'Sign-in failed. Check your connection and account permissions, then try again.'
  async function status() {
    const record = await ctx.credentials.readRecord(CODEX_KEY)
    const account = readCodexAccount(record)
    return {
      available: codexFlow(ctx) !== undefined,
      connected: account !== undefined && typeof record?.payload?.refresh === 'string',
      account,
      ...current,
    }
  }
  function start() {
    if (closed) throw new Error('ChatGPT management is closed.')
    if (active !== undefined || ctx.authorization.describe(CODEX_KEY)?.inFlight) {
      throw new Error('An OpenAI sign-in is already running.')
    }
    const controller = new AbortController()
    const attempt = { controller, job: undefined }
    active = attempt
    current = { state: 'pending', notice: undefined, error: undefined }
    attempt.job = beginCodexLogin(ctx, {
      signal: controller.signal,
      notify(notice) {
        if (active !== attempt) return
        current = { ...current, notice }
      },
    }).then(outcome => {
      if (active !== attempt) return
      current = outcome === 'authorized'
        ? { state: 'authorized', notice: undefined, error: undefined }
        : { state: 'cancelled', notice: undefined, error: undefined }
    }, error => {
      if (active !== attempt) return
      current = { state: 'failed', notice: undefined, error: publicError(error) }
    }).finally(() => { if (active === attempt) active = undefined })
    // The attempt owns its own failures; an unobserved rejection here would
    // otherwise surface as an unhandled one.
    attempt.job.catch(() => {})
    return status()
  }
  async function cancel() {
    active?.controller.abort()
    ctx.authorization.cancel(CODEX_KEY)
    await active?.job
    if (current.state === 'pending') current = { state: 'cancelled', notice: undefined, error: undefined }
    return status()
  }
  return {
    status, start, cancel,
    async signOut() {
      await cancel()
      await forgetCodexLogin(ctx)
      current = { state: 'idle', notice: undefined, error: undefined }
      return status()
    },
    async dispose() { closed = true; await cancel() },
  }
}

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

/** Publish one management endpoint's path and token to the browser. */
function injectConnection(ctx, id, path, token) {
  ctx.on('webserver/index-inject', table => {
    // A computed index script merges instances without exposing OAuth credentials.
    table.push({ kind: 'script', placement: 'head', text: `globalThis.${MANAGEMENT_GLOBAL}=Object.assign(globalThis.${MANAGEMENT_GLOBAL}||{},${JSON.stringify({ [id]: { path, token } })});` })
  })
}

/** Serve one management endpoint's operations under a token-guarded prefix. */
function serve(ctx, path, token, routes) {
  const dispose = ctx.webServer.register({ kind: 'prefix', path, async handler(req, res) {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    const reply = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)) }
    if (!trustedManagementRequest(req, token, ctx.webRuntime.trustedHosts)) { reply(403, { error: 'Request refused.' }); return }
    const operation = new URL(req.url, 'http://127.0.0.1').pathname.slice(path.length)
    const route = routes[operation]
    if (route === undefined || route.method !== req.method) { reply(405, { error: 'Unsupported management operation.' }); return }
    try {
      reply(200, await route.run())
    } catch {
      reply(400, { error: 'ChatGPT operation failed. Check your connection and account permissions, then retry.' })
    }
  } })
  return dispose
}

export function registerManagement(ctx, manager, provider, logout) {
  const token = randomBytes(32).toString('hex')
  const path = `/chatgpt-management/${provider}`
  injectConnection(ctx, provider, path, token)
  const dispose = serve(ctx, path, token, {
    '/status': { method: 'GET', run: () => manager.status() },
    '/models': { method: 'GET', run: async () => ({ models: await manager.models() }) },
    '/login': { method: 'POST', run: () => manager.start() },
    // Both mutations answer with the resulting status: the page renders from
    // one shape whichever operation it called.
    '/cancel': { method: 'POST', run: async () => { await manager.cancel(); return manager.status() } },
    '/logout': { method: 'POST', run: async () => { await manager.signOut(logout); return manager.status() } },
  })
  ctx.effect(() => () => { dispose(); return manager.dispose() }, 'chatgpt management routes')
}

/**
 * Serve the official openai-codex sign-in to the settings page.
 *
 * Separate from the chatgpt-plan endpoint because it authorizes a different
 * record under a different adapter family; the page renders it on the
 * llm-pi-ai provider card, where that route's own settings live.
 * @param ctx - the plugin context carrying webServer and webRuntime.
 * @param manager - the codex management state machine.
 * @returns nothing; both the endpoint and its index injection are owned by the caller's fiber.
 */
export function registerCodexManagement(ctx, manager) {
  const token = randomBytes(32).toString('hex')
  const path = `/chatgpt-management/${CODEX_PROVIDER}`
  injectConnection(ctx, CODEX_PROVIDER, path, token)
  const dispose = serve(ctx, path, token, {
    '/status': { method: 'GET', run: () => manager.status() },
    '/login': { method: 'POST', run: () => manager.start() },
    '/cancel': { method: 'POST', run: () => manager.cancel() },
    '/logout': { method: 'POST', run: () => manager.signOut() },
  })
  ctx.effect(() => () => { dispose(); return manager.dispose() }, 'codex management routes')
}
