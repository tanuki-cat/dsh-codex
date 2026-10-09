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
import { createUsageController, createUsageView, usageCss, usageDictionaries } from './client-usage.js'
import type { ModelStore, UsageController } from './client-usage.js'
import { createUsageCommandView, usageCommandCss, usageCommandDictionaries } from './client-usage-command.js'
import type { UsagePrimitives, UsageCommandNode } from './client-usage-command.js'

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
type PatchReason = 'settings-unavailable' | 'settings-read-only' | 'route-missing' | 'sign-in-required'
  | 'credential-expired' | 'credential-incomplete' | 'source-unavailable' | 'config-unmergeable'
  | 'conflict' | 'registration-unconfirmed' | 'native-catalog-unavailable'
type PatchPreview = {
  added: string[]
  preserved: string[]
  total: number
  unsupported: number
  limited?: { id: string; omittedEfforts: string[] }[]
  source: string
  signature: string
  unavailable?: string
  reason?: PatchReason
  fetchedAt?: number
  clientVersion?: string
  current?: number
  alreadySelectable?: string[]
  unlisted?: string[]
  understated?: { id: string; declared: number; source: number }[]
  overstated?: { id: string; declared: number; source: number }[]
  replacesCatalog?: boolean
  kind?: 'restore'
  removed?: string[]
  resets?: string[]
  restored?: boolean
  nativeAdded?: string[]
  nativeAvailable?: boolean
  hasExplicitCatalog?: boolean
  clientVersionSource?: string
  capabilityStatus?: 'catalog-only' | 'registered-only'
  inheritedOutputLimits?: string[]
  windows?: { id: string; contextWindow: number; maxContextWindow?: number }[]
}
type PatchApplied = PatchPreview & {
  applied: string[]
  before?: { revision?: number; models?: string[] }
  after?: { revision?: number; models?: string[] }
}
type Environment = {
  fetch: typeof fetch
  open(url: string, target: string): Window | null
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
  addEventListener?: (name: string, callback: () => void) => void
  removeEventListener?: (name: string, callback: () => void) => void
}
type CardProps = { provider?: { provider: string }; t: (key: string) => string }
type UsageContext = ClientContext & {
  modelDirectories: { directoryFor(id: string): { store: ModelStore; load(): Promise<unknown> } }
  sessions: { subagentAddress(id: string): unknown }
  connection: { isLoopback: boolean }
}
type ClientContext = {
  inject?(services: string[], callback: (ctx: UsageContext) => void): void
  effect(factory: () => () => void, label: string): void
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void; bind(namespace: string): (key: string) => string }
  slots: { inject(name: string, callback: () => void): void; register(entry: { name: string; key: string; locale: string; inject: () => { t: (key: string) => string } }, view: (props: CardProps) => React.ReactNode): void }
}
declare global {
  interface Window { __ModuleLoader__: { load(value: { id: string; factory(require: { (id: 'react'): typeof import('react'); (id: '@deepseek-ai/dsh-client-ui-primitives'): UsagePrimitives }): object }): void } }
  var __DSH_CHATGPT_MANAGEMENT__: Record<string, Connection> | undefined
}
window.__ModuleLoader__.load({
  id: 'dsh-llm-chatgpt',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { createElement: h, useEffect, useState } = React
    const NS = 'chatgptManagement'
    const STYLE_ID = 'dsh-llm-chatgpt/ChatgptCodex.css'
    const usageControllers = new Set<UsageController>()
    let usagePaused = false
    const invalidateUsage = (paused = false) => { usagePaused = paused; for (const controller of usageControllers) controller.setPaused(paused) }
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
      tag.textContent = css + usageCss + usageCommandCss
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
        patchSelected: '当前可选', patchSourceAt: '列表获取于', patchClient: '请求版本', patchWrites: '写入后列表', patchHandover: '显式 models 会接管整个目录：未列出的模型将不可选。', patchUnlisted: '来源未收录（保留但来源列表中没有）', patchUnderstated: '声明的上下文小于来源给出的窗口',
        patchApplied: '已补充模型', patchRevision: '配置修订',
        patchRestore: '检查恢复原生目录', patchRestoreConfirm: '确认恢复原生目录', patchRestored: '已恢复原生目录', patchRestoreEmpty: '已使用原生目录，无需恢复',
        patchRestoreWarning: '确认后清空显式 models，恢复当前安装的 pi-ai 目录。下列条目的显式能力配置将被移除，非原生模型将不可选；其它路由设置不变。',
        patchRemoved: '将不再可选', patchResets: '将恢复默认能力的条目', patchNativeAdded: '同步的原生模型',
        patchCatalogOnly: '仅验证目录信息；尚未验证实际推理或完整协议能力。', patchRegisteredOnly: '仅确认模型已注册；未执行推理，完整能力仍取决于已安装 pi-ai。',
        patchOverstated: '显式上下文大于远端默认窗口（保留已有配置；若非有意覆盖，请检查模型设置或恢复原生目录）',
        patchOutputDefaults: '以下模型未提供输出上限，使用宿主默认值', patchWindows: '上下文窗口 / 最大配置覆盖上限',
        reasonNative: '无法读取已安装的原生目录，未修改显式模型列表。',
        reasonSettingsUnavailable: '模型设置服务不可用。', reasonSettingsReadOnly: '模型设置为只读，无法写入补丁。', reasonRouteMissing: '尚未声明 openai-codex 路由；请先在模型页用「从目录添加」声明它。', reasonSignIn: '请先登录 ChatGPT。', reasonExpired: '凭据已过期，请重新登录或等待刷新后重试。', reasonIncomplete: '凭据缺少 account ID，请重新登录。', reasonSource: '无法获取 Codex 模型列表（网络或接口不可用），未写入任何模型。', reasonConfig: '现有模型配置无法安全合并，未做改动。', reasonConflict: '模型来源或配置已变化，请重新预览后再确认。', reasonRegistration: '配置已写入，但模型未能注册；请检查宿主设置。',
      },
      en: {
        login: 'Sign in to ChatGPT', relogin: 'Sign in again', disconnected: 'No ChatGPT account connected', connected: 'Connected', expired: 'Credential awaiting refresh', incomplete: 'Incomplete credential', pending: 'Waiting for authorization…',
        loading: 'Loading…', expires: 'Credential valid until', logout: 'Sign out and delete local credentials', cancel: 'Cancel sign-in', open: 'Open browser to authorize',
        hint: 'Uses the official openai-codex route. Signing in opens your browser; this card updates once it finishes.',
        expiredHint: 'Access token expired; the next model request will attempt an automatic refresh. Sign in again if it fails.',
        incompleteHint: 'The stored credential is missing required fields. Sign in again.',
        error: 'Operation failed. Check your network and account permissions, then retry.',
        patchPreview: 'Check missing models', patchApply: 'Confirm missing model patch', patchEmpty: 'No missing models to add', patchError: 'Cannot safely retrieve or apply Codex models. Try again later.', patchCount: 'Models to add', patchPreserved: 'Preserved models', patchUnverified: 'Unverified', patchFallback: 'Remote catalog unavailable; installed models only. No patch applied.', patchLimited: 'Unsupported reasoning efforts', patchTotal: 'Remote entries', patchDetails: 'Model and source details', logoutShort: 'Sign out', plan: 'Plan',
        patchSelected: 'Currently selectable', patchSourceAt: 'Listing fetched', patchClient: 'Requested as', patchWrites: 'Catalogue after writing', patchHandover: 'An explicit models list replaces the whole catalogue: models not listed here become unselectable.', patchUnlisted: 'Not in the source listing (kept anyway)', patchUnderstated: 'Declared context below the window the source gives',
        patchApplied: 'Models added', patchRevision: 'Config revision',
        patchRestore: 'Review native catalog restoration', patchRestoreConfirm: 'Confirm native catalog restoration', patchRestored: 'Native catalog restored', patchRestoreEmpty: 'Already using the native catalog',
        patchRestoreWarning: 'Confirmation clears explicit models and restores the installed pi-ai catalog. Explicit capabilities on these entries will be removed and non-native models become unavailable; other route settings stay unchanged.',
        patchRemoved: 'Models becoming unavailable', patchResets: 'Entries reverting to default capabilities', patchNativeAdded: 'Native models synchronized',
        patchCatalogOnly: 'Catalog metadata only; inference and full protocol capabilities have not been verified.', patchRegisteredOnly: 'Registration confirmed only; no inference was run. Full capabilities depend on the installed pi-ai.',
        patchOverstated: 'Explicit context exceeds the remote default (preserved; if unintended, review model settings or restore the native catalog)',
        patchOutputDefaults: 'These models omit an output limit and use the host default', patchWindows: 'Context window / maximum configuration override',
        reasonNative: 'The installed native catalog cannot be read. Explicit models were not changed.',
        reasonSettingsUnavailable: 'The model settings service is unavailable.', reasonSettingsReadOnly: 'Model settings are read-only, so no patch can be written.', reasonRouteMissing: 'The openai-codex route is not declared yet; add it from the catalog on the Models page first.', reasonSignIn: 'Sign in to ChatGPT first.', reasonExpired: 'The credential expired. Sign in again, or retry after it refreshes.', reasonIncomplete: 'The credential has no account ID. Sign in again.', reasonSource: 'The Codex model listing could not be retrieved (network or endpoint). No model was added.', reasonConfig: 'The existing model configuration cannot be safely merged; nothing was changed.', reasonConflict: 'The model source or configuration changed. Preview again before confirming.', reasonRegistration: 'The configuration was saved, but the models did not register. Check the host settings.',
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
        if (snapshot.status?.state === 'pending' && status?.state !== 'pending') invalidateUsage()
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
          invalidateUsage(true)
          const expected = ++sequence
          stopPolling()
          // Open synchronously in the user's click stack to avoid popup blockers.
          if (operation === 'login') {
            popup = environment.open('about:blank', '_blank') ?? undefined
            popupUrl = undefined
            if (popup) popup.opener = null
          }
          publish({ busy: true, error: false })
          try { accept(await request(operation, 'POST'), expected); if (expected === sequence) invalidateUsage(snapshot.status?.state === 'pending') }
          catch {
            if (expected !== sequence) return
            popup?.close(); popup = undefined; popupUrl = undefined
            publish({ busy: false, error: true })
            invalidateUsage()
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
    /** Locale key for one refusal reason; every code has its own remedy. */
    const REASON_KEYS: Record<PatchReason, string> = {
      'settings-unavailable': 'reasonSettingsUnavailable',
      'settings-read-only': 'reasonSettingsReadOnly',
      'route-missing': 'reasonRouteMissing',
      'sign-in-required': 'reasonSignIn',
      'credential-expired': 'reasonExpired',
      'credential-incomplete': 'reasonIncomplete',
      'source-unavailable': 'reasonSource',
      'config-unmergeable': 'reasonConfig',
      'conflict': 'reasonConflict',
      'registration-unconfirmed': 'reasonRegistration',
      'native-catalog-unavailable': 'reasonNative',
    }
    const reasonKey = (reason: PatchReason) => REASON_KEYS[reason] ?? REASON_KEYS['source-unavailable']

    function CodexCard({ provider, t }: CardProps) {
      const connection = (globalThis.__DSH_CHATGPT_MANAGEMENT__ ?? {})[CODEX_ROUTE]
      const controller = React.useRef<ReturnType<typeof createController> | undefined>(undefined)
      const [state, setState] = useState<Snapshot>({ loading: true, busy: false, status: undefined, error: false })
      const [patch, setPatch] = useState<PatchPreview | undefined>(undefined)
      const [applied, setApplied] = useState<PatchApplied | undefined>(undefined)
      const [patchBusy, setPatchBusy] = useState(false)
      const [patchReason, setPatchReason] = useState<PatchReason | undefined>(undefined)

      /**
       * One preview or apply request.
       *
       * A refusal carries the reason the endpoint decided, so the card names
       * the remedy (`route-missing`, `settings-read-only`, …) instead of
       * reporting every failure as an unreachable source. An HTTP-level
       * refusal without a body falls back to the generic reason.
       */
      const inspectPatch = async (apply = false, restore = false) => {
        if (!connection || patchBusy) return
        setPatchBusy(true); setPatchReason(undefined); setApplied(undefined)
        try {
          const restoring = restore || (apply && patch?.kind === 'restore')
          const operation = restoring ? (apply ? 'models-restore' : 'models-restore-preview') : (apply ? 'models-apply' : 'models-preview')
          const response = await fetch(`${connection.path}/${operation}`, {
            method: apply ? 'POST' : 'GET',
            headers: { 'x-dsh-chatgpt-token': connection.token, ...(apply && patch ? { 'x-dsh-model-patch': patch.signature } : {}) },
            credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          })
          const value = await response.json().catch(() => undefined) as (PatchApplied & { reason?: PatchReason }) | undefined
          // A refusal is not a preview: its body carries a reason, not a diff.
          if (!response.ok) {
            setPatch(undefined)
            setPatchReason(value?.reason ?? 'source-unavailable')
            return
          }
          if (apply) {
            setPatch(undefined)
            // A write without an `applied` list confirms nothing.
            if (Array.isArray(value?.applied)) { setApplied(value); await controller.current?.load() }
            else setPatchReason('registration-unconfirmed')
            return
          }
          if (value) {
            setApplied(undefined)
            setPatch(value)
            if (value.unavailable) setPatchReason(value.reason ?? 'source-unavailable')
          }
          await controller.current?.load()
        } catch { setPatch(undefined); setPatchReason('source-unavailable') }
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
          status?.patchAvailable && (connected || expired) && !pending && button(t('patchPreview'), 'secondary', () => void inspectPatch()),
          status?.patchAvailable && !pending && button(t('patchRestore'), 'secondary', () => void inspectPatch(false, true)),
          pending ? button(t('cancel'), 'danger', () => void controller.current?.act('cancel'))
            : connected ? h('span', { className: 'dsh-chatgpt-push' }, button(t('logoutShort'), 'danger', () => void controller.current?.act('logout')))
              : button(t(stored ? 'relogin' : 'login'), 'primary', () => void controller.current?.act('login')),
          stored && !connected && !pending && h('span', { className: 'dsh-chatgpt-push' }, button(t('logoutShort'), 'danger', () => void controller.current?.act('logout')))),
        state.error && h('p', { className: 'dsh-chatgpt-error', role: 'alert' }, t('error')),

        patch && h('section', { className: 'dsh-chatgpt-preview', 'aria-live': 'polite' },
          h('p', { className: 'dsh-chatgpt-preview-title' }, patch.unavailable ? t('patchFallback') : patch.kind === 'restore' ? t(patch.signature ? 'patchRestoreConfirm' : 'patchRestoreEmpty') : patch.added.length ? `${t('patchCount')} (${patch.added.length})` : t('patchEmpty')),
          !patch.unavailable && patch.added.length > 0 && h('div', { className: 'dsh-chatgpt-models' }, ...patch.added.map(id => h('span', { key: id, className: 'dsh-chatgpt-model' }, id))),
          h('p', { className: 'dsh-chatgpt-note' }, `${t('patchSelected')}: ${patch.current ?? patch.preserved.length} · ${t('patchPreserved')}: ${patch.preserved.length} · ${t('patchTotal')}: ${patch.total} · ${t('patchUnverified')}: ${patch.unsupported}`),
          patch.kind === 'restore' && patch.signature && h('p', { className: 'dsh-chatgpt-note' }, t('patchRestoreWarning')),
          patch.kind === 'restore' && h('p', { className: 'dsh-chatgpt-note' }, `${t('patchResets')}: ${patch.resets?.join(', ') || '0'}`),
          patch.kind === 'restore' && h('p', { className: 'dsh-chatgpt-note' }, `${t('patchRemoved')}: ${patch.removed?.join(', ') || '0'}`),
          patch.capabilityStatus && h('p', { className: 'dsh-chatgpt-note' }, t('patchCatalogOnly')),
          h('details', { className: 'dsh-chatgpt-details' }, h('summary', null, t('patchDetails')),
            h('p', { className: 'dsh-chatgpt-note' }, patch.preserved.join(', ')),
            h('p', { className: 'dsh-chatgpt-note' }, `${t('patchLimited')}: ${patch.limited?.map(item => `${item.id} (${item.omittedEfforts.join(', ')})`).join('; ') || '0'}`),
            h('p', { className: 'dsh-chatgpt-note' }, patch.source),
            patch.fetchedAt !== undefined && h('p', { className: 'dsh-chatgpt-note' }, `${t('patchSourceAt')} ${new Date(patch.fetchedAt).toLocaleString()}${patch.clientVersion ? ` · ${t('patchClient')} ${patch.clientVersion}${patch.clientVersionSource ? ` (${patch.clientVersionSource})` : ''}` : ''}`),
            // The catalogue the write would leave behind, not just the additions.
            !patch.unavailable && patch.added.length > 0 && h('p', { className: 'dsh-chatgpt-note' }, `${t('patchWrites')}: ${[...patch.preserved, ...patch.added].join(', ')}`),
            // Kept models the listing does not carry: reported, never removed.
            patch.unlisted?.length ? h('p', { className: 'dsh-chatgpt-note' }, `${t('patchUnlisted')}: ${patch.unlisted.join(', ')}`) : null,
            // A declared capacity below the window the source reports is
            // surfaced, never rewritten: the value may be the user's own choice.
            patch.understated?.length ? h('p', { className: 'dsh-chatgpt-note' }, `${t('patchUnderstated')}: ${patch.understated.map(item => `${item.id} (${item.declared} → ${item.source})`).join('; ')}`) : null,
            patch.overstated?.length ? h('p', { className: 'dsh-chatgpt-note' }, `${t('patchOverstated')}: ${patch.overstated.map(item => `${item.id} (${item.declared} > ${item.source})`).join('; ')}`) : null,
            patch.nativeAdded?.length ? h('p', { className: 'dsh-chatgpt-note' }, `${t('patchNativeAdded')}: ${patch.nativeAdded.join(', ')}`) : null,
            patch.inheritedOutputLimits?.length ? h('p', { className: 'dsh-chatgpt-note' }, `${t('patchOutputDefaults')}: ${patch.inheritedOutputLimits.join(', ')}`) : null,
            patch.windows?.length ? h('p', { className: 'dsh-chatgpt-note' }, `${t('patchWindows')}: ${patch.windows.map(item => `${item.id} (${item.contextWindow} / ${item.maxContextWindow ?? '—'})`).join('; ')}`) : null,
            patch.replacesCatalog && h('p', { className: 'dsh-chatgpt-note' }, t('patchHandover'))),
          !patch.unavailable && (patch.added.length > 0 || (patch.kind === 'restore' && patch.signature)) && h('div', { className: 'dsh-chatgpt-actions' }, button(t(patch.kind === 'restore' ? 'patchRestoreConfirm' : 'patchApply'), 'primary', () => void inspectPatch(true)))),

        applied?.applied && h('section', { className: 'dsh-chatgpt-preview', 'aria-live': 'polite' },
          h('p', { className: 'dsh-chatgpt-note' }, t('patchRegisteredOnly')),
          h('p', { className: 'dsh-chatgpt-preview-title' }, applied.restored ? t('patchRestored') : `${t('patchApplied')} (${applied.applied.length})`),
          h('div', { className: 'dsh-chatgpt-models' }, ...applied.applied.map(id => h('span', { key: id, className: 'dsh-chatgpt-model' }, id))),
          h('p', { className: 'dsh-chatgpt-note' }, `${t('patchPreserved')}: ${applied.preserved.length} · ${t('patchRevision')}: ${applied.before?.revision ?? '-'} → ${applied.after?.revision ?? '-'}`),
          h('details', { className: 'dsh-chatgpt-details' }, h('summary', null, t('patchDetails')),
            h('p', { className: 'dsh-chatgpt-note' }, `${t('patchWrites')}: ${(applied.after?.models ?? []).join(', ')}`),
            h('p', { className: 'dsh-chatgpt-note' }, applied.source))),
        patchReason && h('p', { className: 'dsh-chatgpt-error', role: 'alert' }, `${t('patchError')} ${t(reasonKey(patchReason))}`))
    }

    function apply(ctx: ClientContext) {
      ctx.effect(() => mountStyles(), 'chatgpt sign-in styles')
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'chatgpt sign-in translations')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('conversation.chat.commandview', () => {
        const commandNS = 'codexUsageCommand'
        ctx.effect(() => ctx.locale.register(commandNS, usageCommandDictionaries), 'codex usage command translations')
        const slots = ctx.slots as unknown as {
          register(entry: { name: string; key: string; locale: string; inject(): { t(key: string): string } }, view: (props: { node: UsageCommandNode; t(key: string): string }) => React.ReactNode): void
        }
        slots.register({ name: 'conversation.chat.commandview', key: 'usage', locale: commandNS,
          inject: () => ({ t: ctx.locale.bind(commandNS) }) }, createUsageCommandView(React, primitives))
      })
      // The seat is keyed by the row's settings namespace, so this renders on
      // every llm-pi-ai provider card — openai-codex among them — and nowhere
      // else. Registered unconditionally: the Host decides per request whether
      // the flow exists.
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card', key: 'llm-pi-ai',
        locale: NS, inject: () => ({ t }),
      }, CodexCard))
      ctx.inject?.(['modelDirectories', 'sessions', 'connection'], scope => {
        const connection = globalThis.__DSH_CHATGPT_MANAGEMENT__?.[CODEX_ROUTE]
        if (!connection || !scope.connection.isLoopback) return
        const controller = createUsageController(connection)
        controller.setPaused(usagePaused)
        const usageNS = 'codexUsage'
        scope.effect(() => {
          usageControllers.add(controller)
          return () => { usageControllers.delete(controller); controller.dispose() }
        }, 'codex usage controller')
        scope.effect(() => scope.locale.register(usageNS, usageDictionaries), 'codex usage translations')
        const UsageSeat = createUsageView(React, controller)
        const slots = scope.slots as unknown as {
          inject(name: string, fn: () => void): void
          register(entry: { name: 'conversation.input.right'; id: string; locale: string; inject(id: string): object }, view: typeof UsageSeat): void
        }
        slots.inject('conversation.input.right', () => slots.register({
          name: 'conversation.input.right', id: 'codex-five-hour-usage', locale: usageNS,
          inject(id) {
            const directory = scope.modelDirectories.directoryFor(id)
            const available = scope.sessions.subagentAddress(id) === undefined
            return { directory: directory.store, available, t: scope.locale.bind(usageNS),
              load: () => { if (available) directory.load().catch(() => {}) } }
          },
        }, UsageSeat))
      })
    }
    return { name: 'chatgpt-signin', inject: ['slots', 'locale'], apply, createController }
  },
})
