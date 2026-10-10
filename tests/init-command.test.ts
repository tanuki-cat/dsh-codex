import test from 'node:test'
import assert from 'node:assert/strict'
import { createInitCommand, registerInitCommand } from '../lib/init-command.js'
import { INIT_PROMPT } from '../lib/init-prompt.js'

const makeMessage = input => ({ ...input, id: 'test-message' })
const invocation = () => {
  const messages = [], controller = new AbortController()
  return { messages, controller, input: { rawInput: '', signal: controller.signal, agent: { followup(message) { messages.push(message) } } } }
}

test('init submits one task notice follow-up with full instructions, without claiming a file was generated', async () => {
  const f = invocation()
  const result = await createInitCommand(async () => makeMessage)(f.input)
  assert.equal(result.kind, 'success'); assert.match(result.text, /已提交/)
  assert.doesNotMatch(result.text, /已生成|已创建/)
  assert.equal(f.messages.length, 1)
  assert.deepEqual(f.messages[0].source, { kind: 'codex-init', form: 'notice', summary: '初始化项目规则' })
  assert.equal(f.messages[0].content[0].text, INIT_PROMPT)
  for (const rule of ['current filesystem working directory', 'already exists, stop', 'creation conflicts', 'Never read a conflicting file', 'plan-mode', 'read the file back']) assert.ok(INIT_PROMPT.includes(rule), rule)
})

test('invalid arguments, attachments, cancellation, and unsupported agents do not load or send', async () => {
  const f = invocation(), handler = createInitCommand(async () => assert.fail('must not load'))
  assert.equal((await handler({ ...f.input, rawInput: 'force' })).kind, 'error')
  assert.equal((await handler({ ...f.input, attachments: [{}] })).kind, 'error')
  assert.match((await handler({ ...f.input, agent: {} })).text, /不支持/)
  assert.match((await handler({ ...f.input, agent: undefined })).text, /不支持/)
  f.controller.abort()
  assert.match((await handler(f.input)).text, /已取消/)
  assert.deepEqual(f.messages, [])
})

test('cancel or unload during asynchronous preparation prevents late delivery', async () => {
  for (const action of ['cancel', 'unload']) {
    const f = invocation(), cleanups = []
    let release, loaded, definition, removals = 0
    const entered = new Promise(resolve => { loaded = resolve })
    const pending = new Promise(resolve => { release = resolve })
    const dispose = registerInitCommand({
      commands: { register(value) { definition = value; return () => { removals++ } } },
      effect(fn) { cleanups.push(fn()) },
    }, async () => { loaded(); return await pending })
    const result = definition.handler(f.input)
    await entered
    if (action === 'cancel') f.controller.abort(); else cleanups[0]()
    release(makeMessage)
    assert.equal((await result).kind, 'error')
    assert.deepEqual(f.messages, [])
    dispose(); dispose(); assert.equal(removals, 1)
    assert.match((await definition.handler(f.input)).text, /已取消|已卸载/)
  }
})

test('load and submission failures do not leak diagnostics or report success', async () => {
  const f = invocation()
  const unavailable = await createInitCommand(async () => { throw new Error('private-detail') })(f.input)
  assert.equal(unavailable.kind, 'error'); assert.doesNotMatch(unavailable.text, /private-detail/)
  const broken = await createInitCommand(async () => makeMessage)({ ...f.input, agent: { followup() { throw new Error('private-detail') } } })
  assert.equal(broken.kind, 'error'); assert.deepEqual(f.messages, [])
})
