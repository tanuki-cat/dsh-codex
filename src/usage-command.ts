import type { UsageReply, UsageReason } from './usage.js'
import type { UsageWindow, WindowReason } from './usage-policy.js'
import { visibleUsageData, USAGE_POLL_INTERVAL } from './usage-policy.js'

export type UsageCommandResult = { kind: 'success' | 'error'; text: string }
export interface UsageCommandInvocation { rawInput: string; signal: AbortSignal }
export interface UsageCommandServices {
  commands: { register(definition: { name: string; description: string; handler(invocation: UsageCommandInvocation): Promise<UsageCommandResult> }): () => void }
}
type Service = { get(mode: 'manual'): Promise<UsageReply> }
const messages: Record<UsageReason, string> = {
  'sign-in-required': '未登录，请到设置 → 模型登录 ChatGPT',
  'credential-incomplete': '登录凭据不完整，请重新登录', 'credential-expired': '登录已失效，请重新登录',
  'refresh-unavailable': '无法刷新登录，请重新登录', 'refresh-failed': '登录刷新失败，请稍后重试',
  'permission-denied': '账号无权查询额度', 'rate-limited': '查询受限，请稍后重试',
  'network-error': '网络错误，请稍后重试', timeout: '查询超时，请稍后重试',
  'invalid-response': '额度数据无效或已过期', 'no-five-hour-window': '账号未返回 5 小时额度',
  'account-changed': '账号已变化，请重新查询', 'service-unavailable': '额度服务不可用，请稍后重试',
}
const windowMessages: Record<WindowReason, string> = {
  'not-returned': '未返回额度', 'invalid-response': '额度数据无效', expired: '额度已重置，请重新查询',
}

/** Format only validated quota fields, without account identity or upstream diagnostics. */
export function formatUsage(reply: UsageReply, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): UsageCommandResult {
  const data = visibleUsageData(reply.data, now)
  if (!data) return { kind: 'error', text: 'Codex usage：' + messages[reply.reason ?? 'invalid-response'] }
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  const percent = (value: number) => String(Math.round(value * 10) / 10)
  const window = (label: string, quota: UsageWindow | undefined, reason: WindowReason | undefined) => {
    if (!quota) return label + '：' + windowMessages[reason ?? 'not-returned']
    const filled = Math.round(quota.remainingPercent / 10)
    return label + ' [' + '█'.repeat(filled) + '░'.repeat(10 - filled) + '] ' + percent(quota.remainingPercent) + '% 剩余可用 · ' + percent(quota.usedPercent) + '% 已用'
      + '\n  重置：' + (quota.resetsAt === undefined ? '重置时间未知' : date.format(quota.resetsAt))
  }
  const stale = reply.state === 'stale' || now >= data.fetchedAt + USAGE_POLL_INTERVAL
  const lines = ['Codex usage', '', window('5 小时额度', data.fiveHour, data.fiveHourReason), window('周额度', data.weekly, data.weeklyReason), '',
    '查询时间：' + date.format(data.fetchedAt) + ' · ' + timeZone]
  if (reply.fromCache || stale) lines.push(stale ? '旧数据：仍在有效期内' : '缓存数据：主动查询最短间隔 1 分钟')
  if (reply.reason) lines.push(messages[reply.reason])
  if (data.usageAllowed === false) lines.push('账号当前受限，剩余额度不保证可调用')
  if (reply.fromCache || reply.reason) lines.push('自动再次检查：' + date.format(reply.nextCheckAt))
  return { kind: 'success', text: lines.join('\n') }
}

/** Cancellation releases this waiter; the service owns the shared request and its timeout. */
export function createUsageCommand(service: Service, now = Date.now) {
  return async (invocation: UsageCommandInvocation): Promise<UsageCommandResult> => {
    if (invocation.rawInput.trim()) return { kind: 'error', text: '用法：/usage（无需参数）' }
    const { signal } = invocation
    const cancelled: UsageCommandResult = { kind: 'error', text: '额度查询已取消' }
    if (signal.aborted) return cancelled
    let cancel = () => {}
    const aborted = new Promise<UsageCommandResult>(resolve => { cancel = () => resolve(cancelled); signal.addEventListener('abort', cancel, { once: true }) })
    try {
      const result = await Promise.race([service.get('manual').then(reply => formatUsage(reply, now())), aborted])
      return signal.aborted ? cancelled : result
    } catch { return signal.aborted ? cancelled : { kind: 'error', text: messages['service-unavailable'] } }
    finally { signal.removeEventListener('abort', cancel) }
  }
}

export function registerUsageCommand(ctx: UsageCommandServices, service: Service) {
  return ctx.commands.register({ name: 'usage', description: '查询 Codex 订阅的 5 小时和周剩余额度', handler: createUsageCommand(service) })
}
