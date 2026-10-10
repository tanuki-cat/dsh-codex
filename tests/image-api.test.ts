import test from 'node:test'
import assert from 'node:assert/strict'
import { generateImage, decodeImageResponse, validateImageInput, IMAGE_ENDPOINT } from '../lib/image-api.js'
import { PNG, imageResponse, signal, rejectsReason } from './image-fixtures.ts'

test('fixed image endpoint, credentials, defaults and transparent request', async () => {
  for (const transparent of [false, true]) {
    let calls = 0
    const output = await generateImage({ prompt: 'a fox', transparent_background: transparent }, { access: 'token', accountId: 'account' }, signal(), 1024, 'turn', async (url, init) => {
      calls++; assert.equal(url, IMAGE_ENDPOINT); assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST')
      assert.deepEqual(init.headers, { authorization: 'Bearer token', 'ChatGPT-Account-ID': 'account', 'content-type': 'application/json', accept: 'application/json', originator: 'dsh-llm-chatgpt', 'x-codex-image-turn-id': 'turn' })
      assert.deepEqual(JSON.parse(init.body), { model: 'gpt-image-2', prompt: 'a fox', background: transparent ? 'transparent' : 'opaque', quality: 'auto', size: 'auto' })
      return imageResponse()
    })
    assert.equal(calls, 1); assert.deepEqual(output.data, PNG); assert.equal(output.mediaType, 'image/png')
  }
})
test('nonblank bounded prompt and boolean background', () => {
  for (const args of [{ prompt: '' }, { prompt: '  ' }, { prompt: 'x'.repeat(32001) }, { prompt: 'ok', transparent_background: 1 }]) assert.throws(() => validateImageInput(args), rejectsReason('invalid-input'))
})
test('strict single image, canonical base64, format and byte limits', () => {
  for (const value of [null, {}, { data: [] }, { data: [{}, {}] }, { data: [{ b64_json: 'abcd===' }] }, { data: [{ b64_json: 'eA==' }] }, { data: [{ b64_json: PNG.toString('base64') }], output_format: 'jpeg' }]) assert.throws(() => decodeImageResponse(value, 1024), rejectsReason('invalid-response'))
  assert.throws(() => decodeImageResponse({ data: [{ b64_json: PNG.toString('base64') }] }, 10), rejectsReason('invalid-response'))
})
test('HTTP failures are classified, sanitized and never retried by transport', async () => {
  for (const [status, code, reason] of [[401, '', 'credential-expired'], [403, '', 'permission-denied'], [429, 'insufficient_quota', 'quota-exhausted'], [429, 'rate_limit', 'rate-limited'], [500, '', 'network-error']]) {
    let calls = 0
    await assert.rejects(generateImage({ prompt: 'private-prompt' }, { access: 'private-access', accountId: 'private-account' }, signal(), 1024, 'turn', async () => {
      calls++; return new Response(JSON.stringify({ error: { code, message: 'private-prompt private-access private-account' } }), { status, headers: { 'retry-after': '60', 'x-codex-imagegen-request-id': 'req-safe' } })
    }, () => 1000), error => {
      assert.equal(error.reason, reason); assert.equal(error.status, status); assert.equal(error.requestId, 'req-safe'); assert.doesNotMatch(error.message, /private-/)
      if (status === 429) assert.equal(error.retryAfter, 61000)
      return true
    }); assert.equal(calls, 1)
  }
})
test('stream cap and malformed JSON reject without exposing body', async () => {
  for (const body of ['private-secret', 'x'.repeat(100_000)]) await assert.rejects(generateImage({ prompt: 'x' }, { access: 'x', accountId: 'x' }, signal(), 1024, 'turn', async () => new Response(body, { headers: { 'content-type': 'application/json' } })), rejectsReason('invalid-response'))
})
test('aborting a blocked response body cancels its reader', async () => {
  const controller = new AbortController(); let cancelled = false
  const started = Promise.withResolvers()
  const job = generateImage({ prompt: 'x' }, { access: 'x', accountId: 'x' }, controller.signal, 1024, 'turn', async () => new Response(new ReadableStream({ pull() { started.resolve() }, cancel() { cancelled = true } }), { headers: { 'content-type': 'application/json' } }))
  const outcome = assert.rejects(job, rejectsReason('cancelled'))
  await started.promise; controller.abort(); await outcome; assert.equal(cancelled, true)
})

test('transport diagnostics retain only recognized names and nested cause codes', async () => {
  for (const [failure, code] of [
    [new TypeError('private-prompt', { cause: Object.assign(new Error('private-access'), { code: 'ECONNRESET' }) }), 'ECONNRESET'],
    [new TypeError('private-prompt', { cause: Object.assign(new Error('private-account'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) }), 'ERR_TLS_CERT_ALTNAME_INVALID'],
    [new TypeError('fetch failed', { cause: new Error('unexpected redirect') }), 'REDIRECT_BLOCKED'],
    [new TypeError('Cannot convert argument to a ByteString private-access'), 'BYTESTRING_CONVERSION'],
    [new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('private-access'), { code: 'ENOTFOUND' })]) }), 'ENOTFOUND'],
  ]) {
    let calls = 0
    await assert.rejects(generateImage({ prompt: 'private-prompt' }, { access: 'private-access', accountId: 'private-account' }, signal(), 1024, 'turn', async () => { calls++; throw failure }), error => {
      assert.equal(error.reason, 'network-error'); assert.equal(error.status, undefined)
      assert.deepEqual(error.diagnostic, { stage: 'request', errorType: 'TypeError', causeCode: code })
      assert.match(error.message, /stage=request/); assert.ok(error.message.includes('causeCode=' + code))
      assert.doesNotMatch(JSON.stringify(error) + error.message, /private-|fetch failed|unexpected redirect/)
      assert.equal(error.cause, undefined); return true
    }); assert.equal(calls, 1)
  }
})
test('unknown, cyclic and throwing cause properties are bounded and not echoed', async () => {
  const cyclic = new Error('private-prompt'); cyclic.cause = cyclic
  for (const failure of [
    Object.assign(new Error('private-access'), { name: 'private-name', code: 'private-code', cause: { code: 'UND_ERR_private-access' } }),
    cyclic,
    Object.defineProperty(new Error('private-account'), 'code', { get() { throw new Error('private-access') } }),
  ]) await assert.rejects(generateImage({ prompt: 'private-prompt' }, { access: 'private-access', accountId: 'private-account' }, signal(), 1024, 'turn', async () => { throw failure }), error => {
    assert.equal(error.reason, 'network-error'); assert.equal(error.diagnostic.stage, 'request'); assert.equal(error.diagnostic.causeCode, undefined)
    assert.doesNotMatch(JSON.stringify(error) + error.message, /private-|UND_ERR_private/); return true
  })
})
test('response stream failures retain HTTP status and distinguish response from decoding', async () => {
  const fetcher = async () => new Response(new ReadableStream({ start(controller) {
    controller.error(Object.assign(new Error('private-access'), { code: 'UND_ERR_SOCKET' }))
  } }), { headers: { 'content-type': 'application/json', 'x-codex-imagegen-request-id': 'req-safe' } })
  await assert.rejects(generateImage({ prompt: 'private-prompt' }, { access: 'private-access', accountId: 'private-account' }, signal(), 1024, 'turn', fetcher), error => {
    assert.equal(error.status, 200); assert.equal(error.requestId, 'req-safe')
    assert.deepEqual(error.diagnostic, { stage: 'response', errorType: 'Error', causeCode: 'UND_ERR_SOCKET' }); assert.doesNotMatch(error.message, /private-/); return true
  })
  await assert.rejects(generateImage({ prompt: 'x' }, { access: 'a', accountId: 'b' }, signal(), 1024, 'turn', async () => new Response(JSON.stringify({ data: [{ b64_json: 'eA==' }] }), { headers: { 'content-type': 'application/json' } })), error => {
    assert.equal(error.reason, 'invalid-response'); assert.deepEqual(error.diagnostic, { stage: 'decode' }); return true
  })
})
