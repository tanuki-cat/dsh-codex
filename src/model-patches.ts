import { createHash } from 'node:crypto'
import { CODEX_KEY, CODEX_PROVIDER, CODEX_SETTINGS_NS } from './codex.js'
import type { CodexContext } from './types.js'

const URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.160.1'
const MAX_BYTES = 4 * 1024 * 1024
const LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const MODALITIES = new Set(['text', 'image'])

type Entry = { id: string; name?: string; contextWindow?: number; input?: string[]; reasoningEfforts?: false | Record<string, string> }
type RemoteModel = { slug?: unknown; display_name?: unknown; visibility?: unknown; supported_in_api?: unknown; context_window?: unknown; max_context_window?: unknown; input_modalities?: unknown; supported_reasoning_levels?: unknown }
export interface PatchSettings {
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; revision: number; value: unknown; user?: unknown }>
  mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], expectedRevision: number): Promise<void>
  readonly writable: boolean
}
export interface PatchLlm { listModels(provider: string): Promise<readonly { id: string }[]> }
export type PatchServices = { settings: PatchSettings; llm: PatchLlm }

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Reject uncertain or unrepresentable remote entries instead of inventing capabilities. */
export function parseRemoteCatalog(value: unknown) {
  const models = object(value)?.models
  if (!Array.isArray(models) || models.length === 0 || models.length > 500) throw new Error('Codex model listing is incomplete or invalid.')
  const seen = new Set<string>()
  const entries: Entry[] = []
  const limited: Array<{ id: string; omittedEfforts: string[] }> = []
  let unsupported = 0
  for (const raw of models) {
    const model = object(raw) as RemoteModel | undefined
    if (!model || typeof model.slug !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(model.slug) || seen.has(model.slug)) throw new Error('Codex model listing contains invalid or duplicate IDs.')
    seen.add(model.slug)
    // ChatGPT OAuth permits models even when supported_in_api is false.
    if (model.visibility !== 'list') continue
    const contextWindow = positive(model.context_window) ?? positive(model.max_context_window)
    // Codex protocol defaults an omitted input_modalities field to text.
    const modalities = model.input_modalities === undefined ? ['text'] : model.input_modalities
    const levels = model.supported_reasoning_levels
    if (!contextWindow || !Array.isArray(modalities) || modalities.length === 0 || !modalities.every(x => MODALITIES.has(x)) || !Array.isArray(levels)) { unsupported++; continue }
    const entry: Entry = { id: model.slug, contextWindow, input: modalities }
    if (typeof model.display_name === 'string' && model.display_name.length <= 150) entry.name = model.display_name
    if (levels.length === 0) entry.reasoningEfforts = false
    else {
      const efforts: Record<string, string> = {}
      const omitted: string[] = []
      let malformed = false
      for (const level of levels) {
        const name = object(level)?.effort
        if (typeof name !== 'string') { malformed = true; break }
        if (LEVELS.has(name)) efforts[name] = name
        else omitted.push(name)
      }
      if (malformed || Object.keys(efforts).length === 0) { unsupported++; continue }
      if (omitted.length) limited.push({ id: entry.id, omittedEfforts: omitted })
      entry.reasoningEfforts = efforts
    }
    entries.push(entry)
  }
  if (entries.length === 0) throw new Error('Codex listing contains no serviceable models.')
  return { entries, unsupported, limited, total: models.length }
}

/** Bounded read: a response with private instructions must not reach the browser. */
export async function fetchCodexCatalog(access: string, accountId: string | undefined, fetcher: typeof fetch = fetch) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 7000)
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${access}`, accept: 'application/json' }
    if (accountId) headers['chatgpt-account-id'] = accountId
    const response = await fetcher(URL, { method: 'GET', headers, redirect: 'error', signal: controller.signal })
    if (!response.ok) throw new Error('Codex model listing is unavailable.')
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Codex model listing exceeds size limit.')
    if (!response.body) throw new Error('Codex model listing has no body.')
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) throw new Error('Codex model listing exceeds size limit.')
        parts.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.length }
    return parseRemoteCatalog(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
  } finally { clearTimeout(timeout) }
}

function descriptor(settings: PatchSettings) {
  const entry = settings.describe({ redactSecrets: true }).find(item => item.ns === CODEX_SETTINGS_NS)
  const route = object(object(entry?.value)?.providers)?.[CODEX_PROVIDER]
  if (!entry || !object(route)) throw new Error('Add the openai-codex route in Models settings first.')
  const raw = object(object(entry.user)?.providers)?.[CODEX_PROVIDER]
  const explicit = object(raw)?.models ?? object(route)?.models
  if (explicit !== undefined && !Array.isArray(explicit)) throw new Error('Existing model configuration cannot be safely merged.')
  return { entry, explicit: explicit as unknown[] | undefined }
}

function fingerprint(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

export function createModelPatches(ctx: CodexContext, services: PatchServices, fetcher: typeof fetch = fetch) {
  async function preview() {
    if (!services.settings.writable) throw new Error('Model settings are read-only.')
    const record = await ctx.credentials.readRecord(CODEX_KEY)
    const grant = record?.kind === 'grant' ? object(record.payload) : undefined
    if (typeof grant?.access !== 'string' || grant.access.length === 0 || !positive(grant.expires) || (grant.expires as number) <= Date.now()) throw new Error('Sign in to ChatGPT or refresh the expired credential first.')
    const accountId = typeof grant.accountId === 'string' && grant.accountId.length > 0 ? grant.accountId : undefined
    if (!accountId) throw new Error('Codex credential has no account ID; sign in again.')
    const catalog = await fetchCodexCatalog(grant.access, accountId, fetcher)
    const { entry, explicit } = descriptor(services.settings)
    const current = await services.llm.listModels(CODEX_PROVIDER)
    const currentIds = new Set(current.map(model => model.id))
    const missing = catalog.entries.filter(model => !currentIds.has(model.id))
    const original = [...explicit ?? []]
    if (!original.every(value => typeof object(value)?.id === 'string')) throw new Error('Existing model configuration cannot be safely merged.')
    const savedIds = new Set(original.map(value => object(value)?.id))
    // Explicit settings may be empty/defaulted while the runtime exposes a catalog.
    for (const model of current) {
      if (!savedIds.has(model.id)) { original.push({ id: model.id }); savedIds.add(model.id) }
    }
    const added = missing.filter(model => !savedIds.has(model.id))
    const proposed = [...original, ...added]
    const signature = fingerprint({ accountId, revision: entry.revision, catalog: catalog.entries, limited: catalog.limited, original, current: [...currentIds] })
    return { source: URL.split('?')[0], total: catalog.total, unsupported: catalog.unsupported, limited: catalog.limited, current: currentIds.size, added: added.map(x => x.id), preserved: original.map(x => object(x)?.id), signature, revision: entry.revision, proposed }
  }
  return {
    async fallback() {
      const current = await services.llm.listModels(CODEX_PROVIDER)
      return { unavailable: 'Codex remote listing is unavailable; no models were added.', source: 'current configured pi-ai models (read-only fallback)', total: current.length, unsupported: 0, limited: [], current: current.length, added: [], preserved: current.map(x => x.id), signature: '' }
    },
    async preview() { const { proposed: _proposed, ...view } = await preview(); return view },
    async apply(signature: string) {
      if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid model patch confirmation.')
      const plan = await preview()
      if (plan.signature !== signature) throw new Error('Model catalog or settings changed; review the patch again.')
      if (plan.added.length === 0) return this.preview()
      await services.settings.mutate(CODEX_SETTINGS_NS, [{ op: 'set', path: ['providers', CODEX_PROVIDER, 'models'], value: plan.proposed }], plan.revision)
      const ids = new Set((await services.llm.listModels(CODEX_PROVIDER)).map(x => x.id))
      if (![...plan.added, ...plan.preserved].every(id => typeof id === 'string' && ids.has(id))) throw new Error('Settings saved, but model registration could not be confirmed.')
      return { applied: plan.added }
    },
  }
}
