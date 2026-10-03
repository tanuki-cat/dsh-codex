window.__ModuleLoader__.load({
  id: 'dsh-llm-chatgpt',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React
    const NS = 'chatgptManagement'
    const STYLE_ID = 'dsh-llm-chatgpt/ChatgptSettings.css'
    // Every color, radius and control metric comes from the host's --dsw-* tokens,
    // so the page follows the active light/dark theme; the fallbacks only keep a
    // token-less host readable instead of unstyled.
    const css = `
.dsh-chatgpt-page{display:flex;flex-direction:column;gap:20px;max-width:720px;padding:4px 0 8px;color:var(--dsw-alias-label-primary,inherit)}
.dsh-chatgpt-header{display:flex;flex-direction:column;gap:6px}
.dsh-chatgpt-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dsh-chatgpt-intro{margin:0;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));font-size:14px;line-height:22px}
.dsh-chatgpt-section{display:flex;flex-direction:column;gap:16px}
.dsh-chatgpt-route{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;font-weight:500;line-height:20px}
.dsh-chatgpt-card{display:flex;flex-direction:column;gap:14px;box-sizing:border-box;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(128,128,128,.25));border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-settings-card-fill,transparent)}
.dsh-chatgpt-identity{display:flex;align-items:center;gap:10px;min-width:0}
.dsh-chatgpt-avatar{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-bg-skeleton,rgba(128,128,128,.16))}
.dsh-chatgpt-dot{box-sizing:border-box;flex:none;width:10px;height:10px;border-radius:50%;corner-shape:round;border:1.5px solid currentColor;background:currentColor}
.dsh-chatgpt-dot[data-state='done']{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dsh-chatgpt-dot[data-state='warning']{color:var(--dsw-alias-state-warn-primary,#f59e0b);background:transparent}
.dsh-chatgpt-dot[data-state='ongoing']{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));background:transparent;animation:dsh-chatgpt-pulse 1.5s ease-in-out infinite}
.dsh-chatgpt-dot[data-state='idle']{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));background:transparent}
@keyframes dsh-chatgpt-pulse{50%{opacity:.35}}
.dsh-chatgpt-lines{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-chatgpt-name{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:14px;line-height:22px}
.dsh-chatgpt-nameText{overflow-wrap:anywhere}
.dsh-chatgpt-note{margin:0;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));font-size:12px;line-height:18px}
.dsh-chatgpt-tag{display:inline-flex;align-items:center;flex:none;border-radius:999px;corner-shape:round;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dsh-chatgpt-tag[data-tone='success']{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent);color:var(--dsw-alias-state-success-primary,#16a34a)}
.dsh-chatgpt-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.dsh-chatgpt-push{display:inline-flex;margin-left:auto}
.dsh-chatgpt-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.dsh-chatgpt-button:disabled{cursor:not-allowed;opacity:.4}
.dsh-chatgpt-button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6))}
.dsh-chatgpt-button[data-variant='primary']{background:var(--dsw-alias-button-primary-fill,#111);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-chatgpt-button[data-variant='primary']:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#333)}
.dsh-chatgpt-button[data-variant='outline']{border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35))}
.dsh-chatgpt-button[data-variant='outline']:hover:not(:disabled),.dsh-chatgpt-button[data-variant='ghost']:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.dsh-chatgpt-button[data-variant='danger']{padding:0 10px;color:var(--dsw-alias-state-error-primary,#d33)}
.dsh-chatgpt-button[data-variant='danger']:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(221,51,51,.08))}
.dsh-chatgpt-block{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));padding-top:14px}
.dsh-chatgpt-blockHead{display:flex;align-items:baseline;gap:8px}
.dsh-chatgpt-blockTitle{margin:0;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));font-size:12px;font-weight:500;line-height:18px}
.dsh-chatgpt-count{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));font-size:12px;line-height:18px}
.dsh-chatgpt-models{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.dsh-chatgpt-model{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px)}
.dsh-chatgpt-model:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
.dsh-chatgpt-modelName{font-size:14px;line-height:22px;overflow-wrap:anywhere}
.dsh-chatgpt-modelId{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-chatgpt-chip{display:inline-flex;align-items:center;flex:none;box-sizing:border-box;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:999px;corner-shape:round;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}
.dsh-chatgpt-empty{margin:0;padding:12px;border:.5px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:var(--dsw-radius-lg,12px);color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));font-size:12px;line-height:18px;text-align:center}
.dsh-chatgpt-hint{margin:0;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));font-size:12px;line-height:18px}
.dsh-chatgpt-config{display:flex;flex-direction:column;margin:0}
.dsh-chatgpt-configRow{display:grid;grid-template-columns:minmax(0,150px) minmax(0,1fr);gap:12px;align-items:baseline;padding:7px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.dsh-chatgpt-configRow:last-child{border-bottom:none}
.dsh-chatgpt-configRow dt{color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.95));font-size:12px;line-height:18px}
.dsh-chatgpt-configRow dd{display:flex;flex-wrap:wrap;gap:6px;margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dsh-chatgpt-code{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.dsh-chatgpt-notice{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));font-size:12px;line-height:18px}
.dsh-chatgpt-link{color:var(--dsw-alias-state-business-primary,#2563eb);text-decoration:none}
.dsh-chatgpt-link:hover{text-decoration:underline}
.dsh-chatgpt-error{margin:0;color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;line-height:18px}
.dsh-chatgpt-spinner{box-sizing:border-box;flex:none;width:14px;height:14px;border:1.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.3));border-top-color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));border-radius:50%;corner-shape:round;animation:dsh-chatgpt-spin 1s linear infinite}
.dsh-chatgpt-spinnerSm{width:12px;height:12px}
@keyframes dsh-chatgpt-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-chatgpt-spinner,.dsh-chatgpt-dot{animation:none}}
.dsh-chatgpt-usage{align-self:flex-start;font-size:12px;line-height:18px}
`
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-llm-chatgpt'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = css
      document.head.appendChild(tag)
    }
    const dictionaries = {
      zh: {
        nav: 'ChatGPT', title: 'ChatGPT 订阅', description: '将 ChatGPT 账户连接到 DSH，使用账户允许的订阅额度。',
        connected: '已连接', disconnected: '未连接账户', pending: '等待浏览器授权…', authorized: '登录成功，正在使用 ChatGPT 订阅。',
        login: 'Continue with ChatGPT', cancel: '取消登录', logout: '退出并撤销会话', refresh: '刷新模型列表', refreshing: '正在刷新…',
        open: '打开浏览器完成授权', models: '可用模型', empty: '登录后刷新可用模型。', error: '操作失败，请检查网络与账户权限后重试。',
        loading: '正在加载…', provider: '模型路由', port: '登录回调端口', timeout: '请求超时（毫秒）', auto: '自动选择', proxyError: '代理请求失败，请确认代理地址正确且代理已启动，然后重试登录。',
        configuration: '当前配置', configHint: '配置字段在 profile 配置文件中修改，重启后生效。', proxy: '代理地址', inherited: '沿用 DSH 网络配置', manualModels: '手动添加的模型', noManualModels: '无',
        modelHint: '连接后在 DSH 模型选择器中选择该路由与模型。', usage: '管理 ChatGPT 用量与权限', disconnectedHint: '在浏览器中完成 ChatGPT 授权即可连接账户。',
        pendingHint: '浏览器完成授权后，此页面会自动更新。', manual: '手动',
        codexLogin: '登录 ChatGPT', codexDisconnected: '未连接 ChatGPT 账户', codexExpires: '凭据有效期至',
        codexHint: '使用官方 openai-codex 路由。点击登录后浏览器会打开授权页面；完成后此卡片会自动更新。',
      },
      en: {
        nav: 'ChatGPT', title: 'ChatGPT subscription', description: 'Connect your ChatGPT account to DSH and use your eligible plan allowance.',
        connected: 'Connected', disconnected: 'No account connected', pending: 'Waiting for browser authorization…', authorized: 'Signed in. You are using your ChatGPT plan.',
        login: 'Continue with ChatGPT', cancel: 'Cancel sign-in', logout: 'Sign out and revoke session', refresh: 'Refresh models', refreshing: 'Refreshing…',
        open: 'Open browser to authorize', models: 'Available models', empty: 'Sign in and refresh the available models.', error: 'Operation failed. Check your network and account permissions, then retry.',
        loading: 'Loading…', provider: 'Provider route', port: 'Callback port', timeout: 'Request timeout (milliseconds)', auto: 'Automatic', proxyError: 'The proxy request failed. Check the proxy address and make sure the proxy is running, then sign in again.',
        configuration: 'Current configuration', configHint: 'Edit these fields in your profile configuration and restart to apply.', proxy: 'Proxy address', inherited: 'Use DSH network configuration', manualModels: 'Manually added models', noManualModels: 'None',
        modelHint: 'Select this provider and a model in the DSH model selector after connecting.', usage: 'Manage ChatGPT usage and permissions', disconnectedHint: 'Authorize ChatGPT in your browser to connect an account.',
        pendingHint: 'This page updates automatically once the browser finishes authorization.', manual: 'Manual',
        codexLogin: 'Sign in to ChatGPT', codexDisconnected: 'No ChatGPT account connected', codexExpires: 'Credential valid until',
        codexHint: 'Uses the official openai-codex route. Signing in opens your browser; this card updates once it finishes.',
      },
    }

    function createController(connection, environment = globalThis) {
      let snapshot = { loading: true, refreshing: false, status: undefined, models: [], error: false, loginUrl: undefined }
      const listeners = new Set()
      let timer, disposed = false, polling = false
      const requests = new Set()
      const publish = patch => {
        if (disposed) return
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener(snapshot)
      }
      const request = async (operation, method = 'GET') => {
        const abort = new AbortController()
        requests.add(abort)
        try {
          const response = await environment.fetch(`${connection.path}/${operation}`, {
            method, headers: { 'x-dsh-chatgpt-token': connection.token }, signal: abort.signal,
            credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          })
          if (!response.ok) throw new Error('ChatGPT management failed')
          return await response.json()
        } finally { requests.delete(abort) }
      }
      async function refreshModels() {
        publish({ refreshing: true })
        try { const result = await request('models'); publish({ models: result.models, error: false, refreshing: false }) }
        catch { publish({ error: true, refreshing: false }) }
      }
      async function load() {
        try {
          const status = await request('status')
          publish({ loading: false, status, loginUrl: status.loginUrl, error: status.state === 'failed' })
          return status
        } catch { publish({ loading: false, error: true }); return undefined }
      }
      async function poll() {
        if (disposed || !polling) return
        const status = await load()
        if (disposed || !polling) return
        if (!status || status.state === 'pending') timer = environment.setTimeout(poll, 1000)
        else {
          polling = false
          if (status.connected) await refreshModels()
        }
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async load() {
          const status = await load()
          if (status?.state === 'pending') { polling = true; void poll() }
          else if (status?.connected) await refreshModels()
        },
        async login() {
          // Open synchronously in the user's click stack to avoid popup blockers.
          const popup = environment.open('about:blank', '_blank')
          if (popup) popup.opener = null
          publish({ error: false, loading: true })
          try {
            const { loginUrl } = await request('login', 'POST')
            publish({ loginUrl, loading: false, status: { ...snapshot.status, state: 'pending' } })
            if (popup) popup.location.href = loginUrl
            polling = true
            void poll()
          } catch { popup?.close(); publish({ loading: false, error: true }) }
        },
        async cancel() {
          polling = false
          environment.clearTimeout(timer)
          try { await request('cancel', 'POST'); await load() } catch { publish({ error: true }) }
        },
        async logout() {
          polling = false
          environment.clearTimeout(timer)
          publish({ loading: true })
          try {
            await request('logout', 'POST')
            publish({ models: [], loginUrl: undefined })
            await load()
          } catch { publish({ loading: false, error: true }) }
        },
        refreshModels,
        dispose() {
          disposed = true; polling = false
          environment.clearTimeout(timer)
          for (const request of requests) request.abort()
          listeners.clear()
        },
      }
    }

    function Account({ provider, connection, t }) {
      const controller = React.useRef()
      const [state, setState] = useState({ loading: true, refreshing: false, models: [], error: false })
      useEffect(() => {
        const instance = createController(connection)
        controller.current = instance
        const off = instance.subscribe(setState)
        void instance.load()
        return () => { off(); instance.dispose(); controller.current = undefined }
      }, [connection])
      const status = state.status
      const pending = status?.state === 'pending'
      const connected = Boolean(status?.connected)
      // Before the first status answer the page claims no verdict rather than reporting a disconnect.
      const settled = status !== undefined
      const label = !settled ? t('loading') : pending ? t('pending') : connected ? t('connected') : t('disconnected')
      const identity = !settled || (connected && !status.email) ? label : connected ? status.email : label
      const note = !settled ? '' : pending ? t('pendingHint') : connected ? t('authorized') : t('disconnectedHint')
      // The badge confirms a named connection; without an email the name line already carries the verdict.
      const badge = settled && connected && !pending && status.email ? t('connected') : undefined
      // The avatar dot carries the same verdict as the badge, in the shape of a person row.
      const dotState = !settled ? 'ongoing' : pending ? 'warning' : connected ? 'done' : 'idle'
      const button = (text, variant, action, busy = false) => h('button', {
        type: 'button', className: 'dsh-chatgpt-button', 'data-variant': variant,
        disabled: state.loading || busy, onClick: action,
      }, busy ? h('span', { className: 'dsh-chatgpt-spinner dsh-chatgpt-spinnerSm' }) : null, text)
      const models = state.models
      const extraModels = status?.extraModels ?? []
      const rows = [
        [t('provider'), h('span', { className: 'dsh-chatgpt-code' }, provider)],
        [t('port'), h('span', { className: 'dsh-chatgpt-code' }, String(status?.callbackPort || t('auto')))],
        [t('timeout'), h('span', { className: 'dsh-chatgpt-code' }, status?.requestTimeoutMs === undefined ? '—' : String(status.requestTimeoutMs))],
        [t('proxy'), h('span', { className: 'dsh-chatgpt-code' }, status?.proxyUrl || t('inherited'))],
        [t('manualModels'), extraModels.length
          ? extraModels.map(id => h('span', { key: id, className: 'dsh-chatgpt-chip' }, id))
          : h('span', null, t('noManualModels'))],
      ]
      return h('section', { className: 'dsh-chatgpt-section', 'aria-busy': state.loading || state.refreshing ? 'true' : undefined },
        h('h3', { className: 'dsh-chatgpt-route' }, provider),
        h('div', { className: 'dsh-chatgpt-card' },
          h('div', { className: 'dsh-chatgpt-identity' },
            h('span', { className: 'dsh-chatgpt-avatar', 'aria-hidden': 'true' },
              h('span', { className: 'dsh-chatgpt-dot', 'data-state': dotState })),
            h('div', { className: 'dsh-chatgpt-lines' },
              h('span', { className: 'dsh-chatgpt-name', role: 'status', 'aria-live': 'polite' },
                settled && (pending || state.loading) && h('span', { className: 'dsh-chatgpt-spinner' }),
                h('span', { className: 'dsh-chatgpt-nameText' }, identity),
                badge !== undefined && h('span', { className: 'dsh-chatgpt-tag', 'data-tone': 'success' }, badge)),
              note && h('p', { className: 'dsh-chatgpt-note' }, note))),
          state.loginUrl && h('p', { className: 'dsh-chatgpt-notice' },
            h('a', { className: 'dsh-chatgpt-link', href: state.loginUrl, target: '_blank', rel: 'noopener noreferrer' }, t('open'))),
          h('div', { className: 'dsh-chatgpt-actions' },
            pending ? button(t('cancel'), 'outline', () => controller.current?.cancel())
              : connected ? [
                button(state.refreshing ? t('refreshing') : t('refresh'), 'outline',
                  () => controller.current?.refreshModels(), state.refreshing),
                h('span', { className: 'dsh-chatgpt-push' }, button(t('logout'), 'danger', () => controller.current?.logout())),
              ] : button(t('login'), 'primary', () => controller.current?.login())),
          state.error && h('p', { className: 'dsh-chatgpt-error', role: 'alert' },
            t(status?.errorCode === 'PROXY_CONNECTION' ? 'proxyError' : 'error'))),
        h('div', { className: 'dsh-chatgpt-block' },
          h('div', { className: 'dsh-chatgpt-blockHead' },
            h('h4', { className: 'dsh-chatgpt-blockTitle' }, t('models')),
            models.length > 0 && h('span', { className: 'dsh-chatgpt-count' }, String(models.length))),
          models.length > 0
            ? h('ul', { className: 'dsh-chatgpt-models' }, ...models.map(model => h('li', { key: model.id, className: 'dsh-chatgpt-model' },
              h('span', { className: 'dsh-chatgpt-modelName' }, model.manual ? model.id : model.name || model.id),
              !model.manual && h('span', { className: 'dsh-chatgpt-modelId' }, model.id),
              model.manual && h('span', { className: 'dsh-chatgpt-chip' }, t('manual')))))
            : h('p', { className: 'dsh-chatgpt-empty' }, t('empty')),
          h('p', { className: 'dsh-chatgpt-hint' }, t('modelHint'))),
        h('div', { className: 'dsh-chatgpt-block' },
          h('div', { className: 'dsh-chatgpt-blockHead' }, h('h4', { className: 'dsh-chatgpt-blockTitle' }, t('configuration'))),
          h('dl', { className: 'dsh-chatgpt-config' }, ...rows.map(([term, value], index) => h('div', { key: index, className: 'dsh-chatgpt-configRow' },
            h('dt', null, term), h('dd', null, value)))),
          h('p', { className: 'dsh-chatgpt-hint' }, t('configHint'))))
    }

    function Page({ connections, t }) {
      return h('div', { className: 'dsh-chatgpt-page' },
        h('div', { className: 'dsh-chatgpt-header' }, h('h2', { className: 'dsh-chatgpt-title' }, t('title')), h('p', { className: 'dsh-chatgpt-intro' }, t('description'))),
        ...Object.entries(connections).map(([provider, connection]) => h(Account, { key: provider, provider, connection, t })),
        h('a', { className: 'dsh-chatgpt-link dsh-chatgpt-usage', href: 'https://chatgpt.com/#settings', target: '_blank', rel: 'noopener noreferrer' }, t('usage')))
    }

    /**
     * The official openai-codex route carries no sign-in surface of its own.
     * This card fills that seat on its provider row: the flow is registered by
     * the host adapter, so all this adds is the button that calls it and the
     * account facts it produced.
     *
     * The seat dispatches per settings namespace, and every pi-ai route shares
     * one namespace — so this component is handed *every* llm-pi-ai row and
     * must answer for the one route it signs into. Rendering unconditionally
     * would put a ChatGPT sign-in card on llama-cpp and command-code too.
     */
    function CodexCard({ provider, t }) {
      const connection = (globalThis.__DSH_CHATGPT_MANAGEMENT__ ?? {})['openai-codex']
      // The owner passes the row's directory entry; only its route id decides.
      const route = provider?.provider
      const [state, setState] = useState({ loading: true, busy: false, status: undefined, error: false })
      useEffect(() => {
        if (connection === undefined) { setState({ loading: false, busy: false, status: undefined, error: false }); return }
        let live = true
        const load = async () => {
          try {
            const response = await fetch(`${connection.path}/status`, {
              headers: { 'x-dsh-chatgpt-token': connection.token },
              credentials: 'same-origin', redirect: 'error', cache: 'no-store',
            })
            if (!response.ok) throw new Error('status failed')
            const status = await response.json()
            if (live) setState(current => ({ ...current, loading: false, status }))
          } catch { if (live) setState(current => ({ ...current, loading: false, error: true })) }
        }
        void load()
        return () => { live = false }
      }, [connection])
      if (connection === undefined || route !== 'openai-codex') return null
      const status = state.status
      const connected = status?.connected === true
      // The Host answers whether llm-pi-ai offers the flow at all; without it
      // there is nothing this card could sign into.
      if (status !== undefined && status.available === false) return null
      const act = async (operation) => {
        setState(current => ({ ...current, busy: true, error: false }))
        const popup = operation === 'login' ? globalThis.open('about:blank', '_blank') : undefined
        if (popup) popup.opener = null
        try {
          const response = await fetch(`${connection.path}/${operation}`, {
            method: 'POST', headers: { 'x-dsh-chatgpt-token': connection.token },
            credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          })
          if (!response.ok) throw new Error('operation failed')
          const next = await response.json()
          setState(current => ({ ...current, busy: false, status: next }))
          if (popup && next?.notice?.url) popup.location.href = next.notice.url
          else popup?.close()
        } catch { popup?.close(); setState(current => ({ ...current, busy: false, error: true })) }
      }
      const account = status?.account
      const label = state.loading ? t('loading') : connected ? (account?.name || account?.email || t('connected')) : t('codexDisconnected')
      const note = connected
        ? [account?.plan && `plan: ${account.plan}`, account?.expires && `${t('codexExpires')} ${new Date(account.expires).toLocaleDateString()}`].filter(Boolean).join(' · ')
        : t('codexHint')
      const loginUrl = status?.notice?.url
      return h('div', { className: 'dsh-chatgpt-block' },
        h('div', { className: 'dsh-chatgpt-identity' },
          h('span', { className: 'dsh-chatgpt-avatar', 'aria-hidden': 'true' },
            h('span', { className: 'dsh-chatgpt-dot', 'data-state': state.loading || state.busy ? 'ongoing' : connected ? 'done' : 'idle' })),
          h('div', { className: 'dsh-chatgpt-lines' },
            h('span', { className: 'dsh-chatgpt-name', role: 'status', 'aria-live': 'polite' },
              h('span', { className: 'dsh-chatgpt-nameText' }, label),
              connected && h('span', { className: 'dsh-chatgpt-tag', 'data-tone': 'success' }, t('connected'))),
            note && h('p', { className: 'dsh-chatgpt-note' }, note))),
        loginUrl && h('p', { className: 'dsh-chatgpt-notice' },
          h('a', { className: 'dsh-chatgpt-link', href: loginUrl, target: '_blank', rel: 'noopener noreferrer' }, t('open'))),
        h('div', { className: 'dsh-chatgpt-actions' },
          connected
            ? h('span', { className: 'dsh-chatgpt-push' }, h('button', {
              type: 'button', className: 'dsh-chatgpt-button', 'data-variant': 'danger',
              disabled: state.busy, onClick: () => void act('logout'),
            }, t('logout')))
            : h('button', {
              type: 'button', className: 'dsh-chatgpt-button', 'data-variant': 'primary',
              disabled: state.loading || state.busy, onClick: () => void act('login'),
            }, state.busy ? h('span', { className: 'dsh-chatgpt-spinner dsh-chatgpt-spinnerSm' }) : null, t('codexLogin'))),
        state.error && h('p', { className: 'dsh-chatgpt-error', role: 'alert' }, t('error')))
    }

    function apply(ctx) {
      const connections = globalThis.__DSH_CHATGPT_MANAGEMENT__ ?? {}
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'chatgpt settings translations')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'chatgpt-subscription', order: 15, label: () => t('nav'),
        inject: () => ({ connections, t }),
      }, Page))
      // The seat is keyed by the row's settings namespace, so this renders on
      // every llm-pi-ai provider card — openai-codex among them — and nowhere
      // else. Registered unconditionally: the Host decides per request whether
      // the flow exists.
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card', key: 'llm-pi-ai',
        locale: NS, inject: () => ({ t }),
      }, CodexCard))
    }
    return { name: 'chatgpt-settings', inject: ['slots', 'locale'], apply, createController }
  },
})
