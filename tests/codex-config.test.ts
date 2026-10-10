import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadCodexVersionConfig, getCodexClientVersion } from '../lib/codex-config.js'

test('builtin version comes from independently shipped JSON', () => {
  assert.equal(getCodexClientVersion(), '0.162.1')
})

test('bounded configuration validation captures failures rather than rejecting module import', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const url = pathToFileURL(join(root, 'codex.json'))
  for (const input of [
    '{', 'null', '[]', '{}', '{"codexClientVersion":1}',
    JSON.stringify({ codexClientVersion: '1.2.3', extra: true }),
    JSON.stringify({ codexClientVersion: '1.2.3?private-secret' }),
    JSON.stringify({ codexClientVersion: '1.2.3-' + 'x'.repeat(64) }),
    JSON.stringify({ codexClientVersion: '1.2.3' }) + ' '.repeat(4096),
  ]) {
    await writeFile(url, input)
    const config = loadCodexVersionConfig(url)
    assert.ok('error' in config)
    assert.equal(config.error.reason, 'version-config-invalid')
    assert.match(config.error.message, /codex.json.*restart DSH/)
    assert.doesNotMatch(config.error.message, /private-secret/)
    assert.throws(() => getCodexClientVersion(config), { reason: 'version-config-invalid' })
  }
  await rm(url)
  assert.ok('error' in loadCodexVersionConfig(url))
  await mkdir(url)
  assert.ok('error' in loadCodexVersionConfig(url))
  await rm(url, { recursive: true })
  for (const version of ['3.2.1', '3.2.1-beta.2']) {
    await writeFile(url, JSON.stringify({ codexClientVersion: version }))
    assert.deepEqual(loadCodexVersionConfig(url), { version })
  }
})
