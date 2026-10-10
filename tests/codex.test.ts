import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { store } from './helpers.ts'

// These doubles validate the plugin's host calls, not a real Cordis boot: the
// credential key grammar is the one fact this module borrows from the host.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') {
    return { url: `data:text/javascript,${encodeURIComponent("export const credentialKey = (scope, id) => scope + '/' + id")}`, shortCircuit: true }
  }
  return next(specifier, context)
} })
const { CODEX_KEY, CODEX_PROVIDER, beginCodexLogin, codexFlow, readCodexAccount } = await import('../lib/codex.js')
const { createCodexManagement, registerCodexManagement } = await import('../lib/management.js')
hooks.deregister()

/** A stored grant shaped like the one pi-ai's OAuth flow commits. */
function codexGrant(overrides = {}) {
  const claims = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' },
    'https://api.openai.com/profile': { email: 'person@example.com', name: 'Test Person' },
  })).toString('base64url')
  return {
    kind: 'grant',
    payload: {
      type: 'oauth', access: `header.${claims}.signature`, refresh: 'test-refresh',
      expires: Date.now() + 3600_000, accountId: 'acct-1', ...overrides,
    },
  }
}

/** A Host double exposing only the seams the codex management reads. */
function host({ flow = true, record, notices = [{ message: 'Open this page', url: 'https://auth.openai.com/oauth/authorize?x=1' }] } = {}) {
  const storage = store(record === undefined ? [] : [[CODEX_KEY, record]])
  let pending
  return {
    storage,
    ctx: {
      credentials: storage,
      authorization: {
        describe(key) {
          assert.equal(key, CODEX_KEY)
          if (!flow) return undefined
          return { key, label: 'OpenAI (ChatGPT Plus/Pro)', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: Boolean(pending) }
        },
        begin({ signal, interaction }) {
          for (const notice of notices) interaction.notify(notice)
          return new Promise(resolve => {
            pending = {
              async finish() {
                await storage.modifyRecord(CODEX_KEY, async () => codexGrant())
                pending = undefined; resolve({ status: 'authorized' })
              },
              cancel() { pending = undefined; resolve({ status: 'cancelled' }) },
            }
            signal.addEventListener('abort', () => pending?.cancel(), { once: true })
          })
        },
        cancel() { pending?.cancel() },
      },
    },
    complete: () => pending.finish(),
  }
}

test('the codex module drives the flow the host adapter registered', async () => {
  const world = host()
  const notices = []
  assert.equal(codexFlow(world.ctx).label, 'OpenAI (ChatGPT Plus/Pro)')
  const running = beginCodexLogin(world.ctx, { notify: notice => notices.push(notice), signal: new AbortController().signal })
  // pi-ai's first prompt chooses a login method; the browser path leads.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(notices[0].url, 'https://auth.openai.com/oauth/authorize?x=1')
  await world.complete()
  assert.equal(await running, 'authorized')
})

test('a composition without llm-pi-ai reports the flow as absent instead of throwing late', async () => {
  const world = host({ flow: false })
  assert.equal(codexFlow(world.ctx), undefined)
  await assert.rejects(() => beginCodexLogin(world.ctx, { notify() {}, signal: new AbortController().signal }), /openai-codex sign-in/)
  const manager = createCodexManagement(world.ctx)
  assert.equal((await manager.status()).available, false)
  // Reaching for the missing flow is what fails, and it must surface as a
  // failed attempt rather than as a throw out of the management surface.
  await manager.start()
  await new Promise(resolve => setImmediate(resolve))
  const failed = await manager.status()
  assert.equal(failed.state, 'failed')
  assert.match(failed.error, /Sign-in failed/)
})

test('management reports the signed-in account without leaking tokens', async () => {
  const world = host({ record: codexGrant() })
  const manager = createCodexManagement(world.ctx)
  const status = await manager.status()
  assert.equal(status.connected, true)
  assert.equal(status.credentialState, 'unexpired')
  assert.equal(status.account.plan, 'plus')
  assert.equal(status.account.name, 'Test Person')
  assert.equal(status.account.email, 'person@example.com')
  const serialized = JSON.stringify(status)
  for (const secret of ['test-refresh', 'signature']) assert.equal(serialized.includes(secret), false, secret)
  await manager.dispose()
})

test('expired and incomplete grants remain stored without reporting a usable access token', async () => {
  for (const [grant, expected] of [
    [codexGrant({ expires: Date.now() - 60_000 }), 'expired'],
    [codexGrant({ refresh: '' }), 'incomplete'],
    [codexGrant({ expires: undefined }), 'incomplete'],
  ]) {
    const manager = createCodexManagement(host({ record: grant }).ctx)
    const status = await manager.status()
    assert.equal(status.credentialState, expected)
    assert.equal(status.connected, false)
    assert.ok(status.account)
    assert.equal(JSON.stringify(status).includes('test-refresh'), false)
  }
  assert.equal((await createCodexManagement(host().ctx).status()).credentialState, 'absent')
})

test('login publishes the authorization notice and settles on commit', async () => {
  const world = host()
  const manager = createCodexManagement(world.ctx)
  assert.equal((await manager.status()).connected, false)
  const started = await manager.start()
  assert.equal(started.state, 'pending')
  assert.match(started.notice.url, /auth\.openai\.com/)
  assert.throws(() => manager.start(), /already running/)
  await world.complete()
  await new Promise(resolve => setImmediate(resolve))
  const settled = await manager.status()
  assert.equal(settled.state, 'authorized')
  assert.equal(settled.connected, true)
  await manager.dispose()
})

test('progress notices do not hide the authorization URL', async () => {
  const url = 'https://auth.openai.com/oauth/authorize?x=1'
  const world = host({ notices: [{ message: 'Open this page', url }, { message: 'Waiting for callback' }] })
  const manager = createCodexManagement(world.ctx)
  const started = await manager.start()
  assert.equal(started.notice.message, 'Waiting for callback')
  assert.equal(started.notice.url, url)
  assert.equal((await manager.status()).notice.url, url)
  await manager.cancel()
  assert.equal((await manager.status()).notice, undefined)
})

test('cancelling and signing out leave no session behind', async () => {
  const world = host({ record: codexGrant() })
  const manager = createCodexManagement(world.ctx)
  assert.equal((await manager.status()).connected, true)
  const after = await manager.signOut()
  assert.equal(after.connected, false)
  assert.equal(after.state, 'idle')
  assert.equal(await world.storage.readRecord(CODEX_KEY), undefined)
  await manager.dispose()
  assert.throws(() => manager.start(), /closed/)
})

test('the credential record address matches the adapter contract', () => {
  assert.equal(CODEX_KEY, 'llm-pi-ai/openai-codex')
  assert.equal(CODEX_PROVIDER, 'openai-codex')
  // A malformed token must not take the status read down with it.
  assert.equal(readCodexAccount({ kind: 'grant', payload: { access: 'not-a-jwt' } })?.accountId, undefined)
  assert.equal(readCodexAccount(undefined), undefined)
})
test('codex management routes require the capability and expose the official sign-in', async () => {
  const world = host()
  let route, inject, cleanup
  // A plain-object double, so this covers the property-read fallback that
  // hosts without ctx.get go through. The generation-specific sources are read
  // by trustAuthorities independently of that fallback.
  const web = {
    webRuntime: { trustedHosts: [] },
    webServer: { register(value) { route = value; return () => {} } },
    on(_event, callback) { inject = callback },
    effect(callback) { cleanup = callback() },
  }
  registerCodexManagement(web, createCodexManagement(world.ctx))
  const table = []
  inject(table)
  const token = /"token":"([a-f0-9]+)"/.exec(table[0].text)[1]
  assert.match(table[0].text, /openai-codex/)
  async function request(operation, method, capability = token) {
    let code, body
    await route.handler({ url: route.path + operation, method, headers: { host: '127.0.0.1:8080', 'x-dsh-chatgpt-token': capability } }, {
      setHeader() {}, writeHead(value) { code = value }, end(value) { body = JSON.parse(value) },
    })
    return { code, body }
  }
  assert.match(route.path, /openai-codex$/)
  assert.equal((await request('/status', 'GET', 'wrong')).code, 403)
  // The card only ever POSTs a sign-in; a GET must not start one.
  assert.equal((await request('/login', 'GET')).code, 405)
  assert.equal((await request('/status', 'GET')).body.available, true)
  assert.equal((await request('/login', 'POST')).body.state, 'pending')
  assert.equal((await request('/cancel', 'POST')).body.state, 'cancelled')
  await cleanup()
})

