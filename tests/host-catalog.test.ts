import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-credentials') return { url: 'data:text/javascript,' + encodeURIComponent("export const credentialKey = (scope, id) => scope + '/' + id"), shortCircuit: true }
  return next(specifier, context)
} })
const { bindHostCatalog, resolveClientVersion, CODEX_CLIENT_VERSION } = await import('../lib/host-catalog.js')
hooks.deregister()

test('client version uses a validated override, CLI version, then the tested fallback', async () => {
  let probes = 0
  const probe = async () => { probes++; return 'codex-cli 1.2.3\n' }
  assert.deepEqual(await resolveClientVersion('2.3.4', probe), { value: '2.3.4', source: 'environment' })
  assert.equal(probes, 0)
  assert.deepEqual(await resolveClientVersion(null, probe), { value: '1.2.3', source: 'codex-cli' })
  assert.deepEqual(await resolveClientVersion(null, async () => 'codex 3.4.5-beta.1'), { value: '3.4.5-beta.1', source: 'codex-cli' })
  assert.deepEqual(await resolveClientVersion(null, async () => { throw new Error('ENOENT') }), { value: CODEX_CLIENT_VERSION, source: 'builtin' })
  assert.deepEqual(await resolveClientVersion(null, async () => 'garbage'), { value: CODEX_CLIENT_VERSION, source: 'builtin' })
  await assert.rejects(resolveClientVersion('1.2.3?account=secret', probe), /semantic version/)
})

test('provider auth refresh uses serialized record modification and cannot double-rotate', async () => {
  let record = { kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 } }
  let tail = Promise.resolve(), rotations = 0, modifications = 0
  let started, release
  const entered = new Promise(resolve => { started = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  const ctx = { credentials: {
    readRecord: async () => record,
    async modifyRecord(key, fn) {
      assert.equal(key, 'llm-pi-ai/openai-codex')
      modifications++
      const result = tail.then(async () => { const next = await fn(record); if (next) record = next; return record })
      tail = result.then(() => {}, () => {})
      return result
    },
    deleteRecord: async () => { record = undefined },
  } }
  const pi = { createModels({ credentials }) { return {
    setProvider() {},
    async getAuth(id, options) {
      assert.equal(id, 'openai-codex')
      assert.equal(options.signal.aborted, false)
      await credentials.modify(id, async current => {
        if (current.expires > Date.now()) return undefined
        rotations++; started(); await barrier
        return { ...current, access: 'new', refresh: 'rotated', expires: Date.now() + 60_000 }
      })
      return { auth: { apiKey: (await credentials.read(id)).access } }
    },
  } } }
  const first = bindHostCatalog(ctx, pi, { getModels: () => [{ id: 'native' }] })
  const second = bindHostCatalog(ctx, pi, { getModels: () => [{ id: 'native' }] })
  const a = first.refreshCredential()
  await entered
  const b = second.refreshCredential()
  assert.equal(modifications, 2, 'both operations reached the same store before release')
  release()
  await Promise.all([a, b])
  assert.equal(rotations, 1)
  assert.equal(record.payload.refresh, 'rotated')
  assert.deepEqual(first.models, [{ id: 'native' }])
})

test('a provider refresh rejection preserves the stored record', async () => {
  const record = { kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'r', expires: 1 } }
  let committed = false
  const ctx = { credentials: {
    readRecord: async () => record,
    modifyRecord: async (_key, fn) => { const next = await fn(record); committed = next !== undefined; return next ?? record },
    deleteRecord: async () => {},
  } }
  const pi = { createModels({ credentials }) { return {
    setProvider() {}, getAuth: async id => credentials.modify(id, async () => { throw new Error('provider failure') }),
  } } }
  const host = bindHostCatalog(ctx, pi, { getModels: () => [] })
  await assert.rejects(host.refreshCredential(), /provider failure/)
  assert.equal(committed, false)
  assert.equal(record.payload.refresh, 'r')
})
