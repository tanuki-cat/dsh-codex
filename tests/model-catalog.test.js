import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeExtraModels, reasoningFor, withExtraModels } from '../src/model-catalog.js'
import { requestBody } from '../src/wire.js'

test('documented models advertise only their supported reasoning efforts', () => {
  const checks = [
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.5', ['none', 'low', 'medium', 'high', 'xhigh']],
  ]
  for (const [model, expected] of checks) {
    assert.deepEqual(reasoningFor(model).efforts.map(item => item.id), expected)
    assert.equal(reasoningFor(model).defaultEffort, undefined)
  }
  assert.equal(reasoningFor('unknown-model'), undefined)
})

test('selected strength reaches Responses reasoning.effort without changing an omitted selection', () => {
  const options = { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }
  assert.deepEqual(requestBody({ ...options, reasoningEffort: 'xhigh' }).reasoning, { effort: 'xhigh', summary: 'auto' })
  assert.equal(requestBody(options).reasoning, undefined)
})

test('manual model is visibly distinguished from account-listed models and deduplicated', () => {
  const listed = [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', inputModalities: ['text'] }]
  const combined = withExtraModels(listed, ['gpt-6.1-sol', 'gpt-5.6-sol'])
  assert.equal(combined.length, 2)
  assert.deepEqual(combined[0], listed[0])
  assert.equal(combined[1].id, 'gpt-6.1-sol')
  assert.equal(combined[1].manual, true)
  assert.match(combined[1].name, /manual; verify access/)
})

test('extra model IDs reject invalid configuration and remove duplicates', () => {
  assert.deepEqual(normalizeExtraModels(['gpt-6.1-sol', 'gpt-6.1-sol']), ['gpt-6.1-sol'])
  for (const value of [[''], ['gpt 6'], ['../secret'], ['a'.repeat(129)], 'gpt-6.1-sol']) {
    assert.throws(() => normalizeExtraModels(value))
  }
})
