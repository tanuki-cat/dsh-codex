/**
 * The token-guarded HTTP surface the settings page drives.
 *
 * It exposes one flow — the official openai-codex sign-in — as plain
 * request/response operations, so the page polls state instead of holding a
 * stream open. The capability token and origin checks are the same ones any
 * local management route needs; nothing here reaches a provider.
 * @module dsh-llm-chatgpt/management
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { CODEX_KEY, CODEX_PROVIDER, beginCodexLogin, codexFlow, forgetCodexLogin, readCodexAccount } from './codex.js'
import type { IncomingMessage } from 'node:http'
import type { CodexContext, ManagementState, WebContext } from './types.js'

export const MANAGEMENT_GLOBAL = '__DSH_CHATGPT_MANAGEMENT__'

/**
 * The official openai-codex sign-in, as the settings page drives it.
 *
 * It owns one attempt at a time, mirroring the seam's own exclusion, so two
 * page tabs cannot prompt the same human twice. The latest notice retains
 * the authorization URL across later progress messages. Polling it instead of
 * holding a stream open keeps the management surface a plain request/response route.
 * @param ctx - the plugin context carrying the authorization and credential seams.
 * @returns the codex operations the management route exposes.
 */
export function createCodexManagement(ctx: CodexContext) {
  let current: ManagementState = { state: 'idle' }
  let active: { controller: AbortController; job?: Promise<void> } | undefined
  let closed = false
  const publicError = (error: unknown) => error instanceof Error && error.name === 'AbortError'
    ? 'Sign-in cancelled.'
    : 'Sign-in failed. Check your connection and account permissions, then try again.'
  async function status() {
    const record = await ctx.credentials.readRecord(CODEX_KEY)
    const account = readCodexAccount(record)
    const stored = record !== undefined
    const payload = record?.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null
      ? record.payload as Record<string, unknown> : undefined
    const refreshable = account !== undefined && typeof payload?.refresh === 'string' && payload.refresh.length > 0
    const expires = account?.expires
    const credentialState = !stored ? 'absent'
      : !refreshable || typeof expires !== 'number' || !Number.isFinite(expires) ? 'incomplete'
        : expires <= Date.now() ? 'expired' : 'unexpired'
    return {
      available: codexFlow(ctx) !== undefined,
      connected: credentialState === 'unexpired',
      credentialState,
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
    const attempt: { controller: AbortController; job?: Promise<void> } = { controller }
    active = attempt
    current = { state: 'pending', notice: undefined, error: undefined }
    attempt.job = beginCodexLogin(ctx, {
      signal: controller.signal,
      notify(notice) {
        if (active !== attempt) return
        current = { ...current, notice: { ...notice, url: notice.url ?? current.notice?.url } }
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

/**
 * Whether one request may reach a management route.
 *
 * Two independent proofs: a capability token the index injection handed this
 * browser, and an authority that is loopback or explicitly trusted. A page on
 * another origin cannot satisfy both, and a DNS-rebinding hostname fails the
 * authority check even when the token leaked.
 * @param req - the incoming request.
 * @param token - the capability this endpoint was registered with.
 * @param trustedHosts - additional authorities accepted beside loopback.
 * @returns whether the request is trusted.
 */
export function trustedManagementRequest(req: Pick<IncomingMessage, 'headers'>, token: string, trustedHosts: readonly string[] = []) {
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

/**
 * Serve the official openai-codex sign-in to the settings page.
 *
 * Availability is checked per status request, so registration is independent
 * of whether llm-pi-ai mounted its flow before or after this plugin.
 * @param ctx - the plugin context carrying webServer and webRuntime.
 * @param manager - the codex management state machine.
 * @returns nothing; the endpoint and its index injection are owned by the caller's fiber.
 */
export function registerCodexManagement(ctx: WebContext, manager: ReturnType<typeof createCodexManagement>) {
  const token = randomBytes(32).toString('hex')
  const path = `/chatgpt-management/${CODEX_PROVIDER}`
  ctx.on('webserver/index-inject', table => {
    // A computed index script merges instances without exposing OAuth credentials.
    table.push({ kind: 'script', placement: 'head', text: `globalThis.${MANAGEMENT_GLOBAL}=Object.assign(globalThis.${MANAGEMENT_GLOBAL}||{},${JSON.stringify({ [CODEX_PROVIDER]: { path, token } })});` })
  })
  const routes: Record<string, { method: string; run: () => Promise<unknown> }> = {
    '/status': { method: 'GET', run: () => manager.status() },
    '/login': { method: 'POST', run: () => manager.start() },
    '/cancel': { method: 'POST', run: () => manager.cancel() },
    '/logout': { method: 'POST', run: () => manager.signOut() },
  }
  const dispose = ctx.webServer.register({ kind: 'prefix', path, async handler(req, res) {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    const reply = (code: number, value: unknown) => { res.writeHead(code); res.end(JSON.stringify(value)) }
    if (!trustedManagementRequest(req, token, ctx.webRuntime.trustedHosts)) { reply(403, { error: 'Request refused.' }); return }
    const operation = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.slice(path.length)
    const route = routes[operation]
    if (route === undefined || route.method !== req.method) { reply(405, { error: 'Unsupported management operation.' }); return }
    try {
      reply(200, await route.run())
    } catch {
      reply(400, { error: 'ChatGPT operation failed. Check your connection and account permissions, then retry.' })
    }
  } })
  ctx.effect(() => () => { dispose(); return manager.dispose() }, 'codex management routes')
}
