import type * as React from 'react'
import { quotaTone } from './usage-policy.ts'

export interface UsageCommandNode {
  name: string | null; outcome: { kind: 'success' | 'error'; text?: string } | null
}
export interface QuotaRow { label: string; remaining?: number; used?: number; reset?: string; unavailable?: string }
export interface UsageCardData { rows: QuotaRow[]; updated: string; notes: string[] }

/** Read the plugin's persisted text format; unknown output stays plain text. */
export function parseUsageText(text: string | undefined): UsageCardData | undefined {
  if (!text || text.length > 8192) return undefined
  const lines = text.split('\n')
  if (lines[0] !== 'Codex usage') return undefined
  const rows: QuotaRow[] = [], notes: string[] = []
  let updated: string | undefined
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const match = /^(5 小时额度|周额度) \[[█░]{10}\] ([0-9]+(?:\.[0-9]+)?)% 剩余可用 · ([0-9]+(?:\.[0-9]+)?)% 已用$/.exec(line)
    if (match) {
      const remaining = Number(match[2]), used = Number(match[3])
      if (remaining > 100 || used > 100 || Math.abs(remaining + used - 100) > 0.11) return undefined
      if (!lines[i + 1]?.startsWith('  重置：')) return undefined
      rows.push({ label: match[1], remaining, used, reset: lines[++i].slice(5) })
    } else {
      const missing = /^(5 小时额度|周额度)：(未返回额度|额度数据无效|额度已重置，请重新查询)$/.exec(line)
      if (missing) rows.push({ label: missing[1], unavailable: missing[2] })
      else if (line.startsWith('查询时间：')) { if (updated !== undefined) return undefined; updated = line.slice(5) }
      else notes.push(line)
    }
  }
  if (rows.length !== 2 || rows[0].label !== '5 小时额度' || rows[1].label !== '周额度' || !updated) return undefined
  return { rows, updated, notes }
}

export interface UsagePrimitives {
  DisclosureRow: React.ComponentType<{
    icon: React.ReactNode; title: string; open: boolean; expandable: boolean; onToggle(): void
    running?: boolean; expandOnRowClick?: boolean; keepContentWhenOpen?: boolean
    collapsedContent?: React.ReactNode; children?: React.ReactNode; contentClassName?: string
  }>
  IconApiOutlineRegular: React.ComponentType<{ size: number }>
}
export const usageCommandDictionaries = {
  zh: { title: 'Codex 额度', five: '5 小时额度', week: '周额度', remaining: '剩余可用', used: '已用', reset: '重置', updated: '查询时间', loading: '正在查询额度', failed: '查询失败', done: '查询完成' },
  en: { title: 'Codex quota', five: 'Five-hour quota', week: 'Weekly quota', remaining: 'Remaining', used: 'Used', reset: 'Resets', updated: 'Checked', loading: 'Checking quota', failed: 'Query failed', done: 'Query complete' },
}

export function createUsageCommandView(runtime: Pick<typeof React, 'createElement' | 'useState'>, primitives: UsagePrimitives) {
  const { createElement: h, useState } = runtime
  return function UsageCommandView({ node, t }: { node: UsageCommandNode; t(key: string): string }) {
    const [expanded, setExpanded] = useState(true)
    const text = node.outcome?.text
    const data = node.outcome?.kind === 'success' ? parseUsageText(text) : undefined
    const running = node.outcome === null
    const summary = data
      ? data.rows.map(row => (row.label === '周额度' ? t('week') : t('five')) + ' ' + (row.remaining === undefined ? '—' : row.remaining + '%')).join(' · ')
      : running ? t('loading') : text?.split('\n')[0] ?? t(node.outcome?.kind === 'error' ? 'failed' : 'done')
    const body = data ? h('div', { className: 'dsh-codex-command-card' },
      h('div', { className: 'dsh-codex-command-grid' }, ...data.rows.map(row => {
        const label = row.label === '周额度' ? t('week') : t('five')
        return h('section', { key: row.label, className: 'dsh-codex-quota', 'data-tone': quotaTone(row.remaining), 'aria-label': label },
          h('div', { className: 'dsh-codex-quota-heading' }, h('span', null, label),
            h('span', { className: 'dsh-codex-quota-balance' }, row.remaining === undefined ? '—' : row.remaining + '%', ' ', t('remaining'))),
          row.remaining !== undefined && h('div', { className: 'dsh-codex-quota-track', role: 'progressbar', 'aria-label': label + ' ' + t('remaining'),
            'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': row.remaining, 'aria-valuetext': row.remaining + '% ' + t('remaining') },
            h('span', { className: 'dsh-codex-quota-fill', style: { width: row.remaining + '%' } })),
          h('div', { className: 'dsh-codex-quota-detail' }, row.used === undefined ? row.unavailable : t('used') + ' ' + row.used + '%'),
          row.reset && h('div', { className: 'dsh-codex-quota-detail' }, t('reset') + '：' + row.reset))
      })),
      h('div', { className: 'dsh-codex-command-meta' }, t('updated') + '：' + data.updated,
        ...data.notes.map((note, index) => h('div', { key: index }, note))))
      : text ? h('pre', { className: 'dsh-codex-command-fallback', 'data-error': node.outcome?.kind === 'error' }, text) : null
    return h('div', { className: 'dsh-codex-command', 'data-state': running ? 'running' : node.outcome?.kind },
      h(primitives.DisclosureRow, { icon: h(primitives.IconApiOutlineRegular, { size: 14 }), title: t('title'),
        open: expanded && !!body, expandable: !!body, running, expandOnRowClick: true, keepContentWhenOpen: false,
        onToggle: () => setExpanded(value => !value), contentClassName: 'dsh-codex-command-summary-layout',
        collapsedContent: h('span', { className: 'dsh-codex-command-summary' }, summary) }, expanded ? body : null))
  }
}

export const usageCommandCss =
'.dsh-codex-command{min-width:0;color:var(--dsw-alias-label-primary,#333);font-size:var(--dsh-content-font-size-secondary,13px)}' +
'.dsh-codex-command-summary-layout{min-width:0}.dsh-codex-command-summary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:8px}' +
'.dsh-codex-command-card,.dsh-codex-command-fallback{margin:4px 0;padding:12px 16px;border:.5px solid var(--dsw-alias-border-l1,#0000001a);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-module-platform,#f5f6f7)}' +
'.dsh-codex-command-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}' +
'.dsh-codex-quota{min-width:0}.dsh-codex-quota-heading{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 8px}' +
'.dsh-codex-quota-balance{font-weight:500;font-variant-numeric:tabular-nums}' +
'.dsh-codex-quota-track{height:6px;margin:8px 0;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-bg-skeleton,#0000000a);overflow:hidden}' +
'.dsh-codex-quota-fill{display:block;height:100%;background:var(--codex-quota-fill)}' +
'.dsh-codex-quota-detail,.dsh-codex-command-meta{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#545557)}' +
'.dsh-codex-command-meta{border-top:.5px solid var(--dsw-alias-border-l1,#0000001a);margin-top:12px;padding-top:8px}' +
'.dsh-codex-command-fallback{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-codex-command-fallback[data-error=true]{color:var(--dsw-alias-state-error-primary,#ef4444)}' +
'@media(max-width:600px){.dsh-codex-command-grid{grid-template-columns:minmax(0,1fr);gap:12px}.dsh-codex-command-card,.dsh-codex-command-fallback{padding:12px}}'
