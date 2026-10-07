import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/**
 * The model patch against the real adapter, its real Config schema and the
 * real model resolver.
 *
 * The settings service is doubled — `SettingsForms` needs the whole Loader and
 * profile-boot chain, which no unit test should stand up — but the two facts
 * that actually decide whether a patch is safe are real here: the section the
 * double accepts must resolve under `llm-pi-ai`'s own `Config` schema, and the
 * models it then exposes must resolve through the real `LlmRuntime` resolver
 * that raises `UNKNOWN_MODEL`. A green unit test with a hand-written settings
 * stand-in proves neither.
 *
 * The adapter is re-resolved from a new snapshot identity plus the
 * `loader/volatile-update` the host emits on reload, which is how a live
 * profile observes a settings write without a restart.
 */
const root = process.env.DSH_INSTALL_ROOT
const MODELS = ['gpt-5.3-codex-spark', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol']

// The real adapter pulls the whole credentials module, so this resolves the
// installed one rather than a stub; the plugin only needs its key grammar.
const hook = () => registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || specifier === 'undici') {
    const require = createRequire(resolve(root, 'package.json'))
    return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
  }
  return next(specifier, context)
} })

const remoteModel = (slug, other = {}) => ({
  slug, display_name: slug, visibility: 'list', supported_in_api: false,
  context_window: 272000, input_modalities: ['text', 'image'],
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }], ...other,
})

/** The upstream listing this account actually returns, trimmed to what the patch reads. */
const listing = [
  remoteModel('gpt-6.1-sol', { supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) }),
  remoteModel('gpt-6-luna'),
  remoteModel('gpt-reserve', { visibility: 'hide' }),
  remoteModel('codex-auto-review', { visibility: 'hide' }),
]

test('a patch accepted by the host schema registers through the real adapter and resolver', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to run against an installed DSH.',
}, async () => {
  const hooks = hook()
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm')
  const piai = await import('@deepseek-ai/dsh-llm-pi-ai')
  const { Config } = piai
  const { createModelPatches } = await import('../lib/model-patches.js')

  // The live providers map the adapter re-resolves from; mutate() swaps it.
  let live = { 'openai-codex': { reasoning: 'medium' } }
  const config = { providers: { get: () => live } }
  let revision = 1
  const writes = []

  const ctx = new Context()
  const fibers = [ctx.plugin(LlmRuntime)]
  try {
    await new Promise(done => setImmediate(done))
    fibers.push(ctx.plugin({ name: piai.name, inject: piai.inject, apply: piai.apply }, config))
    await new Promise(done => setImmediate(done))
    await new Promise(done => setImmediate(done))

    // Only the eight catalog models are offered before the patch.
    assert.deepEqual((await ctx.llm.listModels('openai-codex')).map(m => m.id), MODELS)
    await assert.rejects(ctx.llm.resolveModelInfo('openai-codex', 'gpt-6.1-sol'),
      (error) => error.code === 'UNKNOWN_MODEL', 'the target is unknown before the patch')

    const settings = {
      writable: true,
      describe() {
        return [{ ns: 'llm-pi-ai', revision, value: { providers: live }, user: { providers: live } }]
      },
      async mutate(ns, ops, expected) {
        assert.equal(ns, 'llm-pi-ai')
        assert.equal(expected, revision, 'the write carries the revision it previewed')
        assert.deepEqual(ops.map(op => op.path), [['providers', 'openai-codex', 'models']])
        const models = ops[0].value
        // The host refuses a section its own schema cannot resolve, so this is
        // the real contract the composed value has to satisfy.
        Config({ providers: { 'openai-codex': { ...live['openai-codex'], models } } })
        writes.push(models)
        live = { ...live, 'openai-codex': { ...live['openai-codex'], models } }
        revision += 1
        // A profile reload hands the adapter a new snapshot identity; that is
        // what makes it re-resolve instead of serving the memoized catalogue.
        ctx.emit('loader/volatile-update')
      },
    }

    const credentialContext = { credentials: { async readRecord() { return { kind: 'grant', payload: { type: 'oauth', access: 'test-access', refresh: 'test-refresh', accountId: 'account-1', expires: Date.now() + 3_600_000 } } } } }
    const { loadHostCatalog } = await import('../lib/host-catalog.js')
    const patches = createModelPatches(
      credentialContext,
      { settings, llm: { listModels: provider => ctx.llm.listModels(provider) } },
      async () => new Response(JSON.stringify({ models: listing }), { status: 200 }),
      { host: () => loadHostCatalog(credentialContext), clientVersion: async () => ({ value: '0.160.1', source: 'builtin' }) },
    )

    // Preview reads the real runtime listing and proposes only the missing,
    // visible entry — the hidden ones stay out.
    const view = await patches.preview()
    assert.deepEqual(view.added, ['gpt-6.1-sol'])
    assert.deepEqual(view.preserved, MODELS)
    assert.equal(writes.length, 0, 'preview writes nothing')

    await patches.apply(view.signature)

    // The composed entry keeps the capability fields the listing supplied.
    const written = writes[0]
    const added = written.find(entry => entry.id === 'gpt-6.1-sol')
    assert.ok(added, 'the target was written')
    assert.equal(added.contextWindow, 272000)
    assert.deepEqual(added.input, ['image', 'text'])
    assert.equal(added.reasoningEfforts.ultra, undefined, 'levels the host cannot represent are omitted')
    assert.equal(added.reasoningEfforts.max, 'max')
    // Every catalog model survives, in order, ahead of the addition.
    assert.deepEqual(written.slice(0, MODELS.length).map(entry => entry.id), MODELS)

    // And the runtime observes it without a restart.
    const after = (await ctx.llm.listModels('openai-codex')).map(m => m.id)
    assert.deepEqual(after, [...MODELS, 'gpt-6.1-sol'])
    const info = await ctx.llm.resolveModelInfo('openai-codex', 'gpt-6.1-sol')
    assert.equal(info.id, 'gpt-6.1-sol')
    // The real resolver reports the capability it resolved from the entry.
    assert.equal(info.context.contextWindow, 272000)
    assert.deepEqual(info.inputModalities, ['image', 'text'])
    // Negative control: the resolver is live, not a stub that answers anything.
    await assert.rejects(ctx.llm.resolveModelInfo('openai-codex', 'ghost-model'),
      (error) => error.code === 'UNKNOWN_MODEL')

    // Re-applying the same patch is idempotent: nothing left to add, no write.
    const second = await patches.preview()
    assert.deepEqual(second.added, [])
    assert.equal(writes.length, 1)

    const restore = await patches.restorePreview()
    assert.deepEqual(restore.removed, ['gpt-6.1-sol'])
    assert.equal((await patches.restore(restore.signature)).restored, true)
    assert.deepEqual((await ctx.llm.listModels('openai-codex')).map(model => model.id), MODELS)
    assert.equal(live['openai-codex'].reasoning, 'medium')
    assert.deepEqual(live['openai-codex'].models, [])
    await assert.rejects(ctx.llm.resolveModelInfo('openai-codex', 'gpt-6.1-sol'), error => error.code === 'UNKNOWN_MODEL')
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    hooks.deregister()
  }
})

test('the host schema rejects sections it cannot express, and a refused write is surfaced', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to run against an installed DSH.',
}, async () => {
  const hooks = hook()
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm')
  const piai = await import('@deepseek-ai/dsh-llm-pi-ai')
  const { Config } = piai
  const { createModelPatches } = await import('../lib/model-patches.js')

  // The adapter cannot resolve a reasoning level the host does not know, so a
  // configuration carrying one must not reach the profile.
  let live = { 'openai-codex': { reasoning: 'medium' } }
  const ctx = new Context()
  const fibers = [ctx.plugin(LlmRuntime)]
  try {
    await new Promise(done => setImmediate(done))
    fibers.push(ctx.plugin({ name: piai.name, inject: piai.inject, apply: piai.apply }, { providers: { get: () => live } }))
    await new Promise(done => setImmediate(done))
    await new Promise(done => setImmediate(done))

    // The schema is the host's own, so these refusals are the real contract a
    // composed patch has to satisfy — not a reimplementation of it.
    assert.throws(() => Config({ providers: { 'openai-codex': { models: [{ id: 'x', reasoningEfforts: { ultra: 'ultra' } }] } } }),
      /reasoningEfforts/, 'the host schema rejects the level pi-ai cannot express')
    assert.throws(() => Config({ providers: { 'openai-codex': { models: [{ id: 'x', input: ['audio'] }] } } }),
      /input/, 'and an unknown modality')

    // A settings service that refuses the write the way the host would. The
    // failure is the plugin's to report: it must not swallow it, retry, or
    // fall back to overwriting the profile behind the service.
    let revision = 1
    let attempts = 0
    const settings = {
      writable: true,
      describe() { return [{ ns: 'llm-pi-ai', revision, value: { providers: live }, user: { providers: live } }] },
      async mutate(_ns, ops) {
        attempts += 1
        // Validate first, then refuse: a write the host rejects is not applied,
        // so the profile keeps the catalogue it had.
        Config({ providers: { 'openai-codex': { ...live['openai-codex'], models: ops[0].value } } })
        throw new Error('SETTINGS_CONFLICT: the entry changed since the form was read')
      },
    }
    const patches = createModelPatches(
      { credentials: { async readRecord() { return { kind: 'grant', payload: { access: 'a', refresh: 'r', accountId: 'account-1', expires: Date.now() + 3_600_000 } } } } },
      { settings, llm: { listModels: provider => ctx.llm.listModels(provider) } },
      async () => new Response(JSON.stringify({ models: [remoteModel('gpt-6.1-sol')] }), { status: 200 }),
    )
    const view = await patches.preview()
    await assert.rejects(patches.apply(view.signature), /SETTINGS_CONFLICT/, 'the refusal reaches the caller')
    assert.equal(attempts, 1, 'a refused write is not retried')
    // The profile is left as the host left it; nothing was written around it.
    assert.deepEqual((await ctx.llm.listModels('openai-codex')).map(m => m.id), MODELS)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    hooks.deregister()
  }
})
