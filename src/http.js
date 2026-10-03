export const API = 'https://api.openai.com/v1'
export const ISSUER = 'https://auth.openai.com'

export class PlanError extends Error {
  constructor(message, code, status, retryAfterMs) {
    super(message)
    this.code = code
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export function boundedSignal(signal, timeoutMs = 60_000) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export async function checkedFetch(fetcher, url, init) {
  const response = await fetcher(url, { ...init, redirect: 'error' })
  if (!response.ok) {
    const delay = response.headers.get('retry-after')
    const retryAfterMs = delay ? (Number.isFinite(Number(delay))
      ? Number(delay) * 1000 : Date.parse(delay) - Date.now()) : undefined
    // Provider bodies may contain credentials or prompt text; never forward them.
    const code = response.status === 401 || response.status === 403 ? 'AUTH'
      : response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'SERVER' : 'BAD_REQUEST'
    await response.body?.cancel()
    throw new PlanError(`ChatGPT plan request failed (HTTP ${response.status}).`, code,
      response.status, retryAfterMs > 0 ? retryAfterMs : undefined)
  }
  return response
}

export async function jsonFetch(fetcher, url, init = {}) {
  return (await checkedFetch(fetcher, url, init)).json()
}
