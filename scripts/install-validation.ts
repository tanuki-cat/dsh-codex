/**
 * Schema-dump comparison used to verify one install.
 *
 * An install must not make the profile's schema worse. The comparison is a
 * multiset difference over diagnostics and incomplete entries, so a profile
 * that was already broken stays installable while a new break is refused.
 *
 * The plugin itself declares no profile entry, so there is no entry to look
 * for: its module import is proven by the absence of a new entry carrying its
 * id, which is exactly what this comparison reports.
 */

import type { SpawnSyncReturns } from 'node:child_process'

type SchemaDump = {
  complete: boolean
  entries: Array<{ path: string; id: string; name: string; status: string }>
  diagnostics: Array<{ level: string; path: string; message: string }>
}
type DumpResult = Pick<SpawnSyncReturns<string>, 'status' | 'stdout'> & { error?: Error }

/** The entry id and package name an install of this plugin owns. */
const PLUGIN_ID = 'llm-chatgpt'
const PLUGIN_NAME = 'dsh-llm-chatgpt'

function schemaDump(result: DumpResult): SchemaDump {
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('Schema 导出命令异常，无法验证插件导入。')
  let metadata
  try { metadata = JSON.parse(result.stdout)['x-cordis'] } catch {
    throw new Error('Schema 导出未返回 JSON；请在本机执行 dsh --profile web --dump-config-schema 查看诊断。')
  }
  if (!metadata || typeof metadata.complete !== 'boolean' || !Array.isArray(metadata.entries)
    || !Array.isArray(metadata.diagnostics) || (result.status === 1 && metadata.complete)) {
    throw new Error('Schema 导出结果无效，无法验证插件导入。')
  }
  return metadata as SchemaDump
}

function issues(metadata: SchemaDump) {
  return [
    ...metadata.diagnostics.map(({ level, path, message }) => JSON.stringify(['diagnostic', level, path, message])),
    ...metadata.entries.filter(entry => ['partial', 'unsupported', 'error'].includes(entry.status))
      .map(({ path, id, name, status }) => JSON.stringify(['entry', path, id, name, status])),
  ]
}

export function captureSchemaBaseline(result: DumpResult) {
  return schemaDump(result)
}

export function validateInstalledSchema(baseline: SchemaDump, result: DumpResult) {
  const metadata = schemaDump(result)
  // A partial or failed entry under the plugin's own id is the one shape that
  // means its module did not import cleanly.
  const broken = metadata.entries.filter(entry => entry.id === PLUGIN_ID && entry.name === PLUGIN_NAME
    && ['partial', 'unsupported', 'error'].includes(entry.status))
  if (broken.length > 0) throw new Error('llm-chatgpt 模块未成功导入或其 schema 不受支持。')
  const counts = new Map()
  for (const issue of issues(baseline)) counts.set(issue, (counts.get(issue) ?? 0) + 1)
  for (const issue of issues(metadata)) {
    const remaining = counts.get(issue) ?? 0
    if (remaining === 0) throw new Error('安装后新增 schema 诊断或不完整条目；请执行 dsh --profile web --dump-config-schema 查看诊断。')
    counts.set(issue, remaining - 1)
  }
  // Exit 1 must remain explainable by an existing incomplete baseline.
  if (!metadata.complete && (baseline.complete || issues(metadata).length === 0)) {
    throw new Error('安装后 schema 不完整，不能用已有诊断解释。')
  }
  return { complete: metadata.complete }
}
