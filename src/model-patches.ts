import { createHash } from 'node:crypto'
import { CODEX_KEY, CODEX_PROVIDER, CODEX_SETTINGS_NS } from './codex.js'
import type { CodexContext } from './types.js'

/**
 * The Codex CLI version this listing is requested as.
 *
 * The endpoint is versioned by the caller it serves, so this is part of the
 * request contract and not a free parameter: upstream ships the value with
 * each CLI release, and a stale one is answered by the same shape. Review it
 * when the installed Codex CLI moves.
 */
export const CODEX_CLIENT_VERSION = '0.160.1'
const SOURCE = 'https://chatgpt.com/backend-api/codex/models'
const URL = `${SOURCE}?client_version=${CODEX_CLIENT_VERSION}`
const MAX_BYTES = 4 * 1024 * 1024
const LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const MODALITIES = new Set(['text', 'image'])

/**
 * Why a patch operation could not proceed.
 *
 * Each code is a distinct operator-facing remedy, so the page can name the one
 * that applies instead of collapsing every refusal into "source unavailable".
 */
export type PatchReason =
  | 'settings-unavailable'
  | 'settings-read-only'
  | 'route-missing'
  | 'sign-in-required'
  | 'credential-expired'
  | 'credential-incomplete'
  | 'source-unavailable'
  | 'config-unmergeable'
  | 'conflict'
  | 'registration-unconfirmed'

/** A refusal carrying the reason the caller should report. */
export class PatchError extends Error {
  constructor(readonly reason: PatchReason, message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

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
  const root = object(value)
  const models = root?.models
  // The endpoint answers one unpaginated page under a single `models` key, so
  // any other envelope shape means this is not the listing it claims to be.
  // An unknown top-level key would be an unread page of some other shape.
  if (root === undefined || Object.keys(root).some(key => key !== 'models')) {
    throw new PatchError('source-unavailable', 'Codex model listing has an unexpected shape.')
  }
  if (!Array.isArray(models) || models.length === 0 || models.length > 500) {
    throw new PatchError('source-unavailable', 'Codex model listing is incomplete or invalid.')
  }
  const seen = new Set<string>()
  const entries: Entry[] = []
  const limited: Array<{ id: string; omittedEfforts: string[] }> = []
  let unsupported = 0
  for (const raw of models) {
    const model = object(raw) as RemoteModel | undefined
    if (!model || typeof model.slug !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,100}$/.test(model.slug) || seen.has(model.slug)) throw new PatchError('source-unavailable', 'Codex model listing contains invalid or duplicate IDs.')
    seen.add(model.slug)
    // ChatGPT OAuth permits models even when supported_in_api is false.
    if (model.visibility !== 'list') continue
    // The usable ceiling, not the billing boundary. This endpoint reports
    // gpt-6.1-sol as context_window=272000 — the point where long-context
    // billing starts — and max_context_window=872000, the maximum the account
    // may actually declare. Declaring the smaller value makes the adapter
    // compact far earlier than the account allows, so the maximum wins and the
    // model's own window is the fallback for listings that omit it.
    const contextWindow = positive(model.max_context_window) ?? positive(model.context_window)
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
  if (entries.length === 0) throw new PatchError('source-unavailable', 'Codex listing contains no serviceable models.')
  return { entries, unsupported, limited, total: models.length }
}

/** Bounded read: a response with private instructions must not reach the browser. */
export async function fetchCodexCatalog(access: string, accountId: string | undefined, fetcher: typeof fetch = fetch) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 7000)
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${access}`, accept: 'application/json' }
    if (accountId) headers['chatgpt-account-id'] = accountId
    let response: Response
    try {
      response = await fetcher(URL, { method: 'GET', headers, redirect: 'error', signal: controller.signal })
    } catch (error) {
      // A transport failure and an HTTP refusal are different reports.
      throw new PatchError('source-unavailable', `Codex model listing could not be reached: ${error instanceof Error ? error.message : 'request failed'}`)
    }
    if (!response.ok) throw new PatchError('source-unavailable', `Codex model listing was refused with HTTP ${response.status}.`)
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new PatchError('source-unavailable', 'Codex model listing exceeds size limit.')
    if (!response.body) throw new PatchError('source-unavailable', 'Codex model listing has no body.')
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) throw new PatchError('source-unavailable', 'Codex model listing exceeds size limit.')
        parts.push(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.length }
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    } catch {
      // A truncated or non-JSON body is a source failure, not a parse bug.
      throw new PatchError('source-unavailable', 'Codex model listing is not valid JSON.')
    }
    return parseRemoteCatalog(payload)
  } finally { clearTimeout(timeout) }
}

function descriptor(settings: PatchSettings) {
  const entry = settings.describe({ redactSecrets: true }).find(item => item.ns === CODEX_SETTINGS_NS)
  const route = object(object(entry?.value)?.providers)?.[CODEX_PROVIDER]
  if (!entry || !object(route)) throw new PatchError('route-missing', 'Add the openai-codex route in Models settings first.')
  const raw = object(object(entry.user)?.providers)?.[CODEX_PROVIDER]
  const explicit = object(raw)?.models ?? object(route)?.models
  if (explicit !== undefined && !Array.isArray(explicit)) throw new PatchError('config-unmergeable', 'Existing model configuration cannot be safely merged.')
  return { entry, explicit: explicit as unknown[] | undefined }
}

function fingerprint(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

export function createModelPatches(ctx: CodexContext, services: PatchServices, fetcher: typeof fetch = fetch) {
  async function preview() {
    if (!services.settings.writable) throw new PatchError('settings-read-only', 'Model settings are read-only.')
    // Local refusals are decided before the network: a section that cannot
    // accept the patch must not cost a request to discover.
    const { entry, explicit } = descriptor(services.settings)
    const record = await ctx.credentials.readRecord(CODEX_KEY)
    const grant = record?.kind === 'grant' ? object(record.payload) : undefined
    if (typeof grant?.access !== 'string' || grant.access.length === 0) throw new PatchError('sign-in-required', 'Sign in to ChatGPT first.')
    if (!positive(grant.expires) || (grant.expires as number) <= Date.now()) throw new PatchError('credential-expired', 'Sign in to ChatGPT or refresh the expired credential first.')
    const accountId = typeof grant.accountId === 'string' && grant.accountId.length > 0 ? grant.accountId : undefined
    if (!accountId) throw new PatchError('credential-incomplete', 'Codex credential has no account ID; sign in again.')
    const catalog = await fetchCodexCatalog(grant.access, accountId, fetcher)
    const current = await services.llm.listModels(CODEX_PROVIDER)
    const currentIds = new Set(current.map(model => model.id))
    const missing = catalog.entries.filter(model => !currentIds.has(model.id))
    const original = [...explicit ?? []]
    if (!original.every(value => typeof object(value)?.id === 'string')) throw new PatchError('config-unmergeable', 'Existing model configuration cannot be safely merged.')
    const savedIds = new Set(original.map(value => object(value)?.id))
    // Explicit settings may be empty/defaulted while the runtime exposes a catalog.
    for (const model of current) {
      if (!savedIds.has(model.id)) { original.push({ id: model.id }); savedIds.add(model.id) }
    }
    const added = missing.filter(model => !savedIds.has(model.id))
    // An explicit entry keeps its declared capacity verbatim — a user may have
    // chosen it. When the source now allows more, that is reported rather than
    // rewritten, so a stale value is visible instead of silently preserved.
    const capacityById = new Map(catalog.entries.map(model => [model.id, model.contextWindow]))
    const understated = original.flatMap(value => {
      const entry = object(value)
      const id = typeof entry?.id === 'string' ? entry.id : undefined
      const declared = positive(entry?.contextWindow)
      const source = id === undefined ? undefined : capacityById.get(id)
      return id !== undefined && declared !== undefined && source !== undefined && source > declared
        ? [{ id, declared, source }] : []
    })
    const proposed = [...original, ...added]
    // A listed target that the account cannot select is a different report from
    // a catalogue with nothing left to add.
    const alreadySelectable = catalog.entries.filter(model => currentIds.has(model.id)).map(model => model.id)
    // Selectable models the account listing does not carry: a model kept from an
    // older catalogue, or one the account cannot see. Reported, never removed.
    const listedIds = new Set(catalog.entries.map(model => model.id))
    const unlisted = [...currentIds].filter(id => !listedIds.has(id))
    const signature = fingerprint({ accountId, revision: entry.revision, catalog: catalog.entries, limited: catalog.limited, original, current: [...currentIds] })
    return {
      source: SOURCE, clientVersion: CODEX_CLIENT_VERSION, fetchedAt: Date.now(),
      total: catalog.total, unsupported: catalog.unsupported, limited: catalog.limited,
      current: currentIds.size, added: added.map(x => x.id), alreadySelectable, unlisted, understated,
      preserved: original.map(x => object(x)?.id), signature, revision: entry.revision, proposed,
      // The explicit `models` list takes over the whole catalogue; the page says so.
      replacesCatalog: true,
    }
  }
  return {
    /** Read-only view over what the runtime already offers; never proposes an addition. */
    async fallback(reason?: PatchReason) {
      const current = await services.llm.listModels(CODEX_PROVIDER)
      return {
        unavailable: 'Codex remote listing is unavailable; no models were added.',
        reason: reason ?? 'source-unavailable',
        source: 'current configured pi-ai models (read-only fallback)',
        total: current.length, unsupported: 0, limited: [], current: current.length,
        added: [], alreadySelectable: current.map(x => x.id), unlisted: [], understated: [], preserved: current.map(x => x.id),
        signature: '', replacesCatalog: false,
      }
    },
    async preview() { const { proposed: _proposed, ...view } = await preview(); return view },
    async apply(signature: string) {
      if (!/^[a-f0-9]{64}$/.test(signature)) throw new PatchError('conflict', 'Invalid model patch confirmation.')
      const plan = await preview()
      if (plan.signature !== signature) throw new PatchError('conflict', 'Model catalog or settings changed; review the patch again.')
      if (plan.added.length === 0) return { applied: [], ...(await this.preview()) }
      await services.settings.mutate(CODEX_SETTINGS_NS, [{ op: 'set', path: ['providers', CODEX_PROVIDER, 'models'], value: plan.proposed }], plan.revision)
      const ids = new Set((await services.llm.listModels(CODEX_PROVIDER)).map(x => x.id))
      if (![...plan.added, ...plan.preserved].every(id => typeof id === 'string' && ids.has(id))) throw new PatchError('registration-unconfirmed', 'Settings saved, but model registration could not be confirmed.')
      // The record a later review needs: what this patch added, the revision it
      // replaced, and the one it produced. Nothing here is persisted or secret.
      const after = services.settings.describe({ redactSecrets: true }).find(item => item.ns === CODEX_SETTINGS_NS)?.revision
      return {
        applied: plan.added,
        before: { revision: plan.revision, models: plan.preserved },
        after: { revision: after, models: [...plan.preserved, ...plan.added] },
        source: plan.source, clientVersion: plan.clientVersion, fetchedAt: plan.fetchedAt,
        added: [], alreadySelectable: [...plan.alreadySelectable, ...plan.added], unlisted: plan.unlisted, understated: plan.understated, preserved: plan.preserved,
        total: plan.total, unsupported: plan.unsupported, limited: plan.limited, signature: '', replacesCatalog: true,
      }
    },
  }
}
