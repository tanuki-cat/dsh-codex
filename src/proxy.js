import { PlanError } from './http.js'

export function normalizeProxyUrl(value) {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string') throw new PlanError('proxyUrl must be an HTTP or HTTPS proxy address.', 'INVALID_CONFIG')
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid proxy')
    return url.origin
  } catch {
    throw new PlanError('proxyUrl must be an HTTP or HTTPS proxy address without credentials, path or query.', 'INVALID_CONFIG')
  }
}

export function createProxyTransport(proxyUrl, {
  fetcher = (url, init) => globalThis.fetch(url, init),
  loadProxyAgent = async () => (await import('undici')).ProxyAgent,
} = {}) {
  const normalized = normalizeProxyUrl(proxyUrl)
  let agent, agentPromise, closed = false
  return {
    proxyUrl: normalized,
    async fetch(url, init = {}) {
      if (closed) throw new PlanError('ChatGPT transport is closed.', 'TRANSPORT')
      if (!normalized) return fetcher(url, init)
      init.signal?.throwIfAborted()
      try {
        agentPromise ??= loadProxyAgent().then(ProxyAgent => {
          agent = new ProxyAgent(normalized)
          return agent
        })
        const dispatcher = await agentPromise
        if (closed) throw new Error('Closed')
        init.signal?.throwIfAborted()
        return await fetcher(url, { ...init, dispatcher })
      } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason
        throw new PlanError('ChatGPT proxy request failed. Check the configured proxy address and make sure the proxy is running.', 'TRANSPORT')
      }
    },
    async dispose() {
      closed = true
      if (agentPromise) {
        try { await agentPromise; await agent.destroy() } catch { /* Failed construction owns no open connections. */ }
      }
    },
  }
}
