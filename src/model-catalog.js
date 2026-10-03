const MEDIUM = ['low', 'medium', 'high', 'xhigh', 'max']
const WITH_NONE = ['none', ...MEDIUM]

// Exact public model IDs only. Unknown account catalog IDs remain selectable
// without an invented reasoning control.
const REASONING = new Map([
  ['gpt-6-astra', MEDIUM],
  ['gpt-6.1-sol', MEDIUM],
  ['gpt-5.6-sol', WITH_NONE],
  ['gpt-5.6-terra', WITH_NONE],
  ['gpt-5.6-luna', WITH_NONE],
  ['gpt-5.6', WITH_NONE],
  ['gpt-5.5', ['none', 'low', 'medium', 'high', 'xhigh']],
])

export function reasoningFor(model) {
  const efforts = REASONING.get(model)
  return efforts === undefined ? undefined : { efforts: efforts.map(id => ({ id, name: id })) }
}

export function normalizeExtraModels(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32) throw new Error('extraModels must be an array of at most 32 model IDs')
  const result = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(entry)) {
      throw new Error('extraModels must contain valid model IDs without whitespace')
    }
    if (!result.includes(entry)) result.push(entry)
  }
  return result
}

export function withExtraModels(listed, extraModels) {
  const result = [...listed]
  const ids = new Set(listed.map(model => model.id))
  for (const id of extraModels) {
    if (ids.has(id)) continue
    ids.add(id)
    result.push({ id, name: `${id} (manual; verify access)`,
      description: 'Manually configured model. Access depends on the connected ChatGPT account.',
      inputModalities: ['text'], manual: true })
  }
  return result
}
