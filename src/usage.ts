import { createHash, randomUUID } from 'node:crypto'
import { CODEX_KEY } from './codex.js'
import { loadHostCatalog } from './host-catalog.js'
import type { CodexContext } from './types.js'

export type UsageReason = 'sign-in-required' | 'credential-incomplete' | 'credential-expired'
  | 'refresh-unavailable' | 'refresh-failed' | 'permission-denied' | 'rate-limited'
  | 'network-error' | 'timeout' | 'invalid-response' | 'no-five-hour-window'
  | 'account-changed' | 'service-unavailable'
export interface UsageData {
  usedPercent: number; remainingPercent: number; windowSeconds: 18000
  resetsAt?: number; fetchedAt: number; usageAllowed?: boolean
}
export interface UsageReply {
  state: 'ready' | 'stale' | 'unavailable'; accountScope?: string
  data?: UsageData; reason?: UsageReason; nextCheckAt: number
}
export class UsageError extends Error {
  constructor(public readonly reason: UsageReason, public readonly retryAfter?: number) { super(reason) }
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export function parseUsage(value: unknown, now: number, accountId: string): UsageData {
  if (!object(value)) throw new UsageError('invalid-response')
  if (value.account_id !== undefined && value.account_id !== accountId) throw new UsageError('account-changed')
  if (value.rate_limit === null || value.rate_limit === undefined) throw new UsageError('no-five-hour-window')
  if (!object(value.rate_limit)) throw new UsageError('invalid-response')
  const limit = value.rate_limit
  const windows = [limit.primary_window, limit.secondary_window].filter(v => v != null)
  if (windows.some(w => !object(w) || !finite(w.limit_window_seconds) || w.limit_window_seconds <= 0)) throw new UsageError('invalid-response')
  const matches = windows.filter(w => object(w) && w.limit_window_seconds === 18000) as Record<string, unknown>[]
  if (!matches.length) throw new UsageError('no-five-hour-window')
  if (matches.length !== 1) throw new UsageError('invalid-response')
  const w = matches[0], used = w.used_percent
  if (!finite(used) || used < 0 || used > 100) throw new UsageError('invalid-response')
  let resetsAt: number | undefined
  if (w.reset_at != null) {
    if (!finite(w.reset_at) || !Number.isSafeInteger(w.reset_at) || w.reset_at <= 0 || w.reset_at * 1000 > 8.64e15) throw new UsageError('invalid-response')
    resetsAt = w.reset_at * 1000
    if (resetsAt <= now) throw new UsageError('invalid-response')
  }
  for (const key of ['allowed', 'limit_reached']) if (limit[key] !== undefined && typeof limit[key] !== 'boolean') throw new UsageError('invalid-response')
  return { usedPercent: used, remainingPercent: 100 - used, windowSeconds: 18000, resetsAt, fetchedAt: now,
    usageAllowed: typeof limit.allowed === 'boolean' ? limit.allowed : undefined }
}
export function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const text = value.trim()
  const deadline = /^[0-9]+$/.test(text) && finite(seconds) ? now + seconds * 1000
    : /^[A-Za-z]{3},/.test(text) ? Date.parse(text) : NaN
  return finite(deadline) && deadline > now && deadline <= 8.64e15 ? deadline : undefined
}
export async function fetchUsage(access: string, accountId: string, signal: AbortSignal, fetcher: typeof fetch = fetch, now = Date.now, timeoutSignal = AbortSignal.timeout): Promise<UsageData> {
  const timeout = timeoutSignal(10_000)
  const combined = AbortSignal.any([signal, timeout])
  try {
    const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', {
      headers: { authorization: 'Bearer ' + access, 'ChatGPT-Account-Id': accountId, accept: 'application/json' },
      redirect: 'error', signal: combined,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new UsageError(response.status === 401 ? 'credential-expired' : response.status === 403 ? 'permission-denied'
        : response.status === 429 ? 'rate-limited' : 'network-error', response.status === 429 ? retryAfter(response.headers.get('retry-after'), now()) : undefined)
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); throw new UsageError('invalid-response') }
    const reader = response.body?.getReader()
    if (!reader) throw new UsageError('invalid-response')
    const chunks: Uint8Array[] = []; let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 256 * 1024) throw new UsageError('invalid-response')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new UsageError('invalid-response') }
    return parseUsage(value, now(), accountId)
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError(combined.aborted ? (signal.aborted ? 'account-changed' : 'timeout') : 'network-error')
  }
}
type Grant = { access: string; accountId: string; expires: number; refresh?: string }
function grantOf(record: Awaited<ReturnType<CodexContext['credentials']['readRecord']>>): Grant {
  if (!record) throw new UsageError('sign-in-required')
  const p = record.kind === 'grant' && object(record.payload) ? record.payload : undefined
  if (!p || typeof p.access !== 'string' || !p.access || typeof p.accountId !== 'string' || !p.accountId || !finite(p.expires) || p.expires <= 0) throw new UsageError('credential-incomplete')
  return { access: p.access, accountId: p.accountId, expires: p.expires, refresh: typeof p.refresh === 'string' ? p.refresh : undefined }
}
const fingerprint = (g: Grant) => createHash('sha256').update(JSON.stringify(g)).digest('hex')
interface UsageOptions {
  fetcher?: typeof fetch; now?: () => number; timeoutSignal?: (ms: number) => AbortSignal
  refresh?: () => Promise<boolean>
}
async function withSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new UsageError('timeout'))
    signal.addEventListener('abort', rejectAbort, { once: true })
    if (signal.aborted) rejectAbort()
  })
  try { return await Promise.race([operation, cancelled]) }
  finally { signal.removeEventListener('abort', rejectAbort) }
}
export function createUsageService(ctx: CodexContext, options: UsageOptions = {}) {
  const timeoutSignal = options.timeoutSignal ?? AbortSignal.timeout
  const now = options.now ?? Date.now
  let closed = false, paused = false, generation = 0, identity: string | undefined, scope: string | undefined
  let cached: UsageReply | undefined, failures = 0
  let flight: { controller: AbortController; job: Promise<UsageReply> } | undefined
  const unavailable = (reason: UsageReason, nextCheckAt = now() + 300_000): UsageReply => ({ state: 'unavailable', reason, accountScope: scope, nextCheckAt })
  function invalidate() {
    generation++; identity = undefined; scope = undefined; cached = undefined; failures = 0
    flight?.controller.abort(); flight = undefined
  }
  function observe(g: Grant) {
    const key = fingerprint(g)
    if (identity !== key) { invalidate(); identity = key; scope = randomUUID() }
  }
  function visible(reply: UsageReply): UsageReply {
    if (reply.data && (now() >= reply.data.fetchedAt + 300_000 || now() >= (reply.data.resetsAt ?? Infinity)))
      return { ...reply, state: 'unavailable', data: undefined, reason: reply.reason ?? 'invalid-response' }
    return reply
  }
  async function load(g: Grant, epoch: number, controller: AbortController, budget: AbortSignal): Promise<UsageReply> {
    const signal = AbortSignal.any([controller.signal, budget])
    const check = () => { if (closed || epoch !== generation || signal.aborted) throw new UsageError(signal.aborted && !controller.signal.aborted ? 'timeout' : 'account-changed') }
    let ownRefresh = false
    try {
      if (g.expires <= now() + 300_000 && g.refresh) {
        if (!ctx.credentials.modifyRecord) throw new UsageError('refresh-unavailable')
        ownRefresh = true
        const refresh = options.refresh ?? (async () => { const host = await loadHostCatalog(ctx); if (!host) return false; await host.refreshCredential(); return true })
        let refreshed: boolean
        try { refreshed = await withSignal(refresh(), signal) } catch (error) { if (error instanceof UsageError) throw error; throw new UsageError('refresh-failed') }
        if (!refreshed) throw new UsageError('refresh-unavailable')
        check()
        const next = grantOf(await withSignal(ctx.credentials.readRecord(CODEX_KEY), signal)); check()
        if (next.accountId !== g.accountId) throw new UsageError('account-changed')
        g = next; identity = fingerprint(g)
      }
      if (g.expires <= now()) throw new UsageError('credential-expired')
      const data = await withSignal(fetchUsage(g.access, g.accountId, signal, options.fetcher, now, timeoutSignal), signal)
      check()
      const current = grantOf(await withSignal(ctx.credentials.readRecord(CODEX_KEY), signal)); check()
      if (fingerprint(current) !== fingerprint(g)) throw new UsageError('account-changed')
      failures = 0
      cached = { state: 'ready', data, accountScope: scope, nextCheckAt: Math.min(now() + 60_000, data.resetsAt ?? Infinity) }
      return cached
    } catch (error) {
      if (closed || epoch !== generation) return unavailable(closed ? 'service-unavailable' : 'account-changed', now())
      const reason = error instanceof UsageError ? error.reason : 'network-error'
      if (reason === 'account-changed') { invalidate(); return unavailable(reason, now()) }
      // Recheck identity before retaining data even when the upstream request failed.
      try {
        const current = grantOf(await withSignal(ctx.credentials.readRecord(CODEX_KEY), signal))
        if (fingerprint(current) !== fingerprint(g)) { invalidate(); return unavailable('account-changed', now()) }
      } catch (error) { invalidate(); return unavailable(error instanceof UsageError ? error.reason : 'service-unavailable', now() + 300_000) }
      if (epoch !== generation || closed) return unavailable('account-changed', now())
      const transient = ['timeout', 'network-error', 'rate-limited'].includes(reason) && !ownRefresh
      const delay = transient ? Math.min(300_000, 60_000 * 2 ** Math.min(failures++, 3)) : 300_000
      const nextCheckAt = Math.max(now() + delay, error instanceof UsageError ? error.retryAfter ?? 0 : 0)
      const old = cached && visible(cached).data
      cached = transient && old ? { state: 'stale', data: old, reason, accountScope: scope, nextCheckAt } : unavailable(reason, nextCheckAt)
      return cached
    }
  }
  async function get(): Promise<UsageReply> {
    if (closed) return unavailable('service-unavailable')
    if (paused) return unavailable('sign-in-required')
    const budget = timeoutSignal(25_000)
    let g: Grant
    try { g = grantOf(await withSignal(ctx.credentials.readRecord(CODEX_KEY), budget)) } catch (error) {
      invalidate(); return unavailable(error instanceof UsageError ? error.reason : 'service-unavailable')
    }
    if (closed) return unavailable('service-unavailable')
    if (paused) return unavailable('sign-in-required')
    observe(g)
    if (flight) return flight.job
    if (cached && cached.nextCheckAt > now()) return visible(cached)
    const controller = new AbortController(), epoch = generation
    const task = { controller, job: undefined as unknown as Promise<UsageReply> }
    flight = task
    task.job = load(g, epoch, controller, budget).finally(() => { controller.abort(); if (flight === task) flight = undefined })
    return task.job
  }
  return { get, invalidate, setPaused(value: boolean) { paused = value; invalidate() }, dispose() { closed = true; invalidate() } }
}
