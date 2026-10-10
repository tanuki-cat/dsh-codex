import { randomUUID } from 'node:crypto'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CODEX_KEY } from './codex.js'
import { loadHostCatalog } from './host-catalog.js'
import { generateImage, ImageError, IMAGE_MODEL, MAX_IMAGE_BYTES, validateImageInput } from './image-api.js'
import type { ImageInput } from './image-api.js'
import type { CodexContext } from './types.js'

export interface ImageServiceContext extends CodexContext {
  attachments: Pick<AttachmentStore, 'imageLimits' | 'saveImage'>
  on?(event: 'credentials/record-updated', callback: (key: string) => Promise<void>): (() => void) | void
}
interface Grant { access: string; accountId: string; expires: number; refresh?: string }
function grantOf(record: Awaited<ReturnType<CodexContext['credentials']['readRecord']>>): Grant {
  if (!record) throw new ImageError('sign-in-required')
  const value = record.kind === 'grant' ? record.payload : undefined
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.access !== 'string' || !p.access
    || typeof p.accountId !== 'string' || !p.accountId || typeof p.expires !== 'number' || !Number.isFinite(p.expires)
    || p.expires <= 0 || p.type !== 'oauth') throw new ImageError('credential-incomplete')
  return { access: p.access, accountId: p.accountId, expires: p.expires, refresh: typeof p.refresh === 'string' ? p.refresh : undefined }
}
const same = (a: Grant, b: Grant) => a.accountId === b.accountId && a.access === b.access && a.refresh === b.refresh && a.expires === b.expires
interface Options {
  fetcher?: typeof fetch; now?: () => number; timeoutMs?: number
  refresh?: (signal: AbortSignal, options: { minOAuthValidityMs: number; rejectedAccess?: string }) => Promise<boolean>
}
interface Flight { controller: AbortController; grant?: Grant; refreshing: boolean; active: boolean }
export interface ImageResult { image: ImageAttachmentRef; model: typeof IMAGE_MODEL; requestId?: string }
/** Account-local serialization; disposal drains saves because saveImage has no cancellation API. */
export function createImageService(ctx: ImageServiceContext, options: Options = {}) {
  const now = options.now ?? Date.now
  const queues = new Map<string, Promise<void>>(), flights = new Set<Flight>(), jobs = new Set<Promise<ImageResult>>()
  const cooldowns = new Map<string, number>()
  let closed = false
  const unsubscribe = ctx.on?.('credentials/record-updated', async key => {
    if (key !== CODEX_KEY || closed) return
    // Capture the read before another notification can replace this committed record.
    const pending = ctx.credentials.readRecord(CODEX_KEY)
    const observing = [...flights].filter(f => f.grant).map(f => ({ f, grant: f.grant!, accountOnly: f.refreshing || !f.active }))
    try {
      const current = grantOf(await pending)
      for (const { f, grant, accountOnly } of observing) if (accountOnly ? current.accountId !== grant.accountId : !same(current, grant)) f.controller.abort(new ImageError('account-changed'))
    } catch { for (const { f } of observing) f.controller.abort(new ImageError('account-changed')) }
  })
  function check(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason instanceof ImageError ? signal.reason : new ImageError('cancelled')
    if (closed) throw new ImageError('service-unavailable')
  }
  async function read(signal: AbortSignal) { check(signal); const g = grantOf(await ctx.credentials.readRecord(CODEX_KEY)); check(signal); return g }
  async function assertCurrent(g: Grant, signal: AbortSignal) {
    let next: Grant
    try { next = await read(signal) } catch (error) { check(signal); throw error instanceof ImageError && ['sign-in-required', 'credential-incomplete'].includes(error.reason) ? new ImageError('account-changed') : error }
    if (!same(g, next)) throw new ImageError('account-changed')
  }
  async function refresh(g: Grant, f: Flight, signal: AbortSignal, force: boolean) {
    if (!g.refresh || !ctx.credentials.modifyRecord) throw new ImageError('refresh-unavailable')
    await assertCurrent(g, signal)
    f.refreshing = true
    try {
      const refreshOptions = { minOAuthValidityMs: 300_000, ...(force ? { rejectedAccess: g.access } : {}) }
      const refreshAuth = options.refresh ?? (async (signal, refreshOptions) => {
        // Check identity again inside the shared transaction, not only before waiting for its lock.
        const guarded = { ...ctx, credentials: {
          readRecord: async (key: typeof CODEX_KEY) => {
            const record = await ctx.credentials.readRecord(key)
            check(signal)
            if (grantOf(record).accountId !== g.accountId) throw new ImageError('account-changed')
            return record
          },
          deleteRecord: ctx.credentials.deleteRecord.bind(ctx.credentials),
          modifyRecord: async (key: typeof CODEX_KEY, mutate: Parameters<NonNullable<CodexContext['credentials']['modifyRecord']>>[1]) =>
            ctx.credentials.modifyRecord!(key, async current => {
              check(signal)
              if (grantOf(current).accountId !== g.accountId) throw new ImageError('account-changed')
              const next = await mutate(current)
              check(signal)
              return next
            }),
        } }
        const host = await loadHostCatalog(guarded)
        check(signal)
        if (!host) return false
        await host.refreshCredential({ signal, ...refreshOptions }); return true
      })
      let available: boolean
      try { available = await refreshAuth(signal, refreshOptions) } catch (error) { check(signal); if (error instanceof ImageError) throw error; throw new ImageError('refresh-failed') }
      check(signal)
      if (!available) throw new ImageError('refresh-unavailable')
      const next = await read(signal)
      if (next.accountId !== g.accountId) throw new ImageError('account-changed')
      if (next.expires <= now() + 180_000 || force && next.access === g.access) throw new ImageError('refresh-failed')
      f.grant = next
      return next
    } finally { f.refreshing = false }
  }
  function byteLimit() {
    const limits = ctx.attachments?.imageLimits
    if (!limits || typeof ctx.attachments.saveImage !== 'function' || !limits.mediaTypes.includes('image/png')
      || limits.maxImagesPerMessage < 1 || !Number.isFinite(limits.maxImageDimension) || limits.maxImageDimension < 1
      || !Number.isFinite(limits.maxImagePixels) || limits.maxImagePixels < 1) throw new ImageError('service-unavailable')
    const cap = Math.min(MAX_IMAGE_BYTES, limits.maxImageBytes, limits.maxMessageImageBytes)
    if (!Number.isFinite(cap) || cap < 1) throw new ImageError('service-unavailable')
    return Math.floor(cap)
  }
  async function run(input: ImageInput, caller: AbortSignal): Promise<ImageResult> {
    validateImageInput(input)
    const cap = byteLimit(), f: Flight = { controller: new AbortController(), refreshing: false, active: false }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new ImageError('timeout')), options.timeoutMs ?? 180_000)
    timer.unref()
    const signal = AbortSignal.any([caller, f.controller.signal, timeout.signal])
    flights.add(f)
    let release: (() => void) | undefined, account: string | undefined, tail: Promise<void> | undefined
    try {
      let g = await read(signal); f.grant = g; account = g.accountId
      const previous = queues.get(account) ?? Promise.resolve()
      const gate = new Promise<void>(resolve => { release = resolve })
      tail = previous.then(() => gate); queues.set(account, tail)
      // A cancelled waiter releases only its own gate; it cannot unlock its predecessor.
      await waitForQueue(previous, signal); check(signal)
      const queuedAccount = g.accountId
      g = await read(signal)
      if (g.accountId !== queuedAccount) throw new ImageError('account-changed')
      f.grant = g; f.active = true
      const due = cooldowns.get(account)
      if (due !== undefined && due > now()) throw new ImageError('rate-limited', 429, undefined, due)
      if (due !== undefined) cooldowns.delete(account)
      if (g.expires <= now() + 300_000) g = await refresh(g, f, signal, false)
      await assertCurrent(g, signal)
      const turn = randomUUID()
      let generated: Awaited<ReturnType<typeof generateImage>>
      try { generated = await generateImage(input, g, signal, cap, turn, options.fetcher, now) } catch (error) {
        if (!(error instanceof ImageError) || error.reason !== 'credential-expired') throw error
        g = await refresh(g, f, signal, true)
        await assertCurrent(g, signal)
        generated = await generateImage(input, g, signal, cap, turn, options.fetcher, now)
      }
      await assertCurrent(g, signal)
      if (!ctx.attachments.imageLimits.mediaTypes.includes(generated.mediaType)) throw new ImageError('invalid-response')
      let image: ImageAttachmentRef
      try {
        // Host storage fully decodes, validates dimensions, and normalizes the raster.
        image = await ctx.attachments.saveImage({ data: generated.data, mediaType: generated.mediaType,
          name: 'generated-image.' + generated.mediaType.split('/')[1] })
      } catch (error) {
        check(signal)
        const { isImageAdmissionError } = await import('@deepseek-ai/dsh-attachment')
        check(signal)
        throw new ImageError(isImageAdmissionError(error) ? 'invalid-response' : 'save-failed', 200, generated.requestId)
      }
      await assertCurrent(g, signal)
      return { image, model: IMAGE_MODEL, ...(generated.requestId ? { requestId: generated.requestId } : {}) }
    } catch (error) {
      check(signal)
      if (error instanceof ImageError) {
        if (account && error.retryAfter !== undefined) cooldowns.set(account, error.retryAfter)
        throw error
      }
      throw new ImageError('service-unavailable')
    } finally {
      clearTimeout(timer); flights.delete(f); release?.()
      if (account && tail) void tail.then(() => { if (queues.get(account!) === tail) queues.delete(account!) })
    }
  }
  return {
    generate(input: ImageInput, signal: AbortSignal) {
      const job = run(input, signal); jobs.add(job)
      void job.then(() => jobs.delete(job), () => jobs.delete(job))
      return job
    },
    async dispose() {
      closed = true; unsubscribe?.()
      for (const f of flights) f.controller.abort(new ImageError('cancelled'))
      await Promise.allSettled([...jobs]); queues.clear(); cooldowns.clear()
    },
  }
}
async function waitForQueue(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  })
  try { await Promise.race([previous, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}
