import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../scripts/install-local.mjs', import.meta.url))
const countEntries = patch => (patch.match(/^\s*-?\s*id: llm-chatgpt\s*$/gm) ?? []).length
const entryBlock = patch => {
  const lines = patch.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== '- insert:') continue
    let end = index + 1
    while (end < lines.length && !/^\S/.test(lines[end])) end += 1
    const block = lines.slice(index, end).join('\n')
    if (/^\s*-?\s*id: llm-chatgpt\s*$/m.test(block)) return block
  }
  return ''
}
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
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
  copyFileSync(new URL('./fixtures/dsh-install-cli.mjs', import.meta.url), join(bin, 'dsh'))
  chmodSync(join(bin, 'dsh'), 0o700)
  const run = (extra = {}, args = []) => spawnSync(process.execPath, [installer, ...args], {
    encoding: 'utf8', env: { ...process.env, DSH_HOME: home, PATH: `${bin}:${process.env.PATH}`, ...extra },
  })
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
  assert.ok(patch.startsWith(current.original))
  assert.equal(current.run().status, 0)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), patch)
  assert.equal(readFileSync(join(current.profile, 'package.json'), 'utf8'), current.manifest)
})

test('installer restores the original patch when the target plugin fails to import', () => {
  const current = fixture()
  const failed = current.run({ TEST_SCHEMA_PLUGIN_ERROR: '1' })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /已恢复安装前的 patch/)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), current.original)
  assert.doesNotMatch(failed.stdout + failed.stderr, /TEST_PRIVATE_VALUE/)
})

test('installer merges a proxy override without duplicating it on repeated runs', () => {
  const current = fixture()
  const args = ['--proxy', '127.0.0.1:7890']
  assert.equal(current.run({}, args).status, 0)
  const configured = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  assert.match(configured, /proxyUrl: "http:\/\/127.0.0.1:7890"/)
  assert.equal(current.run({}, args).status, 0)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), configured)
  assert.equal(current.run({ TEST_SCHEMA_PLUGIN_ERROR: '1' }, ['--proxy', '127.0.0.1:7891']).status, 1)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), configured)
})

test('installer adds one explicitly named model while preserving the proxy', () => {
  const current = fixture()
  const args = ['--proxy', '127.0.0.1:7890', '--model', 'gpt-6.1-sol']
  assert.equal(current.run({}, args).status, 0)
  const configured = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  assert.match(configured, /proxyUrl: "http:\/\/127\.0\.0\.1:7890"/)
  assert.match(configured, /extraModels: \["gpt-6\.1-sol"\]/)
  assert.equal(current.run({}, args).status, 0)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), configured)
})

test('installer enables the plugin once and keeps every entry inside one insert block', () => {
  const current = fixture()
  const args = ['--proxy', '127.0.0.1:7890', '--model', 'gpt-6.1-sol']
  assert.equal(current.run({}, args).status, 0)
  const configured = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(countEntries(configured), 1)
  assert.equal((configured.match(/^- insert:$/gm) ?? []).length, 2)
  const tuned = entryBlock(configured)
  assert.match(tuned, /proxyUrl: "http:\/\/127\.0\.0\.1:7890"/)
  assert.match(tuned, /extraModels: \["gpt-6\.1-sol"\]/)
  assert.ok(tuned.startsWith('- insert:\n    - id: llm-chatgpt\n'))
  assert.doesNotMatch(configured, /^# Merge these rows/m)
  assert.doesNotMatch(configured, /TEST_PRIVATE_VALUE\n- id: llm-chatgpt/)
})

test('installer collapses repeatedly appended entries into one and keeps their settings', () => {
  const current = fixture()
  const stacked = current.original
    + '\n- id: llm-chatgpt\n  name: dsh-llm-chatgpt\n  config:\n    proxyUrl: "http://127.0.0.1:7890"\n'
    + '\n- id: llm-chatgpt\n  name: dsh-llm-chatgpt\n  config:\n    proxyUrl: "http://127.0.0.1:7890"\n    extraModels: [ "gpt-6.1-sol" ]\n'
    + '\n- insert:\n    - id: llm-chatgpt\n      name: dsh-llm-chatgpt\n      config:\n        provider: chatgpt-plan\n\n'
    + '- id: llm-chatgpt\n  name: dsh-llm-chatgpt\n  config:\n    proxyUrl: "http://127.0.0.1:7890"\n    extraModels: ["gpt-6.1-sol"]\n'
  writeFileSync(join(current.profile, 'cordis.patch.yml'), stacked)
  const result = current.run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /检测到 4 个重复的 llm-chatgpt 条目/)
  const configured = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(countEntries(configured), 1)
  assert.ok(configured.startsWith(current.original))
  assert.match(entryBlock(configured), /provider: chatgpt-plan/)
  assert.match(entryBlock(configured), /proxyUrl: "http:\/\/127\.0\.0\.1:7890"/)
  assert.match(entryBlock(configured), /extraModels: \["gpt-6\.1-sol"\]/)
  assert.doesNotMatch(configured, /extraModels: \[ "gpt-6\.1-sol" \]/)
  assert.equal(current.run().status, 0)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), configured)
})

test('installer accumulates explicit models across runs without dropping earlier ones', () => {
  const current = fixture()
  assert.equal(current.run({}, ['--model', 'gpt-6.1-sol']).status, 0)
  assert.equal(current.run({}, ['--model', 'gpt-6-astra']).status, 0)
  const configured = readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8')
  assert.equal(countEntries(configured), 1)
  assert.match(entryBlock(configured), /extraModels: \["gpt-6\.1-sol","gpt-6-astra"\]/)
  assert.equal(current.run({}, ['--model', 'gpt-6-astra']).status, 0)
  assert.equal(readFileSync(join(current.profile, 'cordis.patch.yml'), 'utf8'), configured)
})
