import test from 'node:test'
import assert from 'node:assert/strict'
import { accessGrant, authorizationUrl, createTransaction, login, logout, loopback, readGrant, tokenGrant, validateCallback, verifyIdentity } from '../src/auth.js'
import { API, ISSUER } from '../src/http.js'
import { grant, json, jwks, jwt, store, tokens } from './helpers.js'

const key = 'llm-chatgpt/chatgpt-plan'
const hostKey = 'llm-chatgpt/host'

test('initial registration uses host identity, PKCE and direct-plan scopes', () => {
  const tx = createTransaction('urn:uuid:test')
  const next = createTransaction('urn:uuid:test')
  assert.notEqual(tx.state, next.state)
  const url = new URL(authorizationUrl(tx, 'http://127.0.0.1:1234/auth/callback'))
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('resource'), API)
  assert.equal(url.searchParams.get('agent_name_hint'), 'dsh-llm-chatgpt')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), tx.challenge)
  assert.match(url.searchParams.get('scope'), /chatgpt.tokens.use.direct/)
  const again = new URL(authorizationUrl(createTransaction(tx.hostId, grant()), 'http://127.0.0.1:5678/auth/callback'))
  assert.equal(again.searchParams.get('client_id'), 'oaiapp_test')
  assert.equal(again.searchParams.has('agent_name_hint'), false)
  assert.equal(again.searchParams.has('id_token_hint'), false)
})

test('callback rejects state mismatch, denial and missing issued client ID', () => {
  const tx = createTransaction('host')
  const callback = params => new URL(`http://127.0.0.1/auth/callback?${new URLSearchParams(params)}`)
  assert.throws(() => validateCallback(callback({ state: 'wrong', code: 'x', client_id: 'oaiapp_test' }), tx), /state/)
  assert.throws(() => validateCallback(callback({ state: tx.state, error: 'access_denied' }), tx), /declined/)
  for (const client_id of ['', 'dynamic_agent_client']) {
    assert.throws(() => validateCallback(callback({ state: tx.state, code: 'x', client_id }), tx), /Incomplete/)
  }
  const returning = createTransaction('host', grant())
  assert.throws(() => validateCallback(callback({ state: returning.state, code: 'x', client_id: 'other' }), returning), /selected account/)
  assert.equal(validateCallback(callback({ state: returning.state, code: 'x' }), returning).clientId, 'oaiapp_test')
})

test('ID token verifies signature and rejects identity, audience, nonce and time mismatches', () => {
  const expected = { clientId: 'oaiapp_test', nonce: 'test-nonce' }
  assert.equal(verifyIdentity(jwt(), jwks, expected).sub, 'test-account')
  for (const changes of [ { iss: 'https://example.com' }, { aud: 'wrong' }, { nonce: 'wrong' }, { exp: 1 },
    { iat: Date.now() / 1000 + 1000 }, { sub: '' }, { aud: ['oaiapp_test', 'other'] } ]) {
    assert.throws(() => verifyIdentity(jwt(changes), jwks, expected), /validation failed/)
  }
  assert.throws(() => verifyIdentity(jwt(), { keys: [] }, expected), /validation failed/)
  const parts = jwt().split('.')
  parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url')
  assert.throws(() => verifyIdentity(parts.join('.'), jwks, expected), /validation failed/)
  assert.throws(() => verifyIdentity(jwt(), jwks, { ...expected, subject: 'other' }), /validation failed/)
})

test('identity-only and malformed token grants cannot authorize inference', () => {
  assert.throws(() => tokenGrant(tokens({ scope: 'openid email' }), { sub: 'a' }, 'client'), /permission/)
  for (const changes of [{ token_type: 'Basic' }, { access_token: '' }, { refresh_token: '' }, { expires_in: -1 }]) {
    assert.throws(() => tokenGrant(tokens(changes), { sub: 'a' }, 'client'), /Incomplete/)
  }
  assert.throws(() => readGrant(undefined), /Sign in/)
})

test('concurrent refresh rotates once under the credential-store lock', async () => {
  const storage = store([[key, { kind: 'grant', payload: grant({ expiresAt: 1 }) }]])
  let calls = 0
  const fetcher = async (url, init) => {
    assert.equal(url, `${ISSUER}/api/accounts/oauth/token`)
    assert.equal(init.body.get('client_id'), 'oaiapp_test')
    assert.equal(init.body.get('refresh_token'), 'test-refresh')
    assert.equal(init.body.has('scope'), false)
    assert.equal(init.body.get('resource'), API)
    calls++
    return json(tokens({ id_token: undefined, scope: undefined, refresh_token: 'rotated' }))
  }
  const results = await Promise.all([accessGrant(storage, key, { fetcher }), accessGrant(storage, key, { fetcher })])
  assert.equal(calls, 1)
  assert.ok(results.every(result => result.refreshToken === 'rotated'))
})

test('failed refresh leaves the previous credential set intact and does not expose secrets', async () => {
  const old = { kind: 'grant', payload: grant({ expiresAt: 1 }) }
  const storage = store([[key, old]])
  await assert.rejects(accessGrant(storage, key, { fetcher: async () => new Response('test-refresh', { status: 401 }) }),
    error => error.status === 401 && !error.message.includes('test-refresh'))
  assert.deepEqual(await storage.readRecord(key), old)
})

test('aborted request performs no refresh', async () => {
  const storage = store([[key, { kind: 'grant', payload: grant({ expiresAt: 1 }) }]])
  await assert.rejects(accessGrant(storage, key, { signal: AbortSignal.abort(), fetcher: () => assert.fail('fetch') }), { name: 'AbortError' })
})

test('login commits verified identity and uses the callback-issued client in code exchange', async () => {
  const storage = store()
  let tx
  const receiveCallback = async transaction => {
    tx = transaction
    return { code: 'code', clientId: 'oaiapp_test', redirectUri: 'http://127.0.0.1:1234/auth/callback' }
  }
  const fetcher = async (url, init) => {
    if (url.endsWith('jwks.json')) return json(jwks)
    assert.equal(init.body.get('client_id'), 'oaiapp_test')
    assert.equal(init.body.get('code_verifier'), tx.verifier)
    assert.equal(init.body.get('redirect_uri'), 'http://127.0.0.1:1234/auth/callback')
    return json(tokens({ id_token: jwt({ nonce: tx.nonce }) }))
  }
  await login(storage, key, hostKey, { signal: new AbortController().signal }, { fetcher, receiveCallback })
  assert.equal(readGrant(await storage.readRecord(key)).subject, 'test-account')
  const host = (await storage.readRecord(hostKey)).payload.hostId
  await login(storage, key, hostKey, { signal: new AbortController().signal }, { fetcher, receiveCallback })
  assert.equal(tx.hostId, host)
  assert.equal(tx.previous.clientId, 'oaiapp_test')
})

test('returning sign-in cannot overwrite a different verified identity', async () => {
  const original = { kind: 'grant', payload: grant() }
  const storage = store([[key, original]])
  let tx
  await assert.rejects(login(storage, key, hostKey, { signal: new AbortController().signal }, {
    receiveCallback: async transaction => { tx = transaction; return { code: 'code', clientId: 'oaiapp_test', redirectUri: 'http://127.0.0.1:1234/auth/callback' } },
    fetcher: async url => url.endsWith('jwks.json') ? json(jwks) : json(tokens({ id_token: jwt({ nonce: tx.nonce, sub: 'different' }) })),
  }), /validation failed/)
  assert.deepEqual(await storage.readRecord(key), original)
})

test('login cancelled before starting performs no credential writes', async () => {
  const storage = store()
  await assert.rejects(login(storage, key, hostKey, { signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.equal(storage.values.size, 0)
})

test('login cancelled after verification leaves account credentials untouched', async () => {
  const original = { kind: 'grant', payload: grant() }
  const storage = store([[key, original]])
  const controller = new AbortController()
  let tx
  await assert.rejects(login(storage, key, hostKey, { signal: controller.signal }, {
    receiveCallback: async transaction => {
      tx = transaction
      return { code: 'code', clientId: 'oaiapp_test', redirectUri: 'http://127.0.0.1:1234/auth/callback' }
    },
    fetcher: async url => {
      if (url.endsWith('jwks.json')) { controller.abort(); return json(jwks) }
      return json(tokens({ id_token: jwt({ nonce: tx.nonce }) }))
    },
  }), { name: 'AbortError' })
  assert.deepEqual(await storage.readRecord(key), original)
})

test('login rejects credentials changed during OAuth rather than overwriting a concurrent refresh', async () => {
  const original = { kind: 'grant', payload: grant() }
  const changed = { kind: 'grant', payload: { ...original.payload, refreshToken: 'concurrently-rotated' } }
  const storage = store([[key, original]])
  let tx
  await assert.rejects(login(storage, key, hostKey, { signal: new AbortController().signal }, {
    receiveCallback: async transaction => {
      tx = transaction
      await storage.modifyRecord(key, async () => changed)
      return { code: 'code', clientId: 'oaiapp_test', redirectUri: 'http://127.0.0.1:1234/auth/callback' }
    },
    fetcher: async url => url.endsWith('jwks.json') ? json(jwks) : json(tokens({ id_token: jwt({ nonce: tx.nonce }) })),
  }), /credentials changed/)
  assert.deepEqual(await storage.readRecord(key), changed)
})

test('logout revokes refresh session and clears tokens while retaining registration', async () => {
  const storage = store([[key, { kind: 'grant', payload: grant() }]])
  let revoked = false
  await logout(storage, key, { fetcher: async (url, init) => {
    if (url.includes('openid-configuration')) return json({ revocation_endpoint: `${ISSUER}/revoke` })
    assert.equal(init.body.get('token'), 'test-refresh')
    assert.equal(init.body.get('client_id'), 'oaiapp_test')
    revoked = true
    return new Response('')
  } })
  assert.equal(revoked, true)
  const record = await storage.readRecord(key)
  assert.equal(record.payload.accessToken, '')
  assert.equal(record.payload.refreshToken, '')
  assert.equal(record.payload.clientId, 'oaiapp_test')
  assert.throws(() => readGrant(record), /Sign in/)
})

test('failed remote revocation preserves renewable session for retry', async () => {
  const old = { kind: 'grant', payload: grant() }
  const storage = store([[key, old]])
  await assert.rejects(logout(storage, key, { fetcher: async url => url.includes('openid-configuration')
    ? json({ revocation_endpoint: `${ISSUER}/revoke` }) : new Response('', { status: 503 }) }), /503/)
  assert.deepEqual(await storage.readRecord(key), old)
})

function fakeServer() {
  let handler, closed = false
  const server = {
    listening: false,
    once() {},
    listen(port, host, callback) { assert.equal(host, '127.0.0.1'); this.listening = true; callback() },
    address() { return { port: 1455 } },
    closeAllConnections() {},
    close(callback) { closed = true; this.listening = false; callback() },
  }
  return {
    factory(callback) { handler = callback; return server },
    request(url) {
      const result = { headers: {}, status: 200 }
      const res = {
        setHeader(key, value) { result.headers[key] = value },
        writeHead(code, headers) { result.status = code; Object.assign(result.headers, headers); return this },
        end(value) { result.body = value },
      }
      handler({ method: 'GET', url }, res)
      return result
    },
    get closed() { return closed },
  }
}

test('loopback exposes only a token-free local notice, rejects stray callbacks and closes after success', async () => {
  const tx = createTransaction('host')
  const server = fakeServer()
  const result = await loopback(tx, { signal: new AbortController().signal, notify(notice) {
    assert.equal(notice.url, 'http://127.0.0.1:1455/login')
    const redirect = server.request('/login')
    assert.equal(redirect.status, 302)
    assert.equal(new URL(redirect.headers.location).searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback')
    assert.equal(server.request('/auth/callback?state=wrong&code=x').status, 400)
    assert.equal(server.request(`/auth/callback?${new URLSearchParams({ state: tx.state, code: 'code', client_id: 'oaiapp_test' })}`).status, 200)
    assert.equal(server.request('/auth/callback').status, 404)
  } }, 0, server.factory)
  assert.equal(result.clientId, 'oaiapp_test')
  assert.equal(server.closed, true)
})

test('loopback cancellation releases its listener', async () => {
  const controller = new AbortController()
  const server = fakeServer()
  await assert.rejects(loopback(createTransaction('host'), {
    signal: controller.signal, notify() { controller.abort() },
  }, 0, server.factory), { name: 'AbortError' })
  assert.equal(server.closed, true)
})
