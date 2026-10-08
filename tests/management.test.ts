import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { store } from './helpers.ts'

// The management surface imports the codex adapter, which addresses credential
// records through the host's key grammar; that one import is doubled here.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') {
    return { url: 'data:text/javascript,' + encodeURIComponent("export const credentialKey = (scope, id) => scope + '/' + id"), shortCircuit: true }
  }
  return next(specifier, context)
} })
const { createCodexManagement, registerCodexManagement, trustedManagementRequest } = await import('../lib/management.js')
const { PatchError } = await import('../lib/model-patches.js')
hooks.deregister()

test('usage route inherits capability checks, no-store and lifecycle disposal', async () => {
  let route, inject, cleanup, calls = 0, disposed = false
  const manager = { async dispose() {}, async status() {}, async start() {}, async cancel() {}, async signOut() {} }
  const usage = { async get() { calls++; return { state: 'unavailable', reason: 'no-five-hour-window', nextCheckAt: 1000 } }, dispose() { disposed = true } }
  const ctx = { webRuntime: { trustedHosts: [] }, webServer: { register(value) { route = value; return () => {} } },
    on(_event, callback) { inject = callback }, effect(callback) { cleanup = callback() } }
  registerCodexManagement(ctx, manager, undefined, usage)
  const scripts = []; inject(scripts)
  const connection = { token: /"token":"([a-f0-9]+)"/.exec(scripts[0].text)[1] }
  async function request(method = 'GET', token = connection.token, origin) {
    let code, body; const headers = {}
    await route.handler({ url: route.path + '/usage', method, headers: { host: '127.0.0.1:3080', 'x-dsh-chatgpt-token': token, origin } }, {
      setHeader(key, value) { headers[key] = value }, writeHead(value) { code = value }, end(value) { body = JSON.parse(value) },
    })
    return { code, body, headers }
  }
  assert.equal((await request('GET', 'wrong')).code, 403)
  assert.equal((await request('GET', connection.token, 'https://attacker.example')).code, 403)
  assert.equal((await request('POST')).code, 405); assert.equal(calls, 0)
  const result = await request(); assert.equal(result.code, 200); assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.body.reason, 'no-five-hour-window'); assert.equal(calls, 1)
  await cleanup(); assert.equal(disposed, true)
})

test('management protects against wrong capability, cross-site origins and DNS rebinding', () => {
  const request = (host, token = 'secret', origin, site) => ({ headers: { host, 'x-dsh-chatgpt-token': token, origin, 'sec-fetch-site': site } })
  assert.equal(trustedManagementRequest(request('127.0.0.1:8080', 'secret', 'http://127.0.0.1:8080'), 'secret'), true)
  assert.equal(trustedManagementRequest(request('127.0.0.1:8080', 'wrong'), 'secret'), false)
  assert.equal(trustedManagementRequest(request('127.0.0.1:8080', 'secret', 'https://attacker.example'), 'secret'), false)
  assert.equal(trustedManagementRequest(request('127.attacker.example'), 'secret'), false)
  assert.equal(trustedManagementRequest(request('127.0.0.1', 'secret', undefined, 'cross-site'), 'secret'), false)
  assert.equal(trustedManagementRequest(request('192.168.1.2:8080'), 'secret', ['192.168.1.2:8080']), true)
  assert.equal(trustedManagementRequest(request('192.168.1.2:9090'), 'secret', ['192.168.1.2:8080']), false)
})

test('management routes require the injected capability and POST for state changes', async () => {
  let route, inject, cleanup
  let pending
  const ctx = {
    credentials: store(),
    authorization: {
      describe() { return { inFlight: Boolean(pending) } },
      // A never-settling attempt, like a real one waiting for the browser. The
      // management surface must answer while it is still outstanding.
      begin() { pending = {}; return new Promise(() => {}) },
      cancel() { pending = undefined },
    },
  }
  const manager = {
    // The real manager answers `start()` with the status of the attempt it just
    // launched, so the page renders "pending" without waiting for the browser.
    async status() { return { state: pending ? 'pending' : 'idle', available: true, connected: false } },
    async start() { ctx.authorization.begin(); return manager.status() },
    async cancel() { ctx.authorization.cancel(); return manager.status() },
    async signOut() { return manager.status() },
    async dispose() {},
  }
  const web = {
    webRuntime: { trustedHosts: [] },
    webServer: { register(value) { route = value; return () => {} } },
    on(_event, callback) { inject = callback },
    effect(callback) { cleanup = callback() },
  }
  // The route reports the reason the patch layer decided, so the page can name
  // the remedy instead of collapsing every refusal into "source unavailable".
  let refusal
  const patch = {
    async preview() {
      if (refusal) throw new PatchError(refusal, 'refused for the test')
      return { added: ['gpt-6.1-sol'], signature: 'a'.repeat(64) }
    },
    async fallback(reason) { return { unavailable: 'listing unavailable', reason, added: [] } },
    async restorePreview() { if (refusal) throw new PatchError(refusal, 'refused'); return { kind: 'restore', signature: 'b'.repeat(64) } },
    async restore(signature) { if (refusal) throw new PatchError(refusal, 'refused'); assert.equal(signature, 'b'.repeat(64)); return { restored: true, applied: [] } },
    async apply(signature) {
      if (refusal) throw new PatchError(refusal, 'refused for the test')
      assert.equal(signature, 'a'.repeat(64))
      return { applied: ['gpt-6.1-sol'] }
    },
  }
  registerCodexManagement(web, manager, () => patch)
  const table = []
  inject(table)
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'head')
  const token = /"token":"([a-f0-9]+)"/.exec(table[0].text)[1]
  async function request(operation, method, capability = token, signature) {
    let code, body
    await route.handler({ url: route.path + operation, method, headers: { host: '127.0.0.1:8080', 'x-dsh-chatgpt-token': capability, 'x-dsh-model-patch': signature } }, {
      setHeader() {}, writeHead(value) { code = value }, end(value) { body = JSON.parse(value) },
    })
    return { code, body }
  }
  assert.equal((await request('/status', 'GET', 'wrong')).code, 403)
  assert.equal((await request('/login', 'GET')).code, 405)
  assert.equal((await request('/status', 'GET')).body.available, true)
  assert.equal((await request('/login', 'POST')).body.state, 'pending')
  assert.equal((await request('/cancel', 'POST')).body.state, 'idle')
  assert.equal((await request('/models-preview', 'GET', 'wrong')).code, 403)
  assert.deepEqual((await request('/models-preview', 'GET')).body.added, ['gpt-6.1-sol'])
  assert.equal((await request('/models-apply', 'POST')).code, 400)
  // A malformed confirmation is reported as a conflict, not as a source failure.
  assert.equal((await request('/models-apply', 'POST', token, 'nope')).body.reason, 'conflict')
  assert.deepEqual((await request('/models-apply', 'POST', token, 'a'.repeat(64))).body.applied, ['gpt-6.1-sol'])
  assert.equal((await request('/models-restore-preview', 'GET', 'wrong')).code, 403)
  assert.equal((await request('/models-restore', 'GET')).code, 405)
  assert.equal((await request('/models-restore-preview', 'GET')).body.kind, 'restore')
  assert.equal((await request('/models-restore', 'POST', token, 'nope')).body.reason, 'conflict')
  assert.equal((await request('/models-restore', 'POST', token, 'b'.repeat(64))).body.restored, true)

  // Each refusal reason survives the route: the read-only fallback keeps the
  // reason it was refused for, and the status code separates a stale
  // confirmation (409) from every other refusal (400).
  for (const [reason, code, operation, method] of [
    ['route-missing', 200, '/models-preview', 'GET'],
    ['settings-read-only', 200, '/models-preview', 'GET'],
    ['registration-unconfirmed', 400, '/models-apply', 'POST'],
    ['conflict', 409, '/models-apply', 'POST'],
    ['conflict', 409, '/models-restore', 'POST'],
    ['native-catalog-unavailable', 400, '/models-restore-preview', 'GET'],
  ]) {
    refusal = reason
    const answer = await request(operation, method, token, 'a'.repeat(64))
    assert.equal(answer.code, code, reason)
    assert.equal(answer.body.reason, reason, reason)
    // A refusal never proposes an addition, whichever layer reported it.
    assert.ok(!answer.body.added || answer.body.added.length === 0, reason)
  }
  refusal = undefined
  await cleanup()
})

test('no route response or injected script ever carries the stored OAuth credential', async () => {
  let route, inject, cleanup
  const pending = {}
  const world = store()
  // A grant whose every field is a distinct sentinel, so any leak is nameable.
  const ACCESS = 'sentinel-access-token'
  const REFRESH = 'sentinel-refresh-token'
  const SIGNATURE = 'sentinel-signature'
  await world.modifyRecord('llm-pi-ai/openai-codex', () => ({
    kind: 'grant',
    payload: { type: 'oauth', access: `header.${'e30'}.sentinel-signature`, refresh: REFRESH, accountId: 'account-sentinel', expires: Date.now() + 60_000 },
  }))
  const ctx = {
    credentials: world,
    authorization: {
      describe() { return { inFlight: Boolean(pending.value) } },
      begin() { pending.value = {}; return new Promise(() => {}) },
      cancel() { pending.value = undefined },
    },
  }
  const manager = createCodexManagement(ctx)
  const web = {
    webRuntime: { trustedHosts: [] },
    webServer: { register(value) { route = value; return () => {} } },
    on(_event, callback) { inject = callback },
    effect(callback) { cleanup = callback() },
  }
  const patch = {
    async preview() { return { added: ['gpt-6.1-sol'], preserved: [], total: 1, unsupported: 0, signature: 'a'.repeat(64), source: 'https://chatgpt.com/backend-api/codex/models' } },
    async fallback(reason) { return { unavailable: 'unavailable', reason, added: [] } },
    async apply() { return { applied: ['gpt-6.1-sol'] } },
    async restorePreview() { return { kind: 'restore', signature: 'b'.repeat(64) } },
    async restore() { return { restored: true, applied: [] } },
  }
  registerCodexManagement(web, manager, () => patch)
  const table = []
  inject(table)
  // Everything the browser receives: the injected index script and each reply.
  const received = [table.map(entry => entry.text).join('\n')]
  const token = /"token":"([a-f0-9]+)"/.exec(table[0].text)[1]
  async function request(operation, method, signature) {
    let body
    await route.handler({ url: route.path + operation, method, headers: { host: '127.0.0.1:8080', 'x-dsh-chatgpt-token': token, 'x-dsh-model-patch': signature } }, {
      setHeader() {}, writeHead() {}, end(value) { body = value },
    })
    received.push(body)
    return body
  }
  for (const [operation, method, signature] of [
    ['/status', 'GET'], ['/login', 'POST'], ['/cancel', 'POST'], ['/logout', 'POST'],
    ['/models-preview', 'GET'], ['/models-apply', 'POST', 'a'.repeat(64)],
    ['/models-restore-preview', 'GET'], ['/models-restore', 'POST', 'b'.repeat(64)],
  ]) await request(operation, method, signature)

  const whole = received.join('\n')
  // Tokens never leave the server, on any route.
  for (const secret of [ACCESS, REFRESH, SIGNATURE]) {
    assert.equal(whole.includes(secret), false, secret)
  }
  // The account id is not a token: it identifies the signed-in account, the
  // same fact the card already shows. It is the only credential-derived value
  // that rides, and it is asserted here so a later change cannot widen it.
  assert.equal(whole.includes('account-sentinel'), true)
  // The capability token is the one credential the browser is given, and the
  // access token must not ride in that same script.
  assert.match(received[0], /"token":"[a-f0-9]{64}"/)
  assert.doesNotMatch(received[0], /access|refresh/i)
  await cleanup()
})
