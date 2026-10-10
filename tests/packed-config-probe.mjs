import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const [directory, project, expected] = process.argv.slice(2)
const require = createRequire(join(project, 'package.json'))
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/') || specifier === 'import-meta-resolve') return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
  return next(specifier, context)
} })
try {
  const load = name => import(pathToFileURL(join(directory, 'lib', name + '.js')).href)
  const { resolveClientVersion } = await load('host-catalog')
  const { getCodexClientVersion } = await load('codex-config')
  const { apply } = await load('index')
  const { createModelPatches } = await load('model-patches')
  const { createCodexManagement } = await load('management')
  const { createUsageService } = await load('usage')
  const { createImageService } = await load('image-service')
  const { createInitCommand } = await load('init-command')
  const { CODEX_KEY } = await load('codex')
  const definitions = new Map(), cleanups = []
  let record, credentialReads = 0, loginStarts = 0
  const ctx = {
    credentials: { async readRecord() { credentialReads++; return record }, async deleteRecord() { record = undefined } },
    authorization: { describe() { return { methods: [{ id: 'oauth' }] } }, async begin() { loginStarts++; return { status: 'authorized' } }, async cancel() {} },
    effect(fn) { cleanups.push(fn()) },
    inject(deps, callback) {
      if (deps[0] === 'commands') callback({ effect: this.effect.bind(this), commands: { register(value) { definitions.set(value.name, value); return () => definitions.delete(value.name) } } })
    },
  }
  apply(ctx)
  assert.deepEqual([...definitions.keys()], ['usage', 'init'])
  assert.match((await definitions.get('usage').handler({ rawInput: '', signal: new AbortController().signal })).text, /未登录/)
  const messages = []
  assert.equal((await createInitCommand(async () => input => input)({ rawInput: '', signal: new AbortController().signal, agent: { followup(message) { messages.push(message) } } })).kind, 'success')
  assert.equal(messages.length, 1)
  const usage = createUsageService(ctx)
  assert.equal((await usage.get()).reason, 'sign-in-required'); usage.dispose()
  assert.ok(createImageService(ctx))
  const manager = createCodexManagement(ctx)
  assert.equal((await manager.status()).available, true)
  await manager.start(); assert.equal(loginStarts, 1); await manager.cancel(); await manager.dispose()
  if (expected !== 'invalid') {
    assert.equal(getCodexClientVersion(), expected)
    assert.deepEqual(await resolveClientVersion(null, async () => { throw new Error('CLI absent') }), { value: expected, source: 'builtin' })
    assert.equal((await resolveClientVersion('9.8.7', async () => assert.fail())).value, '9.8.7')
  } else {
    assert.throws(() => getCodexClientVersion(), { reason: 'version-config-invalid' })
    await assert.rejects(resolveClientVersion('9.8.7', async () => assert.fail()), { reason: 'version-config-invalid' })
    const settings = { writable: true, describe() { return [{ ns: 'llm-pi-ai', revision: 0, value: { providers: { 'openai-codex': { models: [] } } } }] }, async mutate() { assert.fail('no setting mutation') } }
    const llm = { async listModels() { return [] } }
    const patches = createModelPatches(ctx, { settings, llm }, async () => assert.fail('no remote request'), { host: async () => ({ models: [{ id: 'native' }] }) })
    const before = credentialReads
    await assert.rejects(patches.preview(), { reason: 'version-config-invalid' })
    await assert.rejects(patches.apply('a'.repeat(64)), { reason: 'version-config-invalid' })
    assert.equal(credentialReads, before)
    assert.ok(await patches.restorePreview())
  }
  for (const cleanup of cleanups.reverse()) await cleanup()
  console.log(JSON.stringify({ expected, commands: ['usage', 'init'], imported: true }))
} finally { hooks.deregister() }
