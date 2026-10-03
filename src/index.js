import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { accessGrant, login, logout, readRegistration } from './auth.js'
import { PlanError } from './http.js'
import { models, streamResponse } from './wire.js'
import { createManagement, registerManagement } from './management.js'
import { createProxyTransport } from './proxy.js'
import { normalizeExtraModels, reasoningFor, withExtraModels } from './model-catalog.js'

export const name = 'llm-chatgpt'
export const inject = ['llm', 'credentials', 'authorization']

function asLlmError(error) {
  if (error instanceof LlmError || error?.name === 'AbortError') return error
  if (error?.name === 'TimeoutError') return new LlmError('ChatGPT request timed out.', 'TIMEOUT')
  if (error instanceof PlanError) return new LlmError(error.message, error.code, {
    ...error.status === undefined ? {} : { status: error.status },
    ...error.retryAfterMs === undefined ? {} : { providerRetryAfterMs: error.retryAfterMs },
  })
  return new LlmError('ChatGPT request could not be completed. Check the connection and try again.', 'TRANSPORT')
}

export function apply(ctx, config = {}) {
  const provider = config.provider ?? 'chatgpt-plan'
  if (!/^[a-z][a-z0-9-]*$/.test(provider) || provider === 'host') throw new Error('provider must be a lowercase hyphenated identifier other than host')
  const port = config.callbackPort ?? 0
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('callbackPort must be an integer from 0 through 65535')
  const timeoutMs = config.requestTimeoutMs ?? 600_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2_147_483_647) throw new Error('requestTimeoutMs is out of range')
  const extraModels = normalizeExtraModels(config.extraModels)
  const key = credentialKey(name, provider)
  const hostKey = credentialKey(name, 'host')
  const headers = attributionHeaders()
  const transport = createProxyTransport(config.proxyUrl)
  const fetcher = transport.fetch
  ctx.effect(() => () => transport.dispose(), 'chatgpt proxy transport')
  class ChatgptAdapter extends LlmAdapter {
    providerInfo() { return { id: provider, name: 'ChatGPT subscription' } }
    async listModels() {
      // Keep the provider selectable before its first sign-in.
      if (!await ctx.credentials.readRecord(key)) return []
      try {
        const grant = await accessGrant(ctx.credentials, key, { headers, fetcher })
        return withExtraModels(await models(grant, { headers, fetcher }), extraModels)
          .map(model => ({ ...model, provider }))
      } catch (error) { throw asLlmError(error) }
    }
    async resolveModel(_provider, model) {
      const reasoning = reasoningFor(model)
      return { provider, id: model, name: model, inputModalities: ['text'],
        ...reasoning === undefined ? {} : { reasoning } }
    }
    async *stream(options) {
      try {
        const grant = await accessGrant(ctx.credentials, key, { headers, fetcher, signal: options.signal })
        yield* streamResponse(options, grant, { headers, fetcher, timeoutMs })
      } catch (error) { throw asLlmError(error) }
    }
  }
  const adapter = new ChatgptAdapter()
  ctx.llm.registerAdapter([provider], adapter)
  ctx.authorization.registerFlow({
    key, label: 'ChatGPT subscription', methods: [{ id: 'oauth', label: 'Continue with ChatGPT' }],
    async run(session) {
      try { await login(ctx.credentials, key, hostKey, session, { headers, port, fetcher }) }
      catch (error) { throw asLlmError(error) }
    },
  })
  ctx.inject(['webServer', 'webRuntime'], web => {
    const management = createManagement(ctx, key, adapter, { provider, callbackPort: port, requestTimeoutMs: timeoutMs, proxyUrl: transport.proxyUrl, extraModels })
    registerManagement(web, management, provider, () => logout(ctx.credentials, key, { headers, fetcher }))
  })
  ctx.inject(['commands', 'userQuestions'], interactive => {
    interactive.commands.register({
      name: `${provider}-login`, description: 'Connect your ChatGPT subscription.', recordInput: false,
      async handler({ agent, signal }) {
        const controller = new AbortController()
        const pending = AbortSignal.any([signal, controller.signal])
        try {
          const outcome = await ctx.authorization.begin({ key, signal: pending, interaction: {
            notify(notice) {
              void interactive.userQuestions.ask({ agent, signal: pending, questions: [{
                id: 'chatgpt-login', question: `${notice.message}\n${notice.url ?? ''}`,
                options: [{ label: '已完成浏览器登录' }, { label: '取消登录' }],
              }] }).then(answer => {
                if (!answer.answers.some(item => item.selected.includes('已完成浏览器登录'))) controller.abort()
              }, error => { if (!pending.aborted) controller.abort(error) })
            },
            async prompt() { throw new Error('Unexpected ChatGPT authorization prompt.') },
          } })
          if (outcome.status !== 'authorized') return { kind: 'error', text: 'ChatGPT 登录已取消。' }
          return { kind: 'success', text: `ChatGPT 已连接。选择 ${provider} 下账户可用的模型。` }
        } catch (error) { return { kind: 'error', text: asLlmError(error).message } }
        finally { controller.abort() }
      },
    })
    interactive.commands.register({
      name: `${provider}-status`, description: 'Show the connected ChatGPT account.', recordInput: false,
      async handler() {
        const record = await ctx.credentials.readRecord(key)
        if (!record) return { kind: 'success', text: '尚未连接 ChatGPT。' }
        const grant = readRegistration(record)
        return { kind: 'success', text: `${grant.email ?? 'ChatGPT account'}：${grant.accessToken ? '已连接' : '已退出'}。额度和应用权限请在 ChatGPT Settings 中管理。` }
      },
    })
    interactive.commands.register({
      name: `${provider}-logout`, description: 'Revoke and sign out of the ChatGPT connection.', recordInput: false,
      async handler({ signal }) {
        try {
          await ctx.authorization.cancel(key)
          await logout(ctx.credentials, key, { signal, headers, fetcher })
          return { kind: 'success', text: 'ChatGPT 会话已撤销，登录令牌已清除。' }
        } catch (error) { return { kind: 'error', text: `${asLlmError(error).message} 退出未完成，可重试或在 ChatGPT Settings 中断开应用。` } }
      },
    })
  })
}
