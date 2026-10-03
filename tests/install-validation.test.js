import test from 'node:test'
import assert from 'node:assert/strict'
import { captureSchemaBaseline, validateInstalledSchema } from '../scripts/install-validation.mjs'

// The plugin declares no profile entry, so a healthy install shows no entry
// under its id at all; a broken import is what would produce one.
const absent = { id: 'llm-chatgpt', name: 'dsh-llm-chatgpt', path: '/10', status: 'absent' }
const broken = { id: 'llm-chatgpt', name: 'dsh-llm-chatgpt', path: '/10', status: 'error' }
const prior = { id: 'ui-chat', name: 'existing-ui', path: '/0', status: 'partial' }
const warning = { level: 'warning', path: '/0', message: 'Existing schema projection limitation' }
function result(complete, entries = [], diagnostics = []) {
  return { status: complete ? 0 : 1, stdout: JSON.stringify({ 'x-cordis': { complete, entries, diagnostics } }) }
}

test('existing partial profile schema does not reject a successfully imported plugin', () => {
  const baseline = captureSchemaBaseline(result(false, [prior], [warning]))
  // Neither an entry nor a diagnostic mentions the plugin: its module imported
  // without declaring a schema, which is the expected shape.
  assert.deepEqual(validateInstalledSchema(baseline, result(false, [prior], [warning])), { complete: false })
})

test('complete baseline accepts a complete schema', () => {
  assert.equal(validateInstalledSchema(captureSchemaBaseline(result(true)), result(true)).complete, true)
})

test('an entry the plugin owns that failed to import rejects installation', () => {
  const baseline = captureSchemaBaseline(result(false, [prior], [warning]))
  for (const entries of [[prior, broken], [prior, { ...broken, status: 'partial' }], [prior, { ...broken, status: 'unsupported' }]]) {
    assert.throws(() => validateInstalledSchema(baseline, result(false, entries, [warning])), /模块未成功/)
  }
})

test('new diagnostics and new incomplete entries cannot be hidden by an incomplete baseline', () => {
  const baseline = captureSchemaBaseline(result(false, [prior], [warning]))
  assert.throws(() => validateInstalledSchema(baseline, result(false, [prior, absent], [warning, { level: 'error', path: '/10', message: 'Failed to import' }])), /新增/)
  assert.throws(() => validateInstalledSchema(baseline, result(false, [prior, { ...prior, path: '/11' }], [warning])), /新增/)
  assert.throws(() => validateInstalledSchema(baseline, result(false, [prior], [warning, warning])), /新增/)
})

test('non-JSON output, invalid exit status and unexplained incompleteness reject validation', () => {
  for (const check of [{ status: 1, stdout: 'EPERM' }, { status: 2, stdout: '{}' }, { status: 0, stdout: '{}' }, { error: new Error('failed') }]) {
    assert.throws(() => captureSchemaBaseline(check))
  }
  // A complete baseline cannot explain an incomplete result that reports no
  // issue at all, since there is no existing diagnostic to attribute it to.
  assert.throws(() => validateInstalledSchema(captureSchemaBaseline(result(true)), result(false, [])), /不能用已有/)
})
