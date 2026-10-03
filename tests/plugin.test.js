import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// These doubles validate the plugin's host calls, not a real Cordis boot.
const modules = {
  '@deepseek-ai/dsh-credentials': `export const credentialKey = (scope, id) => scope + '/' + id`,
  '@deepseek-ai/dsh-llm': `export class LlmAdapter {};
    export class LlmError extends Error { constructor(message, code, options) { super(message); this.code=code; this.options=options } };
    export const attributionHeaders = () => ({ 'user-agent': 'deepseek-harness/test' });`,
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier in modules) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true }
  return next(specifier, context)
} })
const { apply, inject } = await import('../src/index.js')
hooks.deregister()

function context(status = 'authorized') {
  const commands = new Map()
  let flow, adapter, registered
  const ctx = {
    credentials: { async readRecord() { return undefined } },
    llm: { registerAdapter(routes, value) { registered = routes; adapter = value } },
    authorization: {
      registerFlow(value) { flow = value },
      async begin() { return { status } },
      cancel() {},
    },
    commands: { register(command) { commands.set(command.name, command) } },
    userQuestions: {},
    effect(callback) { callback() },
    inject(dependencies, callback) {
      if (dependencies[0] === 'webServer') return
      assert.deepEqual(dependencies, ['commands', 'userQuestions']); callback(ctx)
    },
  }
  return { ctx, commands, get flow() { return flow }, get adapter() { return adapter }, get routes() { return registered } }
}

test('plugin registers a separate route, owned credential flow and interactive commands', async () => {
  const host = context()
  apply(host.ctx)
  assert.deepEqual(inject, ['llm', 'credentials', 'authorization'])
  assert.deepEqual(host.routes, ['chatgpt-plan'])
  assert.equal(host.flow.key, 'llm-chatgpt/chatgpt-plan')
  assert.equal(host.flow.methods[0].id, 'oauth')
  assert.equal(host.commands.size, 3)
  assert.deepEqual(await host.adapter.listModels(), [])
  assert.equal((await host.adapter.resolveModel('chatgpt-plan', 'model')).inputModalities[0], 'text')
})

test('cancelled authorization cannot be reported as a successful connection', async () => {
  const host = context('cancelled')
  apply(host.ctx)
  const result = await host.commands.get('chatgpt-plan-login').handler({ signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /取消/)
})

test('authorization success reports the actual provider route', async () => {
  const host = context()
  apply(host.ctx, { provider: 'personal-chatgpt' })
  const result = await host.commands.get('personal-chatgpt-login').handler({ signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /personal-chatgpt/)
})

test('invalid provider and bounds fail before registration', () => {
  for (const config of [{ provider: 'host' }, { provider: 'Invalid' }, { callbackPort: -1 }, { requestTimeoutMs: 0 }]) {
    const host = context()
    assert.throws(() => apply(host.ctx, config))
    assert.equal(host.routes, undefined)
  }
})
