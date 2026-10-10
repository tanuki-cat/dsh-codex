import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { resolve, dirname, join } from 'node:path'
const root = process.env.DSH_INSTALL_ROOT

test('installed Chat renders init as a collapsed turn trigger, preserves expandable text and ordinary user bubbles', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to verify installed Chat presentation.',
}, async () => {
  const require = createRequire(resolve(root, 'package.json'))
  const file = join(dirname(require.resolve('@deepseek-ai/dsh-client-ui-chat')), 'client.js')
  let source = readFileSync(file, 'utf8'), registration
  // Expose native closures only inside this private VM; do not reimplement the host classifier or renderer.
  const marker = 'return module.exports;'
  assert.equal(source.split(marker).length, 2, 'installed client must have one factory export boundary')
  source = source.replace(marker, 'exports.initTest = { messageDefinition, TurnTriggerNodeView }; ' + marker)
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value } } }, URL, AbortController, console })
  let open = false
  const jsx = (type, props) => ({ type, props: props ?? {} })
  const React = {
    createElement: jsx, Fragment: 'fragment', memo: value => value, forwardRef: value => value,
    createContext: () => ({ Provider: 'provider' }), useId: () => 'init-details',
    useState: initial => [open || initial, value => { open = typeof value === 'function' ? value(open) : value }],
  }
  const store = { defineStore: () => () => assert.fail('unrelated store hooks must not run') }
  const primitives = new Proxy({}, { get: (_target, name) => String(name) })
  const loaded = registration.factory(name => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
    if (name === 'react-dom') return { createPortal: value => value }
    if (name === '@deepseek-ai/dsh-client-store') return store
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    assert.fail('unexpected host dependency: ' + name)
  })
  const { createInitCommand } = await import('../lib/init-command.js')
  const { INIT_PROMPT } = await import('../lib/init-prompt.js')
  let message
  await createInitCommand(async () => input => ({ ...input, id: 'init-notice', role: 'user' }))({
    rawInput: '', signal: new AbortController().signal, agent: { followup(value) { message = value } },
  })
  const event = { type: 'user/message', seq: 2, time: Date.now(), data: message, surface: { op: 'append' } }
  const state = loaded.initTest.messageDefinition.start({}, { event, location: { kind: 'outside' } }, {
    previous(kind) { return kind === 'inbox-next-turn' ? { state: { currentClaimed: new Set([message.id]) } } : undefined },
  })
  assert.equal(state.kind, 'context'); assert.equal(state.form, 'notice'); assert.equal(state.waking, true)
  const node = loaded.initTest.messageDefinition.buildViewNode({ state, start: { event, location: { kind: 'unresolved' } } })
  assert.equal(node.kind, 'turn-trigger')
  const t = key => key
  const view = () => loaded.initTest.TurnTriggerNodeView({ node: { data: state }, t })
  const collapsed = view(), header = collapsed.props.children[0]
  assert.equal(header.props['aria-expanded'], false)
  assert.equal(collapsed.props.children[1], false, 'full prompt has no collapsed DOM subtree')
  header.props.onClick()
  const expanded = view()
  assert.equal(expanded.props.children[0].props['aria-expanded'], true)
  const notice = expanded.props.children[1].props.children[1].props.children
  assert.equal(notice.props.content[0].text, INIT_PROMPT)
  expanded.props.children[0].props.onClick(); assert.equal(view().props.children[0].props['aria-expanded'], false)
  const human = loaded.initTest.messageDefinition.start({}, { event: { ...event, data: { ...message, source: { kind: 'user' } } } }, { previous() {} })
  assert.equal(human.kind, 'user', 'unrelated user messages must retain ordinary bubble presentation')
})
