import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { grant, response } from './helpers.js'

const root = process.env.DSH_INSTALL_ROOT
test('installed DSH boots the plugin and routes a first-class tool result through LlmRuntime', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to run against an installed DSH.',
}, async () => {
  const require = createRequire(resolve(root, 'package.json'))
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') || specifier === 'undici') return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
    return next(specifier, context)
  } })
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm')
  const { CredentialProvider } = await import('@deepseek-ai/dsh-credentials')
  const { Service } = await import('@deepseek-ai/cordis')
  const { renderIndexInjections } = await import('@deepseek-ai/dsh-host-webserver')
  const { default: AuthorizationService } = await import('@deepseek-ai/dsh-authorization')
  const { createToolResultMessage } = await import('@deepseek-ai/dsh-llm/message')
  const plugin = await import('../src/index.js')
  const manifest = require('./package.json')
  const local = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(local.peerDependencies['@deepseek-ai/dsh-llm'].split(' || ').includes(manifest.version))
  class MemoryCredentials extends CredentialProvider {
    async readRecord(key) { return key === 'llm-chatgpt/chatgpt-plan' ? { kind: 'grant', payload: grant() } : undefined }
  }
  const routes = new Map()
  class MemoryWebServer extends Service {
    constructor(ctx) { super(ctx, 'webServer') }
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) }
  }
  class WebRuntime extends Service {
    constructor(ctx) { super(ctx, 'webRuntime') }
    trustedHosts = []
  }
  const ctx = new Context()
  const fibers = []
  const originalFetch = globalThis.fetch
  try {
    for (const service of [LlmRuntime, MemoryCredentials, AuthorizationService, MemoryWebServer, WebRuntime]) fibers.push(ctx.plugin(service))
    fibers.push(ctx.plugin(plugin, { proxyUrl: '127.0.0.1:7890' }))
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(ctx.llm.listProviders().some(item => item.id === 'chatgpt-plan'))
    assert.ok(ctx.authorization.list().some(item => item.key === 'llm-chatgpt/chatgpt-plan'))
    const injections = []
    ctx.emit('webserver/index-inject', injections)
    const index = renderIndexInjections('<html><head></head><body></body></html>', injections)
    assert.match(index, /__DSH_CHATGPT_MANAGEMENT__/)
    assert.ok(routes.has('/chatgpt-management/chatgpt-plan'))
    assert.doesNotMatch(index, /test-access|test-refresh/)
    let calls = 0
    globalThis.fetch = async (url, init) => {
      calls++
      assert.equal(url, 'https://api.openai.com/v1/responses')
      assert.equal(init.dispatcher.constructor.name, 'ProxyAgent')
      const body = JSON.parse(init.body)
      assert.deepEqual(body.input, [{ type: 'function_call_output', call_id: 'call_1', output: 'File content' }])
      return response([{ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Read the file.' }] },
      ] } }])
    }
    const chunks = []
    for await (const chunk of ctx.llm.stream({ provider: 'chatgpt-plan', model: 'test-model', messages: [
      createToolResultMessage({ callId: 'call_1', content: [{ type: 'text', text: 'File content' }], isError: false }),
    ] })) chunks.push(chunk)
    assert.equal(calls, 1)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, 'Read the file.')
  } finally {
    globalThis.fetch = originalFetch
    for (const fiber of fibers.reverse()) await fiber.dispose()
    hooks.deregister()
  }
})
