import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageCommand, formatUsage, registerUsageCommand } from '../lib/usage-command.js'

const now = Date.parse('2026-10-09T07:40:00Z')
const reply = () => ({ state: 'ready', accountScope: 'opaque', nextCheckAt: now + 300_000,
  data: { fetchedAt: now, usageAllowed: true,
    fiveHour: { usedPercent: 12, remainingPercent: 88, windowSeconds: 18000, resetsAt: Date.parse('2026-10-09T11:35:00Z') },
    weekly: { usedPercent: 42, remainingPercent: 58, windowSeconds: 604800, resetsAt: Date.parse('2026-10-13T17:50:00Z') } } })
const invocation = (rawInput = '', signal = new AbortController().signal) => ({ rawInput, signal })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('usage command formats remaining balances, full reset dates and explicit timezone', () => {
  const result = formatUsage(reply(), now, 'Asia/Shanghai')
  assert.equal(result.kind, 'success')
  assert.equal(result.text, [
    'Codex usage', '', '5 小时额度 [█████████░] 88% 剩余可用 · 12% 已用', '  重置：2026/10/09 19:35',
    '周额度 [██████░░░░] 58% 剩余可用 · 42% 已用', '  重置：2026/10/14 01:50', '',
    '查询时间：2026/10/09 15:40 · Asia/Shanghai',
  ].join('\n'))
  assert.doesNotMatch(result.text, /opaque|accountId|access|refresh/)
})
test('format preserves fractions, zero and full remaining progress', () => {
  for (const remaining of [0, 58.5, 100]) {
    const value = reply(); value.data.fiveHour.remainingPercent = remaining; value.data.fiveHour.usedPercent = 100 - remaining
    const text = formatUsage(value, now, 'UTC').text
    assert.ok(text.includes(remaining + '% 剩余可用'))
    assert.ok(text.includes('[' + '█'.repeat(Math.round(remaining / 10)) + '░'.repeat(10 - Math.round(remaining / 10)) + ']'))
  }
})
test('missing invalid expired and unknown reset windows remain independent', () => {
  for (const [reason, label] of [['not-returned', '未返回额度'], ['invalid-response', '额度数据无效'], ['expired', '额度已重置']]) {
    const value = reply(); delete value.data.fiveHour; value.data.fiveHourReason = reason; delete value.data.weekly.resetsAt
    const result = formatUsage(value, now, 'UTC')
    assert.match(result.text, new RegExp('5 小时额度：' + label)); assert.ok(result.text.includes('58% 剩余可用'))
    assert.ok(result.text.includes('重置时间未知'))
  }
  const value = reply(); value.data.fiveHour.resetsAt = now
  const text = formatUsage(value, now, 'UTC').text
  assert.ok(text.includes('5 小时额度：额度已重置')); assert.ok(text.includes('周额度 [')); assert.equal(text.includes('88%'), false)
  assert.equal(formatUsage(reply(), now + 900_000, 'UTC').kind, 'error')
})
test('cache and stale results report timestamp, fixed failure and account restriction', () => {
  const value = reply(); value.fromCache = true; value.data.usageAllowed = false
  assert.ok(formatUsage(value, now, 'UTC').text.includes('缓存数据'))
  value.state = 'stale'; value.reason = 'rate-limited'
  const result = formatUsage(value, now + 60_000, 'UTC')
  assert.ok(result.text.includes('旧数据')); assert.ok(result.text.includes('查询受限'))
  assert.ok(result.text.includes('账号当前受限')); assert.ok(result.text.includes('自动再次检查'))
})
test('command rejects arguments and never returns raw service errors', async () => {
  let calls = 0
  const command = createUsageCommand({ get: async mode => { calls++; assert.equal(mode, 'manual'); throw new Error('fake-access private-account') } }, () => now)
  assert.match((await command(invocation(' extra'))).text, /用法/); assert.equal(calls, 0)
  const failed = await command(invocation())
  assert.equal(failed.kind, 'error'); assert.doesNotMatch(failed.text, /fake-access|private-account/)
  const unavailable = createUsageCommand({ get: async () => ({ state: 'unavailable', reason: 'sign-in-required', nextCheckAt: now }) }, () => now)
  assert.match((await unavailable(invocation())).text, /设置 → 模型登录/)
})
test('cancelled command releases its waiter without cancelling shared service work', async () => {
  const response = deferred(), started = deferred(); let calls = 0
  const command = createUsageCommand({ get: async () => { calls++; started.resolve(); return response.promise } }, () => now)
  const cancel = new AbortController()
  const cancelled = command(invocation('', cancel.signal)); await started.promise
  const other = command(invocation()); cancel.abort()
  assert.equal((await cancelled).text, '额度查询已取消')
  response.resolve(reply()); assert.equal((await other).kind, 'success'); assert.equal(calls, 2)
  const pre = new AbortController(); pre.abort(); await command(invocation('', pre.signal)); assert.equal(calls, 2)
})
test('registration advertises usage without input and returns the registry disposer', () => {
  let definition; const dispose = () => {}
  assert.equal(registerUsageCommand({ commands: { register(value) { definition = value; return dispose } } }, { get: async () => reply() }), dispose)
  assert.equal(definition.name, 'usage'); assert.match(definition.description, /5 小时和周/)
  assert.equal(definition.input, undefined); assert.equal(typeof definition.handler, 'function')
})
