import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationNotice } from '@deepseek-ai/dsh-authorization/types'
import type { PatchServices } from './model-patches.js'
import type { UsageCommandServices } from './usage-command.js'
import type { InitCommandServices } from './init-command.js'
import type { ImageToolServices } from './image-tool.js'

export interface CodexContext {
  authorization: Pick<AuthorizationService, 'describe' | 'begin' | 'cancel'>
  credentials: Pick<CredentialProvider, 'readRecord' | 'deleteRecord'> & Partial<Pick<CredentialProvider, 'modifyRecord'>>
}

/**
 * The web services one sign-in surface needs, across host generations.
 *
 * Trust authorities moved: 0.2.0-rc.2 and 0.2.1-alpha.1 publish bind-time LAN
 * literals and invocation authorities through `webRuntime`, while
 * 0.2.1-alpha.2 dropped that service — it reads invocation authorities from
 * `webStartup` and accepts the listener's own bind address separately. Every
 * source is optional here and read through {@link trustAuthorities}, so a host
 * that dropped one still reaches the endpoint.
 */
export interface WebContext {
  webServer: {
    register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void
    /** The configured bind address; alpha.2 accepts it beside this list. */
    host?: string
  }
  /** Bind-time LAN literals plus invocation authorities; absent from alpha.2 on. */
  webRuntime?: { trustedHosts: string[] }
  /** Invocation authorities; the surviving source on alpha.2. */
  webStartup?: { trustedHosts: string[] }
  /** Cordis service read without an inject requirement; absent on host doubles. */
  get?(name: string): unknown
  on(event: 'webserver/index-inject', callback: (table: Array<{ kind: 'script'; placement: 'head'; text: string }>) => void): void
  effect(factory: () => () => Promise<void> | void, label: string): void
}

export interface PluginContext extends CodexContext {
  effect(factory: () => () => Promise<void> | void, label: string): void
  inject(services: string[], callback: (context: WebContext & PatchServices & UsageCommandServices & InitCommandServices & ImageToolServices) => Promise<void> | void): void
}

export interface ManagementState {
  state: 'idle' | 'pending' | 'authorized' | 'cancelled' | 'failed'
  notice?: AuthorizationNotice
  error?: string
}
