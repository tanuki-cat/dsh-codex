import { generateKeyPairSync, sign } from 'node:crypto'
import { ISSUER } from '../src/http.js'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256' }] }
export const scopes = 'openid offline_access resource.invoke chatgpt.tokens.use.direct'
export function jwt(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ iss: ISSUER, sub: 'test-account', aud: 'oaiapp_test',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce: 'test-nonce', ...overrides })).toString('base64url')
  const data = `${header}.${payload}`
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`
}
export function tokens(overrides = {}) {
  return { access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'Bearer', expires_in: 3600,
    scope: scopes, id_token: jwt(), ...overrides }
}
export function grant(overrides = {}) {
  return { version: 1, clientId: 'oaiapp_test', subject: 'test-account', accessToken: 'test-access',
    refreshToken: 'test-refresh', idToken: jwt(), scopes: scopes.split(' '), expiresAt: Date.now() + 3600_000, ...overrides }
}
export function store(entries = []) {
  const values = new Map(entries)
  let tail = Promise.resolve()
  return {
    values,
    async readRecord(key) { return structuredClone(values.get(key)) },
    modifyRecord(key, mutate) {
      const task = tail.then(async () => {
        const next = await mutate(structuredClone(values.get(key)))
        if (next !== undefined) values.set(key, structuredClone(next))
        return structuredClone(values.get(key))
      })
      tail = task.catch(() => {})
      return task
    },
  }
}
export const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
export async function collect(iterable) {
  const items = []
  for await (const item of iterable) items.push(item)
  return items
}
export function response(events, width = 17) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(offset, offset + width))
      offset = Math.min(bytes.length, offset + width)
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}
