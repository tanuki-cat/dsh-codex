import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') return { url: 'data:text/javascript,' + encodeURIComponent("export const credentialKey = (scope, id) => scope + '/' + id"), shortCircuit: true }
  return next(specifier, context)
} })
const { createModelPatches, parseRemoteCatalog, fetchCodexCatalog } = await import('../lib/model-patches.js')
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

test('preview preserves existing catalog and adds only missing model after confirmation', async () => {
  const { patches, settings } = fixture()
  const view = await patches.preview()
  assert.deepEqual(view.added, ['gpt-6.1-sol'])
  assert.deepEqual(view.preserved, ['gpt-6-sol'])
  assert.equal(settings.route.models, undefined)
  await assert.rejects(patches.apply('0'.repeat(64)), /review/)
  assert.equal(settings.route.models, undefined)
  assert.deepEqual(await patches.apply(view.signature), { applied: ['gpt-6.1-sol'] })
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
  await assert.rejects(patches.preview(), /unavailable/)
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
