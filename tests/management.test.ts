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
const { registerCodexManagement, trustedManagementRequest } = await import('../lib/management.js')
hooks.deregister()

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
  registerCodexManagement(web, manager)
  const table = []
  inject(table)
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'head')
  const token = /"token":"([a-f0-9]+)"/.exec(table[0].text)[1]
  async function request(operation, method, capability = token) {
    let code, body
    await route.handler({ url: route.path + operation, method, headers: { host: '127.0.0.1:8080', 'x-dsh-chatgpt-token': capability } }, {
      setHeader() {}, writeHead(value) { code = value }, end(value) { body = JSON.parse(value) },
    })
    return { code, body }
  }
  assert.equal((await request('/status', 'GET', 'wrong')).code, 403)
  assert.equal((await request('/login', 'GET')).code, 405)
  assert.equal((await request('/status', 'GET')).body.available, true)
  assert.equal((await request('/login', 'POST')).body.state, 'pending')
  assert.equal((await request('/cancel', 'POST')).body.state, 'idle')
  await cleanup()
})
