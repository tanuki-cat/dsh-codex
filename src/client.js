window.__ModuleLoader__.load({
  id: 'dsh-llm-chatgpt',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React
    const NS = 'chatgptManagement'
    const dictionaries = {
      zh: {
        nav: 'ChatGPT', title: 'ChatGPT 订阅', description: '将 ChatGPT 账户连接到 DSH，使用账户允许的订阅额度。',
        connected: '已连接', disconnected: '未连接', pending: '等待浏览器授权…', authorized: '登录成功，正在使用 ChatGPT 订阅。',
        login: 'Continue with ChatGPT', cancel: '取消登录', logout: '退出并撤销会话', refresh: '刷新模型列表',
        open: '打开浏览器完成授权', models: '可用模型', empty: '登录后刷新可用模型。', error: '操作失败，请检查网络与账户权限后重试。',
        loading: '正在加载…', provider: '模型路由', port: '登录回调端口', timeout: '请求超时（毫秒）', auto: '自动选择', proxyError: '代理请求失败，请确认代理地址正确且代理已启动，然后重试登录。',
        configuration: '当前配置', configHint: '配置字段在 profile 配置文件中修改，重启后生效。', proxy: '代理地址', inherited: '沿用 DSH 网络配置', manualModels: '手动添加的模型', noManualModels: '无',
        modelHint: '连接后在 DSH 模型选择器中选择该路由与模型。', usage: '管理 ChatGPT 用量与权限',
      },
      en: {
        nav: 'ChatGPT', title: 'ChatGPT subscription', description: 'Connect your ChatGPT account to DSH and use your eligible plan allowance.',
        connected: 'Connected', disconnected: 'Not connected', pending: 'Waiting for browser authorization…', authorized: 'Signed in. You are using your ChatGPT plan.',
        login: 'Continue with ChatGPT', cancel: 'Cancel sign-in', logout: 'Sign out and revoke session', refresh: 'Refresh models',
        open: 'Open browser to authorize', models: 'Available models', empty: 'Sign in and refresh the available models.', error: 'Operation failed. Check your network and account permissions, then retry.',
        loading: 'Loading…', provider: 'Provider route', port: 'Callback port', timeout: 'Request timeout (milliseconds)', auto: 'Automatic', proxyError: 'The proxy request failed. Check the proxy address and make sure the proxy is running, then sign in again.',
        configuration: 'Current configuration', configHint: 'Edit these fields in your profile configuration and restart to apply.', proxy: 'Proxy address', inherited: 'Use DSH network configuration', manualModels: 'Manually added models', noManualModels: 'None',
        modelHint: 'Select this provider and a model in the DSH model selector after connecting.', usage: 'Manage ChatGPT usage and permissions',
      },
    }

    function createController(connection, environment = globalThis) {
      let snapshot = { loading: true, status: undefined, models: [], error: false, loginUrl: undefined }
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
        try { const result = await request('models'); publish({ models: result.models, error: false }) }
        catch { publish({ error: true }) }
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

    const style = {
      page: { maxWidth: 780, padding: '24px', color: 'inherit' },
      card: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 16, padding: 20, margin: '18px 0' },
      controls: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 },
      button: { border: '1px solid rgba(128,128,128,.35)', borderRadius: 10, background: 'transparent', color: 'inherit', padding: '10px 16px', cursor: 'pointer', font: 'inherit' },
      primary: { border: '1px solid #111', borderRadius: 10, background: '#111', color: '#fff', padding: '10px 16px', cursor: 'pointer', font: 'inherit' },
      muted: { opacity: 0.65, lineHeight: 1.6 },
    }
    function Account({ provider, connection, t }) {
      const controller = React.useRef()
      const [state, setState] = useState({ loading: true, models: [], error: false })
      useEffect(() => {
        const instance = createController(connection)
        controller.current = instance
        const off = instance.subscribe(setState)
        void instance.load()
        return () => { off(); instance.dispose(); controller.current = undefined }
      }, [connection])
      const status = state.status
      const pending = status?.state === 'pending'
      const button = (label, action, primary = false) => h('button', {
        type: 'button', disabled: state.loading, style: primary ? style.primary : style.button,
        onClick: action,
      }, label)
      return h('section', { style: style.card },
        h('h3', null, provider),
        h('p', { role: 'status', 'aria-live': 'polite' }, state.loading ? t('loading') : pending ? t('pending') : status?.connected ? t('connected') : t('disconnected')),
        status?.email && h('p', null, status.email),
        status?.state === 'authorized' && h('p', null, t('authorized')),
        state.error && h('p', { role: 'alert', style: { color: '#d33' } }, t(status?.errorCode === 'PROXY_CONNECTION' ? 'proxyError' : 'error')),
        h('div', { style: style.controls }, pending ? button(t('cancel'), () => controller.current?.cancel())
          : button(t('login'), () => controller.current?.login(), true),
        status?.connected && !pending && button(t('logout'), () => controller.current?.logout()),
        status?.connected && button(t('refresh'), () => controller.current?.refreshModels())),
        state.loginUrl && h('p', null, h('a', { href: state.loginUrl, target: '_blank', rel: 'noopener noreferrer' }, t('open'))),
        h('h4', null, t('models')),
        state.models.length ? h('ul', null, ...state.models.map(model => h('li', { key: model.id }, `${model.name} · ${model.id}`)))
          : h('p', { style: style.muted }, t('empty')),
        h('p', { style: style.muted }, t('modelHint')),
        h('h4', null, t('configuration')),
        h('dl', null, h('dt', null, t('provider')), h('dd', null, provider),
          h('dt', null, t('port')), h('dd', null, status?.callbackPort || t('auto')),
          h('dt', null, t('timeout')), h('dd', null, status?.requestTimeoutMs ?? '—'),
          h('dt', null, t('proxy')), h('dd', null, status?.proxyUrl || t('inherited')),
          h('dt', null, t('manualModels')), h('dd', null, status?.extraModels?.join(', ') || t('noManualModels'))),
        h('p', { style: style.muted }, t('configHint')))
    }
    function Page({ connections, t }) {
      return h('div', { style: style.page }, h('h2', null, t('title')), h('p', { style: style.muted }, t('description')),
        ...Object.entries(connections).map(([provider, connection]) => h(Account, { key: provider, provider, connection, t })),
        h('a', { href: 'https://chatgpt.com/#settings', target: '_blank', rel: 'noopener noreferrer' }, t('usage')))
    }
    function apply(ctx) {
      const connections = globalThis.__DSH_CHATGPT_MANAGEMENT__ ?? {}
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'chatgpt settings translations')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'chatgpt-subscription', order: 15, label: () => t('nav'),
        inject: () => ({ connections, t }),
      }, Page))
    }
    return { name: 'chatgpt-settings', inject: ['slots', 'locale'], apply, createController }
  },
})
