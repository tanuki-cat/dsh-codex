import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fixture, signal } from './image-fixtures.ts'
const root = process.env.DSH_INSTALL_ROOT

/**
 * One composed host: the real tool registry in the requested presentation, the
 * real attachment store, and the plugin's image tool registered through a scope
 * that injects them.
 *
 * Presentation is a mount-time decision — 0.2.1-alpha.2 removed the `both`
 * value, and under `ptc` only `run_code` is callable directly — so each
 * presentation is its own composition rather than one mount asserting both.
 */
async function harness(Context, Service, ToolRuntime, PtcRuntime, LocalAttachmentStore, registerImageTool, sharp, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-image-test-'))
  const ctx = new Context(), fibers = []
  class Prompt extends Service { constructor(ctx) { super(ctx, 'systemPrompt') } tools() {} section() {} getSectionOrder() { return 0 } }
  // The real PTC bridge dispatches the SDK calls; this in-process runtime isolates process transport from this test.
  class TestPtc extends PtcRuntime {
    language = 'typescript'; isolation = 'test'
    get timeout() { return { defaultMs: 120_000, maxMs: 600_000 } }
    resolve(request) { assert.equal(request.timeoutMs, 240_000); return request }
    async run(spec) {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      return { value: await new AsyncFunction('tools', spec.program)(spec.bindings[0].functions), logs: [] }
    }
  }
  // 0.2.1-alpha.2 requires a working directory for a `run_code` call made with an
  // agent. The real service wants the whole session/projection chain, which is
  // not what this test exercises, so only the resolved directory is doubled —
  // the same shape the real one returns. Older hosts ignore the registration.
  class WorkingDirectory extends Service {
    constructor(ctx) { super(ctx, 'workingDirectory') }
    async ensure() { return directory }
  }
  fibers.push(ctx.plugin(Prompt), ctx.plugin(TestPtc), ctx.plugin(ToolRuntime, { mode }), ctx.plugin(WorkingDirectory), ctx.plugin(LocalAttachmentStore, { dshHome: directory }))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(ctx.tools); assert.ok(ctx.attachments)
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer()
  const f = fixture()
  const state = { calls: 0, transportFailure: false, modalities: ['text', 'image'], route: undefined }
  const events = []
  const agent = { ctx, session: { header: { cwd: directory }, requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }), append(type, data) { events.push({ type, data }); return events.length } }, options: { provider: 'fallback', model: 'text' } }
  let readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  fibers.push(ctx.plugin({ name: 'image-registration-test', inject: ['tools', 'attachments'], async apply(scope) {
    await registerImageTool(f.ctx, { tools: scope.tools, attachments: scope.attachments, on: scope.on.bind(scope), effect: scope.effect.bind(scope), llm: { async resolveModelInfo(provider, model) { state.route = [provider, model]; return { inputModalities: state.modalities } } } }, {
      fetcher: async () => { state.calls++; if (state.transportFailure) throw new TypeError('private-access', { cause: Object.assign(new Error('private-account'), { code: 'ECONNRESET' }) }); return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { headers: { 'content-type': 'application/json' } }) },
    }); readyResolve()
  } }))
  await ready
  return { ctx, fibers, agent, events, state, png, directory }
}

test('installed registry persists native and PTC image outcomes and rejects text-only routes', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to test installed image services.',
}, async t => {
  const require = createRequire(resolve(root, 'package.json'))
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
    return next(specifier, context)
  } })
  t.after(() => hooks.deregister())
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { PtcRuntime } = await import('@deepseek-ai/dsh-ptc-runtime')
  const { LocalAttachmentStore } = await import('@deepseek-ai/dsh-attachment-local')
  const { registerImageTool } = await import('../lib/image-tool.js')
  const sharp = createRequire(require.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
  const opened = []
  t.after(async () => {
    for (const host of opened) {
      for (const fiber of host.fibers.reverse()) await fiber.dispose()
      await rm(host.directory, { recursive: true, force: true })
    }
  })
  const open = async mode => {
    const host = await harness(Context, Service, ToolRuntime, PtcRuntime, LocalAttachmentStore, registerImageTool, sharp, mode)
    opened.push(host)
    return host
  }

  // A native mount: the model calls the tool by name.
  {
    const { ctx, fibers, agent, state, png } = await open('native')
    const schema = ctx.tools.schemas(agent).find(tool => tool.name === 'image_gen')
    assert.ok(schema); assert.deepEqual(Object.keys(schema.parameters.properties), ['prompt', 'transparent_background'])
    const native = await ctx.tools.execute({ name: 'image_gen', arguments: { prompt: 'fox', transparent_background: true }, agent, callId: 'native', signal: signal() })
    assert.equal(native.isError, false, JSON.stringify(native)); assert.deepEqual(state.route, ['test', 'vision'])
    const image = native.content.find(block => block.type === 'image').attachment
    assert.deepEqual(image, native.value.image); assert.equal(image.width, 2)
    const stored = await ctx.attachments.readImage(image)
    assert.equal((await sharp(stored.data).metadata()).hasAlpha, true)
    // A new store instance must resolve the serialized reference without an in-memory cache.
    const reopened = new LocalAttachmentStore(new Context(), { dshHome: agent.session.header.cwd })
    assert.deepEqual((await reopened.readImage(JSON.parse(JSON.stringify(image)))).data, stored.data)
    const before = state.calls; state.modalities = ['text']
    const incapable = await ctx.tools.execute({ name: 'image_gen', arguments: { prompt: 'fox' }, agent, callId: 'text-route', signal: signal() })
    assert.equal(incapable.isError, true); assert.equal(state.calls, before)
    const invalid = await ctx.tools.execute({ name: 'image_gen', arguments: { prompt: 'fox', url: 'https://evil.invalid' }, agent, callId: 'unknown-param', signal: signal() })
    assert.equal(invalid.isError, true); assert.equal(state.calls, before)
    state.modalities = ['text', 'image']
    const damaged = png.subarray(0, 12)
    const damagedRefusal = await ctx.attachments.saveImage({ data: damaged, mediaType: 'image/png' }).then(() => assert.fail('damaged PNG must fail'), error => error.code)
    assert.equal(damagedRefusal, 'INVALID_IMAGE')
    state.transportFailure = true
    const failure = await ctx.tools.execute({ name: 'image_gen', arguments: { prompt: 'fox' }, agent, callId: 'diagnostic-direct', signal: signal() })
    assert.equal(failure.isError, true)
    assert.match(JSON.stringify(failure.content), /stage=request/); assert.match(JSON.stringify(failure.content), /causeCode=ECONNRESET/)
    assert.doesNotMatch(JSON.stringify(failure), /private-access|private-account/)
    await fibers.pop().dispose()
    assert.equal(ctx.tools.schemas(agent).some(tool => tool.name === 'image_gen'), false)
  }

  // A PTC mount: the model reaches the same tool through the SDK, and the
  // dispatch is observable as its own event.
  {
    const { ctx, agent, state, events } = await open('ptc')
    const nested = await ctx.tools.execute({ name: 'run_code', arguments: { description: 'Generate a test image', code: "return await tools.image_gen({prompt: 'fox'})", timeoutMs: 240_000 }, agent, callId: 'nested', signal: signal() })
    assert.equal(nested.isError, false, JSON.stringify(nested))
    assert.ok(nested.additionalContexts.some(context => context.content.some(block => block.type === 'image')))
    assert.ok(events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'image_gen' && event.data.content.some(block => block.type === 'image')))
    state.transportFailure = true
    const failure = await ctx.tools.execute({ name: 'run_code', arguments: { description: 'Check image diagnostics', code: "return await tools.image_gen({prompt: 'fox'})", timeoutMs: 240_000 }, agent, callId: 'diagnostic-nested', signal: signal() })
    assert.equal(failure.isError, true)
    assert.match(JSON.stringify(failure.content), /stage=request/); assert.match(JSON.stringify(failure.content), /causeCode=ECONNRESET/)
    assert.doesNotMatch(JSON.stringify(failure), /private-access|private-account/)
  }
})
