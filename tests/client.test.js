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
  // The sandbox is the page's global object, so `document` and the browser
  // doubles are reachable both bare and through `globalThis`.
  const sandbox = {
    __DSH_CHATGPT_MANAGEMENT__: { 'chatgpt-plan': { path: '/chatgpt-management/chatgpt-plan', token: 'capability' } },
    document, AbortController, ...environment,
  }
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    ...sandbox, window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.equal(registration.id, 'dsh-llm-chatgpt')
  const module = registration.factory(name => { assert.equal(name, 'react'); return React })
  return {
    module,
    /** Mount the registered settings page and render its account section. */
    mount() {
      let entry, component, translations
      const ctx = {
        locale: { register(_ns, value) { translations = value; return () => {} }, bind() { return key => translations.zh[key] } },
        effect(callback) { callback() },
        slots: { inject(name, callback) { assert.equal(name, 'settings.section'); callback() }, register(value, view) { entry = value; component = view } },
      }
      module.apply(ctx)
      const page = component(entry.inject())
      const account = nodes(page).find(node => typeof node.type === 'function')
      assert.ok(account, 'the page renders one account section')
      draw = () => account.type(account.props)
      paint()
      return { entry, translations, get tree() { return tree } }
    },
  }
}

/** Injected stylesheet tags, in injection order. */
function styleDocument() {
  const injected = []
  return {
    injected,
    querySelector() { return null },
    createElement() { return { dataset: {}, textContent: '' } },
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
function host({ status, models = [], fail = [] } = {}) {
  const calls = []
  return {
    calls,
    async fetch(url, init) {
      const operation = url.split('/').at(-1)
      calls.push(operation)
      if (fail.includes(operation)) throw new Error('offline')
      assert.equal(init.headers['x-dsh-chatgpt-token'], 'capability')
      const body = operation === 'status' ? status : operation === 'models' ? { models } : {}
      return { ok: true, async json() { return body } }
    },
  }
}

const connected = {
  state: 'authorized', connected: true, email: 'test@example.com', provider: 'chatgpt-plan',
  callbackPort: 0, requestTimeoutMs: 600_000, proxyUrl: 'http://127.0.0.1:7890', extraModels: ['gpt-6.1-sol'],
}

/** Let the mounted page settle its initial status and catalog requests. */
const settled = () => new Promise(resolve => setImmediate(resolve))

test('browser module contributes ChatGPT to the settings sidebar and registers bilingual copy', () => {
  const page = browser().mount()
  assert.equal(page.entry.id, 'chatgpt-subscription')
  assert.equal(page.entry.label(), 'ChatGPT')
  assert.ok(page.entry.inject().connections['chatgpt-plan'])
  assert.deepEqual(Object.keys(page.translations.zh), Object.keys(page.translations.en))
})

test('the page styles one injected stylesheet from host tokens instead of inline styles', () => {
  const document = styleDocument()
  const page = browser({ document }).mount()
  assert.equal(document.injected.length, 1)
  const [stylesheet] = document.injected
  assert.equal(stylesheet.dataset.plugin, 'dsh-llm-chatgpt')
  assert.equal(stylesheet.dataset.pluginCss, 'dsh-llm-chatgpt/ChatgptSettings.css')
  for (const token of ['--dsw-alias-label-primary', '--dsw-alias-settings-card-fill', '--dsw-alias-button-primary-fill', '--dsw-radius-xl']) {
    assert.ok(stylesheet.textContent.includes(token), token)
  }
  assert.equal(elements(page.tree).some(element => element.props.style !== undefined), false)
})

test('a connected account shows its identity, catalog and read-only configuration', async () => {
  const api = host({ status: connected, models: [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-6.1-sol', name: 'gpt-6.1-sol (manual; verify access)', manual: true },
  ] })
  const page = browser({ environment: api }).mount()
  await settled()
  await settled()
  assert.deepEqual(api.calls, ['status', 'models'])
  const rendered = text(page.tree)
  assert.match(rendered, /test@example\.com/)
  assert.match(rendered, /已连接/)
  assert.match(rendered, /GPT-5\.6 Sol/)
  assert.match(rendered, /gpt-5\.6-sol/)
  assert.match(rendered, /手动/)
  assert.match(rendered, /http:\/\/127\.0\.0\.1:7890/)
  assert.deepEqual(controls(page.tree), ['刷新模型列表', '退出并撤销会话'])
})

test('a disconnected account offers sign-in and reports the load failure', async () => {
  const api = host({ status: { state: 'idle', connected: false, provider: 'chatgpt-plan', callbackPort: 0 }, fail: ['models'] })
  const page = browser({ environment: api }).mount()
  await settled()
  await settled()
  assert.match(text(page.tree), /未连接账户/)
  assert.deepEqual(controls(page.tree), ['Continue with ChatGPT'])
  assert.equal(elements(page.tree).some(element => element.props.role === 'alert'), false)
})

test('an unreachable management API reports one inline error', async () => {
  const api = host({ fail: ['status'] })
  const page = browser({ environment: api }).mount()
  await settled()
  const alert = elements(page.tree).find(element => element.props.role === 'alert')
  assert.ok(alert, 'the failure is announced')
  assert.match(text(alert), /操作失败/)
})

test('login opens the popup during the click and finishes without a confirmation prompt', async () => {
  const instance = browser()
  const events = []
  const popup = { location: {}, close() {} }
  const environment = {
    open() { events.push('open'); return popup }, setTimeout() {}, clearTimeout() {},
    async fetch(url, init) {
      events.push(url.split('/').at(-1))
      assert.equal(init.headers['x-dsh-chatgpt-token'], 'capability')
      const body = url.endsWith('/login') ? { loginUrl: 'http://127.0.0.1:1455/login' }
        : url.endsWith('/status') ? { connected: true, state: 'authorized' }
          : { models: [{ id: 'model', name: 'Model' }] }
      return { ok: true, async json() { return body } }
    },
  }
  const controller = instance.module.createController({ path: '/management', token: 'capability' }, environment)
  await controller.login()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events.slice(0, 2), ['open', 'login'])
  assert.equal(popup.location.href, 'http://127.0.0.1:1455/login')
  assert.equal(popup.opener, null)
  assert.equal(controller.getSnapshot().status.state, 'authorized')
  assert.equal(controller.getSnapshot().models[0].id, 'model')
  assert.equal(controller.getSnapshot().loginUrl, undefined)
  controller.dispose()
})

test('blocked popup retains a clickable login URL while waiting for authorization', async () => {
  const instance = browser()
  let scheduled, cancelled = false
  const environment = {
    open() { return null }, setTimeout(callback) { scheduled = callback; return 1 }, clearTimeout() { cancelled = true },
    async fetch(url) {
      return { ok: true, async json() { return url.endsWith('/login')
        ? { loginUrl: 'http://127.0.0.1:1455/login' } : { state: 'pending', loginUrl: 'http://127.0.0.1:1455/login' } } }
    },
  }
  const controller = instance.module.createController({ path: '/management', token: 'capability' }, environment)
  await controller.login()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getSnapshot().loginUrl, 'http://127.0.0.1:1455/login')
  assert.equal(typeof scheduled, 'function')
  controller.dispose()
  assert.equal(cancelled, true)
})
