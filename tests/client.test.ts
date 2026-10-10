import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Browser double: a stylesheet sink, a hook runtime that repaints on every
 * state write, and the module registration the real loader would keep. The
 * environment stands in for the browser globals the page reads (fetch, open,
 * timers), so a mounted page drives its own controller end to end.
 */
function browser({ document = styleDocument(), environment = {} } = {}) {
  const cells = []
  let cursor = 0
  let draw = () => null
  let tree, painting = false, stale = false
  // A state write while the tree is still rendering re-paints after that pass
  // instead of recursing into it, and the pass budget fails a render loop loudly.
  const paint = () => {
    if (painting) { stale = true; return }
    painting = true
    try {
      for (let pass = 0; ; pass += 1) {
        if (pass > 50) throw new Error('the page re-rendered without settling')
        cursor = 0; stale = false; tree = draw()
        if (!stale) return
      }
    } finally { painting = false }
  }
  const same = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useRef() { const at = cursor++; return (cells[at] ??= { current: undefined }) },
    useState(initial) {
      const at = cursor++
      if (!(at in cells)) cells[at] = initial
      return [cells[at], value => {
        const resolved = typeof value === 'function' ? value(cells[at]) : value
        if (Object.is(resolved, cells[at])) return
        cells[at] = resolved
        paint()
      }]
    },
    // Dependencies are honored, so a mounted page subscribes and loads once.
    useEffect(effect, deps) {
      const at = cursor++
      if (at in cells && same(cells[at], deps)) return
      cells[at] = deps
      effect()
    },
  }
  let registration
  const disposers = []
  // The sandbox is the page's global object, so `document` and the browser
  // doubles are reachable both bare and through `globalThis`.
  const sandbox = {
    __DSH_CHATGPT_MANAGEMENT__: {
      // The official route's endpoint, published only when the host reports
      // that llm-pi-ai offers its sign-in flow.
      'openai-codex': { path: '/chatgpt-management/openai-codex', token: 'codex-capability' },
    },
    document, AbortController, ...environment,
  }
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    ...sandbox, window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.equal(registration.id, 'dsh-llm-chatgpt')
  const module = registration.factory(name => {
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { DisclosureRow: 'disclosure-row', IconApiOutlineRegular: 'command-icon' }
    assert.equal(name, 'react'); return React
  })
  // Seats the module registers on slots other than the settings page itself.
  const seats = new Map()
  return {
    module,
    /**
     * Seat the card on the llm-pi-ai provider row and render it.
     *
     * The owner hands the seat every row of the family, so the route id
     * travels with the owner props exactly as ModelsSection dispatches it.
     */
    mount(route = 'openai-codex') {
      let seat, translations
      const ctx = {
        locale: { register(_ns, value) { translations = value; return () => {} }, bind() { return key => translations.zh[key] } },
        effect(callback) {
          const dispose = callback()
          if (typeof dispose === 'function') disposers.push(dispose)
        },
        slots: {
          inject(name, callback) { if (name === 'conversation.chat.commandview' || name === 'tool.call.toolview') return; assert.equal(name, 'settings.models.provider-card'); callback() },
          register(value, view) { seats.set(value.key, { entry: value, component: view }) },
        },
      }
      module.apply(ctx)
      seat = seats.get('llm-pi-ai')
      assert.ok(seat, 'the card is seated on the llm-pi-ai family')
      const owner = { provider: { provider: route, settingsNs: 'llm-pi-ai' }, configured: true, keyConfigured: false }
      draw = () => seat.component({ ...seat.entry.inject(), ...owner })
      paint()
      return {
        translations,
        get tree() { return tree },
        unmount() { for (const dispose of disposers.reverse()) dispose() },
      }
    },
  }
}
/** Injected stylesheet tags, in injection order. */
function styleDocument() {
  const injected = []
  return {
    injected,
    querySelector() { return null },
    createElement() {
      const tag = { dataset: {}, textContent: '', remove() {
        const index = injected.indexOf(tag)
        if (index !== -1) injected.splice(index, 1)
      } }
      return tag
    },
    head: { appendChild(tag) { injected.push(tag) } },
  }
}

/** Every rendered node in the tree, flattened in render order. */
function nodes(node, found = []) {
  for (const child of Array.isArray(node) ? node : [node]) {
    // A fragment is its own child list, never a node of its own.
    if (Array.isArray(child)) { nodes(child, found); continue }
    if (child === null || child === undefined || typeof child !== 'object') continue
    found.push(child)
    nodes(child.children, found)
  }
  return found
}

/** Host elements only — component elements render nothing of their own. */
function elements(node) {
  return nodes(node).filter(child => typeof child.type === 'string')
}

/** Concatenated text of a subtree. */
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  return text(node.children)
}

/** Visible labels of every button and link in the subtree. */
function controls(tree) {
  return elements(tree).filter(element => element.type === 'button' || element.type === 'a').map(element => text(element))
}

/** Answers the management API the way the host route does. */
function host({ status, fail = [], preview, apply, restorePreview, restore, refusal } = {}) {
  const calls = []
  const headers = []
  return {
    calls, headers,
    async fetch(url, init) {
      headers.push(init.headers)
      const operation = url.split('/').at(-1)
      calls.push(operation)
      if (fail.includes(operation)) throw new Error('offline')
      assert.equal(init.headers['x-dsh-chatgpt-token'], 'codex-capability')
      // A refusal carries a reason code with a non-2xx status, which is what
      // lets the card name the remedy rather than the source.
      const body = operation === 'models-restore' ? restore : operation === 'models-restore-preview' ? restorePreview : operation === 'models-apply' ? apply : operation === 'models-preview' ? preview : status
      if (refusal && operation.startsWith('models-')) {
        return { ok: false, status: refusal.status, async json() { return { error: 'refused', reason: refusal.reason } } }
      }
      return { ok: true, async json() { return operation === 'status' ? status : body ?? {} } }
    },
  }
}

const connected = {
  state: 'authorized', available: true, connected: true,
  account: { name: 'Test Person', email: 'person@example.com', plan: 'plus', expires: Date.UTC(2026, 9, 14) },
}

/** Let the mounted card settle its initial status request. */
const settled = () => new Promise(resolve => setImmediate(resolve))

test('usage is an optional independent right-slot contribution with session-local model data', () => {
  const { module } = browser()
  for (const loopback of [true, false]) {
    const seats = new Map(), dictionaries = new Map(), cleanups = []; let loaded = 0
    const store = { getSnapshot: () => ({ current: { provider: 'openai-codex' } }), subscribe: () => () => {} }
    const ctx = {
      connection: { isLoopback: loopback }, sessions: { subagentAddress: id => id === 'child' ? {} : undefined },
      modelDirectories: { directoryFor: () => ({ store, load: async () => { loaded++ } }) },
      effect(fn) { cleanups.push(fn()) },
      locale: { register(ns, dict) { dictionaries.set(ns, dict); return () => dictionaries.delete(ns) }, bind(ns) { return key => dictionaries.get(ns).zh[key] } },
      slots: { inject(_name, fn) { fn() }, register(entry, component) { if (entry.name === 'conversation.input.right') assert.equal(typeof entry.id, 'string'); seats.set(entry.name, { entry, component }) } },
      inject(services, fn) { assert.deepEqual([...services], ['modelDirectories', 'sessions', 'connection']); fn(ctx) },
    }
    module.apply(ctx)
    assert.ok(seats.has('settings.models.provider-card'))
    const usage = seats.get('conversation.input.right')
    assert.equal(Boolean(usage), loopback)
    if (usage) {
      assert.equal(usage.entry.id, 'codex-five-hour-usage'); assert.equal(usage.entry.key, undefined)
      const props = usage.entry.inject('parent'); assert.equal(props.directory, store); assert.equal(props.available, true)
      assert.equal(props.t('used'), '已用'); props.load(); assert.equal(loaded, 1)
      const child = usage.entry.inject('child'); assert.equal(child.available, false); child.load(); assert.equal(loaded, 1)
    }
    for (const dispose of cleanups.reverse()) dispose()
  }
})

test('quota list contribution registers and coexists in the real installed Host SlotCore', {
  skip: process.env.DSH_INSTALL_ROOT ? false : 'Set DSH_INSTALL_ROOT to test the installed slot registry.',
}, async t => {
  const require = createRequire(resolve(process.env.DSH_INSTALL_ROOT, 'package.json'))
  const { SlotCore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-ui-slots')).href)
  const core = new SlotCore(), cleanups = []
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup() })
  cleanups.push(core.register({ name: 'root', children: {
    'conversation.input.right': { kind: 'list', scope: 'session' },
    'settings.models.provider-card': { kind: 'keyed', scope: 'root' },
    'conversation.chat.commandview': { kind: 'keyed', scope: 'session' },
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
  } }, () => null))
  cleanups.push(core.register({ name: 'conversation.input.right', id: 'existing-contribution' }, () => null))
  assert.throws(() => core.register({ name: 'conversation.input.right', key: 'wrong-key' }, () => null), /requires options.id/)
  const store = { getSnapshot: () => ({ current: { provider: 'openai-codex' } }), subscribe: () => () => {} }
  const ctx = {
    connection: { isLoopback: true }, sessions: { subagentAddress: () => undefined },
    modelDirectories: { directoryFor: () => ({ store, load: async () => {} }) },
    effect(fn) { cleanups.push(fn()) },
    locale: { register() { return () => {} }, bind() { return key => key } },
    slots: { inject(_name, fn) { fn() }, register(entry, component) { const dispose = core.register(entry, component); cleanups.push(dispose); return dispose } },
    inject(_services, fn) { fn(ctx) },
  }
  browser().module.apply(ctx)
  const entries = core.entriesOfSlot('conversation.input.right')
  assert.deepEqual(entries.map(entry => entry.options.id), ['existing-contribution', 'codex-five-hour-usage'])
  const usage = entries.find(entry => entry.options.id === 'codex-five-hour-usage')
  assert.equal(usage.inject('parent').directory, store)
  assert.equal(core.entriesOfSlot('settings.models.provider-card')[0].options.key, 'llm-pi-ai')
  const command = core.entriesOfSlot('conversation.chat.commandview')[0]
  assert.equal(command.options.key, 'usage'); assert.equal(command.options.id, undefined)
  assert.equal(typeof command.component, 'function')
  const imageView = core.entriesOfSlot('tool.call.toolview')[0]
  assert.equal(imageView.options.key, 'image_gen')
  assert.equal(typeof imageView.component, 'function')
})

test('the card is seated on the llm-pi-ai family and registers bilingual copy', () => {
  const page = browser().mount()
  assert.deepEqual(Object.keys(page.translations.zh), Object.keys(page.translations.en))
})

test('only the openai-codex row renders the card', () => {
  // One browser per row: each provider card is its own component instance, and
  // this double keeps hook state per instance.
  assert.ok(browser().mount('openai-codex').tree, 'the route the card signs into renders')
  // Every pi-ai route shares one namespace, so the card must decline the rest:
  // rendering there would offer a ChatGPT sign-in on llama-cpp.
  for (const other of ['llama-cpp', 'command-code']) {
    assert.equal(browser().mount(other).tree, null, other + ' must not render the card')
  }
})

test('other pi-ai rows never request ChatGPT management status', async () => {
  const calls = []
  const environment = { async fetch(url) { calls.push(url); throw new Error('unexpected request') } }
  const page = browser({ environment }).mount('llama-cpp')
  await settled()
  assert.equal(page.tree, null)
  assert.deepEqual(calls, [])
})

test('the card styles one injected stylesheet from host tokens instead of inline styles', () => {
  const document = styleDocument()
  const page = browser({ document }).mount()
  assert.equal(document.injected.length, 1)
  const [stylesheet] = document.injected
  assert.equal(stylesheet.dataset.plugin, 'dsh-llm-chatgpt')
  assert.equal(stylesheet.dataset.pluginCss, 'dsh-llm-chatgpt/ChatgptCodex.css')
  for (const token of ['--dsw-alias-button-primary-fill', '--dsw-radius-md', '--dsw-alias-state-success-primary']) {
    assert.ok(stylesheet.textContent.includes(token), token)
  }
  assert.equal(elements(page.tree).some(element => element.props.style !== undefined), false)
  page.unmount()
  assert.equal(document.injected.length, 0)
})

test('a connected account shows its identity and offers sign-out', async () => {
  const api = host({ status: connected })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.deepEqual(api.calls, ['status'])
  const rendered = text(page.tree)
  assert.match(rendered, /Test Person/)
  assert.match(rendered, /已连接/)
  assert.match(rendered, /订阅: plus/)
  assert.deepEqual(controls(page.tree), ['退出登录'])
})

test('an expired credential explains on-demand refresh and offers recovery', async () => {
  const api = host({ status: { ...connected, connected: false, credentialState: 'expired' } })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.match(text(page.tree), /凭据待刷新/)
  assert.match(text(page.tree), /下次模型请求会尝试自动刷新/)
  assert.doesNotMatch(text(page.tree), /已连接/)
  assert.deepEqual(controls(page.tree), ['重新登录', '退出登录'])
})

test('an incomplete stored grant offers re-login without claiming a connection', async () => {
  const api = host({ status: { available: true, state: 'idle', connected: false, credentialState: 'incomplete' } })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.match(text(page.tree), /凭据不完整/)
  assert.deepEqual(controls(page.tree), ['重新登录', '退出登录'])
})

test('a disconnected account offers sign-in', async () => {
  const api = host({ status: { state: 'idle', available: true, connected: false } })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.match(text(page.tree), /未连接 ChatGPT 账户/)
  assert.deepEqual(controls(page.tree), ['登录 ChatGPT'])
})

test('a host without the flow hides the card entirely', async () => {
  const api = host({ status: { state: 'idle', available: false, connected: false } })
  const page = browser({ environment: api }).mount()
  await settled()
  // No flow means no button: the row must look untouched rather than offer a
  // sign-in that could never complete.
  assert.equal(page.tree, null)
})

test('an unreachable management API reports one inline error', async () => {
  const api = host({ fail: ['status'] })
  const page = browser({ environment: api }).mount()
  await settled()
  const alert = elements(page.tree).find(element => element.props.role === 'alert')
  assert.ok(alert, 'the failure is announced')
  assert.match(text(alert), /操作失败/)
})

test('login keeps its popup while polling a delayed notice and refreshes after authorization', async () => {
  const events = []
  let statusReads = 0
  let closed = 0
  const popup = { location: {}, close() { closed += 1 } }
  const environment = {
    open() { events.push('open'); return popup },
    setTimeout(callback) { setImmediate(callback); return 1 },
    clearTimeout() {},
    async fetch(url, init) {
      const operation = url.split('/').at(-1)
      events.push(operation)
      assert.equal(init.headers['x-dsh-chatgpt-token'], 'codex-capability')
      return { ok: true, async json() {
        if (operation === 'login') return { state: 'pending', available: true, connected: false }
        statusReads += 1
        if (statusReads === 1) return { state: 'idle', available: true, connected: false }
        if (statusReads === 2) return {
          state: 'pending', available: true, connected: false,
          notice: { message: 'Open this page', url: 'https://auth.openai.com/oauth/authorize?x=1' },
        }
        return { ...connected, account: { name: 'After Login' } }
      } }
    },
  }
  const page = browser({ environment }).mount()
  await settled()
  elements(page.tree).find(element => element.type === 'button').props.onClick()
  for (let index = 0; index < 4; index += 1) await settled()
  assert.deepEqual(events, ['status', 'open', 'login', 'status', 'status'])
  assert.equal(popup.location.href, 'https://auth.openai.com/oauth/authorize?x=1')
  assert.equal(popup.opener, null)
  assert.equal(closed, 1)
  assert.match(text(page.tree), /After Login/)
  assert.deepEqual(controls(page.tree), ['退出登录'])
})

test('polling recovers after a transient status failure without closing the login popup', async () => {
  const timers = []
  const calls = []
  let closed = 0
  const popup = { location: {}, close() { closed += 1 } }
  const url = 'https://auth.openai.com/oauth/authorize?x=1'
  const pending = { state: 'pending', available: true, connected: false, notice: { url } }
  const environment = {
    open() { return popup },
    setTimeout(callback, delay) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer },
    clearTimeout(timer) { timer.cancelled = true },
    async fetch(path) {
      const operation = path.split('/').at(-1)
      calls.push(operation)
      if (operation === 'status' && calls.length === 3) throw new Error('offline')
      return { ok: true, async json() {
        if (operation === 'login') return pending
        return calls.length === 4 ? connected : { state: 'idle', available: true, connected: false }
      } }
    },
  }
  const page = browser({ environment }).mount()
  await settled()
  elements(page.tree).find(element => element.type === 'button').props.onClick()
  await settled()
  assert.equal(timers[0].delay, 500)
  await timers[0].callback()
  assert.equal(timers[1].delay, 1000)
  assert.equal(closed, 0)
  assert.equal(popup.location.href, url)
  assert.deepEqual(controls(page.tree), ['打开浏览器完成授权', '取消登录'])
  assert.ok(elements(page.tree).some(element => element.props.role === 'alert'))
  await timers[1].callback()
  assert.equal(closed, 1)
  assert.equal(timers.length, 2)
  assert.deepEqual(calls, ['status', 'login', 'status', 'status'])
  assert.deepEqual(controls(page.tree), ['退出登录'])
  assert.equal(elements(page.tree).some(element => element.props.role === 'alert'), false)
})

test('cancelling or unmounting aborts an in-flight poll without disabling retry', async () => {
  for (const stop of ['cancel', 'dispose']) {
    const timers = []
    let statusReads = 0
    let pollSignal
    const environment = {
      setTimeout(callback) { const timer = { callback, cancelled: false }; timers.push(timer); return timer },
      clearTimeout(timer) { timer.cancelled = true },
      async fetch(path, { signal }) {
        if (path.endsWith('/cancel')) return { ok: true, async json() { return { state: 'cancelled', connected: false } } }
        if (++statusReads === 1) return { ok: true, async json() { return { state: 'pending', connected: false } } }
        pollSignal = signal
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      },
    }
    const controller = browser().module.createController({ path: '/chatgpt-management/openai-codex', token: 'test' }, environment)
    await controller.load()
    const pendingPoll = timers[0].callback()
    assert.ok(pollSignal, 'poll must have started')
    if (stop === 'cancel') {
      await controller.act('cancel')
      assert.equal(controller.getSnapshot().status.state, 'cancelled')
    } else controller.dispose()
    await pendingPoll
    assert.equal(pollSignal.aborted, true)
    assert.equal(timers.length, 1, 'stopped attempts must not schedule another retry')
    assert.equal(controller.getSnapshot().error, false)
    controller.dispose()
  }
})

test('a blocked popup keeps a clickable authorization link', async () => {
  const environment = {
    open() { return null },
    setTimeout() { return 1 },
    clearTimeout() {},
    async fetch(url) {
      return { ok: true, async json() {
        return url.endsWith('/login')
          ? { state: 'pending', available: true, connected: false, notice: { message: 'Open this page', url: 'https://auth.openai.com/oauth/authorize?x=1' } }
          : { state: 'idle', available: true, connected: false }
      } }
    },
  }
  const page = browser({ environment }).mount()
  await settled()
  elements(page.tree).find(element => element.type === 'button').props.onClick()
  await settled()
  const link = elements(page.tree).find(element => element.type === 'a')
  assert.ok(link, 'the authorization URL is reachable without a popup')
  assert.equal(link.props.href, 'https://auth.openai.com/oauth/authorize?x=1')
  assert.deepEqual(controls(page.tree), ['打开浏览器完成授权', '取消登录'])
})

test('refocusing an idle page refreshes external credential changes without duplicate requests', async () => {
  const listeners = new Map()
  const calls = []
  let nextStatus = { state: 'idle', available: true, connected: false }
  let deferRefresh = false
  let finishRefresh
  const environment = {
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name) },
    async fetch() {
      calls.push('status')
      if (deferRefresh) await new Promise(resolve => { finishRefresh = resolve })
      return { ok: true, async json() { return nextStatus } }
    },
  }
  const controller = browser().module.createController({ path: '/chatgpt-management/openai-codex', token: 'test' }, environment)
  await controller.load()
  assert.equal(controller.getSnapshot().status.connected, false)
  nextStatus = connected
  deferRefresh = true
  const first = listeners.get('focus')()
  await listeners.get('focus')()
  assert.deepEqual(calls, ['status', 'status'], 'focus events must share one outstanding refresh')
  finishRefresh()
  await first
  assert.equal(controller.getSnapshot().status.connected, true)
  controller.dispose()
  assert.equal(listeners.has('focus'), false)
})

test('a rejected popup navigation keeps the authorization link and polling available', async () => {
  let timer
  let closed = 0
  const popup = { location: { set href(_url) { throw new Error('navigation refused') } }, close() { closed += 1 } }
  const url = 'https://auth.openai.com/oauth/authorize?x=1'
  const environment = {
    open() { return popup },
    setTimeout(callback) { timer = callback; return 1 },
    clearTimeout() { timer = undefined },
    async fetch(path) {
      return { ok: true, async json() {
        if (path.endsWith('/login')) return { state: 'pending', available: true, connected: false, notice: { url } }
        if (path.endsWith('/status') && closed > 0) return connected
        return { state: 'idle', available: true, connected: false }
      } }
    },
  }
  const page = browser({ environment }).mount()
  await settled()
  elements(page.tree).find(element => element.type === 'button').props.onClick()
  await settled()
  assert.equal(closed, 1)
  assert.equal(elements(page.tree).find(element => element.type === 'a').props.href, url)
  assert.deepEqual(controls(page.tree), ['打开浏览器完成授权', '取消登录'])
  await timer()
  assert.deepEqual(controls(page.tree), ['退出登录'])
})

test('a pending sign-in can be cancelled without starting a second login', async () => {
  const calls = []
  let timer
  const environment = {
    open() { return { location: {}, close() {} } },
    setTimeout(callback) { timer = callback; return 1 },
    clearTimeout() { timer = undefined },
    async fetch(url) {
      const operation = url.split('/').at(-1)
      calls.push(operation)
      return { ok: true, async json() {
        if (operation === 'login' || operation === 'status' && calls.length > 1) {
          return { state: 'pending', available: true, connected: false }
        }
        if (operation === 'cancel') return { state: 'cancelled', available: true, connected: false }
        return { state: 'idle', available: true, connected: false }
      } }
    },
  }
  const page = browser({ environment }).mount()
  await settled()
  elements(page.tree).find(element => element.type === 'button').props.onClick()
  await settled()
  assert.equal(typeof timer, 'function')
  assert.deepEqual(controls(page.tree), ['取消登录'])
  elements(page.tree).find(element => element.type === 'button').props.onClick()
  await settled()
  assert.deepEqual(calls, ['status', 'login', 'cancel'])
  assert.deepEqual(controls(page.tree), ['登录 ChatGPT'])
  assert.equal(timer, undefined)
})

test('model patch requires preview before a separate confirmation', async () => {
  const api = host({ status: { ...connected, patchAvailable: true }, preview: {
    added: ['gpt-6.1-sol'], preserved: ['gpt-6-sol'], total: 2, unsupported: 0,
    source: 'https://chatgpt.com/backend-api/codex/models', signature: 'a'.repeat(64),
  } })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.ok(controls(page.tree).includes('检查缺失模型'))
  const actions = elements(page.tree).find(el => el.props.className === 'dsh-chatgpt-actions')
  assert.deepEqual(controls(actions), ['检查缺失模型', '检查恢复原生目录', '退出登录'])
  const logout = elements(actions).find(el => el.type === 'button' && text(el) === '退出登录')
  assert.equal(logout.props.title, '退出登录并删除本地凭据')
  assert.equal(elements(actions).find(el => el.type === 'button' && text(el) === '检查缺失模型').props['data-variant'], 'secondary')
  assert.ok(!controls(page.tree).includes('确认补充缺失模型'))
  elements(page.tree).find(el => el.type === 'button' && text(el) === '检查缺失模型').props.onClick()
  await settled()
  assert.ok(controls(page.tree).includes('确认补充缺失模型'))
  assert.ok(elements(page.tree).some(el => el.type === 'details'))
  assert.ok(elements(page.tree).some(el => el.props.className === 'dsh-chatgpt-model' && text(el) === 'gpt-6.1-sol'))
  elements(page.tree).find(el => el.type === 'button' && text(el) === '确认补充缺失模型').props.onClick()
  await settled()
  assert.deepEqual(api.calls, ['status', 'models-preview', 'status', 'models-apply'])
})

test('the preview names the source, its age and the catalogue the write would leave', async () => {
  const fetchedAt = Date.UTC(2026, 9, 7, 1, 39)
  const api = host({ status: { ...connected, patchAvailable: true }, preview: {
    added: ['gpt-6.1-sol'], preserved: ['gpt-6-sol'], total: 10, unsupported: 0, current: 1,
    alreadySelectable: ['gpt-6-sol'], unlisted: ['legacy-model'], understated: [{ id: 'gpt-6-sol', declared: 128000, source: 272000 }],
    replacesCatalog: true, clientVersion: '0.160.1', fetchedAt,
    source: 'https://chatgpt.com/backend-api/codex/models', signature: 'a'.repeat(64),
  } })
  const page = browser({ environment: api }).mount()
  await settled()
  elements(page.tree).find(el => el.type === 'button' && text(el) === '检查缺失模型').props.onClick()
  await settled()
  const notes = elements(page.tree).filter(el => el.props.className === 'dsh-chatgpt-note').map(text)
  // The counts line distinguishes what is already selectable from what is kept.
  assert.ok(notes.some(line => line.includes('当前可选: 1') && line.includes('保留模型: 1')), JSON.stringify(notes))
  // The details read back the source, when it was fetched, and the version asked for.
  assert.ok(notes.some(line => line === 'https://chatgpt.com/backend-api/codex/models'))
  assert.ok(notes.some(line => line.includes('列表获取于') && line.includes('请求版本 0.160.1')), JSON.stringify(notes))
  // The catalogue after writing, and the takeover warning, are both stated.
  assert.ok(notes.some(line => line.includes('写入后列表: gpt-6-sol, gpt-6.1-sol')), JSON.stringify(notes))
  assert.ok(notes.some(line => line.includes('接管整个目录')), JSON.stringify(notes))
  // A kept model the listing omits is named rather than silently dropped.
  assert.ok(notes.some(line => line.includes('来源未收录') && line.includes('legacy-model')), JSON.stringify(notes))
  // A declared capacity below the source value is shown as a pair, so the gap
  // is visible without the patch rewriting the user's own value.
  assert.ok(notes.some(line => line.includes('声明的上下文小于来源给出的窗口') && line.includes('gpt-6-sol (128000 → 272000)')), JSON.stringify(notes))
})

test('an applied patch reports what it added and the revisions it moved between', async () => {
  const api = host({
    status: { ...connected, patchAvailable: true },
    preview: { added: ['gpt-6.1-sol'], preserved: ['gpt-6-sol'], total: 10, unsupported: 0, signature: 'a'.repeat(64), source: 'src' },
    apply: {
      applied: ['gpt-6.1-sol'], added: [], preserved: ['gpt-6-sol'], total: 10, unsupported: 0,
      before: { revision: 3, models: ['gpt-6-sol'] }, after: { revision: 4, models: ['gpt-6-sol', 'gpt-6.1-sol'] },
      source: 'https://chatgpt.com/backend-api/codex/models', signature: '',
    },
  })
  const page = browser({ environment: api }).mount()
  await settled()
  elements(page.tree).find(el => el.type === 'button' && text(el) === '检查缺失模型').props.onClick()
  await settled()
  elements(page.tree).find(el => el.type === 'button' && text(el) === '确认补充缺失模型').props.onClick()
  await settled()
  const notes = elements(page.tree).filter(el => el.props.className === 'dsh-chatgpt-note').map(text)
  const titles = elements(page.tree).filter(el => el.props.className === 'dsh-chatgpt-preview-title').map(text)
  assert.ok(titles.some(line => line.startsWith('已补充模型')), JSON.stringify(titles))
  // The record a later review needs: the new IDs and the revision pair.
  assert.ok(notes.some(line => line.includes('配置修订: 3 → 4')), JSON.stringify(notes))
  assert.ok(notes.some(line => line.includes('写入后列表: gpt-6-sol, gpt-6.1-sol')), JSON.stringify(notes))
  // The preview is replaced, so the confirmation button is gone.
  assert.ok(!controls(page.tree).includes('确认补充缺失模型'))
})

test('each refusal reason renders its own remedy instead of a generic failure', async () => {
  const cases = [
    ['route-missing', '尚未声明 openai-codex 路由'],
    ['settings-read-only', '只读，无法写入补丁'],
    ['source-unavailable', '无法获取 Codex 模型列表'],
    ['version-config-invalid', 'config/codex.json 并重启 DSH'],
    ['conflict', '请重新预览后再确认'],
  ]
  for (const [reason, expected] of cases) {
    const api = host({ status: { ...connected, patchAvailable: true }, refusal: { reason, status: 409 } })
    const page = browser({ environment: api }).mount()
    await settled()
    elements(page.tree).find(el => el.type === 'button' && text(el) === '检查缺失模型').props.onClick()
    await settled()
    const alerts = elements(page.tree).filter(el => el.props.role === 'alert').map(text)
    assert.ok(alerts.some(line => line.includes(expected)), reason + ' -> ' + JSON.stringify(alerts))
  }
})

test('HTTP 200 fallback renders its specific remedy and never offers confirmation', async () => {
  for (const [reason, expected] of [['route-missing', '尚未声明'], ['settings-read-only', '只读'], ['credential-expired', '凭据已过期'], ['source-unavailable', '无法获取'], ['version-config-invalid', 'config/codex.json 并重启 DSH']]) {
    const api = host({ status: { ...connected, patchAvailable: true }, preview: {
      unavailable: 'remote unavailable', reason, added: [], preserved: ['old'], total: 1, unsupported: 0, signature: '', source: 'fallback',
    } })
    const page = browser({ environment: api }).mount()
    await settled()
    elements(page.tree).find(el => el.type === 'button' && text(el) === '检查缺失模型').props.onClick()
    await settled()
    assert.ok(elements(page.tree).some(el => el.props.role === 'alert' && text(el).includes(expected)))
    assert.ok(text(page.tree).includes('以下仅为本机目录'))
    assert.ok(!controls(page.tree).includes('确认补充缺失模型'))
  }
})

test('expired credentials retain the catalog check entry for automatic refresh', async () => {
  const api = host({ status: { ...connected, connected: false, credentialState: 'expired', patchAvailable: true } })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.ok(controls(page.tree).includes('检查缺失模型'))
  assert.ok(controls(page.tree).includes('重新登录'))
})

test('restoration previews destructive effects before a separate signed confirmation', async () => {
  const preview = { kind: 'restore', added: [], preserved: ['native'], removed: ['custom'], resets: ['native', 'custom'], total: 1, unsupported: 0, signature: 'b'.repeat(64), source: 'installed pi-ai' }
  const api = host({ status: { ...connected, patchAvailable: true }, restorePreview: preview, restore: { ...preview, signature: '', applied: [], restored: true, after: { models: ['native'] } } })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.ok(!controls(page.tree).includes('确认恢复原生目录'))
  elements(page.tree).find(el => el.type === 'button' && text(el) === '检查恢复原生目录').props.onClick()
  await settled()
  assert.ok(text(page.tree).includes('显式能力配置将被移除'))
  assert.ok(text(page.tree).includes('将不再可选: custom'))
  elements(page.tree).find(el => el.type === 'button' && text(el) === '确认恢复原生目录').props.onClick()
  await settled()
  assert.deepEqual(api.calls, ['status', 'models-restore-preview', 'status', 'models-restore', 'status'])
  assert.equal(api.headers[3]['x-dsh-model-patch'], 'b'.repeat(64))
  assert.ok(text(page.tree).includes('已恢复原生目录'))
  assert.ok(text(page.tree).includes('未执行推理'))
  assert.ok(!controls(page.tree).includes('确认恢复原生目录'))
})

test('metadata previews expose capability limits and distinguish context from override maximum', async () => {
  const api = host({ status: { ...connected, patchAvailable: true }, preview: {
    added: ['new'], preserved: [], total: 1, unsupported: 0, signature: 'a'.repeat(64), source: 'remote',
    capabilityStatus: 'catalog-only', inheritedOutputLimits: ['new'], windows: [{ id: 'new', contextWindow: 272000, maxContextWindow: 872000 }],
  } })
  const page = browser({ environment: api }).mount()
  await settled()
  elements(page.tree).find(el => el.type === 'button' && text(el) === '检查缺失模型').props.onClick()
  await settled()
  assert.ok(text(page.tree).includes('尚未验证实际推理'))
  assert.ok(text(page.tree).includes('未提供输出上限'))
  assert.ok(text(page.tree).includes('new (272000 / 872000)'))
})
