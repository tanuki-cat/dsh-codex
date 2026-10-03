import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function client() {
  let registration
  const environment = { __DSH_CHATGPT_MANAGEMENT__: { 'chatgpt-plan': { path: '/chatgpt-management/chatgpt-plan', token: 'capability' } } }
  const React = { createElement() {}, useEffect() {}, useState() {} }
  runInNewContext(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(value) { registration = value } } }, globalThis: environment, AbortController,
  })
  assert.equal(registration.id, 'dsh-llm-chatgpt')
  return registration.factory(name => { assert.equal(name, 'react'); return React })
}

test('browser module contributes ChatGPT to the settings sidebar and registers bilingual copy', () => {
  const module = client()
  let entry, translations
  const ctx = {
    locale: { register(_ns, value) { translations = value; return () => {} }, bind() { return key => translations.zh[key] } },
    effect(callback) { callback() },
    slots: { inject(name, callback) { assert.equal(name, 'settings.section'); callback() }, register(value) { entry = value } },
  }
  module.apply(ctx)
  assert.equal(entry.id, 'chatgpt-subscription')
  assert.equal(entry.label(), 'ChatGPT')
  assert.ok(entry.inject().connections['chatgpt-plan'])
  assert.deepEqual(Object.keys(translations.zh), Object.keys(translations.en))
})

test('browser login opens the popup during the click and finishes without a confirmation prompt', async () => {
  const module = client()
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
  const controller = module.createController({ path: '/management', token: 'capability' }, environment)
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
  const module = client()
  let scheduled, cancelled = false
  const environment = {
    open() { return null }, setTimeout(callback) { scheduled = callback; return 1 }, clearTimeout() { cancelled = true },
    async fetch(url) {
      return { ok: true, async json() { return url.endsWith('/login')
        ? { loginUrl: 'http://127.0.0.1:1455/login' } : { state: 'pending', loginUrl: 'http://127.0.0.1:1455/login' } } }
    },
  }
  const controller = module.createController({ path: '/management', token: 'capability' }, environment)
  await controller.login()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getSnapshot().loginUrl, 'http://127.0.0.1:1455/login')
  assert.equal(typeof scheduled, 'function')
  controller.dispose()
  assert.equal(cancelled, true)
})
