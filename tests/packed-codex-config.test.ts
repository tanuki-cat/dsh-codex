import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const project = dirname(dirname(fileURLToPath(import.meta.url)))

test('tarball includes standalone config, survives bad config, and reads changes after process restart', { timeout: 120_000, skip: process.env.DSH_PACK_TEST !== '1' ? 'Run standalone with DSH_PACK_TEST=1 to avoid shared build races.' : false }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-pack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packed = await exec('npm', ['pack', '--json', '--cache', join(root, 'cache'), '--pack-destination', root], { cwd: project, timeout: 90_000, maxBuffer: 1024 * 1024 })
  const records = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[\n')))
  const pack = records[0]
  assert.ok(pack.files.some(file => file.path === 'config/codex.json'))
  await exec('tar', ['-xzf', join(root, pack.filename), '-C', root], { timeout: 10_000 })
  const directory = join(root, 'package'), config = join(directory, 'config', 'codex.json')
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { codexClientVersion: '0.162.1' })
  const probe = async expected => {
    const result = await exec(process.execPath, [join(project, 'tests', 'packed-config-probe.mjs'), directory, project, expected], { cwd: root, timeout: 20_000, maxBuffer: 1024 * 1024 })
    assert.ok(result.stdout.includes('"expected":"' + expected + '"'), result.stdout + result.stderr)
  }
  await probe('0.162.1')
  await writeFile(config, '{"codexClientVersion":"7.8.9"}')
  await probe('7.8.9')
  await writeFile(config, '{"codexClientVersion":"private-invalid-value"}')
  await probe('invalid')
  await rm(config)
  await probe('invalid')
})
