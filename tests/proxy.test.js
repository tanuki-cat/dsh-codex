import test from 'node:test'
import assert from 'node:assert/strict'
import { createProxyTransport, normalizeProxyUrl } from '../src/proxy.js'
import { accessGrant, login, logout } from '../src/auth.js'
import { models, streamResponse } from '../src/wire.js'
import { collect, grant, json, jwks, jwt, response, store, tokens } from './helpers.js'

test('proxy addresses normalize bare host:port and reject credentials and unsupported protocols', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyUrl(' http://127.0.0.1:7890/ '), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyUrl('https://proxy.example:443'), 'https://proxy.example')
  assert.equal(normalizeProxyUrl(''), '')
  for (const value of ['socks5://localhost:7890', 'http://user:password@localhost:7890', 'http://localhost/path', 'http://localhost?secret=1', 123]) {
    assert.throws(() => normalizeProxyUrl(value), error => error.code === 'INVALID_CONFIG' && !error.message.includes('password'))
  }
})

test('unconfigured proxy leaves the original dispatcher and fetch behavior unchanged', async () => {
  const dispatcher = {}
  const transport = createProxyTransport('', { fetcher: async (_url, init) => init,
    loadProxyAgent: () => assert.fail('no proxy agent should be imported') })
  assert.equal((await transport.fetch('https://api.openai.com/v1/models', { dispatcher })).dispatcher, dispatcher)
  await transport.dispose()
})

test('configured transport reuses an isolated agent and preserves abort signals', async () => {
  const created = []
  class ProxyAgent {
    constructor(url) { this.url = url; created.push(this) }
    async destroy() { this.destroyed = true }
  }
  const controller = new AbortController()
  const transport = createProxyTransport('127.0.0.1:7890', { loadProxyAgent: async () => ProxyAgent,
    fetcher: async (_url, init) => { assert.equal(init.signal, controller.signal); return init.dispatcher } })
  const [first, second] = await Promise.all([
    transport.fetch('https://auth.openai.com/a', { signal: controller.signal }),
    transport.fetch('https://api.openai.com/a', { signal: controller.signal }),
  ])
  assert.equal(first, second)
  assert.equal(created.length, 1)
  assert.equal(first.url, 'http://127.0.0.1:7890')
  await transport.dispose()
  assert.equal(first.destroyed, true)
  await assert.rejects(transport.fetch('https://api.openai.com'), /closed/)
})

test('proxy failures report a safe proxy hint and cancellation remains cancellation', async () => {
  class Agent { async destroy() {} }
  const transport = createProxyTransport('http://localhost:7890', { loadProxyAgent: async () => Agent,
    fetcher: async () => { throw new Error('private-oauth-token') } })
  await assert.rejects(transport.fetch('https://auth.openai.com'), error => error.code === 'TRANSPORT'
    && error.message.includes('proxy') && !error.message.includes('private-oauth-token'))
  await assert.rejects(transport.fetch('https://auth.openai.com', { signal: AbortSignal.abort() }), { name: 'AbortError' })
  await transport.dispose()
})

test('OAuth exchange, JWKS, refresh, models, inference and revocation all use the same proxy', async () => {
  const storage = store()
  const key = 'llm-chatgpt/chatgpt-plan'
  const seen = []
  let tx
  class Agent { async destroy() {} }
  const transport = createProxyTransport('127.0.0.1:7890', {
    loadProxyAgent: async () => Agent,
    async fetcher(url, init) {
      assert.ok(init.dispatcher instanceof Agent)
      seen.push({ url, dispatcher: init.dispatcher })
      if (url.endsWith('jwks.json')) return json(jwks)
      if (url.endsWith('/oauth/token')) return json(tokens({ id_token: jwt({ nonce: tx.nonce }) }))
      if (url.endsWith('/models')) return json({ models: [] })
      if (url.endsWith('/responses')) return response([{ type: 'response.completed', response: { status: 'completed', output: [] } }])
      if (url.endsWith('openid-configuration')) return json({ revocation_endpoint: 'https://auth.openai.com/revoke' })
      if (url.endsWith('/revoke')) return new Response('')
      assert.fail('unexpected request')
    },
  })
  await login(storage, key, 'llm-chatgpt/host', { signal: new AbortController().signal }, {
    fetcher: transport.fetch, receiveCallback: async transaction => {
      tx = transaction
      return { clientId: 'oaiapp_test', code: 'code', redirectUri: 'http://127.0.0.1:1455/auth/callback' }
    },
  })
  await storage.modifyRecord(key, async current => ({ ...current, payload: { ...current.payload, expiresAt: 1 } }))
  const current = await accessGrant(storage, key, { fetcher: transport.fetch })
  await models(current, { fetcher: transport.fetch })
  await collect(streamResponse({ model: 'test-model', messages: [] }, current, { fetcher: transport.fetch }))
  await logout(storage, key, { fetcher: transport.fetch })
  assert.equal(seen.length, 8)
  assert.ok(seen.every(item => item.dispatcher === seen[0].dispatcher))
  assert.equal(seen.some(item => item.url.startsWith('http://127.0.0.1')), false)
  await transport.dispose()
})
