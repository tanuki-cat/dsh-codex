import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve as esmResolve } from 'import-meta-resolve'
import { fixture, imageResponse, signal } from './image-fixtures.ts'

const root = process.env.DSH_INSTALL_ROOT

test('the real pi-ai auth resolver rotates a grant under the DSH record transaction', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to test the installed pi-ai auth resolver.',
}, async t => {
  const require = createRequire(resolve(root, 'package.json'))
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-credentials') return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
    return next(specifier, context)
  } })
  try {
    const pi = await import(esmResolve('@earendil-works/pi-ai', pathToFileURL(resolve(root, 'package.json')).href))
    const { openaiCodexProvider } = await import(esmResolve('@earendil-works/pi-ai/providers/openai-codex', pathToFileURL(resolve(root, 'package.json')).href))
    const { bindHostCatalog } = await import('../lib/host-catalog.js')
    let record = { kind: 'grant', payload: { type: 'oauth', access: 'expired', refresh: 'refresh', expires: 1, accountId: 'test-account' } }
    let tail = Promise.resolve(), refreshes = 0, enter, release
    const entered = new Promise(resolve => { enter = resolve })
    const barrier = new Promise(resolve => { release = resolve })
    const ctx = { credentials: {
      readRecord: async () => record,
      modifyRecord(_key, fn) {
        const result = tail.then(async () => { const next = await fn(record); if (next) record = next; return record })
        tail = result.then(() => {}, () => {})
        return result
      },
      deleteRecord: async () => { record = undefined },
    } }
    const native = openaiCodexProvider()
    const provider = { ...native, auth: { ...native.auth, oauth: { ...native.auth.oauth,
      async refresh(credential, signal) {
        assert.equal(signal.aborted, false)
        refreshes++; enter(); await barrier
        return { ...credential, access: refreshes === 1 ? 'refreshed' : 'refreshed-again', refresh: 'rotated', expires: Date.now() + 3_600_000 }
      },
      async toAuth(credential) { return { apiKey: credential.access } },
    } } }
    const host = bindHostCatalog(ctx, pi, provider)
    const first = host.refreshCredential()
    await entered
    const { createImageService } = await import('../lib/image-service.js')
    const f = fixture(), imageRefreshEntered = Promise.withResolvers()
    const images = createImageService({ ...f.ctx, credentials: ctx.credentials }, {
      refresh: async (signal, options) => {
        const job = host.refreshCredential({ signal, ...options })
        imageRefreshEntered.resolve()
        await job; return true
      },
      fetcher: async (_url, init) => { assert.equal(init.headers.authorization, 'Bearer refreshed'); return imageResponse() },
    })
    t.after(() => images.dispose())
    const second = images.generate({ prompt: 'fox' }, signal())
    await imageRefreshEntered.promise
    release()
    await Promise.all([first, second])
    assert.equal(refreshes, 1)
    assert.equal(record.payload.access, 'refreshed')
    assert.equal(record.payload.refresh, 'rotated')
    assert.equal(record.payload.accountId, 'test-account')
    assert.ok(host.models.some(model => model.id === 'gpt-6-sol'))
    await host.refreshCredential({ rejectedAccess: 'refreshed' })
    assert.equal(refreshes, 2, 'a rejected token refresh does not demand an artificially long expiry')
    assert.equal(record.payload.access, 'refreshed-again')
    assert.ok(record.payload.expires > Date.now())
    await host.refreshCredential({ rejectedAccess: 'expired' })
    assert.equal(refreshes, 2, 'a stale rejection must not rotate another request’s new token')
  } finally { hooks.deregister() }
})
