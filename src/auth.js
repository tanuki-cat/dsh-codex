import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { API, ISSUER, PlanError, boundedSignal, checkedFetch, jsonFetch } from './http.js'

const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const fail = message => { throw new PlanError(message, 'AUTH') }
const nonempty = value => typeof value === 'string' && value.length > 0

export function createTransaction(hostId, previous) {
  const verifier = randomBytes(48).toString('base64url')
  return {
    hostId, previous,
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

export function authorizationUrl(tx, redirectUri) {
  const url = new URL(`${ISSUER}/api/accounts/authorize`)
  const params = {
    client_id: tx.previous?.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: tx.hostId,
    response_type: 'code', redirect_uri: redirectUri, scope: SCOPE,
    resource: API, state: tx.state, nonce: tx.nonce,
    code_challenge_method: 'S256', code_challenge: tx.challenge,
  }
  if (!tx.previous) params.agent_name_hint = 'dsh-llm-chatgpt'
  // Avoid putting retained ID tokens into authorization notices or logs.
  if (tx.previous?.email) params.login_hint = tx.previous.email
  url.search = new URLSearchParams(params).toString()
  return url.toString()
}

export function validateCallback(url, tx) {
  const state = url.searchParams.get('state') ?? ''
  const actual = Buffer.from(state)
  const expected = Buffer.from(tx.state)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('OAuth state mismatch.')
  if (url.searchParams.has('error')) fail('ChatGPT authorization was declined or failed.')
  const code = url.searchParams.get('code')
  const clientId = url.searchParams.get('client_id') ?? tx.previous?.clientId
  if (!nonempty(code) || !nonempty(clientId) || clientId === 'dynamic_agent_client') fail('Incomplete ChatGPT registration.')
  if (tx.previous && clientId !== tx.previous.clientId) fail('ChatGPT registration does not match the selected account.')
  return { code, clientId }
}

export function verifyIdentity(idToken, jwks, { clientId, nonce, subject, now = Date.now() }) {
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) fail('Invalid ChatGPT identity token.')
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (header.alg !== 'RS256' || !nonempty(header.kid) || header.crit !== undefined) fail('Unsupported identity signature.')
    const key = jwks.keys?.find(key => key.kid === header.kid && key.kty === 'RSA'
      && (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === 'RS256'))
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) fail('Invalid ChatGPT identity signature.')
    const seconds = now / 1000
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== ISSUER || !audience.includes(clientId)
      || (audience.length > 1 && claims.azp !== clientId)
      || !Number.isFinite(claims.exp) || claims.exp <= seconds - 5
      || !Number.isFinite(claims.iat) || claims.iat > seconds + 5
      || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 5))
      || (nonce !== undefined && claims.nonce !== nonce)
      || !nonempty(claims.sub) || (subject !== undefined && claims.sub !== subject)) fail('ChatGPT identity validation failed.')
    return claims
  } catch {
    fail('ChatGPT identity validation failed.')
  }
}

export function tokenGrant(tokens, identity, clientId, previous, now = Date.now()) {
  const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes
  if (!scopes?.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) fail('ChatGPT plan usage permission was not granted.')
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken
  if (!nonempty(tokens.access_token) || !nonempty(refreshToken)
    || tokens.token_type?.toLowerCase() !== 'bearer'
    || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) fail('Incomplete ChatGPT credentials.')
  return {
    version: 1, clientId, subject: identity.sub,
    email: typeof identity.email === 'string' ? identity.email : previous?.email,
    accessToken: tokens.access_token, refreshToken,
    idToken: tokens.id_token ?? previous?.idToken,
    scopes, expiresAt: now + tokens.expires_in * 1000,
  }
}

export function readRegistration(record) {
  const grant = record?.kind === 'grant' ? record.payload : undefined
  if (!grant || grant.version !== 1 || !nonempty(grant.clientId) || grant.clientId === 'dynamic_agent_client'
    || !nonempty(grant.subject)) fail('Sign in with ChatGPT before selecting this provider.')
  return grant
}

export function readGrant(record) {
  const grant = readRegistration(record)
  if (!nonempty(grant.accessToken) || !nonempty(grant.refreshToken)
    || !Array.isArray(grant.scopes) || !Number.isFinite(grant.expiresAt)) fail('Sign in with ChatGPT before selecting this provider.')
  if (!grant.scopes.includes('chatgpt.tokens.use.direct') || !grant.scopes.includes('resource.invoke')) fail('ChatGPT plan usage permission is missing.')
  return grant
}

async function getJwks(fetcher, signal, headers) {
  return jsonFetch(fetcher, `${ISSUER}/.well-known/jwks.json`, { signal, headers })
}

async function exchange(fetcher, fields, signal, headers) {
  return jsonFetch(fetcher, TOKEN_ENDPOINT, {
    method: 'POST', signal, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...fields, resource: API }),
  })
}

export async function accessGrant(store, key, { signal, fetcher = fetch, headers = {}, now = Date.now } = {}) {
  signal = boundedSignal(signal)
  signal.throwIfAborted()
  let grant = readGrant(await store.readRecord(key))
  if (grant.expiresAt > now() + 60_000) return grant
  const updated = await store.modifyRecord(key, async record => {
    grant = readGrant(record)
    signal.throwIfAborted()
    if (grant.expiresAt > now() + 60_000) return undefined
    const tokens = await exchange(fetcher, {
      grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refreshToken,
    }, signal, headers)
    const identity = tokens.id_token ? verifyIdentity(tokens.id_token,
      await getJwks(fetcher, signal, headers), { clientId: grant.clientId, subject: grant.subject, now: now() })
      : { sub: grant.subject, email: grant.email }
    return { kind: 'grant', payload: tokenGrant(tokens, identity, grant.clientId, grant, now()) }
  })
  return readGrant(updated)
}

// Only /login and /auth/callback exist; no public token-returning endpoint.
export async function loopback(tx, session, port = 0, serverFactory = createServer) {
  const signal = boundedSignal(session.signal, 300_000)
  signal.throwIfAborted()
  let resolve, reject, consumed = false
  const result = new Promise((ok, bad) => { resolve = ok; reject = bad })
  result.catch(() => {})
  const server = serverFactory((req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('referrer-policy', 'no-referrer')
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    if (url.pathname === '/login') {
      res.writeHead(302, { location: authorizationUrl(tx, redirectUri) }).end()
      return
    }
    if (url.pathname !== '/auth/callback' || consumed) { res.writeHead(404).end(); return }
    try {
      const callback = validateCallback(url, tx)
      consumed = true
      res.end('Authorization received. Return to DSH to check the sign-in result.')
      resolve({ ...callback, redirectUri })
    } catch (error) {
      res.writeHead(400).end('Authorization rejected.')
      // Unrelated requests cannot cancel the pending valid browser callback.
      if (url.searchParams.get('state') === tx.state) reject(error)
    }
  })
  let redirectUri
  const abort = () => reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    await new Promise((ok, bad) => {
      server.once('error', bad)
      server.listen(port, '127.0.0.1', ok)
    })
    redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`
    signal.throwIfAborted()
    session.notify({ message: 'Continue with ChatGPT. Eligible requests use your ChatGPT plan and its usage limits.',
      url: redirectUri.replace('/auth/callback', '/login') })
    return await result
  } finally {
    signal.removeEventListener('abort', abort)
    server.closeAllConnections()
    if (server.listening) await new Promise(ok => server.close(ok))
    // Consume a possible abort rejection if listener startup failed first.
    result.catch(() => {})
  }
}

export async function login(store, key, hostKey, session, {
  fetcher = fetch, headers = {}, port = 0, receiveCallback = loopback,
} = {}) {
  session.signal.throwIfAborted()
  let hostId
  await store.modifyRecord(hostKey, async current => {
    hostId = current?.kind === 'grant' ? current.payload?.hostId : undefined
    if (nonempty(hostId)) return undefined
    hostId = `urn:uuid:${randomUUID()}`
    return { kind: 'grant', payload: { hostId } }
  })
  const before = await store.readRecord(key)
  const previous = before === undefined ? undefined : readRegistration(before)
  const tx = createTransaction(hostId, previous)
  const callback = await receiveCallback(tx, session, port)
  const signal = boundedSignal(session.signal)
  const tokens = await exchange(fetcher, {
    grant_type: 'authorization_code', client_id: callback.clientId,
    code: callback.code, code_verifier: tx.verifier, redirect_uri: callback.redirectUri,
  }, signal, headers)
  if (!nonempty(tokens.scope)) fail('The token response did not include granted scopes.')
  const identity = verifyIdentity(tokens.id_token, await getJwks(fetcher, signal, headers), {
    clientId: callback.clientId, nonce: tx.nonce, subject: previous?.subject,
  })
  const grant = tokenGrant(tokens, identity, callback.clientId, previous)
  // Keep the comparison and write under one store lock. session.commit(record)
  // cannot compare the stored value before replacement.
  await store.modifyRecord(key, async current => {
    signal.throwIfAborted()
    if (JSON.stringify(current) !== JSON.stringify(before)) fail('ChatGPT credentials changed during login. Try again.')
    return { kind: 'grant', payload: grant }
  })
}

export async function logout(store, key, { fetcher = fetch, headers = {}, signal } = {}) {
  signal = boundedSignal(signal)
  await store.modifyRecord(key, async current => {
    if (!current) return undefined
    const grant = readRegistration(current)
    if (grant.refreshToken) {
      const discovery = await jsonFetch(fetcher, `${ISSUER}/.well-known/openid-configuration`, { headers, signal })
      const endpoint = new URL(discovery.revocation_endpoint)
      if (endpoint.origin !== ISSUER) fail('Unexpected ChatGPT revocation endpoint.')
      await checkedFetch(fetcher, endpoint.toString(), {
        method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, signal,
        body: new URLSearchParams({ token: grant.refreshToken, token_type_hint: 'refresh_token', client_id: grant.clientId }),
      })
    }
    return { kind: 'grant', payload: { ...grant, accessToken: '', refreshToken: '', idToken: '', expiresAt: 0 } }
  })
}
