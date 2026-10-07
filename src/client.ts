/**
 * Settings-page surface for the official openai-codex sign-in.
 *
 * The host registers pi-ai's provider logins but renders none of them, so this
 * module fills the provider-card seat for the llm-pi-ai family and draws a
 * sign-in card on the openai-codex row alone. It speaks only to the plugin's
 * own management endpoint.
 *
 * DSH loads the compiled IIFE as a factory; React comes from the host.
 */
import type * as React from 'react'

type ManagementStatus = {
  state: 'idle' | 'pending' | 'authorized' | 'cancelled' | 'failed'
  available: boolean
  connected: boolean
  patchAvailable?: boolean
  credentialState?: 'absent' | 'expired' | 'incomplete' | 'unexpired'
  account?: { name?: string; email?: string; plan?: string; expires?: number }
  notice?: { url?: string; message?: string }
}
type Snapshot = { loading: boolean; busy: boolean; status?: ManagementStatus; error: boolean }
type Connection = { path: string; token: string }
type PatchPreview = { added: string[]; preserved: string[]; total: number; unsupported: number; limited?: { id: string; omittedEfforts: string[] }[]; source: string; signature: string; unavailable?: string }
type Environment = {
  fetch: typeof fetch
  open(url: string, target: string): Window | null
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  addEventListener?: (name: string, callback: () => void) => void
  removeEventListener?: (name: string, callback: () => void) => void
}
type CardProps = { provider?: { provider: string }; t: (key: string) => string }
type ClientContext = {
  effect(factory: () => () => void, label: string): void
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void; bind(namespace: string): (key: string) => string }
  slots: { inject(name: string, callback: () => void): void; register(entry: { name: string; key: string; locale: string; inject: () => { t: (key: string) => string } }, view: (props: CardProps) => React.ReactNode): void }
}
declare global {
  interface Window { __ModuleLoader__: { load(value: { id: string; factory(require: (id: 'react') => typeof import('react')): object }): void } }
  var __DSH_CHATGPT_MANAGEMENT__: Record<string, Connection> | undefined
}
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
.dsh-chatgpt-card{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
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
.dsh-chatgpt-preview{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));border-radius:var(--dsw-radius-md,10px)}
.dsh-chatgpt-preview-title{margin:0;font-size:12px;font-weight:600;line-height:18px}
.dsh-chatgpt-models{display:flex;flex-wrap:wrap;gap:6px}
.dsh-chatgpt-model{padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-skeleton,rgba(128,128,128,.1));font-size:12px;overflow-wrap:anywhere}
.dsh-chatgpt-details{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.dsh-chatgpt-details summary{cursor:pointer}
.dsh-chatgpt-details .dsh-chatgpt-note{margin-top:6px;overflow-wrap:anywhere}
.dsh-chatgpt-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:32px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsh-chatgpt-button:disabled{cursor:not-allowed;opacity:.4}
.dsh-chatgpt-button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3b82f6))}
.dsh-chatgpt-button[data-variant='primary']{background:var(--dsw-alias-button-primary-fill,#111);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-chatgpt-button[data-variant='primary']:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#333)}
.dsh-chatgpt-button[data-variant='secondary']{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));background:var(--dsw-alias-bg-primary,transparent)}
.dsh-chatgpt-button[data-variant='secondary']:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
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
        loading: '正在加载…', expires: '凭据有效期至', logout: '退出登录并删除本地凭据', cancel: '取消登录', open: '打开浏览器完成授权',
        hint: '使用官方 openai-codex 路由。点击登录后浏览器会打开授权页面；完成后此卡片会自动更新。',
        expiredHint: '访问令牌已过期；下次模型请求会尝试自动刷新。若刷新失败，请重新登录。',
        incompleteHint: '已存凭据缺少必要信息，请重新登录。',
        error: '操作失败，请检查网络与账户权限后重试。',
        patchPreview: '检查缺失模型', patchApply: '确认补充缺失模型', patchEmpty: '没有可补充的模型', patchError: '无法安全获取或应用 Codex 模型列表，请稍后重试。', patchCount: '拟补充模型', patchPreserved: '保留模型', patchUnverified: '待核实', patchFallback: '远端目录不可用，以下仅为本机目录；未写入补丁', patchLimited: '未支持推理等级', patchTotal: '远端条目', patchDetails: '查看模型与来源详情', logoutShort: '退出登录', plan: '订阅',
      },
      en: {
        login: 'Sign in to ChatGPT', relogin: 'Sign in again', disconnected: 'No ChatGPT account connected', connected: 'Connected', expired: 'Credential awaiting refresh', incomplete: 'Incomplete credential', pending: 'Waiting for authorization…',
        loading: 'Loading…', expires: 'Credential valid until', logout: 'Sign out and delete local credentials', cancel: 'Cancel sign-in', open: 'Open browser to authorize',
        hint: 'Uses the official openai-codex route. Signing in opens your browser; this card updates once it finishes.',
        expiredHint: 'Access token expired; the next model request will attempt an automatic refresh. Sign in again if it fails.',
        incompleteHint: 'The stored credential is missing required fields. Sign in again.',
        error: 'Operation failed. Check your network and account permissions, then retry.',
        patchPreview: 'Check missing models', patchApply: 'Confirm missing model patch', patchEmpty: 'No missing models to add', patchError: 'Cannot safely retrieve or apply Codex models. Try again later.', patchCount: 'Models to add', patchPreserved: 'Preserved models', patchUnverified: 'Unverified', patchFallback: 'Remote catalog unavailable; installed models only. No patch applied.', patchLimited: 'Unsupported reasoning efforts', patchTotal: 'Remote entries', patchDetails: 'Model and source details', logoutShort: 'Sign out', plan: 'Plan',
      },
    }

    /**
     * Controller over the plugin's own management endpoint.
     *
     * One attempt is driven per call; the page reflects whatever status the
     * endpoint last returned. Requests carry the capability the index
     * injection handed this browser and are aborted on unmount.
     */
    function createController(connection: Connection, environment: Environment = globalThis as unknown as Environment) {
      let snapshot: Snapshot = { loading: true, busy: false, status: undefined, error: false }
      const listeners = new Set<(state: Snapshot) => void>()
      let disposed = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let pollingRequest: AbortController | undefined
      let popup: Window | undefined
      let popupUrl: string | undefined
      let sequence = 0
      const requests = new Set<AbortController>()
      const publish = (patch: Partial<Snapshot>) => {
        if (disposed) return
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener(snapshot)
      }
      const stopPolling = () => {
        if (timer !== undefined) environment.clearTimeout(timer)
        timer = undefined
        pollingRequest?.abort()
        pollingRequest = undefined
      }
      const request = async (operation: 'status' | 'login' | 'cancel' | 'logout', method = 'GET', abort = new AbortController()): Promise<ManagementStatus> => {
        requests.add(abort)
        try {
          const response = await environment.fetch(`${connection.path}/${operation}`, {
            method, headers: { 'x-dsh-chatgpt-token': connection.token }, signal: abort.signal,
            credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          })
          if (!response.ok) throw new Error('ChatGPT management failed')
          return await response.json() as ManagementStatus
        } finally { requests.delete(abort) }
      }
      let pollFailures = 0
      const schedulePoll = (expected: number, delay: number) => {
        stopPolling()
        timer = environment.setTimeout(async () => {
          timer = undefined
          const abort = new AbortController()
          pollingRequest = abort
          try { accept(await request('status', 'GET', abort), expected) }
          catch {
            if (disposed || expected !== sequence || abort.signal.aborted) return
            publish({ busy: false, error: true })
            pollFailures += 1
            schedulePoll(expected, Math.min(10_000, 500 * 2 ** pollFailures))
          } finally { if (pollingRequest === abort) pollingRequest = undefined }
        }, delay)
      }
      const accept = (status: ManagementStatus, expected = sequence) => {
        if (disposed || expected !== sequence) return
        pollFailures = 0
        publish({ loading: false, busy: false, status, error: false })
        if (popup && status?.notice?.url && popupUrl !== status.notice.url) {
          try {
            popup.location.href = status.notice.url
            popupUrl = status.notice.url
          } catch {
            try { popup.close() } catch {}
            popup = undefined
            popupUrl = undefined
          }
        }
        if (status?.state !== 'pending') {
          stopPolling()
          popup?.close()
          popup = undefined
          popupUrl = undefined
          return
        }
        schedulePoll(expected, 500)
      }
      let loadingRequest = false
      const load = async () => {
        if (disposed || loadingRequest || snapshot.busy || snapshot.status?.state === 'pending') return
        loadingRequest = true
        const expected = sequence
        try { accept(await request('status'), expected) }
        catch { if (expected === sequence) publish({ loading: false, error: true }) }
        finally { loadingRequest = false }
      }
      environment.addEventListener?.('focus', load)
      return {
        getSnapshot: () => snapshot,
        subscribe(listener: (state: Snapshot) => void) { listeners.add(listener); return () => listeners.delete(listener) },
        load,
        async act(operation: 'login' | 'cancel' | 'logout') {
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
          environment.removeEventListener?.('focus', load)
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
    function CodexCard({ provider, t }: CardProps) {
      const connection = (globalThis.__DSH_CHATGPT_MANAGEMENT__ ?? {})[CODEX_ROUTE]
      const controller = React.useRef<ReturnType<typeof createController> | undefined>(undefined)
      const [state, setState] = useState<Snapshot>({ loading: true, busy: false, status: undefined, error: false })
      const [patch, setPatch] = useState<PatchPreview | undefined>(undefined)
      const [patchBusy, setPatchBusy] = useState(false)
      const [patchError, setPatchError] = useState(false)
      const inspectPatch = async (apply = false) => {
        if (!connection || patchBusy) return
        setPatchBusy(true); setPatchError(false)
        try {
          const response = await fetch(`${connection.path}/${apply ? 'models-apply' : 'models-preview'}`, {
            method: apply ? 'POST' : 'GET',
            headers: { 'x-dsh-chatgpt-token': connection.token, ...(apply && patch ? { 'x-dsh-model-patch': patch.signature } : {}) },
            credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          })
          if (!response.ok) throw new Error('Model patch unavailable')
          if (apply) { setPatch(undefined); return }
          const value = await response.json() as PatchPreview
          setPatch(value)
        } catch { setPatch(undefined); setPatchError(true) }
        finally { setPatchBusy(false) }
      }
      useEffect(() => {
        if (provider?.provider !== CODEX_ROUTE) return
        if (connection === undefined) { setState(current => ({ ...current, loading: false })); return }
        const instance = createController(connection)
        controller.current = instance
        const off = instance.subscribe(setState)
        void instance.load()
        return () => { off(); instance.dispose(); controller.current = undefined }
      }, [connection, provider?.provider])
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
          ? [account?.plan && `${t('plan')}: ${account.plan}`, account?.expires && `${t('expires')} ${new Date(account.expires).toLocaleDateString()}`].filter(Boolean).join(' · ')
          : t('hint')
      const loginUrl = status?.notice?.url
      const button = (text: string, variant: string, action: () => void) => h('button', {
        type: 'button', className: 'dsh-chatgpt-button', 'data-variant': variant,
        disabled: state.loading || state.busy || patchBusy, onClick: action,
        title: variant === 'danger' && stored && !pending ? t('logout') : undefined,
      }, state.busy || patchBusy ? h('span', { className: 'dsh-chatgpt-spinner', 'aria-hidden': 'true' }) : null, text)
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
        h('div', { className: 'dsh-chatgpt-actions', 'aria-busy': state.busy || patchBusy },
          status?.patchAvailable && connected && !pending && button(t('patchPreview'), 'secondary', () => void inspectPatch()),
          pending ? button(t('cancel'), 'danger', () => void controller.current?.act('cancel'))
            : connected ? h('span', { className: 'dsh-chatgpt-push' }, button(t('logoutShort'), 'danger', () => void controller.current?.act('logout')))
              : button(t(stored ? 'relogin' : 'login'), 'primary', () => void controller.current?.act('login')),
          stored && !connected && !pending && h('span', { className: 'dsh-chatgpt-push' }, button(t('logoutShort'), 'danger', () => void controller.current?.act('logout')))),
        state.error && h('p', { className: 'dsh-chatgpt-error', role: 'alert' }, t('error')),

        patch && h('section', { className: 'dsh-chatgpt-preview', 'aria-live': 'polite' },
          h('p', { className: 'dsh-chatgpt-preview-title' }, patch.unavailable ? t('patchFallback') : patch.added.length ? `${t('patchCount')} (${patch.added.length})` : t('patchEmpty')),
          !patch.unavailable && patch.added.length > 0 && h('div', { className: 'dsh-chatgpt-models' }, ...patch.added.map(id => h('span', { key: id, className: 'dsh-chatgpt-model' }, id))),
          h('p', { className: 'dsh-chatgpt-note' }, `${t('patchPreserved')}: ${patch.preserved.length} · ${t('patchTotal')}: ${patch.total} · ${t('patchUnverified')}: ${patch.unsupported}`),
          h('details', { className: 'dsh-chatgpt-details' }, h('summary', null, t('patchDetails')),
            h('p', { className: 'dsh-chatgpt-note' }, patch.preserved.join(', ')),
            h('p', { className: 'dsh-chatgpt-note' }, `${t('patchLimited')}: ${patch.limited?.map(item => `${item.id} (${item.omittedEfforts.join(', ')})`).join('; ') || '0'}`),
            h('p', { className: 'dsh-chatgpt-note' }, patch.source)),
          !patch.unavailable && patch.added.length > 0 && h('div', { className: 'dsh-chatgpt-actions' }, button(t('patchApply'), 'primary', () => void inspectPatch(true)))),
        patchError && h('p', { className: 'dsh-chatgpt-error', role: 'alert' }, t('patchError')))
    }

    function apply(ctx: ClientContext) {
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
