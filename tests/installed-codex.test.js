import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const root = process.env.DSH_INSTALL_ROOT

/**
 * The official openai-codex sign-in surface, against the real authorization
 * and web-server services.
 *
 * The flow itself is doubled — llm-pi-ai is not mounted here — but everything
 * the plugin talks to is the installed host: the authorization registry it
 * must find the flow in, the credential seam it must not write through, and
 * the web server it must register on.
 */
test('installed DSH accepts the openai-codex management surface when llm-pi-ai offers the flow', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to run against an installed DSH.',
}, async () => {
  const require = createRequire(resolve(root, 'package.json'))
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') || specifier === 'undici') return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
    return next(specifier, context)
  } })
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm')
  const { CredentialProvider } = await import('@deepseek-ai/dsh-credentials')
  const { default: AuthorizationService } = await import('@deepseek-ai/dsh-authorization')
  const plugin = await import('../src/index.js')

  class MemoryCredentials extends CredentialProvider {
    async readRecord() { return undefined }
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
  try {
    for (const service of [LlmRuntime, MemoryCredentials, AuthorizationService, MemoryWebServer, WebRuntime]) fibers.push(ctx.plugin(service))
    // Service fibers activate asynchronously; the registry is only reachable
    // once the authorization service has settled.
    await new Promise(resolve => setImmediate(resolve))
    // Stand in for what llm-pi-ai registers, under the key the plugin reads.
    ctx.authorization.registerFlow({
      key: 'llm-pi-ai/openai-codex', label: 'OpenAI (ChatGPT Plus/Pro)',
      methods: [{ id: 'oauth', label: 'Sign in' }], async run() {},
    })
    fibers.push(ctx.plugin(plugin, {}))
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(routes.has('/chatgpt-management/openai-codex'), 'the codex endpoint is registered')
    const injections = []
    ctx.emit('webserver/index-inject', injections)
    const script = injections.map(entry => entry.text ?? '').join('\n')
    assert.match(script, /"openai-codex":\{"path":"\/chatgpt-management\/openai-codex"/)
    // The token reaches the browser; no credential ever does.
    assert.doesNotMatch(script, /access|refresh/i)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    hooks.deregister()
  }
})

/** Without llm-pi-ai there is no flow to drive, so no endpoint is offered. */
test('installed DSH omits the openai-codex surface when no flow is registered', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to run against an installed DSH.',
}, async () => {
  const require = createRequire(resolve(root, 'package.json'))
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') || specifier === 'undici') return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
    return next(specifier, context)
  } })
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm')
  const { CredentialProvider } = await import('@deepseek-ai/dsh-credentials')
  const { default: AuthorizationService } = await import('@deepseek-ai/dsh-authorization')
  const plugin = await import('../src/index.js')
  class MemoryCredentials extends CredentialProvider {
    async readRecord() { return undefined }
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
  try {
    for (const service of [LlmRuntime, MemoryCredentials, AuthorizationService, MemoryWebServer, WebRuntime]) fibers.push(ctx.plugin(service))
    fibers.push(ctx.plugin(plugin, {}))
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(routes.has('/chatgpt-management/chatgpt-plan'))
    assert.equal(routes.has('/chatgpt-management/openai-codex'), false)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    hooks.deregister()
  }
})
