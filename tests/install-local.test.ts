import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const installer = fileURLToPath(new URL('../scripts/install-local.ts', import.meta.url))
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const tarballName = 'dsh-llm-chatgpt-' + version + '.tgz'
const ownedEntries = patch => (patch.match(/^\s*-?\s*id: llm-chatgpt\s*$/gm) ?? []).length

/** Stand-in tarballs this run created; removed when the process exits. */
const stagedByTest = new Set()
process.on('exit', () => { for (const file of stagedByTest) rmSync(file, { force: true }) })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-chatgpt-install-test-'))
  const bin = join(home, 'bin')
  const profile = join(home, 'profiles/web')
  mkdirSync(bin, { mode: 0o700 })
  mkdirSync(join(profile, 'node_modules/dsh-llm-chatgpt'), { recursive: true, mode: 0o700 })
  const manifest = '{"name":"existing-profile","dependencies":{"unrelated-plugin":"1.0.0"}}\n'
  writeFileSync(join(profile, 'package.json'), manifest)
  writeFileSync(join(profile, 'node_modules/dsh-llm-chatgpt/package.json'), JSON.stringify({ version }))
  const original = '- insert:\n    - id: prior-plugin\n      name: prior-plugin\n      config:\n        value: TEST_PRIVATE_VALUE\n'
  writeFileSync(join(profile, 'cordis.patch.yml'), original)
  copyFileSync(new URL('./fixtures/dsh-install-cli.ts', import.meta.url), join(bin, 'dsh'))
  chmodSync(join(bin, 'dsh'), 0o700)
  // The installer resolves its input as <project>/dsh-llm-chatgpt-<version>.tgz,
  // so a test of its own logic would otherwise depend on npm pack having run —
  // failing the moment the version is bumped, for reasons unrelated to what it
  // asserts. A stand-in is staged on first use; a real tarball is left alone.
  const tarball = join(project, tarballName)
  let staged = false
  const stage = () => {
    if (staged) return
    staged = true
    if (existsSync(tarball)) return
    writeFileSync(tarball, 'fixture tarball')
    stagedByTest.add(tarball)
  }
  const run = (extra = {}, args = []) => {
    stage()
    return spawnSync(process.execPath, [installer, ...args], {
      encoding: 'utf8', env: { ...process.env, DSH_HOME: home, PATH: bin + ':' + process.env.PATH, ...extra },
    })
  }
  return { profile, original, manifest, run }
}

test('installer enables an already-installed plugin despite pre-existing schema issues and remains idempotent', () => {
  const current = fixture()
  const first = current.run()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /跳过重复安装/)
  assert.match(first.stdout, /原有 profile 的 schema 导出仍不完整/)
  assert.doesNotMatch(first.stdout + first.stderr, /TEST_PRIVATE_VALUE/)
  const patch = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch, current.original)
  assert.equal(current.run().status, 0)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), patch)
  assert.equal(readFileSync(join(current.profile, 'package.json'), 'utf8'), current.manifest)
})

test('a failed plugin import rejects the install and leaves the patch alone', () => {
  const current = fixture()
  const failed = current.run({ TEST_SCHEMA_PLUGIN_ERROR: '1' })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /模块未成功/)
  // This profile carried no plugin entry, so nothing was written and nothing
  // needed restoring.
  assert.match(failed.stderr, /原有配置未改动/)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), current.original)
  assert.doesNotMatch(failed.stdout + failed.stderr, /TEST_PRIVATE_VALUE/)
})

test('a failed import also restores a patch the installer had rewritten', () => {
  const current = fixture()
  const legacy = current.original + '\n- id: llm-chatgpt\n  name: dsh-llm-chatgpt\n  config:\n    provider: chatgpt-plan\n'
  writeFileSync(join(current.profile, 'cordis.patch.yml'), legacy)
  const failed = current.run({ TEST_SCHEMA_PLUGIN_ERROR: '1' })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /已恢复安装前的 patch/)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), legacy)
})

test('installer removes the provider entry earlier versions declared', () => {
  const current = fixture()
  // What 0.2.x wrote: an insert block declaring the chatgpt-plan route.
  const legacy = current.original
    + '\n- insert:\n    # Legacy entry removed with its now-empty wrapper.\n\n    - id: llm-chatgpt\n      name: dsh-llm-chatgpt\n      config:\n        provider: chatgpt-plan\n'
    + '\n- id: llm-chatgpt\n  name: dsh-llm-chatgpt\n  config:\n    proxyUrl: "http://127.0.0.1:7890"\n    extraModels: ["gpt-6.1-sol"]\n'
  writeFileSync(join(current.profile, 'cordis.patch.yml'), legacy)
  const result = current.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /已移除 2 个 llm-chatgpt 配置项/)
  const configured = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  // Only the unrelated plugin survives — its own insert wrapper is the one the
  // fixture shipped, so the count stays at one.
  assert.equal(configured, current.original)
  assert.equal(ownedEntries(configured), 0)
  assert.equal((configured.match(/^- insert:$/gm) ?? []).length, 1)
  assert.doesNotMatch(configured, /chatgpt-plan|proxyUrl|extraModels/)
  assert.equal(current.run().status, 0)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), configured)
})

test('installer removes reordered owned entries without deleting nested matching ids', () => {
  const current = fixture()
  const legacy = [
    '- insert:',
    '    - name: dsh-llm-chatgpt',
    '      id: "llm-chatgpt"',
    '      config:',
    '        provider: chatgpt-plan',
    '    - id: unrelated-child',
    '      config:',
    '        metadata:',
    '          id: llm-chatgpt',
    '- name: dsh-llm-chatgpt',
    "  id: 'llm-chatgpt'",
    '  config:',
    '    provider: chatgpt-plan',
    '- id: unrelated-top-level',
    '  config:',
    '    id: llm-chatgpt',
    '',
  ].join('\n')
  writeFileSync(join(current.profile, 'cordis.patch.yml'), legacy)
  const result = current.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /已移除 2 个 llm-chatgpt 配置项/)
  const configured = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  assert.doesNotMatch(configured, /dsh-llm-chatgpt|chatgpt-plan/)
  assert.match(configured, /id: unrelated-child/)
  assert.match(configured, /id: unrelated-top-level/)
  assert.equal((configured.match(/id: llm-chatgpt/g) ?? []).length, 2)
})

test('installer leaves a profile with no plugin entry untouched', () => {
  const current = fixture()
  const before = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  const result = current.run()
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /已移除/)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), before)
})
test('installer accepts every declared host generation and refuses an undeclared one', () => {
  const versions = ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2']
  for (const runtime of versions) {
    const current = fixture()
    const result = current.run({ TEST_DSH_VERSION: runtime })
    assert.equal(result.status, 0, runtime + ': ' + result.stderr)
    assert.doesNotMatch(result.stderr, /插件未声明支持本机 DSH/)
  }
  const unverified = fixture()
  const refused = unverified.run({ TEST_DSH_VERSION: '0.3.0-alpha.1' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /插件未声明支持本机 DSH 0\.3\.0-alpha\.1/)
})
