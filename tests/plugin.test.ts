import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// These doubles validate the plugin's host calls, not a real Cordis boot: the
// only host fact it reads is the credential key grammar.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') {
    return { url: 'data:text/javascript,' + encodeURIComponent("export const credentialKey = (scope, id) => scope + '/' + id"), shortCircuit: true }
  }
  return next(specifier, context)
} })
const { apply, inject, name } = await import('../lib/index.js')
hooks.deregister()

/**
 * A Host double offering only the seams the plugin reads.
 *
 * flow decides whether llm-pi-ai is currently present. The endpoint remains
 * registered either way so a later flow mount becomes visible without remounting.
 */
function context({ flow = true } = {}) {
  const routes = new Map()
  const ctx = {
    credentials: {},
    authorization: {
      describe(key) {
        assert.equal(key, 'llm-pi-ai/openai-codex')
        if (!flow) return undefined
        return { key, label: 'OpenAI (ChatGPT Plus/Pro)', methods: [{ id: 'oauth', label: 'Sign in' }], inFlight: false }
      },
    },
    inject(dependencies, callback) {
      if (dependencies[0] === 'commands' || dependencies[0] === 'tools') return
      if (dependencies[0] === 'settings') {
        assert.deepEqual(dependencies, ['settings', 'llm'])
        return
      }
      assert.deepEqual(dependencies, ['webServer', 'webRuntime'])
      callback(ctx)
    },
    on() {},
    effect() {},
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    webRuntime: { trustedHosts: [] },
  }
  return { ctx, routes }
}

test('plugin claims no provider route and no authorization flow of its own', () => {
  const host = context()
  apply(host.ctx)
  // The point of the slimming: pi-ai owns the route and its flow, so this
  // plugin registers exactly one management endpoint and nothing else.
  assert.equal(name, 'llm-chatgpt')
  assert.deepEqual(inject, ['credentials', 'authorization'])
  assert.equal(host.routes.size, 1)
  assert.ok(host.routes.has('/chatgpt-management/openai-codex'))
})

test('plugin registers management independently of authorization flow order', () => {
  const host = context({ flow: false })
  apply(host.ctx)
  // The status operation decides availability dynamically, allowing llm-pi-ai
  // to mount after this plugin without requiring a remount.
  assert.equal(host.routes.size, 1)
  assert.ok(host.routes.has('/chatgpt-management/openai-codex'))
})

test('optional command shares parent service and survives web scope disposal', async t => {
  const parentCleanups = [], webCleanups = []; let definition
  const ctx = { credentials: { async readRecord() { return undefined } }, authorization: { cancel() {}, describe() { return undefined } },
    effect(fn) { parentCleanups.push(fn()) },
    inject(dependencies, callback) {
      if (dependencies[0] === 'settings' || dependencies[0] === 'tools') return
      if (dependencies[0] === 'commands') { callback({ commands: { register(value) { definition = value; return () => {} } } }); return }
      callback({ webServer: { register() { return () => {} } }, webRuntime: { trustedHosts: [] }, on() {}, effect(fn) { webCleanups.push(fn()) } })
    } }
  apply(ctx)
  t.after(async () => { for (const cleanup of webCleanups) await cleanup(); for (const cleanup of parentCleanups) await cleanup() })
  assert.equal(definition.name, 'usage')
  const args = { rawInput: '', signal: new AbortController().signal }
  await webCleanups[0]()
  assert.match((await definition.handler(args)).text, /未登录/)
  await parentCleanups[0]()
  assert.match((await definition.handler(args)).text, /额度服务不可用/)
})
