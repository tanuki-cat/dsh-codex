import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fixture, signal } from './image-fixtures.ts'
const root = process.env.DSH_INSTALL_ROOT

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
  const directory = await mkdtemp(join(tmpdir(), 'codex-image-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context(), fibers = []
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose() })
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
  fibers.push(ctx.plugin(Prompt), ctx.plugin(TestPtc), ctx.plugin(ToolRuntime, { mode: 'both' }), ctx.plugin(LocalAttachmentStore, { dshHome: directory }))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(ctx.tools); assert.ok(ctx.attachments)
  const sharp = createRequire(require.resolve('@deepseek-ai/dsh-attachment-local'))('sharp')
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer()
  const f = fixture(); let calls = 0, transportFailure = false
  const events = [], agent = { ctx, session: { header: { cwd: directory }, requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }), append(type, data) { events.push({ type, data }); return events.length } }, options: { provider: 'fallback', model: 'text' } }
  let modalities = ['text', 'image'], route
  let readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })
  fibers.push(ctx.plugin({ name: 'image-registration-test', inject: ['tools', 'attachments'], async apply(scope) {
    await registerImageTool(f.ctx, { tools: scope.tools, attachments: scope.attachments, on: scope.on.bind(scope), effect: scope.effect.bind(scope), llm: { async resolveModelInfo(provider, model) { route = [provider, model]; return { inputModalities: modalities } } } }, {
      fetcher: async () => { calls++; if (transportFailure) throw new TypeError('private-access', { cause: Object.assign(new Error('private-account'), { code: 'ECONNRESET' }) }); return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { headers: { 'content-type': 'application/json' } }) },
    }); readyResolve()
  } }))
  await ready
  const schema = ctx.tools.schemas(agent).find(tool => tool.name === 'image_gen')
  assert.ok(schema); assert.deepEqual(Object.keys(schema.parameters.properties), ['prompt', 'transparent_background'])
  const native = await ctx.tools.execute({ name: 'image_gen', arguments: { prompt: 'fox', transparent_background: true }, agent, callId: 'native', signal: signal() })
  assert.equal(native.isError, false, JSON.stringify(native)); assert.deepEqual(route, ['test', 'vision'])
  const image = native.content.find(block => block.type === 'image').attachment
  assert.deepEqual(image, native.value.image); assert.equal(image.width, 2)
  const stored = await ctx.attachments.readImage(image)
  assert.equal((await sharp(stored.data).metadata()).hasAlpha, true)
  // A new store instance must resolve the serialized reference without an in-memory cache.
  const reopened = new LocalAttachmentStore(new Context(), { dshHome: directory })
  assert.deepEqual((await reopened.readImage(JSON.parse(JSON.stringify(image)))).data, stored.data)
  const nested = await ctx.tools.execute({ name: 'run_code', arguments: { description: 'Generate a test image', code: "return await tools.image_gen({prompt: 'fox'})", timeoutMs: 240_000 }, agent, callId: 'nested', signal: signal() })
  assert.equal(nested.isError, false, JSON.stringify(nested))
  assert.ok(nested.additionalContexts.some(context => context.content.some(block => block.type === 'image')))
  assert.ok(events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'image_gen' && event.data.content.some(block => block.type === 'image')))
  const before = calls; modalities = ['text']
  const incapable = await ctx.tools.execute({ name: 'image_gen', arguments: { prompt: 'fox' }, agent, callId: 'text-route', signal: signal() })
  assert.equal(incapable.isError, true); assert.equal(calls, before)
  const invalid = await ctx.tools.execute({ name: 'image_gen', arguments: { prompt: 'fox', url: 'https://evil.invalid' }, agent, callId: 'unknown-param', signal: signal() })
  assert.equal(invalid.isError, true); assert.equal(calls, before)
  modalities = ['text', 'image']
  const damaged = png.subarray(0, 12)
  const damagedRefusal = await ctx.attachments.saveImage({ data: damaged, mediaType: 'image/png' }).then(() => assert.fail('damaged PNG must fail'), error => error.code)
  assert.equal(damagedRefusal, 'INVALID_IMAGE')
  transportFailure = true
  for (const [name, args] of [['image_gen', { prompt: 'fox' }], ['run_code', { description: 'Check image diagnostics', code: "return await tools.image_gen({prompt: 'fox'})", timeoutMs: 240_000 }]]) {
    const failure = await ctx.tools.execute({ name, arguments: args, agent, callId: 'diagnostic-' + name, signal: signal() })
    assert.equal(failure.isError, true)
    assert.match(JSON.stringify(failure.content), /stage=request/); assert.match(JSON.stringify(failure.content), /causeCode=ECONNRESET/)
    assert.doesNotMatch(JSON.stringify(failure), /private-access|private-account/)
  }
  await fibers.pop().dispose()
  assert.equal(ctx.tools.schemas(agent).some(tool => tool.name === 'image_gen'), false)
})
