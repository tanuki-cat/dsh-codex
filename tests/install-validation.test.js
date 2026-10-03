import test from 'node:test'
import assert from 'node:assert/strict'
import { captureSchemaBaseline, validateInstalledSchema } from '../scripts/install-validation.mjs'

const plugin = { id: 'llm-chatgpt', name: 'dsh-llm-chatgpt', path: '/10', status: 'absent' }
const prior = { id: 'ui-chat', name: 'existing-ui', path: '/0', status: 'partial' }
const warning = { level: 'warning', path: '/0', message: 'Existing schema projection limitation' }
function result(complete, entries = [], diagnostics = []) {
  return { status: complete ? 0 : 1, stdout: JSON.stringify({ 'x-cordis': { complete, entries, diagnostics } }) }
}

test('existing partial profile schema does not reject a successfully imported plugin', () => {
  const baseline = captureSchemaBaseline(result(false, [prior], [warning]))
  assert.deepEqual(validateInstalledSchema(baseline, result(false, [prior, plugin], [warning])), {
    complete: false, pluginStatus: 'absent',
  })
})

test('complete baseline accepts a complete schema with the plugin', () => {
  assert.equal(validateInstalledSchema(captureSchemaBaseline(result(true)), result(true, [plugin])).complete, true)
})

test('plugin import failure, unsupported schema and duplicate entry still reject installation', () => {
  const baseline = captureSchemaBaseline(result(false, [prior], [warning]))
  for (const entries of [[prior], [prior, { ...plugin, status: 'error' }], [prior, { ...plugin, status: 'unsupported' }], [prior, plugin, plugin]]) {
    assert.throws(() => validateInstalledSchema(baseline, result(false, entries, [warning])), /模块未成功/)
  }
})

test('new diagnostics and new incomplete entries cannot be hidden by an incomplete baseline', () => {
  const baseline = captureSchemaBaseline(result(false, [prior], [warning]))
  assert.throws(() => validateInstalledSchema(baseline, result(false, [prior, plugin], [warning, { level: 'error', path: '/10', message: 'Failed to import' }])), /新增/)
  assert.throws(() => validateInstalledSchema(baseline, result(false, [prior, plugin, { ...prior, path: '/11' }], [warning])), /新增/)
  assert.throws(() => validateInstalledSchema(baseline, result(false, [prior, plugin], [warning, warning])), /新增/)
})

test('non-JSON output, invalid exit status and unexplained incompleteness reject validation', () => {
  for (const check of [{ status: 1, stdout: 'EPERM' }, { status: 2, stdout: '{}' }, { status: 0, stdout: '{}' }, { error: new Error('failed') }]) {
    assert.throws(() => captureSchemaBaseline(check))
  }
  assert.throws(() => validateInstalledSchema(captureSchemaBaseline(result(true)), result(false, [plugin])), /不能用已有/)
})
