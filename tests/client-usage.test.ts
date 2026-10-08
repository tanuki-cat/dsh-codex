import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageController, createUsageView, validUsage, displayData, usageDictionaries } from '../src/client-usage.ts'
import { json } from './helpers.ts'
const reply = (now = 1_000_000, used = 42) => ({ state: 'ready', accountScope: 'opaque-a', data: { usedPercent: used, remainingPercent: 100 - used, windowSeconds: 18000, fetchedAt: now, resetsAt: now + 600_000 }, nextCheckAt: now + 60_000 })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(condition) { for (let i = 0; i < 100; i++) { if (condition()) return; await Promise.resolve() }; assert.fail('microtask chain did not settle') }
function fixture(t, fetcher) {
  let time = 1_000_000, visible = true, online = true, next = 0, wake, calls = 0
  const timers = new Map()
  const env = { now: () => time, visible: () => visible, online: () => online,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    listen(fn) { wake = fn; return () => { wake = undefined } },
    fetch: async (...args) => { calls++; return fetcher ? fetcher(...args) : json(reply(time)) },
  }
  const controller = createUsageController({ path: '/manage', token: 'fake-capability' }, env)
  t.after(() => controller.dispose())
  return { controller, timers, calls: () => calls, hasListener: () => !!wake,
    advance(ms) { time += ms; const due = [...timers].filter(([, timer]) => timer.at <= time); for (const [id, timer] of due) { if (timers.delete(id)) timer.fn() } },
    visible(value) { visible = value; wake?.() }, online(value) { online = value; wake?.() }, wake() { wake?.() } }
}
test('client validates DTO state and never treats unknown quota as zero', () => {
  assert.equal(validUsage(reply()), true)
  assert.equal(validUsage({ state: 'unavailable', reason: 'no-five-hour-window', nextCheckAt: 0 }), true)
  for (const value of [null, {}, { ...reply(), state: 'unavailable' }, { ...reply(), data: { ...reply().data, remainingPercent: 999 } },
    { ...reply(), reason: 'network-error' }, { ...reply(), state: 'stale', reason: 'permission-denied' }]) assert.equal(validUsage(value), false)
  assert.equal(displayData(reply(), 1_300_000), undefined)
  const reset = reply(); reset.data.resetsAt = 1_010_000; assert.equal(displayData(reset, 1_010_000), undefined)
})
test('subscribers share one request with capability and constrained manual refresh', async t => {
  const f = fixture(t, async (url, init) => { assert.equal(url, '/manage/usage'); assert.equal(init.headers['x-dsh-chatgpt-token'], 'fake-capability'); assert.equal(init.cache, 'no-store'); return json(reply()) })
  assert.equal(f.calls(), 0)
  const a = f.controller.subscribe(() => {}), b = f.controller.subscribe(() => {})
  await until(() => !f.controller.getSnapshot().loading)
  assert.equal(f.calls(), 1); await f.controller.refresh(); f.wake(); assert.equal(f.calls(), 1)
  a(); assert.equal(f.hasListener(), true); b(); assert.equal(f.hasListener(), false); assert.equal(f.timers.size, 0)
})
test('hidden and offline pages stop polling and resume with one freshness check', async t => {
  const f = fixture(t); f.controller.subscribe(() => {})
  await until(() => !f.controller.getSnapshot().loading)
  f.visible(false); assert.equal(f.timers.size, 0); f.advance(60_000); assert.equal(f.calls(), 1)
  f.visible(true); f.wake(); await until(() => !f.controller.getSnapshot().loading); assert.equal(f.calls(), 2)
  f.online(false); assert.equal(f.timers.size, 1); f.advance(60_000); f.online(true); await until(() => !f.controller.getSnapshot().loading); assert.equal(f.calls(), 3)
})
test('visible offline pages mark data stale and expire it without network requests', async t => {
  const f = fixture(t); f.controller.subscribe(() => {})
  await until(() => !f.controller.getSnapshot().loading)
  f.online(false); f.advance(60_000)
  assert.equal(f.calls(), 1); assert.equal(f.controller.getSnapshot().updatedAt, 1_060_000)
  assert.ok(f.controller.getSnapshot().reply.data)
  f.advance(240_000); assert.equal(f.controller.getSnapshot().reply.data, undefined)
  assert.equal(f.calls(), 1); assert.equal(f.timers.size, 0)
  f.online(true); await until(() => !f.controller.getSnapshot().loading); assert.equal(f.calls(), 2)
})
test('quota expires at reset while a refresh response is still pending', async t => {
  const late = deferred(); let calls = 0
  const initial = reply(); initial.data.resetsAt = 1_090_000
  const f = fixture(t, async () => ++calls === 1 ? json(initial) : late.promise)
  f.controller.subscribe(() => {}); await until(() => !f.controller.getSnapshot().loading)
  f.advance(60_000); assert.equal(f.calls(), 2); assert.equal(f.controller.getSnapshot().loading, true)
  assert.ok(f.controller.getSnapshot().reply.data)
  f.advance(30_000); assert.equal(f.controller.getSnapshot().reply.data, undefined)
  late.resolve(json(initial)); await until(() => !f.controller.getSnapshot().loading)
  assert.equal(f.controller.getSnapshot().reply.data, undefined)
})

test('offline pages clear data at reset and hidden cancelled responses cannot publish', async t => {
  const reset = reply(); reset.data.resetsAt = 1_015_000
  const f = fixture(t, async () => json(reset)); f.controller.subscribe(() => {})
  await until(() => !f.controller.getSnapshot().loading)
  f.online(false); f.advance(15_000)
  assert.equal(f.controller.getSnapshot().reply.data, undefined); assert.equal(f.calls(), 1)
  const late = deferred(); const done = deferred(); let signal
  const g = fixture(t, async (_url, init) => { signal = init.signal; const result = await late.promise; done.resolve(); return result })
  g.controller.subscribe(() => {}); g.visible(false); assert.equal(signal.aborted, true)
  late.resolve(json(reply())); await done.promise; await until(() => g.timers.size === 0)
  assert.equal(g.controller.getSnapshot().reply, undefined); assert.equal(g.controller.getSnapshot().loading, false)
})

test('unmount aborts a fetch and a late completion cannot publish', async t => {
  const response = deferred(); let signal
  const f = fixture(t, async (_url, init) => { signal = init.signal; return response.promise })
  const off = f.controller.subscribe(() => {}); off(); assert.equal(signal.aborted, true)
  response.resolve(json(reply())); await until(() => f.timers.size === 0)
  assert.equal(f.controller.getSnapshot().reply, undefined)
})
test('authentication pause clears data without querying old credentials', async t => {
  const f = fixture(t); f.controller.subscribe(() => {}); await until(() => !f.controller.getSnapshot().loading)
  f.controller.setPaused(true); assert.equal(f.controller.getSnapshot().reply, undefined); assert.equal(f.calls(), 1)
  f.advance(300_000); f.wake(); assert.equal(f.calls(), 1)
  f.controller.setPaused(false); await until(() => !f.controller.getSnapshot().loading); assert.equal(f.calls(), 2)
})
test('invalidated old response cannot overwrite new account response', async t => {
  const old = deferred(); let calls = 0
  const f = fixture(t, async () => ++calls === 1 ? old.promise : json({ ...reply(), accountScope: 'opaque-b' }))
  f.controller.subscribe(() => {}); f.controller.invalidate()
  await until(() => f.controller.getSnapshot().reply?.accountScope === 'opaque-b')
  old.resolve(json(reply())); await until(() => !f.controller.getSnapshot().loading)
  assert.equal(f.controller.getSnapshot().reply.accountScope, 'opaque-b')
})
test('local 403 clears historic data and does not become a Codex permission error', async t => {
  let bad = false
  const f = fixture(t, async () => bad ? new Response('', { status: 403 }) : json(reply()))
  f.controller.subscribe(() => {}); await until(() => !f.controller.getSnapshot().loading)
  bad = true; f.advance(60_000); await until(() => !f.controller.getSnapshot().loading)
  assert.equal(f.controller.getSnapshot().reply, undefined); assert.equal(f.controller.getSnapshot().localError, 'reload')
})
test('Retry-After cooldown still expires historic data on time', async t => {
  let bad = false
  const f = fixture(t, async () => bad ? json({ ...reply(), state: 'stale', reason: 'rate-limited', nextCheckAt: 9_000_000 }) : json(reply()))
  f.controller.subscribe(() => {}); await until(() => !f.controller.getSnapshot().loading)
  bad = true; f.advance(60_000); await until(() => !f.controller.getSnapshot().loading)
  assert.equal(f.controller.getSnapshot().reply.state, 'stale')
  f.advance(240_000); assert.equal(f.controller.getSnapshot().reply.data, undefined); assert.equal(f.calls(), 2)
})
test('no Codex or unavailable session produces no bar; valid bar has numeric progress semantics', () => {
  for (const used of [0, 42, 100]) {
    const data = { reply: reply(1_000_000, used), updatedAt: 1_000_000, loading: false }
    const effects = []
    const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useEffect: effect => effects.push(effect), useSyncExternalStore: (_subscribe, get) => get(), useId: () => 'usage-tip' }
    const controller = { getSnapshot: () => data, subscribe: () => () => {}, refresh: async () => {} }
    const Seat = createUsageView(React, controller)
    const props = { directory: { getSnapshot: () => ({ current: { provider: 'openai-codex' } }), subscribe: () => () => {} }, available: true, load() {}, t: k => usageDictionaries.en[k] }
    const seat = Seat(props); const bar = seat.type(seat.props)
    const nodes = []; const walk = v => { if (!v || typeof v !== 'object') return; nodes.push(v); for (const child of v.children ?? []) walk(child) }; walk(bar)
    const progress = nodes.find(n => n.props.role === 'progressbar')
    assert.equal(progress.props['aria-valuenow'], used); assert.equal(progress.props['aria-valuemin'], 0); assert.equal(progress.props['aria-valuemax'], 100)
    const button = nodes.find(n => n.type === 'button')
    const descendants = []; const collect = v => { if (!v || typeof v !== 'object') return; descendants.push(v); for (const child of v.children ?? []) collect(child) }; collect(button)
    assert.equal(descendants.includes(progress), false, 'button descendants are presentational to assistive technology')
    assert.ok(button.props['aria-label'].includes('Used ' + used + '%'))
    assert.equal(progress.props.className, 'dsh-codex-usage-semantic')
    assert.ok(nodes.find(n => n.props.role === 'tooltip'))
    assert.equal(Seat({ ...props, available: false }), null)
    assert.equal(Seat({ ...props, directory: { ...props.directory, getSnapshot: () => ({ current: null }) } }), null)
    assert.equal(Seat({ ...props, directory: { ...props.directory, getSnapshot: () => ({ current: { provider: 'other' } }) } }), null)
  }
})
