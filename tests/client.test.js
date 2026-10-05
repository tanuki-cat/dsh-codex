import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

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
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    ...sandbox, window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.equal(registration.id, 'dsh-llm-chatgpt')
  const module = registration.factory(name => { assert.equal(name, 'react'); return React })
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
          inject(name, callback) { assert.equal(name, 'settings.models.provider-card'); callback() },
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
function host({ status, fail = [] } = {}) {
  const calls = []
  return {
    calls,
    async fetch(url, init) {
      const operation = url.split('/').at(-1)
      calls.push(operation)
      if (fail.includes(operation)) throw new Error('offline')
      assert.equal(init.headers['x-dsh-chatgpt-token'], 'codex-capability')
      return { ok: true, async json() { return operation === 'status' ? status : {} } }
    },
  }
}

const connected = {
  state: 'authorized', available: true, connected: true,
  account: { name: 'Test Person', email: 'person@example.com', plan: 'plus', expires: Date.UTC(2026, 9, 14) },
}

/** Let the mounted card settle its initial status request. */
const settled = () => new Promise(resolve => setImmediate(resolve))

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
  assert.match(rendered, /plan: plus/)
  assert.deepEqual(controls(page.tree), ['退出并撤销会话'])
})

test('an expired credential explains on-demand refresh and offers recovery', async () => {
  const api = host({ status: { ...connected, connected: false, credentialState: 'expired' } })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.match(text(page.tree), /凭据待刷新/)
  assert.match(text(page.tree), /下次模型请求会尝试自动刷新/)
  assert.doesNotMatch(text(page.tree), /已连接/)
  assert.deepEqual(controls(page.tree), ['重新登录', '退出并撤销会话'])
})

test('an incomplete stored grant offers re-login without claiming a connection', async () => {
  const api = host({ status: { available: true, state: 'idle', connected: false, credentialState: 'incomplete' } })
  const page = browser({ environment: api }).mount()
  await settled()
  assert.match(text(page.tree), /凭据不完整/)
  assert.deepEqual(controls(page.tree), ['重新登录', '退出并撤销会话'])
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
  assert.deepEqual(controls(page.tree), ['退出并撤销会话'])
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
