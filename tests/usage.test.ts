import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { store, json } from './helpers.ts'
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') return { url: 'data:text/javascript,' + encodeURIComponent("export const credentialKey = (scope, id) => scope + '/' + id"), shortCircuit: true }
  return next(specifier, context)
} })
const { createUsageService, parseUsage, fetchUsage, retryAfter } = await import('../lib/usage.js')
hooks.deregister()
const key = 'llm-pi-ai/openai-codex'
const grant = (overrides = {}) => ({ kind: 'grant', payload: { access: 'fake-access', accountId: 'account-a', expires: 99_000_000, refresh: 'fake-refresh', ...overrides } })
const payload = (used = 42, reset = 10000) => ({ rate_limit: { allowed: true, primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: reset }, secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: reset } } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function fixture(t, fetcher = async () => json(payload()), options = {}) {
  let time = 1_000_000
  const credentials = store([[key, grant()]])
  const service = createUsageService({ credentials }, { now: () => time, fetcher, ...options })
  t.after(() => service.dispose())
  return { service, credentials, advance(ms) { time += ms }, now: () => time }
}
test('credential and fetch timeout paths finish without real timers or lingering rejections', async t => {
  const readController = new AbortController(), read = deferred()
  const slow = createUsageService({ credentials: { readRecord: () => read.promise } }, { timeoutSignal: () => readController.signal })
  t.after(() => slow.dispose())
  const pending = slow.get(); readController.abort()
  assert.equal((await pending).reason, 'timeout'); read.resolve(grant())
  const budget = new AbortController(), fetchTimeout = new AbortController(), entered = deferred()
  const f = fixture(t, async (_url, init) => {
    entered.resolve()
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }, { timeoutSignal: ms => ms === 10000 ? fetchTimeout.signal : budget.signal })
  const fetch = f.service.get(); await entered.promise; fetchTimeout.abort()
  assert.equal((await fetch).reason, 'timeout')
})
test('auth pause during credential read prevents querying and disposed service cannot accept late data', async t => {
  const read = deferred(); let calls = 0
  const service = createUsageService({ credentials: { readRecord: () => read.promise } }, { fetcher: async () => { calls++; return json(payload()) } })
  t.after(() => service.dispose())
  const pending = service.get(); service.setPaused(true); read.resolve(grant())
  assert.equal((await pending).data, undefined); assert.equal(calls, 0)
  service.dispose(); assert.equal((await service.get()).reason, 'service-unavailable')
})

test('parser identifies duration rather than position and ignores model-specific quota', () => {
  for (const used of [0, 42.5, 100]) {
    const p = payload(used); [p.rate_limit.primary_window, p.rate_limit.secondary_window] = [p.rate_limit.secondary_window, p.rate_limit.primary_window]
    p.additional_rate_limits = [{ rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 90 } } }]
    const result = parseUsage(p, 1_000_000, 'account-a')
    assert.equal(result.usedPercent, used); assert.equal(result.remainingPercent, 100 - used); assert.equal(result.resetsAt, 10_000_000)
  }
})
test('parser rejects ambiguous invalid expired and cross-account usage', () => {
  const rejects = (p, reason = 'invalid-response') => assert.throws(() => parseUsage(p, 1_000_000, 'account-a'), e => e.reason === reason)
  for (const value of [undefined, [], '', NaN]) rejects(value)
  rejects({ rate_limit: null }, 'no-five-hour-window')
  rejects({ rate_limit: {} }, 'no-five-hour-window')
  rejects({ ...payload(), account_id: 'account-b' }, 'account-changed')
  for (const used of [-1, 101, NaN, Infinity, '42', null]) rejects(payload(used))
  for (const reset of [0, 999, -1, '10000', 1e16]) rejects(payload(42, reset))
  const duplicate = payload(); duplicate.rate_limit.secondary_window = duplicate.rate_limit.primary_window; rejects(duplicate)
  const noWindow = payload(); noWindow.rate_limit.primary_window.limit_window_seconds = 100; rejects(noWindow, 'no-five-hour-window')
  const malformed = payload(); malformed.rate_limit.allowed = 'yes'; rejects(malformed)
  const missingReset = payload(); delete missingReset.rate_limit.primary_window.reset_at
  assert.equal(parseUsage(missingReset, 1_000_000, 'account-a').resetsAt, undefined)
})
test('fetch sends only fixed endpoint and credential headers and classifies HTTP failures', async () => {
  for (const [status, reason] of [[401, 'credential-expired'], [403, 'permission-denied'], [429, 'rate-limited'], [500, 'network-error']]) {
    await assert.rejects(fetchUsage('fake', 'account-a', new AbortController().signal, async (url, init) => {
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage'); assert.equal(init.redirect, 'error')
      assert.equal(init.headers.authorization, 'Bearer fake'); assert.equal(init.headers['ChatGPT-Account-Id'], 'account-a')
      return new Response('private-upstream-error', { status, headers: { 'retry-after': '120' } })
    }, () => 1_000_000), e => e.reason === reason && !e.message.includes('private'))
  }
})
test('fetch bounds actual bytes and rejects non-JSON or malformed JSON', async () => {
  for (const response of [new Response('html'), new Response('x'.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } }), new Response('{', { headers: { 'content-type': 'application/json' } })])
    await assert.rejects(fetchUsage('fake', 'account-a', new AbortController().signal, async () => response), e => e.reason === 'invalid-response')
})
test('Retry-After accepts seconds and future HTTP dates without unsafe deadlines', () => {
  assert.equal(retryAfter('120', 1_000_000), 1_120_000)
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:20:00 GMT', 1_000_000), 1_200_000)
  for (const value of ['bad', '-1', '1e99', '', null]) assert.equal(retryAfter(value, 1_000_000), undefined)
})
test('successful requests share one flight and cache for sixty seconds', async t => {
  let calls = 0; const started = deferred(), response = deferred()
  const f = fixture(t, async () => { calls++; started.resolve(); return response.promise })
  const a = f.service.get(), b = f.service.get(); await started.promise
  assert.equal(calls, 1); response.resolve(json(payload()))
  const results = await Promise.all([a, b]); assert.deepEqual(results[0], results[1])
  const serialized = JSON.stringify(results[0]); for (const secret of ['fake-access', 'fake-refresh', 'account-a']) assert.equal(serialized.includes(secret), false)
  await f.service.get(); assert.equal(calls, 1)
  f.advance(60_000); await f.service.get(); assert.equal(calls, 2)
})
test('transient failures retain data only within five minutes and recover after backoff', async t => {
  let bad = false, calls = 0
  const f = fixture(t, async () => { calls++; if (bad) throw new Error('private'); return json(payload()) })
  await f.service.get(); bad = true; f.advance(60_000)
  assert.equal((await f.service.get()).state, 'stale')
  await f.service.get(); assert.equal(calls, 2)
  f.advance(241_000); assert.equal((await f.service.get()).data, undefined)
  bad = false; f.advance(300_000); assert.equal((await f.service.get()).state, 'ready')
})
test('identity and permission failures clear previously valid data', async t => {
  for (const status of [401, 403]) {
    let bad = false
    const f = fixture(t, async () => bad ? new Response('', { status }) : json(payload()))
    await f.service.get(); f.advance(60_000); bad = true
    const result = await f.service.get(); assert.equal(result.state, 'unavailable'); assert.equal(result.data, undefined)
  }
})
test('cache never crosses reset and external credential replacement invalidates account scope', async t => {
  let calls = 0
  const f = fixture(t, async () => { calls++; return json(payload(42, 1030)) })
  const initial = await f.service.get(); f.advance(30_000)
  assert.equal((await f.service.get()).data, undefined)
  f.credentials.values.set(key, grant({ accountId: 'account-b' })); await f.service.get()
  assert.equal(calls, 3)
  assert.notEqual((await f.service.get()).accountScope, initial.accountScope)
})
test('credential change during in-flight fetch discards late data and cannot clear newer flight', async t => {
  const started = deferred(), response = deferred(); let calls = 0
  const f = fixture(t, async () => { if (++calls === 1) { started.resolve(); return response.promise }; return json(payload()) })
  const old = f.service.get(); await started.promise
  f.credentials.values.set(key, grant({ accountId: 'account-b', access: 'second' }))
  const fresh = await f.service.get(); response.resolve(json(payload()))
  assert.equal((await old).data, undefined); assert.equal(fresh.state, 'ready')
  assert.deepEqual(await f.service.get(), fresh)
})
test('failure path also rechecks external identity', async t => {
  const entered = deferred(), release = deferred()
  const f = fixture(t, async () => { entered.resolve(); await release.promise; throw new Error('private') })
  const request = f.service.get(); await entered.promise
  f.credentials.values.delete(key); release.resolve()
  const result = await request; assert.equal(result.data, undefined); assert.equal(result.reason, 'sign-in-required')
})
test('near-expiry refresh is merged and the refreshed access is used', async t => {
  const started = deferred(), finish = deferred(); let refreshes = 0
  const credentials = store([[key, grant({ expires: 1_050_000 })]])
  const service = createUsageService({ credentials }, { now: () => 1_000_000,
    refresh: async () => { refreshes++; started.resolve(); await finish.promise; credentials.values.set(key, grant({ access: 'rotated' })); return true },
    fetcher: async (_url, init) => { assert.equal(init.headers.authorization, 'Bearer rotated'); return json(payload()) } })
  t.after(() => service.dispose())
  const a = service.get(), b = service.get(); await started.promise; finish.resolve()
  assert.equal((await a).state, 'ready'); assert.equal((await b).state, 'ready'); assert.equal(refreshes, 1)
})
test('valid access without refresh remains usable and expired access cannot query', async t => {
  let calls = 0
  const f = fixture(t, async () => { calls++; return json(payload()) })
  f.credentials.values.set(key, grant({ refresh: undefined })); assert.equal((await f.service.get()).state, 'ready')
  f.credentials.values.set(key, grant({ refresh: undefined, expires: 1 })); assert.equal((await f.service.get()).reason, 'credential-expired'); assert.equal(calls, 1)
})
test('refresh failure is negatively cached and dispose rejects late results', async t => {
  let calls = 0
  const f = fixture(t, async () => { throw new Error('must not fetch') }, { refresh: async () => { calls++; throw new Error('private') } })
  f.credentials.values.set(key, grant({ expires: 1 })); assert.equal((await f.service.get()).reason, 'refresh-failed')
  await f.service.get(); assert.equal(calls, 1)
  f.service.dispose(); assert.equal((await f.service.get()).reason, 'service-unavailable')
})
