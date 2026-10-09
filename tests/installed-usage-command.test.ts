import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { store, json } from './helpers.ts'
const root = process.env.DSH_INSTALL_ROOT

test('installed CommandRuntime discovers usage and logs quota results without model work', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to test installed commands.',
}, async t => {
  const require = createRequire(resolve(root, 'package.json'))
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
    return next(specifier, context)
  } })
  t.after(() => hooks.deregister())
  const { Context } = await import('@deepseek-ai/cordis')
  const { CommandRuntime } = await import('@deepseek-ai/dsh-commands')
  const { registerUsageCommand } = await import('../lib/usage-command.js')
  const { createUsageService } = await import('../lib/usage.js')
  const time = Date.now(); let calls = 0
  const usage = createUsageService({ credentials: store([['llm-pi-ai/openai-codex', { kind: 'grant', payload: { access: 'fake-access', accountId: 'fake-account', expires: time + 86400_000 } }]]) }, {
    now: () => time, fetcher: async () => { calls++; return json({ rate_limit: {
      primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: Math.ceil(time / 1000) + 3600 },
      secondary_window: { used_percent: 42, limit_window_seconds: 604800, reset_at: Math.ceil(time / 1000) + 86400 },
    } }) },
  })
  t.after(() => usage.dispose())
  const ctx = new Context(), fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
  fibers.push(ctx.plugin(CommandRuntime))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(ctx.commands)
  const events = []
  const agent = { session: { append(type, data) { events.push({ type, data }); return events.length } }, prompt() { assert.fail('usage must not send a model prompt') } }
  const registration = ctx.plugin({ name: 'usage-command-test', inject: ['commands'], apply(scope) { registerUsageCommand(scope, usage) } })
  fibers.push(registration)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctx.commands.list(agent).find(item => item.name === 'usage').input, undefined)
  const signal = new AbortController().signal
  const auto = usage.get()
  const executed = await ctx.commands.execute(agent, '/usage', [], signal)
  await auto
  assert.equal(calls, 1); assert.equal(executed.result.kind, 'success')
  assert.match(executed.result.text, /88% 剩余可用/); assert.match(executed.result.text, /58% 剩余可用/)
  assert.deepEqual(events.map(event => event.type), ['command/run', 'command/done'])
  assert.equal(events[0].data.commandId, events[1].data.commandId)
  assert.doesNotMatch(JSON.stringify(events), /fake-access|fake-account/)
  await ctx.commands.execute(agent, '/usage', [], signal); assert.equal(calls, 1)
  assert.match(events.at(-1).data.text, /缓存数据/)
  const bad = await ctx.commands.execute(agent, '/usage extra', [], signal)
  assert.equal(bad.result.kind, 'error'); assert.equal(calls, 1)
  await registration.dispose()
  assert.equal(ctx.commands.list(agent).some(item => item.name === 'usage'), false)
})
