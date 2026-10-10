import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageService } from '../lib/image-service.js'
import { fixture, KEY, signal, deferred, imageResponse, rejectsReason } from './image-fixtures.ts'

function service(t, f, options = {}) { const s = createImageService(f.ctx, options); t.after(() => s.dispose()); return s }
test('generation persists an attachment without returning secrets or base64', async t => {
  const f = fixture(), s = service(t, f, { fetcher: async () => imageResponse() })
  const result = await s.generate({ prompt: 'private-prompt' }, signal())
  assert.equal(f.saved.length, 1); assert.equal(result.model, 'gpt-image-2'); assert.equal(result.image.width, 1)
  assert.doesNotMatch(JSON.stringify(result), /private-prompt|secret-|b64_json/)
})
test('missing credential, malformed credential and attachment limits stop before network', async t => {
  for (const reason of ['sign-in-required', 'credential-incomplete', 'service-unavailable']) {
    const f = fixture(); let calls = 0
    if (reason === 'sign-in-required') f.ctx.credentials.values.delete(KEY)
    if (reason === 'credential-incomplete') f.ctx.credentials.values.set(KEY, { kind: 'grant', payload: {} })
    if (reason === 'service-unavailable') f.ctx.attachments.imageLimits.mediaTypes = []
    const s = service(t, f, { fetcher: async () => { calls++; return imageResponse() } })
    await assert.rejects(s.generate({ prompt: 'fox' }, signal()), rejectsReason(reason)); assert.equal(calls, 0)
  }
})
test('near expiry refresh reuses committed token and rejects refreshed account changes', async t => {
  for (const switched of [false, true]) {
    const f = fixture({ expires: 1 }); let calls = 0, refreshes = 0
    const s = service(t, f, { refresh: async (signal, min) => {
      refreshes++; assert.equal(signal.aborted, false); assert.equal(min.minOAuthValidityMs, 300_000)
      await f.update({ access: 'new-access', expires: Date.now() + 86400_000, ...(switched ? { accountId: 'new-account' } : {}) }); return true
    }, fetcher: async (_url, init) => { calls++; assert.equal(init.headers.authorization, 'Bearer new-access'); return imageResponse() } })
    if (switched) await assert.rejects(s.generate({ prompt: 'fox' }, signal()), rejectsReason('account-changed'))
    else await s.generate({ prompt: 'fox' }, signal())
    assert.equal(refreshes, 1); assert.equal(calls, switched ? 0 : 1)
  }
})
test('401 refresh and retry is bounded to one; other HTTP failures do not refresh', async t => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture(); let calls = 0, refreshes = 0
    const s = service(t, f, { refresh: async (_signal, min) => { refreshes++; assert.equal(min.rejectedAccess, 'secret-access'); await f.update({ access: 'new-access' }); return true }, fetcher: async () => { calls++; return new Response('{}', { status }) } })
    await assert.rejects(s.generate({ prompt: 'fox' }, signal()), rejectsReason({ 401: 'credential-expired', 403: 'permission-denied', 429: 'rate-limited', 500: 'network-error' }[status]))
    assert.equal(calls, status === 401 ? 2 : 1); assert.equal(refreshes, status === 401 ? 1 : 0); assert.equal(f.saved.length, 0)
  }
})
test('Retry-After blocks subsequent submissions without another request', async t => {
  const f = fixture(); let calls = 0, time = 1000
  const s = service(t, f, { now: () => time, fetcher: async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '60' } }) } })
  await assert.rejects(s.generate({ prompt: 'one' }, signal()), rejectsReason('rate-limited'))
  await assert.rejects(s.generate({ prompt: 'two' }, signal()), rejectsReason('rate-limited')); assert.equal(calls, 1)
  time = 61001; await assert.rejects(s.generate({ prompt: 'three' }, signal()), rejectsReason('rate-limited')); assert.equal(calls, 2)
})
test('different prompts stay serialized; cancelling the middle waiter never unlocks the first', async t => {
  const f = fixture(), entered = deferred(), release = deferred(), prompts = []
  const s = service(t, f, { fetcher: async (_url, init) => {
    const prompt = JSON.parse(init.body).prompt; prompts.push(prompt)
    if (prompt === 'one') { entered.resolve(); await release.promise }
    return imageResponse()
  } })
  t.after(() => release.resolve())
  const first = s.generate({ prompt: 'one' }, signal()); await entered.promise
  const abort = new AbortController(), middle = s.generate({ prompt: 'two' }, abort.signal)
  const rejected = assert.rejects(middle, rejectsReason('cancelled'))
  const last = s.generate({ prompt: 'three' }, signal()); abort.abort(); await rejected
  assert.deepEqual(prompts, ['one']); release.resolve(); await Promise.all([first, last])
  assert.deepEqual(prompts, ['one', 'three'])
})
test('queued requests pick up the preceding refresh without double rotation', async t => {
  const f = fixture({ expires: 1 }), entered = deferred(), release = deferred(); let refreshes = 0, calls = 0
  const s = service(t, f, { refresh: async () => { refreshes++; entered.resolve(); await release.promise; await f.update({ access: 'new', expires: Date.now() + 86400_000 }); return true }, fetcher: async () => { calls++; return imageResponse() } })
  t.after(() => release.resolve())
  const first = s.generate({ prompt: 'one' }, signal()); await entered.promise
  const last = s.generate({ prompt: 'two' }, signal()); release.resolve(); await Promise.all([first, last])
  assert.equal(refreshes, 1); assert.equal(calls, 2)
})
test('account update aborts network work and detaches listener at disposal', async t => {
  const f = fixture(), entered = deferred(); let deliveredSignal
  const s = service(t, f, { fetcher: async (_url, init) => {
    deliveredSignal = init.signal; entered.resolve()
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  } })
  const job = s.generate({ prompt: 'one' }, signal()), outcome = assert.rejects(job, rejectsReason('account-changed'))
  await entered.promise; await f.update({ accountId: 'other' }); await outcome
  assert.equal(deliveredSignal.aborted, true); assert.equal(f.saved.length, 0)
  await s.dispose(); assert.equal(f.listeners.size, 0)
})
test('cancel during attachment save drains work and withholds success', async t => {
  const f = fixture(), entered = deferred(), release = deferred(), controller = new AbortController(); let saved = false
  f.ctx.attachments.saveImage = async input => { entered.resolve(); await release.promise; saved = true; return { attachmentId: 'a'.repeat(64), mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length } }
  const s = service(t, f, { fetcher: async () => imageResponse() }); t.after(() => release.resolve())
  const job = s.generate({ prompt: 'fox' }, controller.signal), outcome = assert.rejects(job, rejectsReason('cancelled'))
  await entered.promise; controller.abort(); let disposed = false
  const cleanup = s.dispose().then(() => { disposed = true })
  assert.equal(saved, false); assert.equal(disposed, false); release.resolve(); await outcome; await cleanup; assert.equal(saved, true)
})
test('storage failure does not repeat a successful generation', async t => {
  const f = fixture(); let calls = 0
  f.ctx.attachments.saveImage = async () => { throw new Error('secret-access') }
  const s = service(t, f, { fetcher: async () => { calls++; return imageResponse() } })
  await assert.rejects(s.generate({ prompt: 'fox' }, signal()), error => { assert.equal(error.reason, 'save-failed'); assert.doesNotMatch(error.message, /secret-/); return true })
  assert.equal(calls, 1)
})
test('host admission errors are invalid responses rather than storage faults', async t => {
  const f = fixture()
  f.ctx.attachments.saveImage = async () => { throw Object.assign(new Error('private-data'), { code: 'INVALID_IMAGE' }) }
  const s = service(t, f, { fetcher: async () => imageResponse() })
  await assert.rejects(s.generate({ prompt: 'fox' }, signal()), rejectsReason('invalid-response'))
})
test('logout while queued and account change during save withhold results', async t => {
  const f = fixture(), entered = deferred(), release = deferred()
  f.ctx.attachments.saveImage = async input => { entered.resolve(); await release.promise; return { attachmentId: 'a'.repeat(64), mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length } }
  const s = service(t, f, { fetcher: async () => imageResponse() }); t.after(() => release.resolve())
  const first = s.generate({ prompt: 'one' }, signal()), a = assert.rejects(first, rejectsReason('account-changed')); await entered.promise
  const second = s.generate({ prompt: 'two' }, signal()), b = assert.rejects(second, rejectsReason('account-changed'))
  // Ensure the waiter has observed its identity before logout.
  await new Promise(resolve => setImmediate(resolve))
  f.ctx.credentials.values.delete(KEY); await f.notify(); release.resolve(); await Promise.all([a, b])
})
test('unloading aborts an active request and queued waiters', async t => {
  const f = fixture(), entered = deferred(); let calls = 0
  const s = service(t, f, { fetcher: async (_url, init) => { calls++; entered.resolve(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) } })
  const first = s.generate({ prompt: 'one' }, signal()), a = assert.rejects(first, rejectsReason('cancelled')); await entered.promise
  const b = assert.rejects(s.generate({ prompt: 'two' }, signal()), rejectsReason('cancelled')); await s.dispose(); await Promise.all([a, b]); assert.equal(calls, 1)
  await assert.rejects(s.generate({ prompt: 'three' }, signal()), rejectsReason('service-unavailable'))
})
test('remote timeout cancels transport without retry', async t => {
  const f = fixture(); let calls = 0
  // This handle keeps Node alive while the deliberately unrefed service deadline fires.
  const hold = setTimeout(() => {}, 10_000); t.after(() => clearTimeout(hold))
  const s = service(t, f, { timeoutMs: 10, fetcher: async (_url, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) } })
  await assert.rejects(s.generate({ prompt: 'fox' }, signal()), rejectsReason('timeout')); assert.equal(calls, 1)
})
