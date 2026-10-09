import test from 'node:test'
import assert from 'node:assert/strict'
import { parseUsageText, createUsageCommandView, usageCommandDictionaries, usageCommandCss } from '../src/client-usage-command.ts'
import { usageColorCss } from '../src/client-usage.ts'
import { formatUsage } from '../lib/usage-command.js'
const time = Date.parse('2026-10-09T08:02:00Z')
const reply = (five = 75, week = 56) => ({ state: 'ready', accountScope: 'opaque', nextCheckAt: time + 300_000,
  data: { fetchedAt: time, fiveHour: { remainingPercent: five, usedPercent: 100 - five, windowSeconds: 18000, resetsAt: time + 3600_000 },
    weekly: { remainingPercent: week, usedPercent: 100 - week, windowSeconds: 604800, resetsAt: time + 86400_000 } } })
const text = (five = 75, week = 56) => formatUsage(reply(five, week), time, 'Asia/Shanghai').text
const nodes = tree => { const all = []; const walk = n => { if (!n || typeof n !== 'object') return; all.push(n); for (const child of n.children ?? []) walk(child) }; walk(tree); return all }
function fixture() {
  let expanded = true
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: () => [expanded, value => { expanded = typeof value === 'function' ? value(expanded) : value }] }
  const primitives = { DisclosureRow: 'disclosure-row', IconApiOutlineRegular: 'command-icon' }
  const View = createUsageCommandView(React, primitives)
  return outcome => View({ node: { name: 'usage', outcome }, t: key => usageCommandDictionaries.zh[key] })
}
test('persisted usage text maps to independent windows and query metadata', () => {
  const data = parseUsageText(text())
  assert.deepEqual(data.rows.map(row => [row.label, row.remaining, row.used]), [['5 小时额度', 75, 25], ['周额度', 56, 44]])
  assert.match(data.rows[0].reset, /^2026\/10\/09/)
  assert.equal(data.updated, '2026/10/09 16:02 · Asia/Shanghai')
  assert.deepEqual(data.notes, [])
  const cached = reply(); cached.fromCache = true; cached.data.usageAllowed = false
  assert.ok(parseUsageText(formatUsage(cached, time, 'UTC').text).notes.some(line => line.startsWith('缓存数据')))
})
test('missing windows and unknown reset remain visible without invented balances', () => {
  const missing = reply(); delete missing.data.fiveHour; missing.data.fiveHourReason = 'not-returned'; delete missing.data.weekly.resetsAt
  const value = formatUsage(missing, time, 'UTC').text, parsed = parseUsageText(value)
  assert.equal(parsed.rows[0].remaining, undefined); assert.equal(parsed.rows[0].unavailable, '未返回额度')
  assert.equal(parsed.rows[1].reset, '重置时间未知')
  const all = nodes(fixture()({ kind: 'success', text: value }))
  assert.equal(all.filter(n => n.props.role === 'progressbar').length, 1)
  assert.ok(JSON.stringify(all).includes('—'))
})
test('unknown or malformed output falls back instead of fabricating colored quota', () => {
  for (const value of [undefined, '', 'unrelated command', 'Codex usage', text().replace('75%', '175%'), text().replace('25% 已用', '45% 已用'),
    text().replace('周额度', '5 小时额度'), text().replace('  重置：', 'time:'), text().replace('查询时间：', 'time:'), 'x'.repeat(8193)]) assert.equal(parseUsageText(value), undefined)
  const all = nodes(fixture()({ kind: 'success', text: 'other output <script>' }))
  assert.equal(all.filter(n => n.props.role === 'progressbar').length, 0)
  assert.equal(all.find(n => n.type === 'pre').children[0], 'other output <script>')
})
test('card replaces character bars with numeric green orange red quota tracks', () => {
  for (const [five, week, tones] of [[75, 56, ['normal', 'normal']], [20, 5, ['warn', 'danger']], [20.1, 5.1, ['normal', 'warn']], [0, 100, ['danger', 'normal']]]) {
    const all = nodes(fixture()({ kind: 'success', text: text(five, week) }))
    assert.deepEqual(all.filter(n => n.props.className === 'dsh-codex-quota').map(n => n.props['data-tone']), tones)
    assert.deepEqual(all.filter(n => n.props.role === 'progressbar').map(n => n.props['aria-valuenow']), [five, week])
    assert.deepEqual(all.filter(n => n.props.className === 'dsh-codex-quota-fill').map(n => n.props.style.width), [five + '%', week + '%'])
    assert.equal(JSON.stringify(all).includes('█'), false)
  }
  assert.match(usageColorCss, /state-success-primary/); assert.match(usageColorCss, /state-warn-primary/); assert.match(usageColorCss, /state-error-primary/)
  assert.match(usageCommandCss, /@media\(max-width:600px\)/)
})
test('default open shared DisclosureRow collapses to a short two-window summary', () => {
  const render = fixture(), outcome = { kind: 'success', text: text() }
  const first = nodes(render(outcome)).find(n => n.type === 'disclosure-row')
  assert.equal(first.props.open, true); assert.equal(first.props.expandOnRowClick, true)
  first.props.onToggle()
  const second = nodes(render(outcome)), disclosure = second.find(n => n.type === 'disclosure-row')
  assert.equal(disclosure.props.open, false); assert.equal(second.some(n => n.props.role === 'progressbar'), false)
  assert.equal(disclosure.props.collapsedContent.children[0], '5 小时额度 75% · 周额度 56%')
  assert.equal(disclosure.props.collapsedContent.children[0].includes('重置'), false)
})
test('running and error states retain messages and translated keys are aligned', () => {
  const render = fixture()
  const running = nodes(render(null)).find(n => n.type === 'disclosure-row')
  assert.equal(running.props.running, true); assert.equal(running.props.expandable, false)
  const error = nodes(render({ kind: 'error', text: '未登录，请先登录' }))
  assert.equal(error.find(n => n.type === 'pre').props['data-error'], true)
  assert.deepEqual(Object.keys(usageCommandDictionaries.zh), Object.keys(usageCommandDictionaries.en))
})
