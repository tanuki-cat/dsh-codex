import type * as React from 'react'
import type { UsageData, UsageReply, UsageReason } from './usage.js'

type Connection = { path: string; token: string }
export interface UsageEnvironment {
  fetch: typeof fetch; now(): number
  setTimeout(callback: () => void, delay: number): unknown; clearTimeout(timer: unknown): void
  visible(): boolean; online(): boolean
  listen(callback: () => void): () => void
}
const reasons: UsageReason[] = ['sign-in-required', 'credential-incomplete', 'credential-expired', 'refresh-unavailable',
  'refresh-failed', 'permission-denied', 'rate-limited', 'network-error', 'timeout', 'invalid-response',
  'no-five-hour-window', 'account-changed', 'service-unavailable']
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export function validUsage(value: unknown): value is UsageReply {
  if (!value || typeof value !== 'object') return false
  const v = value as UsageReply, d = v.data
  if (!['ready', 'stale', 'unavailable'].includes(v.state) || !finite(v.nextCheckAt) || v.nextCheckAt < 0 || v.nextCheckAt > 8.64e15
    || (v.accountScope !== undefined && (typeof v.accountScope !== 'string' || v.accountScope.length > 128))) return false
  if (v.reason !== undefined && !reasons.includes(v.reason)) return false
  if (v.state === 'unavailable') return !d && !!v.reason
  if (!d || !v.accountScope || !finite(d.usedPercent) || d.usedPercent < 0 || d.usedPercent > 100
    || !finite(d.remainingPercent) || Math.abs(d.remainingPercent - (100 - d.usedPercent)) > 0.00001
    || d.windowSeconds !== 18000 || !finite(d.fetchedAt) || d.fetchedAt < 0 || d.fetchedAt > 8.64e15
    || (d.resetsAt !== undefined && (!finite(d.resetsAt) || d.resetsAt <= 0 || d.resetsAt > 8.64e15))
    || (d.usageAllowed !== undefined && typeof d.usageAllowed !== 'boolean')) return false
  return v.state === 'ready' ? v.reason === undefined : !!v.reason && ['timeout', 'network-error', 'rate-limited'].includes(v.reason)
}
export function displayData(reply: UsageReply | undefined, now: number): UsageData | undefined {
  const d = reply?.data
  return d && now < d.fetchedAt + 300_000 && now < (d.resetsAt ?? Infinity) ? d : undefined
}
export interface UsageSnapshot { loading: boolean; reply?: UsageReply; localError?: 'reload' | 'network'; updatedAt: number }
const browserEnvironment = (): UsageEnvironment => ({
  fetch: (...args) => fetch(...args), now: Date.now,
  setTimeout: (fn, delay) => window.setTimeout(fn, delay), clearTimeout: timer => window.clearTimeout(timer as number),
  visible: () => !document.hidden, online: () => navigator.onLine !== false,
  listen(callback) {
    document.addEventListener('visibilitychange', callback)
    for (const event of ['focus', 'online', 'offline']) window.addEventListener(event, callback)
    return () => { document.removeEventListener('visibilitychange', callback); for (const event of ['focus', 'online', 'offline']) window.removeEventListener(event, callback) }
  },
})
export function createUsageController(connection: Connection, env: UsageEnvironment = browserEnvironment()) {
  let snapshot: UsageSnapshot = { loading: false, updatedAt: env.now() }, disposed = false, paused = false, sequence = 0
  let timer: unknown, unlisten: (() => void) | undefined
  let request: AbortController | undefined, nextCheckAt = 0, lastAttempt = -Infinity
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<UsageSnapshot>) => { snapshot = { ...snapshot, ...patch, updatedAt: env.now() }; for (const fn of listeners) fn() }
  const stop = () => { if (timer !== undefined) env.clearTimeout(timer); timer = undefined }
  function expire() {
    if (snapshot.reply?.data && !displayData(snapshot.reply, env.now())) publish({ reply: { ...snapshot.reply, data: undefined, state: 'unavailable', reason: snapshot.reply.reason ?? 'invalid-response' } })
  }
  function schedule() {
    stop()
    if (disposed || paused || !listeners.size || !env.visible()) return
    let at = env.online() && !request ? Math.max(nextCheckAt, lastAttempt + 60_000) : Infinity
    const d = displayData(snapshot.reply, env.now())
    if (d) {
      at = Math.min(at, d.fetchedAt + 300_000, d.resetsAt ?? Infinity)
      if (env.now() < d.fetchedAt + 60_000) at = Math.min(at, d.fetchedAt + 60_000)
    }
    if (!Number.isFinite(at)) return
    timer = env.setTimeout(() => { timer = undefined; expire(); publish({}); void refresh(); schedule() }, Math.max(1, Math.min(2_147_483_647, at - env.now())))
  }
  async function refresh() {
    expire()
    if (disposed || paused || !listeners.size || !env.visible() || !env.online()) { schedule(); return }
    if (request) return
    if (env.now() < Math.max(nextCheckAt, lastAttempt + 60_000)) { schedule(); return }
    const controller = new AbortController(), expected = sequence
    request = controller; lastAttempt = env.now(); publish({ loading: true }); schedule()
    const timeout = env.setTimeout(() => controller.abort(), 30_000)
    try {
      const res = await env.fetch(connection.path + '/usage', { method: 'GET', cache: 'no-store', credentials: 'same-origin',
        headers: { 'x-dsh-chatgpt-token': connection.token }, signal: controller.signal })
      if (disposed || expected !== sequence) return
      if (!res.ok) throw new Error(res.status === 403 ? 'reload' : 'network')
      const value: unknown = await res.json()
      if (disposed || expected !== sequence) return
      if (!validUsage(value)) throw new Error('network')
      nextCheckAt = value.nextCheckAt
      publish({ reply: value, localError: undefined, loading: false })
      expire()
    } catch (error) {
      if (disposed || expected !== sequence) return
      const localError = error instanceof Error && error.message === 'reload' ? 'reload' : 'network'
      nextCheckAt = env.now() + (localError === 'reload' ? 300_000 : 60_000)
      const d = localError === 'reload' ? undefined : displayData(snapshot.reply, env.now())
      publish({ loading: false, localError, reply: d ? { state: 'stale', data: d, accountScope: snapshot.reply?.accountScope, reason: 'network-error', nextCheckAt } : undefined })
    } finally {
      env.clearTimeout(timeout)
      if (request === controller) { request = undefined; schedule() }
    }
  }
  const wake = () => {
    expire()
    if (!env.visible() || !env.online()) {
      if (request) { sequence++; request.abort(); request = undefined; publish({ loading: false }) }
      schedule(); return
    }
    void refresh()
  }
  function invalidate() {
    sequence++; request?.abort(); request = undefined; stop(); nextCheckAt = 0; lastAttempt = -Infinity
    publish({ reply: undefined, localError: undefined, loading: false }); void refresh()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(fn: () => void) {
      if (disposed) return () => {}
      listeners.add(fn)
      if (listeners.size === 1) { unlisten = env.listen(wake); void refresh() }
      return () => {
        listeners.delete(fn)
        if (!listeners.size) { sequence++; stop(); request?.abort(); request = undefined; unlisten?.(); unlisten = undefined }
      }
    },
    refresh, invalidate,
    setPaused(value: boolean) { paused = value; invalidate() },
    dispose() { disposed = true; sequence++; stop(); request?.abort(); request = undefined; unlisten?.(); unlisten = undefined; listeners.clear() },
  }
}
export type UsageController = ReturnType<typeof createUsageController>
export interface ModelStore { getSnapshot(): { current: { provider: string } | null }; subscribe(fn: () => void): () => void }
export const usageDictionaries: Record<string, Record<string, string>> = {
  zh: {
    label: 'Codex 5h', short: '5h', used: '已用', remaining: '剩余', loading: '正在查询额度', unknown: '额度未知', stale: '旧数据',
    reset: '重置时间', resetUnknown: '重置时间未知', updated: '最后更新', refresh: '检查额度（受刷新间隔限制）',
    shared: '账号共享的 5 小时额度；不含周额度或其他限制', reload: '页面授权已失效，请重新加载', network: '额度更新失败，请稍后重试',
    limited: '账号当前受限；剩余 5 小时额度不保证可调用', cooldown: '再次检查时间',
    'sign-in-required': '未登录，请到设置 → 模型登录', 'credential-incomplete': '登录凭据不完整，请重新登录',
    'credential-expired': '登录已失效，请重新登录', 'refresh-unavailable': '无法刷新登录，请重新登录', 'refresh-failed': '登录刷新失败，请稍后重试',
    'permission-denied': '账号无权查询额度', 'rate-limited': '查询受限，请稍后重试', 'network-error': '网络错误，稍后重试',
    timeout: '查询超时，稍后重试', 'invalid-response': '额度数据无效或已过期', 'no-five-hour-window': '账号未返回 5 小时额度',
    'account-changed': '账号已变化，正在重新检查', 'service-unavailable': '额度服务不可用',
  },
  en: {
    label: 'Codex 5h', short: '5h', used: 'Used', remaining: 'Remaining', loading: 'Checking usage', unknown: 'Usage unknown', stale: 'Stale',
    reset: 'Resets', resetUnknown: 'Reset time unknown', updated: 'Updated', refresh: 'Check usage (refresh interval applies)',
    shared: 'Account-wide five-hour usage; weekly and other limits are not included', reload: 'Page authorization expired; reload', network: 'Usage update failed; retry later',
    limited: 'Account currently limited; five-hour balance does not guarantee availability', cooldown: 'Next check',
    'sign-in-required': 'Sign in through Settings → Models', 'credential-incomplete': 'Incomplete credentials; sign in again',
    'credential-expired': 'Credentials expired; sign in again', 'refresh-unavailable': 'Cannot refresh credentials; sign in again', 'refresh-failed': 'Credential refresh failed; retry later',
    'permission-denied': 'Usage access denied', 'rate-limited': 'Rate limited; retry later', 'network-error': 'Network error; retry later',
    timeout: 'Usage request timed out', 'invalid-response': 'Usage data invalid or expired', 'no-five-hour-window': 'Account returned no five-hour quota',
    'account-changed': 'Account changed; checking again', 'service-unavailable': 'Usage service unavailable',
  },
}
export const usageCss =
'.dsh-codex-usage{position:relative;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#777)}' +
'.dsh-codex-usage button{display:flex;align-items:center;gap:5px;height:28px;padding:0 4px;color:inherit;background:none;border:0;border-radius:4px;cursor:pointer;font:inherit;white-space:nowrap}' +
'.dsh-codex-usage button:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#3b82f6)}' +
'.dsh-codex-usage-semantic{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}' +
'.dsh-codex-usage-track{display:block;width:44px;height:4px;border-radius:4px;background:var(--dsw-alias-bg-skeleton,#ddd);overflow:hidden}' +
'.dsh-codex-usage-fill{display:block;height:100%;background:var(--dsw-alias-state-business-primary,#3b82f6)}' +
'.dsh-codex-usage[data-tone=warn] .dsh-codex-usage-fill{background:var(--dsw-alias-state-warn-label,#b7791f)}' +
'.dsh-codex-usage[data-tone=danger] .dsh-codex-usage-fill{background:var(--dsw-alias-state-error-primary,#dc2626)}' +
'.dsh-codex-usage[data-stale=true]{opacity:.65}.dsh-codex-usage-short{display:none}' +
'.dsh-codex-usage-tip{display:none;position:absolute;bottom:calc(100% + 5px);right:0;width:240px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-module-platform,#fff);color:var(--dsw-alias-label-primary,#333);box-shadow:0 2px 12px #0002;z-index:1200;line-height:18px;pointer-events:none;white-space:normal}' +
'.dsh-codex-usage:hover .dsh-codex-usage-tip,.dsh-codex-usage:focus-within .dsh-codex-usage-tip{display:block}' +
'@media(max-width:600px){.dsh-codex-usage-long,.dsh-codex-usage-used{display:none}.dsh-codex-usage-short{display:inline}.dsh-codex-usage-track{width:25px}}' +
'@media(max-width:400px){.dsh-codex-usage-track{display:none}}'
export function createUsageView(ReactRuntime: Pick<typeof React, 'createElement' | 'useEffect' | 'useSyncExternalStore' | 'useId'>, controller: UsageController) {
  const { createElement: h, useEffect, useSyncExternalStore, useId } = ReactRuntime
  function Bar({ t }: { t: (key: string) => string }) {
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    const id = useId(), data = displayData(state.reply, state.updatedAt)
    const stale = state.reply?.state === 'stale' || !!data && state.updatedAt >= data.fetchedAt + 60_000
    const percent = data ? Math.round(data.usedPercent) : undefined
    const date = (value: number) => new Date(value).toLocaleString()
    const info = [t('shared'), data ? t('used') + ' ' + percent + '% · ' + t('remaining') + ' ' + Math.round(data.remainingPercent) + '%' : t(state.loading ? 'loading' : 'unknown'),
      data?.resetsAt ? t('reset') + ': ' + date(data.resetsAt) : t('resetUnknown'),
      data ? t('updated') + ': ' + date(data.fetchedAt) : '', stale ? t('stale') : '',
      state.reply?.reason ? t(state.reply.reason) : '', state.localError ? t(state.localError) : '',
      data?.usageAllowed === false ? t('limited') : '', state.reply ? t('cooldown') + ': ' + date(state.reply.nextCheckAt) : ''].filter(Boolean)
    return h('div', { className: 'dsh-codex-usage', 'data-tone': (percent ?? 0) >= 95 ? 'danger' : (percent ?? 0) >= 80 ? 'warn' : 'normal', 'data-stale': stale },
      h('button', { type: 'button', onClick: () => void controller.refresh(), 'aria-label': t('refresh') + ' · ' + t('label') + ' · ' + (data ? t('used') + ' ' + percent + '%' : t(state.loading ? 'loading' : 'unknown')), 'aria-describedby': id },
        h('span', { className: 'dsh-codex-usage-long' }, t('label')), h('span', { className: 'dsh-codex-usage-short' }, t('short')),
        data && h('span', { className: 'dsh-codex-usage-track', 'aria-hidden': true },
          h('span', { className: 'dsh-codex-usage-fill', style: { width: data.usedPercent + '%' } })),
        h('span', null, data ? h('span', null, h('span', { className: 'dsh-codex-usage-used' }, t('used') + ' '), percent + '%') : state.loading ? '…' : '—'),
        stale && h('span', null, '*')),
      data && h('span', { className: 'dsh-codex-usage-semantic', role: 'progressbar', 'aria-label': t('label') + ' ' + t('used'),
        'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': data.usedPercent, 'aria-valuetext': t('used') + ' ' + percent + '%' }),
      h('div', { className: 'dsh-codex-usage-tip', role: 'tooltip', id }, ...info.map((line, i) => h('div', { key: i }, line))))
  }
  return function UsageSeat({ directory, available, load, t }: { directory: ModelStore; available: boolean; load(): void; t: (key: string) => string }) {
    const model = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
    useEffect(() => { if (available) load() }, [available, directory])
    return available && model.current?.provider === 'openai-codex' ? h(Bar, { t }) : null
  }
}
