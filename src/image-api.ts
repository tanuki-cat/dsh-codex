import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { retryAfter } from './usage.js'

export const IMAGE_MODEL = 'gpt-image-2'
export const IMAGE_ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/generations'
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_PROMPT_LENGTH = 32_000
export type ImageReason = 'invalid-input' | 'service-unavailable' | 'model-incapable' | 'sign-in-required'
  | 'credential-incomplete' | 'refresh-unavailable' | 'refresh-failed' | 'credential-expired'
  | 'account-changed' | 'permission-denied' | 'quota-exhausted' | 'rate-limited'
  | 'network-error' | 'timeout' | 'cancelled' | 'invalid-response' | 'save-failed'
const messages: Record<ImageReason, string> = {
  'invalid-input': 'Only prompt and transparent_background are accepted. prompt must contain 1–32000 characters; transparent_background must be boolean.',
  'service-unavailable': 'Image generation requires the host attachment and tool services.',
  'model-incapable': 'The current model route must explicitly support image input. Switch to an image-capable model.',
  'sign-in-required': 'Sign in to ChatGPT before generating an image.',
  'credential-incomplete': 'The ChatGPT credential is incomplete. Sign in again.',
  'refresh-unavailable': 'ChatGPT credential refresh is unavailable. Sign in again.',
  'refresh-failed': 'ChatGPT credential refresh failed. Sign in again.',
  'credential-expired': 'The image endpoint rejected the ChatGPT credential. Sign in again.',
  'account-changed': 'The ChatGPT credential changed; the image result was withheld.',
  'permission-denied': 'This account cannot use the Codex image endpoint; ordinary model access is separate.',
  'quota-exhausted': 'The image endpoint reports insufficient quota. No automatic retry was made.',
  'rate-limited': 'The image endpoint is rate limited. Wait until retryAfter before another request.',
  'network-error': 'The image request failed; the remote service may have generated an image and consumed quota. Do not automatically regenerate.',
  'timeout': 'Image generation timed out; the remote service may have consumed quota. Do not automatically regenerate.',
  'cancelled': 'Image generation was cancelled locally; remote generation and quota refund are not guaranteed.',
  'invalid-response': 'The image response is invalid or exceeds storage limits. Do not automatically regenerate.',
  'save-failed': 'Remote generation succeeded, but local attachment storage failed. Do not regenerate automatically.',
}
export interface ImageDiagnostic {
  stage: 'request' | 'response' | 'decode'
  errorType?: string
  causeCode?: string
}
const safeErrorTypes = new Set(['Error', 'TypeError', 'RangeError', 'AggregateError', 'AbortError', 'TimeoutError', 'FetchError'])
const safeTransportCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EACCES', 'EPERM',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED',
  'UND_ERR_INVALID_ARG', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'ERR_INVALID_HTTP_TOKEN', 'ERR_INVALID_CHAR', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
])
/** Copy only recognized constants; exception messages and cause objects never leave this boundary. */
function transportDiagnostic(error: unknown, stage: ImageDiagnostic['stage']): ImageDiagnostic {
  const diagnostic: ImageDiagnostic = { stage }
  const seen = new Set<unknown>(), pending: unknown[] = [error]
  for (let visited = 0; pending.length && visited < 8; visited++) {
    const item = pending.shift()
    if (!object(item) || seen.has(item)) continue
    seen.add(item)
    try {
      if (item === error && typeof item.name === 'string' && safeErrorTypes.has(item.name)) diagnostic.errorType = item.name
      if (!diagnostic.causeCode && typeof item.code === 'string' && safeTransportCodes.has(item.code)) diagnostic.causeCode = item.code
      if (!diagnostic.causeCode && item.message === 'unexpected redirect') diagnostic.causeCode = 'REDIRECT_BLOCKED'
      if (!diagnostic.causeCode && typeof item.message === 'string' && item.message.startsWith('Cannot convert argument to a ByteString')) diagnostic.causeCode = 'BYTESTRING_CONVERSION'
      if (pending.length < 8) pending.push(item.cause)
      if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, Math.max(0, 8 - pending.length)))
    } catch { /* Nonstandard exception properties are not diagnostic data. */ }
  }
  return diagnostic
}
export class ImageError extends Error {
  constructor(public readonly reason: ImageReason, public readonly status?: number,
    public readonly requestId?: string, public readonly retryAfter?: number, public readonly diagnostic?: ImageDiagnostic) {
    super(messages[reason] + (status === undefined ? '' : ' HTTP ' + status + '.')
      + (retryAfter === undefined ? '' : ' retryAfter=' + new Date(retryAfter).toISOString() + '.')
      + (requestId === undefined ? '' : ' requestId=' + requestId + '.')
      + (diagnostic === undefined ? '' : ' stage=' + diagnostic.stage + '.'
        + (diagnostic.errorType ? ' errorType=' + diagnostic.errorType + '.' : '')
        + (diagnostic.causeCode ? ' causeCode=' + diagnostic.causeCode + '.' : '')))
    this.name = 'ImageError'
  }
}
export interface ImageInput { prompt: string; transparent_background?: boolean }
export function validateImageInput(input: ImageInput): void {
  if (!input || Object.keys(input).some(key => key !== 'prompt' && key !== 'transparent_background') || typeof input?.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > MAX_PROMPT_LENGTH
    || input.transparent_background !== undefined && typeof input.transparent_background !== 'boolean') throw new ImageError('invalid-input')
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function imageMediaType(data: Buffer): ImageMediaType | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
}
export function decodeImageResponse(value: unknown, byteCap: number) {
  if (!object(value) || !Array.isArray(value.data) || value.data.length !== 1 || !object(value.data[0])) throw new ImageError('invalid-response')
  const encoded = value.data[0].b64_json
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(byteCap / 3)
    || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ImageError('invalid-response')
  const data = Buffer.from(encoded, 'base64')
  if (!data.length || data.length > byteCap || data.toString('base64') !== encoded) throw new ImageError('invalid-response')
  const mediaType = imageMediaType(data)
  if (!mediaType || value.output_format !== undefined && value.output_format !== ({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' } as const)[mediaType as 'image/png' | 'image/jpeg' | 'image/webp']) throw new ImageError('invalid-response')
  return { data, mediaType }
}
/** Read decoded HTTP chunks under a hard cap; never retain upstream error text. */
async function readJson(response: Response, cap: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new ImageError('invalid-response')
  const chunks: Uint8Array[] = []; let size = 0
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    for (;;) {
      const part = await reader.read(); signal.throwIfAborted()
      if (part.done) break
      size += part.value.byteLength
      if (size > cap) throw new ImageError('invalid-response')
      chunks.push(part.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ImageError('invalid-response') }
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {}); reader.releaseLock()
  }
}
export async function generateImage(input: ImageInput, grant: { access: string; accountId: string },
  signal: AbortSignal, byteCap: number, turnId: string, fetcher: typeof fetch = fetch, now = Date.now) {
  let status: number | undefined, requestId: string | undefined
  let stage: ImageDiagnostic['stage'] = 'request'
  try {
    signal.throwIfAborted()
    const response = await fetcher(IMAGE_ENDPOINT, {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: 'Bearer ' + grant.access, 'ChatGPT-Account-ID': grant.accountId,
        'content-type': 'application/json', accept: 'application/json', originator: 'dsh-llm-chatgpt', 'x-codex-image-turn-id': turnId },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt: input.prompt, background: input.transparent_background ? 'transparent' : 'opaque', quality: 'auto', size: 'auto' }),
    })
    stage = 'response'
    status = response.status
    const id = response.headers.get('x-codex-imagegen-request-id')
    requestId = id && /^[A-Za-z0-9._:-]{1,128}$/.test(id)
      && ![grant.access, grant.accountId, input.prompt].some(secret => secret && id.includes(secret)) ? id : undefined
    if (!response.ok) {
      let reason: ImageReason = status === 401 ? 'credential-expired' : status === 403 ? 'permission-denied' : status === 429 ? 'rate-limited' : 'network-error'
      if (status === 429) {
        try {
          const value = await readJson(response, 16 * 1024, signal)
          if (object(value) && object(value.error) && ['insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached'].includes(String(value.error.code))) reason = 'quota-exhausted'
        } catch { /* Only recognized codes affect classification. */ }
      } else await response.body?.cancel()
      signal.throwIfAborted()
      throw new ImageError(reason, status, requestId, status === 429 ? retryAfter(response.headers.get('retry-after'), now()) : undefined)
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel(); throw new ImageError('invalid-response', status, requestId)
    }
    const value = await readJson(response, 4 * Math.ceil(byteCap / 3) + 64 * 1024, signal)
    stage = 'decode'
    const decoded = decodeImageResponse(value, byteCap)
    signal.throwIfAborted()
    return { ...decoded, ...(requestId ? { requestId } : {}) }
  } catch (error) {
    if (signal.aborted) {
      const reason = signal.reason instanceof ImageError ? signal.reason : new ImageError('cancelled')
      throw new ImageError(reason.reason, reason.status ?? status, reason.requestId ?? requestId, reason.retryAfter, reason.diagnostic ?? { stage })
    }
    if (error instanceof ImageError) throw new ImageError(error.reason, error.status ?? status, error.requestId ?? requestId, error.retryAfter, error.diagnostic ?? { stage })
    throw new ImageError('network-error', status, requestId, undefined, transportDiagnostic(error, stage))
  }
}
