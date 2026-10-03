function schemaDump(result) {
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Schema 导出命令异常，无法验证插件导入。')
  let metadata
  try { metadata = JSON.parse(result.stdout)['x-cordis'] } catch {
    throw new Error('Schema 导出未返回 JSON；请在本机执行 dsh --profile web --dump-config-schema 查看诊断。')
  }
  if (!metadata || typeof metadata.complete !== 'boolean' || !Array.isArray(metadata.entries)
    || !Array.isArray(metadata.diagnostics) || (result.status === 1 && metadata.complete)) {
    throw new Error('Schema 导出结果无效，无法验证插件导入。')
  }
  return metadata
}

function issues(metadata) {
  return [
    ...metadata.diagnostics.map(({ level, path, message }) => JSON.stringify(['diagnostic', level, path, message])),
    ...metadata.entries.filter(entry => ['partial', 'unsupported', 'error'].includes(entry.status))
      .map(({ path, id, name, status }) => JSON.stringify(['entry', path, id, name, status])),
  ]
}

export function captureSchemaBaseline(result) {
  return schemaDump(result)
}

export function validateInstalledSchema(baseline, result) {
  const metadata = schemaDump(result)
  const targets = metadata.entries.filter(entry => entry.id === 'llm-chatgpt' && entry.name === 'dsh-llm-chatgpt')
  if (targets.length !== 1 || !['schema', 'absent'].includes(targets[0].status)) {
    throw new Error('llm-chatgpt 模块未成功导入或其 schema 不受支持。')
  }
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
  return { complete: metadata.complete, pluginStatus: targets[0].status }
}
