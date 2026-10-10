import { execFile } from 'node:child_process'
import { resolve } from 'import-meta-resolve'
import { CODEX_KEY, CODEX_PROVIDER } from './codex.js'
import type { CodexContext } from './types.js'

export interface NativeModel { id: string; contextWindow?: number; maxTokens?: number }
export interface HostCatalog {
  models: readonly NativeModel[]
  refreshCredential(options?: { signal?: AbortSignal; minOAuthValidityMs?: number; rejectedAccess?: string }): Promise<void>
}
type Credential = { type: 'oauth'; access: string; refresh: string; expires: number; [key: string]: unknown }
type Store = {
  read(id: string): Promise<Credential | undefined>
  list(): Promise<{ providerId: string; type: 'oauth' }[]>
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>
  delete(id: string): Promise<void>
}
type Provider = { getModels(): readonly NativeModel[] }
type PiModule = { createModels(options: { credentials: Store }): {
  setProvider(provider: Provider): void
  getAuth(id: string, options: { signal: AbortSignal; minOAuthValidityMs: number }): Promise<unknown>
} }

/** Resolve public pi-ai exports from the adapter, not a second installed copy. */
export async function loadHostCatalog(ctx: CodexContext, adapterUrl?: string): Promise<HostCatalog | undefined> {
  let adapter: string
  try {
    adapter = adapterUrl ?? import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai')
  } catch (error) {
    if (['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
    throw error
  }
  let piUrl: string, providerUrl: string
  try {
    piUrl = resolve('@earendil-works/pi-ai', adapter)
    providerUrl = resolve('@earendil-works/pi-ai/providers/openai-codex', adapter)
  } catch (error) {
    if (['ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
    throw error
  }
  const pi = await import(piUrl) as PiModule
  const module = await import(providerUrl) as { openaiCodexProvider(): Provider }
  if (typeof pi.createModels !== 'function' || typeof module.openaiCodexProvider !== 'function') return undefined
  return bindHostCatalog(ctx, pi, module.openaiCodexProvider())
}

/** Bind the provider's public auth resolver to the same serialized DSH record. */
export function bindHostCatalog(ctx: CodexContext, pi: PiModule, provider: Provider): HostCatalog {
  const payload = (record: Awaited<ReturnType<CodexContext['credentials']['readRecord']>>): Credential | undefined => {
    const value = record?.kind === 'grant' ? record.payload as Partial<Credential> : undefined
    return value?.type === 'oauth' && typeof value.access === 'string' && typeof value.refresh === 'string' && typeof value.expires === 'number' ? value as Credential : undefined
  }
  const assertProvider = (id: string) => { if (id !== CODEX_PROVIDER) throw new Error('Unexpected credential provider.') }
  const store: Store = {
    async read(id) { assertProvider(id); return payload(await ctx.credentials.readRecord(CODEX_KEY)) },
    async list() { return await this.read(CODEX_PROVIDER) ? [{ providerId: CODEX_PROVIDER, type: 'oauth' }] : [] },
    async modify(id, fn) {
      assertProvider(id)
      if (!ctx.credentials.modifyRecord) throw new Error('Credential store does not support refresh.')
      return payload(await ctx.credentials.modifyRecord(CODEX_KEY, async current => {
        const next = await fn(payload(current))
        return next === undefined ? undefined : { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) }
      }))
    },
    async delete(id) { assertProvider(id); await ctx.credentials.deleteRecord(CODEX_KEY) },
  }
  const models = pi.createModels({ credentials: store })
  models.setProvider(provider)
  return {
    models: provider.getModels(),
    async refreshCredential(options = {}) {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)
      let resolver = models
      if (options.rejectedAccess) {
        // Only the explicitly rejected token looks expired to pi-ai; never persist this projection.
        const project = (credential: Credential | undefined) => credential && credential.access === options.rejectedAccess ? { ...credential, expires: 0 } : credential
        resolver = pi.createModels({ credentials: { ...store,
          read: async id => project(await store.read(id)),
          modify: (id, fn) => store.modify(id, current => fn(project(current))),
        } })
        resolver.setProvider(provider)
      }
      if (!await resolver.getAuth(CODEX_PROVIDER, { signal, minOAuthValidityMs: options.minOAuthValidityMs ?? 300_000 })) throw new Error('No usable Codex credential.')
    },
  }
}

export type ClientVersion = { value: string; source: 'environment' | 'codex-cli' | 'builtin' }
export const CODEX_CLIENT_VERSION = '0.160.1'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** A bounded CLI probe; a validated environment override can pin a known contract. */
export async function resolveClientVersion(
  override: string | null = process.env.DSH_CODEX_CLIENT_VERSION ?? null,
  probe = () => new Promise<string>((resolve, reject) => execFile('codex', ['--version'], { timeout: 1500, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout))),
): Promise<ClientVersion> {
  if (override !== null) {
    if (override.length > 64 || !VERSION.test(override)) throw new Error('DSH_CODEX_CLIENT_VERSION must be a semantic version.')
    return { value: override, source: 'environment' }
  }
  try {
    const match = /^codex(?:-cli)?\s+(\S+)\s*$/.exec((await probe()).trim())
    if (match && VERSION.test(match[1])) return { value: match[1], source: 'codex-cli' }
  } catch { /* An absent or unavailable CLI leaves the tested request contract in place. */ }
  return { value: CODEX_CLIENT_VERSION, source: 'builtin' }
}
