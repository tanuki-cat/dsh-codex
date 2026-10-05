/**
 * Settings-page surface for the official openai-codex sign-in.
 *
 * The host registers pi-ai's provider logins but renders none of them, so this
 * module fills the provider-card seat for the llm-pi-ai family and draws a
 * sign-in card on the openai-codex row alone. It speaks only to the plugin's
 * own management endpoint.
 *
 * A browser bundle built by hand: DSH delivers client modules as factory
 * sources, and React is the host's external module.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-chatgpt',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useState } = React
    const NS = 'chatgptManagement'
    const STYLE_ID = 'dsh-llm-chatgpt/ChatgptCodex.css'
    // The one route this card signs into. Its flow is registered by the host;
    // the card is one button over that flow and owns no credential itself.
    const CODEX_ROUTE = 'openai-codex'
    // Every color, radius and control metric comes from the host's --dsw-* tokens,
    // so the card follows the active light/dark theme; the fallbacks only keep a
    // token-less host readable instead of unstyled.
    const css = `
.dsh-chatgpt-card{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.dsh-chatgpt-identity{display:flex;align-items:center;gap:10px;min-width:0}
.dsh-chatgpt-avatar{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-bg-skeleton,rgba(128,128,128,.16))}
.dsh-chatgpt-dot{box-sizing:border-box;flex:none;width:10px;height:10px;border-radius:50%;corner-shape:round;border:1.5px solid currentColor;background:currentColor}
.dsh-chatgpt-dot[data-state='done']{color:var(--dsw-alias-state-success-primary,#16a34a)}
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
.dsh-chatgpt-button[data-variant='danger']{padding:0 10px;color:var(--dsw-alias-state-error-primary,#d33)}
.dsh-chatgpt-button[data-variant='danger']:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(221,51,51,.08))}
.dsh-chatgpt-notice{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));font-size:12px;line-height:18px}
.dsh-chatgpt-link{color:var(--dsw-alias-state-business-primary,#2563eb);text-decoration:none}
.dsh-chatgpt-link:hover{text-decoration:underline}
.dsh-chatgpt-error{margin:0;color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;line-height:18px}
.dsh-chatgpt-spinner{box-sizing:border-box;flex:none;width:12px;height:12px;border:1.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.3));border-top-color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));border-radius:50%;corner-shape:round;animation:dsh-chatgpt-spin 1s linear infinite}
@keyframes dsh-chatgpt-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-chatgpt-spinner,.dsh-chatgpt-dot{animation:none}}
`
    function mountStyles() {
      if (typeof document === 'undefined' || document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-llm-chatgpt'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = css
      document.head.appendChild(tag)
      return () => tag.remove()
    }
    const dictionaries = {
      zh: {
        login: '登录 ChatGPT', relogin: '重新登录', disconnected: '未连接 ChatGPT 账户', connected: '已连接', expired: '凭据待刷新', incomplete: '凭据不完整', pending: '等待授权…',
        loading: '正在加载…', expires: '凭据有效期至', logout: '退出并撤销会话', cancel: '取消登录', open: '打开浏览器完成授权',
        hint: '使用官方 openai-codex 路由。点击登录后浏览器会打开授权页面；完成后此卡片会自动更新。',
        expiredHint: '访问令牌已过期；下次模型请求会尝试自动刷新。若刷新失败，请重新登录。',
        incompleteHint: '已存凭据缺少必要信息，请重新登录。',
        error: '操作失败，请检查网络与账户权限后重试。',
      },
      en: {
        login: 'Sign in to ChatGPT', relogin: 'Sign in again', disconnected: 'No ChatGPT account connected', connected: 'Connected', expired: 'Credential awaiting refresh', incomplete: 'Incomplete credential', pending: 'Waiting for authorization…',
        loading: 'Loading…', expires: 'Credential valid until', logout: 'Sign out and revoke session', cancel: 'Cancel sign-in', open: 'Open browser to authorize',
        hint: 'Uses the official openai-codex route. Signing in opens your browser; this card updates once it finishes.',
        expiredHint: 'Access token expired; the next model request will attempt an automatic refresh. Sign in again if it fails.',
        incompleteHint: 'The stored credential is missing required fields. Sign in again.',
        error: 'Operation failed. Check your network and account permissions, then retry.',
      },
    }

    /**
     * Controller over the plugin's own management endpoint.
     *
     * One attempt is driven per call; the page reflects whatever status the
     * endpoint last returned. Requests carry the capability the index
     * injection handed this browser and are aborted on unmount.
     */
    function createController(connection, environment = globalThis) {
      let snapshot = { loading: true, busy: false, status: undefined, error: false }
      const listeners = new Set()
      let disposed = false
      let timer
      let popup
      let popupUrl
      let sequence = 0
      const requests = new Set()
      const publish = patch => {
        if (disposed) return
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener(snapshot)
      }
      const stopPolling = () => {
        if (timer !== undefined) environment.clearTimeout(timer)
        timer = undefined
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
      const accept = (status, expected = sequence) => {
        if (expected !== sequence) return
        publish({ loading: false, busy: false, status, error: false })
        if (popup && status?.notice?.url && popupUrl !== status.notice.url) {
          popup.location.href = status.notice.url
          popupUrl = status.notice.url
        }
        if (status?.state !== 'pending') {
          stopPolling()
          popup?.close()
          popup = undefined
          popupUrl = undefined
          return
        }
        stopPolling()
        timer = environment.setTimeout(async () => {
          timer = undefined
          try { accept(await request('status'), expected) }
          catch {
            if (expected !== sequence) return
            popup?.close(); popup = undefined; popupUrl = undefined
            publish({ busy: false, error: true })
          }
        }, 500)
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        async load() {
          const expected = sequence
          try { accept(await request('status'), expected) }
          catch { if (expected === sequence) publish({ loading: false, error: true }) }
        },
        async act(operation) {
          const expected = ++sequence
          stopPolling()
          // Open synchronously in the user's click stack to avoid popup blockers.
          if (operation === 'login') {
            popup = environment.open('about:blank', '_blank') ?? undefined
            popupUrl = undefined
            if (popup) popup.opener = null
          }
          publish({ busy: true, error: false })
          try { accept(await request(operation, 'POST'), expected) }
          catch {
            if (expected !== sequence) return
            popup?.close(); popup = undefined; popupUrl = undefined
            publish({ busy: false, error: true })
          }
        },
        dispose() {
          disposed = true
          stopPolling()
          popup?.close()
          popup = undefined
          popupUrl = undefined
          for (const request of requests) request.abort()
          listeners.clear()
        },
      }
    }

    /**
     * The sign-in card for one provider row.
     *
     * The seat dispatches per settings namespace, and every pi-ai route shares
     * one namespace — so this component is handed *every* llm-pi-ai row and
     * must answer for the one route it signs into. Rendering unconditionally
     * would put a ChatGPT sign-in card on llama-cpp and command-code too.
     */
    function CodexCard({ provider, t }) {
      const connection = (globalThis.__DSH_CHATGPT_MANAGEMENT__ ?? {})[CODEX_ROUTE]
      const controller = React.useRef()
      const [state, setState] = useState({ loading: true, busy: false, status: undefined, error: false })
      useEffect(() => {
        if (connection === undefined) { setState(current => ({ ...current, loading: false })); return }
        const instance = createController(connection)
        controller.current = instance
        const off = instance.subscribe(setState)
        void instance.load()
        return () => { off(); instance.dispose(); controller.current = undefined }
      }, [connection])
      // The owner passes the row's directory entry; only its route id decides.
      if (connection === undefined || provider?.provider !== CODEX_ROUTE) return null
      const status = state.status
      const connected = status?.connected === true
      const expired = status?.credentialState === 'expired'
      const incomplete = status?.credentialState === 'incomplete'
      const stored = connected || expired || incomplete
      // The Host answers whether llm-pi-ai offers the flow at all; without it
      // there is nothing this card could sign into.
      if (status !== undefined && status.available === false) return null
      const account = status?.account
      const pending = status?.state === 'pending'
      const label = state.loading ? t('loading') : pending ? t('pending')
        : expired ? t('expired') : incomplete ? t('incomplete')
          : connected ? (account?.name || account?.email || t('connected')) : t('disconnected')
      const note = expired ? t('expiredHint') : incomplete ? t('incompleteHint')
        : connected
          ? [account?.plan && `plan: ${account.plan}`, account?.expires && `${t('expires')} ${new Date(account.expires).toLocaleDateString()}`].filter(Boolean).join(' · ')
          : t('hint')
      const loginUrl = status?.notice?.url
      const button = (text, variant, action) => h('button', {
        type: 'button', className: 'dsh-chatgpt-button', 'data-variant': variant,
        disabled: state.loading || state.busy, onClick: action,
      }, state.busy ? h('span', { className: 'dsh-chatgpt-spinner' }) : null, text)
      return h('div', { className: 'dsh-chatgpt-card' },
        h('div', { className: 'dsh-chatgpt-identity' },
          h('span', { className: 'dsh-chatgpt-avatar', 'aria-hidden': 'true' },
            h('span', { className: 'dsh-chatgpt-dot', 'data-state': state.loading || state.busy || pending ? 'ongoing' : connected ? 'done' : 'idle' })),
          h('div', { className: 'dsh-chatgpt-lines' },
            h('span', { className: 'dsh-chatgpt-name', role: 'status', 'aria-live': 'polite' },
              h('span', { className: 'dsh-chatgpt-nameText' }, label),
              connected && !pending && h('span', { className: 'dsh-chatgpt-tag', 'data-tone': 'success' }, t('connected'))),
            note && h('p', { className: 'dsh-chatgpt-note' }, note))),
        loginUrl && h('p', { className: 'dsh-chatgpt-notice' },
          h('a', { className: 'dsh-chatgpt-link', href: loginUrl, target: '_blank', rel: 'noopener noreferrer' }, t('open'))),
        h('div', { className: 'dsh-chatgpt-actions' },
          pending ? button(t('cancel'), 'danger', () => void controller.current?.act('cancel'))
            : connected ? h('span', { className: 'dsh-chatgpt-push' }, button(t('logout'), 'danger', () => void controller.current?.act('logout')))
              : button(t(stored ? 'relogin' : 'login'), 'primary', () => void controller.current?.act('login')),
          stored && !connected && !pending && h('span', { className: 'dsh-chatgpt-push' }, button(t('logout'), 'danger', () => void controller.current?.act('logout')))),
        state.error && h('p', { className: 'dsh-chatgpt-error', role: 'alert' }, t('error')))
    }

    function apply(ctx) {
      ctx.effect(() => mountStyles(), 'chatgpt sign-in styles')
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'chatgpt sign-in translations')
      const t = ctx.locale.bind(NS)
      // The seat is keyed by the row's settings namespace, so this renders on
      // every llm-pi-ai provider card — openai-codex among them — and nowhere
      // else. Registered unconditionally: the Host decides per request whether
      // the flow exists.
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card', key: 'llm-pi-ai',
        locale: NS, inject: () => ({ t }),
      }, CodexCard))
    }
    return { name: 'chatgpt-signin', inject: ['slots', 'locale'], apply, createController }
  },
})
