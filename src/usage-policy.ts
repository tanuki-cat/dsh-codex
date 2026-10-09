export const USAGE_POLL_INTERVAL = 300_000
export const USAGE_MANUAL_INTERVAL = 60_000
export const USAGE_MAX_AGE = 900_000
export const quotaTone = (remaining: number | undefined) => (remaining ?? 100) <= 5 ? 'danger' : (remaining ?? 100) <= 20 ? 'warn' : 'normal'
export type WindowReason = 'not-returned' | 'invalid-response' | 'expired'
export interface UsageWindow {
  usedPercent: number; remainingPercent: number; windowSeconds: 18000 | 604800; resetsAt?: number
}
export interface UsageData {
  fiveHour?: UsageWindow; weekly?: UsageWindow
  fiveHourReason?: WindowReason; weeklyReason?: WindowReason
  fetchedAt: number; usageAllowed?: boolean
}

/** Expire windows independently; never retain a pre-reset balance. */
export function visibleUsageData(data: UsageData | undefined, now: number): UsageData | undefined {
  if (!data || now >= data.fetchedAt + USAGE_MAX_AGE) return undefined
  const fiveExpired = data.fiveHour?.resetsAt !== undefined && now >= data.fiveHour.resetsAt
  const weekExpired = data.weekly?.resetsAt !== undefined && now >= data.weekly.resetsAt
  if (!fiveExpired && !weekExpired) return data
  return { ...data,
    fiveHour: fiveExpired ? undefined : data.fiveHour, fiveHourReason: fiveExpired ? 'expired' : data.fiveHourReason,
    weekly: weekExpired ? undefined : data.weekly, weeklyReason: weekExpired ? 'expired' : data.weeklyReason }
}
