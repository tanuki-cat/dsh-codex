import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { login, readGrant } from '../src/auth.js'
import { requestBody } from '../src/wire.js'
import { grant, json, jwks, jwt, store, tokens } from './helpers.js'

// Execute the adjacent DSH source with only Cordis infrastructure substituted.
// This is not a complete Cordis boot or a test of the production file backend.
const root = process.env.DSH_SOURCE_ROOT ?? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))
const available = existsSync(resolve(root, 'packages/credentials/authorization/src/index.ts'))
let AuthorizationService, createToolResultMessage, createSystemMessage, projectToolUpdates
if (available) {
  const source = relative => pathToFileURL(resolve(root, relative)).href
  const modules = {
    '@deepseek-ai/cordis': `export class Context {};
      export class Service { constructor(ctx) { this.ctx = ctx } }`,
    '@deepseek-ai/dsh-llm': source('packages/llm/llm/src/error.ts'),
    '@deepseek-ai/dsh-util-crypto': `export { randomUUID } from 'node:crypto'`,
    '@deepseek-ai/dsh-brand': `export const brandString = value => value`,
    '@deepseek-ai/dsh-util-values': `export function deepFreeze(value) {
      if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze) };
      return value;
    }; export const assertNever = value => { throw new Error('Unexpected value: ' + value) };`,
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier in modules) {
        const module = modules[specifier]
        return { url: module.startsWith('file:') ? module : `data:text/javascript,${encodeURIComponent(module)}`, shortCircuit: true }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url.startsWith(pathToFileURL(root).href) && url.endsWith('.ts')) {
        return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true }
      }
      return next(url, context)
    },
  })
  try {
    AuthorizationService = (await import(source('packages/credentials/authorization/src/index.ts'))).default
    ;({ createToolResultMessage, createSystemMessage } = await import(source('packages/llm/llm/src/message.ts')))
    ;({ projectToolUpdates } = await import(source('packages/llm/llm/src/content.ts')))
  } finally { hooks.deregister() }
}

const sourceTest = (name, callback) => test(name, { skip: available ? false : 'Set DSH_SOURCE_ROOT to run against a DSH checkout.' }, callback)

sourceTest('manifest targets the versions and Node engines of the current DSH source', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const dsh = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.equal(manifest.engines.node, dsh.engines.node)
  for (const [packageName, folder] of [
    ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
    ['@deepseek-ai/dsh-credentials', 'packages/credentials/credentials'],
  ]) {
    const dependency = JSON.parse(readFileSync(resolve(root, folder, 'package.json'), 'utf8'))
    assert.ok(manifest.peerDependencies[packageName].split(' || ').includes(dependency.version))
  }
  const patch = readFileSync(new URL('../examples/cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(patch, /id: authorization/)
  assert.match(patch, /name: dsh-llm-chatgpt/)
})

sourceTest('DSH-created system and tool messages serialize into the Responses request', () => {
  const system = createSystemMessage('System instructions')
  const result = createToolResultMessage({ callId: 'call_1', content: [{ type: 'text', text: 'File content' }], isError: false })
  const body = requestBody({ model: 'test-model', messages: [system, result] })
  assert.equal(body.instructions, 'System instructions')
  assert.deepEqual(body.input, [{ type: 'function_call_output', call_id: 'call_1', output: 'File content' }])
})

sourceTest('DSH projects developer tool updates to current declarations for the undeclared route mode', () => {
  const tool = { name: 'read_file', description: 'Read', parameters: { type: 'object' }, deferLoading: true }
  const projected = projectToolUpdates([
    { role: 'developer', id: 'developer-1', content: [{ type: 'tool-addition', toolName: 'read_file' }] },
    { role: 'user', content: [{ type: 'text', text: 'Read a file' }] },
  ], [tool], undefined)
  const body = requestBody({ model: 'test-model', messages: projected.messages, tools: projected.tools })
  assert.equal(body.input.length, 1)
  assert.equal(body.input[0].role, 'user')
  assert.equal(body.tools[0].tools[0].name, 'read_file')
  assert.equal(projected.tools[0].deferLoading, undefined)
})

function authorizationHost(entries = []) {
  const storage = store(entries)
  const listeners = new Map()
  const ctx = {
    credentials: {
      ...storage,
      async describeRecord(key) { return { configured: (await storage.readRecord(key)) !== undefined } },
      async modifyRecord(key, mutate) {
        let written = false
        const result = await storage.modifyRecord(key, async current => {
          const next = await mutate(current)
          written = next !== undefined
          return next
        })
        if (written) for (const listener of listeners.get('credentials/record-updated') ?? []) listener(key)
        return result
      },
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => listeners.get(event).delete(listener)
    },
    effect(factory) {
      const iterator = factory()
      const { value } = iterator.next()
      return () => { value?.(); iterator.return() }
    },
    events: { dispatch() { return [] } },
    logger: { warn() {}, debug() {} },
  }
  const service = new AuthorizationService(ctx)
  return { storage: ctx.credentials, service }
}

function registerLogin(host, duringCallback = async () => {}) {
  let tx
  host.service.registerFlow({
    key: 'llm-chatgpt/chatgpt-plan', label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Continue with ChatGPT' }],
    run: session => login(host.storage, 'llm-chatgpt/chatgpt-plan', 'llm-chatgpt/host', session, {
      receiveCallback: async transaction => {
        tx = transaction
        await duringCallback()
        return { code: 'code', clientId: 'oaiapp_test', redirectUri: 'http://127.0.0.1:1455/auth/callback' }
      },
      fetcher: async url => url.endsWith('jwks.json') ? json(jwks) : json(tokens({ id_token: jwt({ nonce: tx.nonce }) })),
    }),
  })
}
const begin = (host, signal) => host.service.begin({ key: 'llm-chatgpt/chatgpt-plan', signal,
  interaction: { notify() {}, async prompt() { throw new Error('Unexpected prompt') } } })

sourceTest('current DSH authorization observes the guarded credential commit as authorized', async () => {
  const host = authorizationHost()
  registerLogin(host)
  assert.deepEqual(await begin(host), { status: 'authorized' })
  assert.equal(readGrant(await host.storage.readRecord('llm-chatgpt/chatgpt-plan')).clientId, 'oaiapp_test')
})

sourceTest('current DSH cancellation during OAuth never commits account credentials', async () => {
  const host = authorizationHost()
  registerLogin(host, async () => host.service.cancel('llm-chatgpt/chatgpt-plan'))
  assert.deepEqual(await begin(host), { status: 'cancelled' })
  assert.equal(await host.storage.readRecord('llm-chatgpt/chatgpt-plan'), undefined)
})

sourceTest('current DSH reports a changed credential rejection while retaining the concurrent writer', async () => {
  const key = 'llm-chatgpt/chatgpt-plan'
  const initial = { kind: 'grant', payload: grant() }
  const changed = { kind: 'grant', payload: { ...initial.payload, refreshToken: 'concurrent-refresh' } }
  const host = authorizationHost([[key, initial]])
  registerLogin(host, async () => host.storage.modifyRecord(key, async () => changed))
  await assert.rejects(begin(host), /credentials changed/)
  assert.deepEqual(await host.storage.readRecord(key), changed)
})
