import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') return { url: 'data:text/javascript,' + encodeURIComponent("export const credentialKey = (scope, id) => scope + '/' + id"), shortCircuit: true }
  return next(specifier, context)
} })
const { createModelPatches: createPatches, parseRemoteCatalog, fetchCodexCatalog } = await import('../lib/model-patches.js')
const createModelPatches = (ctx, services, fetcher, options = {}) => createPatches(ctx, services, fetcher, {
  host: async () => undefined,
  clientVersion: async () => ({ value: '0.160.1', source: 'builtin' }),
  wait: async () => {}, ...options,
})
hooks.deregister()

const model = (slug, other = {}) => ({ slug, display_name: slug, visibility: 'list', supported_in_api: false, context_window: 272000, input_modalities: ['text'], supported_reasoning_levels: [{ effort: 'medium' }], ...other })
const remote = (models) => async (_url, init) => {
  assert.match(init.headers.authorization, /^Bearer test-access$/)
  assert.equal(init.headers['chatgpt-account-id'], 'account-1')
  assert.equal(init.redirect, 'error')
  return new Response(JSON.stringify({ models }), { status: 200 })
}
function fixture({ models = [model('gpt-6-sol'), model('gpt-6.1-sol')], configured } = {}) {
  let revision = 3
  let route = configured ?? { reasoning: 'medium' }
  const settings = {
    writable: true,
    describe() { return [{ ns: 'llm-pi-ai', revision, value: { providers: { 'openai-codex': route } }, user: { providers: { 'openai-codex': route } } }] },
    async mutate(ns, ops, expected) {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expected, revision)
      assert.deepEqual(ops.map(x => x.path), [['providers', 'openai-codex', 'models']])
      route = { ...route, models: ops[0].value }; revision++
    },
    get route() { return route },
  }
  const llm = { async listModels() { return (route.models ?? [{ id: 'gpt-6-sol' }]).map(item => ({ id: item.id })) } }
  const ctx = { credentials: { async readRecord() { return { kind: 'grant', payload: { access: 'test-access', refresh: 'test-refresh', accountId: 'account-1', expires: Date.now() + 60000 } } } } }
  return { settings, llm, ctx, patches: createModelPatches(ctx, { settings, llm }, remote(models)) }
}

test('remote listing retains ChatGPT-only models and refuses duplicate identifiers', () => {
  assert.deepEqual(parseRemoteCatalog({ models: [model('gpt-6.1-sol')] }).entries.map(x => x.id), ['gpt-6.1-sol'])
  const fallback = parseRemoteCatalog({ models: [model('future', { context_window: null, max_context_window: 272000, input_modalities: undefined })] })
  assert.deepEqual(fallback.entries[0].input, ['text'])
  assert.equal(fallback.entries[0].contextWindow, 272000)
  const projected = parseRemoteCatalog({ models: [model('gpt-6.1-sol', { supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })) })] })
  assert.deepEqual(projected.limited, [{ id: 'gpt-6.1-sol', omittedEfforts: ['ultra'] }])
  assert.equal(projected.entries[0].reasoningEfforts.medium, 'medium')
  assert.equal(projected.entries[0].reasoningEfforts.ultra, undefined)
  assert.throws(() => parseRemoteCatalog({ models: [model('same'), model('same')] }), /duplicate/)
  assert.throws(() => parseRemoteCatalog({ models: [] }), /incomplete/)
})

test("the declared capacity is the model's own window, not the override ceiling", () => {
  // The live endpoint reports both; the window itself wins, exactly as
  // upstream's resolved_context_window() reads it.
  const live = parseRemoteCatalog({ models: [model('gpt-6.1-sol', { context_window: 272000, max_context_window: 872000 })] })
  assert.equal(live.entries[0].contextWindow, 272000)

  // A listing that omits the window falls back to the ceiling rather than
  // declaring nothing.
  const fallback = parseRemoteCatalog({ models: [model('gpt-6.1-sol', { context_window: null, max_context_window: 872000 })] })
  assert.equal(fallback.entries[0].contextWindow, 872000)

  // Neither present means the entry is unrepresentable, so it is dropped
  // rather than given an invented capacity.
  assert.throws(() => parseRemoteCatalog({ models: [model('solo', { context_window: null, max_context_window: undefined })] }), /no serviceable/)

  // A non-positive window does not displace the available ceiling.
  const zeroed = parseRemoteCatalog({ models: [model('zeroed', { context_window: 0, max_context_window: 872000 })] })
  assert.equal(zeroed.entries[0].contextWindow, 872000)
})

test('preview preserves existing catalog and adds only missing model after confirmation', async () => {
  const { patches, settings } = fixture()
  const view = await patches.preview()
  assert.deepEqual(view.added, ['gpt-6.1-sol'])
  assert.deepEqual(view.preserved, ['gpt-6-sol'])
  assert.equal(settings.route.models, undefined)
  await assert.rejects(patches.apply('0'.repeat(64)), /review/)
  assert.equal(settings.route.models, undefined)
  assert.deepEqual((await patches.apply(view.signature)).applied, ['gpt-6.1-sol'])
  assert.deepEqual(settings.route.models.map(item => item.id), ['gpt-6-sol', 'gpt-6.1-sol'])
  assert.deepEqual((await patches.preview()).added, [])
})

test('defaulted empty settings never discard the runtime catalog', async () => {
  const { ctx, settings } = fixture({ configured: { models: [] } })
  const llm = { async listModels() { return [{ id: 'gpt-6-sol' }, ...settings.route.models] } }
  const patches = createModelPatches(ctx, { settings, llm }, remote([model('gpt-6-sol'), model('gpt-6.1-sol')]))
  const view = await patches.preview()
  assert.deepEqual(view.preserved, ['gpt-6-sol'])
  await patches.apply(view.signature)
  assert.deepEqual(settings.route.models.map(x => x.id), ['gpt-6-sol', 'gpt-6.1-sol'])
})

test('preserves explicit model fields and refuses stale revisions', async () => {
  const original = { id: 'gpt-6-sol', contextWindow: 123456, input: ['text'] }
  const { patches, settings } = fixture({ configured: { reasoning: 'high', models: [original] } })
  const view = await patches.preview()
  await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [original] }], view.revision)
  await assert.rejects(patches.apply(view.signature), /review/)
  const next = await patches.preview()
  await patches.apply(next.signature)
  assert.deepEqual(settings.route.models[0], original)
  assert.equal(settings.route.reasoning, 'high')
})

test('remote failure never uses installed catalog as an authoritative substitute', async () => {
  const { ctx, settings, llm } = fixture()
  const patches = createModelPatches(ctx, { settings, llm }, async () => new Response('unauthorized', { status: 401 }))
  await assert.rejects(patches.preview(), /refused with HTTP 401/)
  const fallback = await patches.fallback()
  assert.deepEqual(fallback.preserved, ['gpt-6-sol'])
  assert.deepEqual(fallback.added, [])
  assert.equal(fallback.signature, '')
  assert.equal(settings.route.models, undefined)
})

test('remote catalog request rejects oversized responses without exposing credentials', async () => {
  await assert.rejects(fetchCodexCatalog('secret', 'account-1', async () => new Response('{}', { headers: { 'content-length': '4194305' } })), /size limit/)
  assert.throws(() => parseRemoteCatalog({ models: [model('not-listed', { visibility: 'none' })] }), /no serviceable/)
})

test('unavailable remote listing and unverified target never change settings', async () => {
  const { patches, settings } = fixture({ models: [model('gpt-6.1-sol', { context_window: null })] })
  const view = await patches.preview().catch(error => ({ error }))
  assert.ok(view.error || view.added.length === 0)
  assert.equal(settings.route.models, undefined)
})

test('a read-only settings service is refused before any listing or write', async () => {
  const { settings, ctx } = fixture()
  let listed = 0
  const guarded = createModelPatches(ctx, {
    settings: { ...settings, writable: false },
    llm: { async listModels() { listed += 1; return [{ id: 'gpt-6-sol' }] } },
  }, remote([model('gpt-6.1-sol')]))
  await assert.rejects(guarded.preview(), /read-only/)
  // The refusal is decided before the runtime listing, so no read or write happened.
  assert.equal(listed, 0)
  assert.equal(settings.route.models, undefined)
  // The read-only fallback still lists, and still proposes nothing.
  assert.deepEqual((await guarded.fallback()).added, [])
  assert.equal(listed, 1)
})

test('an undeclared openai-codex route is reported instead of created', async () => {
  const { patches, settings } = fixture({ configured: undefined })
  // describe() returns a namespace whose providers map has no openai-codex key.
  const bare = {
    ...settings,
    describe() { return [{ ns: 'llm-pi-ai', revision: 3, value: { providers: {} }, user: { providers: {} } }] },
  }
  const guarded = createModelPatches(
    { credentials: { async readRecord() { return { kind: 'grant', payload: { access: 'test-access', accountId: 'account-1', expires: Date.now() + 60000 } } } } },
    { settings: bare, llm: { async listModels() { return [] } } },
    remote([model('gpt-6.1-sol')]),
  )
  await assert.rejects(guarded.preview(), /Add the openai-codex route/)
  assert.deepEqual((await guarded.fallback()).added, [])
  assert.equal(settings.route.models, undefined)
})

test('every refusal carries the reason the page reports a remedy for', async () => {
  const reasons = async (run) => { try { await run(); return 'no-refusal' } catch (error) { return error.reason } }
  const { patches, settings, ctx } = fixture()
  const grant = { kind: 'grant', payload: { access: 'a', refresh: 'r', accountId: 'account-1', expires: Date.now() + 60_000 } }

  assert.equal(await reasons(() => createModelPatches(ctx, { settings: { ...settings, writable: false }, llm: { async listModels() { return [] } } }, remote([])).preview()), 'settings-read-only')
  // A route the settings section does not declare is distinct from a source failure.
  const bare = { ...settings, describe: () => [{ ns: 'llm-pi-ai', revision: 3, value: { providers: {} }, user: { providers: {} } }] }
  assert.equal(await reasons(() => createModelPatches(ctx, { settings: bare, llm: { async listModels() { return [] } } }, remote([])).preview()), 'route-missing')
  const withGrant = payload => ({ credentials: { async readRecord() { return payload === undefined ? undefined : { kind: 'grant', payload } } } })
  assert.equal(await reasons(() => createModelPatches(withGrant(undefined), { settings, llm: { async listModels() { return [] } } }, remote([])).preview()), 'sign-in-required')
  assert.equal(await reasons(() => createModelPatches(withGrant({ access: 'a', refresh: 'r', accountId: 'x', expires: Date.now() - 1 }), { settings, llm: { async listModels() { return [] } } }, remote([])).preview()), 'credential-expired')
  assert.equal(await reasons(() => createModelPatches(withGrant({ access: 'a', refresh: 'r', expires: Date.now() + 1000 }), { settings, llm: { async listModels() { return [] } } }, remote([])).preview()), 'credential-incomplete')
  // A transport failure and an HTTP refusal both report the source, not a crash.
  assert.equal(await reasons(() => createModelPatches(ctx, { settings, llm: { async listModels() { return [] } } }, async () => { throw new Error('socket hang up') }).preview()), 'source-unavailable')
  assert.equal(await reasons(() => createModelPatches(ctx, { settings, llm: { async listModels() { return [] } } }, async () => new Response('no', { status: 401 })).preview()), 'source-unavailable')
  assert.equal(await reasons(() => createModelPatches(ctx, { settings, llm: { async listModels() { return [] } } }, async () => new Response('{', { status: 200 })).preview()), 'source-unavailable')
  // An unmergeable section and a stale confirmation are the caller's to fix.
  assert.equal(await reasons(() => createModelPatches(ctx, { settings: { ...settings, describe: () => [{ ns: 'llm-pi-ai', revision: 3, value: { providers: { 'openai-codex': { models: 'nope' } } }, user: {} }] }, llm: { async listModels() { return [] } } }, remote([])).preview()), 'config-unmergeable')
  assert.equal(await reasons(() => patches.apply('f'.repeat(64))), 'conflict')
  assert.equal(await reasons(() => patches.apply('not-a-signature')), 'conflict')
})

test('a listing with an unexpected envelope is refused rather than half-read', () => {
  // An extra key means a page shape this parser does not fully read.
  assert.throws(() => parseRemoteCatalog({ models: [model('gpt-6.1-sol')], next_cursor: 'abc' }), /unexpected shape/)
  assert.doesNotThrow(() => parseRemoteCatalog({ models: [model('gpt-6.1-sol')] }))
  assert.throws(() => parseRemoteCatalog(null), /unexpected shape/)
  assert.throws(() => parseRemoteCatalog({ data: [] }), /unexpected shape/)
})

test('preview reports the account listing, its age, and the empty-state distinction', async () => {
  const { patches, settings } = fixture()
  const before = Date.now()
  const view = await patches.preview()
  assert.deepEqual(view.added, ['gpt-6.1-sol'])
  assert.deepEqual(view.alreadySelectable, ['gpt-6-sol'])
  assert.equal(view.current, 1)
  assert.equal(view.replacesCatalog, true, 'the page warns that explicit models take over')
  assert.equal(view.clientVersion, '0.160.1')
  assert.ok(view.fetchedAt >= before && view.fetchedAt <= Date.now(), 'the listing carries its fetch time')
  assert.equal(view.source, 'https://chatgpt.com/backend-api/codex/models', 'the source carries no query or credential')
  assert.ok(!view.source.includes('client_version'), 'no request parameter leaks into the reported source')

  // Nothing left to add is not the same report as a source that cannot be read.
  await patches.apply(view.signature)
  const settled = await patches.preview()
  assert.deepEqual(settled.added, [])
  assert.deepEqual(settled.alreadySelectable, ['gpt-6-sol', 'gpt-6.1-sol'])
  const unavailable = await patches.fallback('route-missing')
  assert.equal(unavailable.reason, 'route-missing')
  assert.equal(unavailable.replacesCatalog, false)
  assert.deepEqual(unavailable.unlisted, [])
})

test('a capacity below the source value is reported, never rewritten', async () => {
  // The profile declares less than the model's own window.
  const stale = { id: 'gpt-6.1-sol', contextWindow: 128000 }
  const settings = {
    writable: true,
    describe: () => [{ ns: 'llm-pi-ai', revision: 5, value: { providers: { 'openai-codex': { models: [stale] } } }, user: { providers: { 'openai-codex': { models: [stale] } } } }],
    async mutate() { throw new Error('an advisory must not write') },
  }
  const llm = { listModels: async () => [{ id: 'gpt-6.1-sol' }] }
  const patches = createModelPatches(
    { credentials: { async readRecord() { return { kind: 'grant', payload: { access: 'test-access', accountId: 'account-1', expires: Date.now() + 60_000 } } } } },
    { settings, llm },
    remote([model('gpt-6.1-sol', { context_window: 272000, max_context_window: 872000 })]),
  )
  const view = await patches.preview()
  assert.deepEqual(view.added, [], 'nothing to add: the model is already selectable')
  assert.deepEqual(view.understated, [{ id: 'gpt-6.1-sol', declared: 128000, source: 272000 }])

  // A value already at the source window is not flagged.
  const current = { id: 'gpt-6.1-sol', contextWindow: 272000 }
  const aligned = createModelPatches(
    { credentials: { async readRecord() { return { kind: 'grant', payload: { access: 'test-access', accountId: 'account-1', expires: Date.now() + 60_000 } } } } },
    { settings: { ...settings, describe: () => [{ ns: 'llm-pi-ai', revision: 5, value: { providers: { 'openai-codex': { models: [current] } } }, user: { providers: { 'openai-codex': { models: [current] } } } }] }, llm },
    remote([model('gpt-6.1-sol', { context_window: 272000, max_context_window: 872000 })]),
  )
  assert.deepEqual((await aligned.preview()).understated, [])

  // An entry without a declared capacity inherits the catalog, so it is not flagged.
  const inherited = createModelPatches(
    { credentials: { async readRecord() { return { kind: 'grant', payload: { access: 'test-access', accountId: 'account-1', expires: Date.now() + 60_000 } } } } },
    { settings: { ...settings, describe: () => [{ ns: 'llm-pi-ai', revision: 5, value: { providers: { 'openai-codex': { models: [{ id: 'gpt-6.1-sol' }] } } }, user: { providers: { 'openai-codex': { models: [{ id: 'gpt-6.1-sol' }] } } } }] }, llm },
    remote([model('gpt-6.1-sol', { context_window: 272000, max_context_window: 872000 })]),
  )
  assert.deepEqual((await inherited.preview()).understated, [])
})

test('a selectable model the source does not list is reported, not removed', async () => {
  // The runtime offers a model the account listing no longer carries.
  const { patches } = fixture({ models: [model('gpt-6.1-sol')] })
  const llm = { async listModels() { return [{ id: 'gpt-6-sol' }, { id: 'legacy-model' }] } }
  const settings = {
    writable: true,
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers: { 'openai-codex': { models: [{ id: 'gpt-6-sol' }, { id: 'legacy-model' }] } } }, user: { providers: { 'openai-codex': { models: [{ id: 'gpt-6-sol' }, { id: 'legacy-model' }] } } } }],
    async mutate() { throw new Error('must not write') },
  }
  // The shared `remote` double asserts the credential it was handed.
  const view = await createModelPatches(
    { credentials: { async readRecord() { return { kind: 'grant', payload: { access: 'test-access', accountId: 'account-1', expires: Date.now() + 60_000 } } } } },
    { settings, llm }, remote([model('gpt-6.1-sol')]),
  ).preview()
  // Both selectable models are absent from this one-entry listing, and both are
  // preserved: a model the source omits is reported, never dropped.
  assert.deepEqual(view.unlisted, ['gpt-6-sol', 'legacy-model'], 'every unlisted model is named')
  assert.deepEqual(view.preserved, ['gpt-6-sol', 'legacy-model'], 'and all of them are preserved')
  assert.deepEqual(view.added, ['gpt-6.1-sol'])
})

test('apply records what it added and the revisions it moved between', async () => {
  const { patches } = fixture()
  const view = await patches.preview()
  const result = await patches.apply(view.signature)
  assert.deepEqual(result.applied, ['gpt-6.1-sol'])
  assert.deepEqual(result.before.models, ['gpt-6-sol'])
  assert.equal(result.before.revision, view.revision)
  assert.ok(result.after.revision > result.before.revision, 'the write produced a new revision')
  assert.deepEqual(result.after.models, ['gpt-6-sol', 'gpt-6.1-sol'])
  assert.equal(result.clientVersion, '0.160.1')
  assert.ok(result.fetchedAt > 0)
  assert.deepEqual(result.alreadySelectable, ['gpt-6-sol', 'gpt-6.1-sol'])
})

test('a credential that is missing, expired or account-less never reaches the listing', async () => {
  const { settings, llm } = fixture()
  const payloads = [
    ['absent', undefined, /Sign in to ChatGPT/],
    ['expired', { access: 'a', refresh: 'r', accountId: 'account-1', expires: Date.now() - 1000 }, /refresh the expired credential/],
    ['account-less', { access: 'a', refresh: 'r', expires: Date.now() + 60000 }, /no account ID/],
  ]
  for (const [label, payload, expected] of payloads) {
    let fetched = false
    const guarded = createModelPatches(
      { credentials: { async readRecord() { return payload === undefined ? undefined : { kind: 'grant', payload } } } },
      { settings, llm },
      async () => { fetched = true; return new Response(JSON.stringify({ models: [model('gpt-6.1-sol')] }), { status: 200 }) },
    )
    await assert.rejects(guarded.preview(), expected, label)
    assert.equal(fetched, false, label)
    assert.equal(settings.route.models, undefined, label)
  }
})

test('remote and runtime traversal order do not invalidate a confirmation', async () => {
  const { ctx, settings } = fixture()
  let reverse = false
  const source = [model('a', { input_modalities: ['image', 'text'], supported_reasoning_levels: [{ effort: 'high' }, { effort: 'low' }, { effort: 'ultra' }, { effort: 'future' }] }), model('new')]
  const llm = { listModels: async () => settings.route.models ?? (reverse ? [{ id: 'b' }, { id: 'a' }] : [{ id: 'a' }, { id: 'b' }]) }
  const patches = createModelPatches(ctx, { settings, llm }, async () => {
    const values = reverse ? [...source].reverse().map(value => ({ ...value, input_modalities: [...value.input_modalities].reverse(), supported_reasoning_levels: [...value.supported_reasoning_levels].reverse() })) : source
    return new Response(JSON.stringify({ models: values }))
  })
  const preview = await patches.preview()
  reverse = true
  assert.equal((await patches.preview()).signature, preview.signature)
  assert.deepEqual((await patches.apply(preview.signature)).applied, ['new'])
})

test('a semantic catalog change still invalidates a confirmation', async () => {
  const { ctx, settings, llm } = fixture()
  let capacity = 272000
  const patches = createModelPatches(ctx, { settings, llm }, async () => new Response(JSON.stringify({ models: [model('new', { context_window: capacity })] })))
  const preview = await patches.preview()
  capacity++
  await assert.rejects(patches.apply(preview.signature), error => error.reason === 'conflict')
  assert.equal(settings.route.models, undefined)
})

test('refreshable expired credentials are refreshed and reread before catalog access', async () => {
  const { settings, llm } = fixture()
  let grant = { access: 'expired-access', refresh: 'r', accountId: 'old-account', expires: 1 }
  let refreshed = 0
  const ctx = { credentials: { readRecord: async () => ({ kind: 'grant', payload: grant }) } }
  const patches = createModelPatches(ctx, { settings, llm }, async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer new-access')
    assert.equal(init.headers['chatgpt-account-id'], 'new-account')
    return new Response(JSON.stringify({ models: [model('new')] }))
  }, { host: async () => ({ models: [], refreshCredential: async () => {
    refreshed++
    grant = { ...grant, access: 'new-access', accountId: 'new-account', expires: Date.now() + 60_000 }
  } }) })
  const preview = await patches.preview()
  assert.deepEqual(preview.added, ['new'])
  assert.equal(refreshed, 1)
  assert.ok(!JSON.stringify(preview).includes('new-access'))
})

test('refresh failure never fetches a catalog or exposes provider errors', async () => {
  const { settings, llm } = fixture()
  const ctx = { credentials: { readRecord: async () => ({ kind: 'grant', payload: { access: 'secret', refresh: 'secret-refresh', accountId: 'a', expires: 1 } }) } }
  let requests = 0
  const patches = createModelPatches(ctx, { settings, llm }, async () => { requests++; throw new Error('unexpected') }, {
    host: async () => ({ models: [], refreshCredential: async () => { throw new Error('secret-refresh') } }),
  })
  await assert.rejects(patches.preview(), error => error.reason === 'credential-expired' && !error.message.includes('secret'))
  assert.equal(requests, 0)
  assert.equal(settings.route.models, undefined)
})

test('registration confirmation observes delayed state without repeating the write', async () => {
  const { ctx, settings } = fixture()
  let refreshed = false, writes = 0
  const llm = { listModels: async () => refreshed ? settings.route.models : [{ id: 'gpt-6-sol' }] }
  const mutate = settings.mutate.bind(settings)
  settings.mutate = async (...args) => { writes++; await mutate(...args) }
  const delays = []
  const patches = createModelPatches(ctx, { settings, llm }, remote([model('new')]), {
    wait: async ms => { delays.push(ms); refreshed = true },
  })
  await patches.apply((await patches.preview()).signature)
  assert.equal(writes, 1)
  assert.deepEqual(delays, [100])
})

test('permanently unconfirmed registration is bounded and leaves a saved patch intact', async () => {
  const { ctx, settings } = fixture()
  const llm = { listModels: async () => [{ id: 'gpt-6-sol' }] }
  const delays = []
  const patches = createModelPatches(ctx, { settings, llm }, remote([model('new')]), { wait: async ms => { delays.push(ms) } })
  await assert.rejects(patches.apply((await patches.preview()).signature), error => error.reason === 'registration-unconfirmed')
  assert.deepEqual(delays, [100, 250, 500, 1000])
  assert.ok(settings.route.models.some(model => model.id === 'new'))
})

test('rechecking an explicit snapshot includes new native models without overwriting custom fields', async () => {
  const custom = { id: 'gpt-6-sol', contextWindow: 123456 }
  const { ctx, settings, llm } = fixture({ configured: { models: [custom], reasoning: 'medium' } })
  const patches = createModelPatches(ctx, { settings, llm }, remote([model('gpt-6-sol')]), {
    host: async () => ({ models: [{ id: 'gpt-6-sol' }, { id: 'native-new' }], refreshCredential: async () => {} }),
  })
  const preview = await patches.preview()
  assert.deepEqual(preview.nativeAdded, ['native-new'])
  await patches.apply(preview.signature)
  assert.deepEqual(settings.route.models, [custom, { id: 'native-new' }])
  assert.equal(settings.route.reasoning, 'medium')
})

test('restoring native defaults requires a separate preview and preserves other settings', async () => {
  const { ctx, settings } = fixture({ configured: { models: [{ id: 'gpt-6-sol', contextWindow: 123 }, { id: 'custom' }], reasoning: 'high' } })
  const llm = { listModels: async () => settings.route.models.length ? settings.route.models : [{ id: 'gpt-6-sol' }, { id: 'native-new' }] }
  const patches = createModelPatches(ctx, { settings, llm }, async () => { throw new Error('restoration must not require OAuth or network') }, {
    host: async () => ({ models: [{ id: 'gpt-6-sol' }, { id: 'native-new' }], refreshCredential: async () => { throw new Error('unexpected') } }),
  })
  const preview = await patches.restorePreview()
  assert.deepEqual(preview.removed, ['custom'])
  assert.deepEqual(preview.resets, ['gpt-6-sol', 'custom'])
  assert.equal(settings.route.models.length, 2)
  await assert.rejects(patches.restore('f'.repeat(64)), error => error.reason === 'conflict')
  const applied = await patches.restore(preview.signature)
  assert.equal(applied.restored, true)
  assert.deepEqual(applied.before.models, ['gpt-6-sol', 'custom'])
  assert.deepEqual(settings.route.models, [])
  assert.equal(settings.route.reasoning, 'high')
  assert.equal((await patches.restorePreview()).signature, '')
})

test('native restoration refuses absent catalogs, read-only settings and stale revisions', async () => {
  const { patches, settings, ctx, llm } = fixture({ configured: { models: [{ id: 'custom' }] } })
  await assert.rejects(patches.restorePreview(), error => error.reason === 'native-catalog-unavailable')
  const options = { host: async () => ({ models: [{ id: 'gpt-6-sol' }], refreshCredential: async () => {} }) }
  const guarded = createModelPatches(ctx, { settings: { ...settings, writable: false }, llm }, remote([]), options)
  await assert.rejects(guarded.restorePreview(), error => error.reason === 'settings-read-only')
  const restore = createModelPatches(ctx, { settings, llm }, remote([]), options)
  const preview = await restore.restorePreview()
  await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openai-codex', 'models'], value: [{ id: 'user-edit' }] }], preview.revision)
  await assert.rejects(restore.restore(preview.signature), error => error.reason === 'conflict')
  assert.deepEqual(settings.route.models, [{ id: 'user-edit' }])
})

test('output limits are mapped only when supplied and maximum context is kept diagnostic', async () => {
  const parsed = parseRemoteCatalog({ models: [model('new', { context_window: 272000, max_context_window: 872000, max_output_tokens: 12345 })] })
  assert.equal(parsed.entries[0].maxTokens, 12345)
  assert.deepEqual(parsed.windows, [{ id: 'new', contextWindow: 272000, maxContextWindow: 872000 }])
  const { patches } = fixture()
  const preview = await patches.preview()
  assert.equal(preview.capabilityStatus, 'catalog-only')
  assert.deepEqual(preview.inheritedOutputLimits, ['gpt-6.1-sol'])
  assert.equal((await patches.apply(preview.signature)).capabilityStatus, 'registered-only')
})

test('oversized explicit context is reported without overriding the user choice', async () => {
  const configured = { models: [{ id: 'gpt-6-sol', contextWindow: 872000 }] }
  const { patches, settings } = fixture({ configured })
  const preview = await patches.preview()
  assert.deepEqual(preview.overstated, [{ id: 'gpt-6-sol', declared: 872000, source: 272000 }])
  await patches.apply(preview.signature)
  assert.equal(settings.route.models[0].contextWindow, 872000)
})
