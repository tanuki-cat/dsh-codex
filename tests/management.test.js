import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { grant, store } from './helpers.js'

// The management surface imports the codex adapter, which addresses credential
// records through the host's key grammar; that one import is doubled here.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') {
    return { url: `data:text/javascript,${encodeURIComponent("export const credentialKey = (scope, id) => scope + '/' + id")}`, shortCircuit: true }
  }
  return next(specifier, context)
} })
const { createManagement, registerManagement, trustedManagementRequest } = await import('../src/management.js')
hooks.deregister()

const key = 'llm-chatgpt/chatgpt-plan'
function managementHost() {
  const storage = store()
  let pending
  const ctx = {
    credentials: storage,
    authorization: {
      describe() { return { inFlight: Boolean(pending) } },
      begin({ signal, interaction }) {
        interaction.notify({ url: 'http://127.0.0.1:1455/login' })
        return new Promise(resolve => {
          pending = { async finish() {
            await storage.modifyRecord(key, async () => ({ kind: 'grant', payload: grant({ email: 'test@example.com' }) }))
            pending = undefined; resolve({ status: 'authorized' })
          }, cancel() { pending = undefined; resolve({ status: 'cancelled' }) } }
          signal.addEventListener('abort', () => pending?.cancel(), { once: true })
        })
      },
      cancel() { pending?.cancel() },
    },
  }
  const manager = createManagement(ctx, key, { async listModels() { return [{ id: 'test-model', name: 'Test model' }] } }, {
    provider: 'chatgpt-plan', callbackPort: 0, requestTimeoutMs: 600_000,
  })
  return { manager, ctx, complete: () => pending.finish() }
}

test('management login finishes automatically and returns only public account facts', async () => {
  const host = managementHost()
  assert.equal((await host.manager.status()).connected, false)
  assert.deepEqual(await host.manager.start(), { loginUrl: 'http://127.0.0.1:1455/login' })
  assert.throws(() => host.manager.start(), /already running/)
  await host.complete()
  await new Promise(resolve => setImmediate(resolve))
  const status = await host.manager.status()
  assert.equal(status.connected, true)
  assert.equal(status.state, 'authorized')
  assert.equal(status.email, 'test@example.com')
  for (const token of ['test-access', 'test-refresh', 'idToken']) assert.equal(JSON.stringify(status).includes(token), false)
  assert.equal(status.loginUrl, undefined)
  assert.equal((await host.manager.models())[0].id, 'test-model')
  await host.manager.dispose()
})

test('management cancellation and disposal do not authorize an account', async () => {
  const host = managementHost()
  await host.manager.start()
  await host.manager.cancel()
  assert.equal((await host.manager.status()).state, 'cancelled')
  assert.equal((await host.manager.status()).connected, false)
  await host.manager.start()
  await host.manager.dispose()
  assert.throws(() => host.manager.start(), /closed/)
})

test('management sign-out cancels pending login before clearing the account', async () => {
  const host = managementHost()
  await host.manager.start()
  await host.manager.signOut(async () => {
    assert.equal(host.ctx.authorization.describe().inFlight, false)
  })
  assert.equal((await host.manager.status()).state, 'idle')
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

test('management routes require the injected capability and POST for account changes', async () => {
  let route, inject, cleanup
  const host = managementHost()
  const web = {
    webRuntime: { trustedHosts: [] },
    webServer: { register(value) { route = value; return () => {} } },
    on(_event, callback) { inject = callback },
    effect(callback) { cleanup = callback() },
  }
  registerManagement(web, host.manager, 'chatgpt-plan', async () => {})
  const table = []
  inject(table)
  const script = table[0]
  assert.equal(script.kind, 'script')
  assert.equal(script.placement, 'head')
  const token = /"token":"([a-f0-9]+)"/.exec(script.text)[1]
  async function request(operation, method, capability = token) {
    let code, body
    await route.handler({ url: route.path + operation, method, headers: { host: '127.0.0.1:8080', 'x-dsh-chatgpt-token': capability } }, {
      setHeader() {}, writeHead(value) { code = value }, end(value) { body = JSON.parse(value) },
    })
    return { code, body }
  }
  assert.equal((await request('/status', 'GET', 'wrong')).code, 403)
  assert.equal((await request('/login', 'GET')).code, 405)
  assert.equal((await request('/status', 'GET')).body.connected, false)
  assert.equal((await request('/login', 'POST')).body.loginUrl, 'http://127.0.0.1:1455/login')
  assert.equal((await request('/cancel', 'POST')).body.state, 'cancelled')
  await cleanup()
})
