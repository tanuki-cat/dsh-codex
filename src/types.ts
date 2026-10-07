import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationNotice } from '@deepseek-ai/dsh-authorization/types'
import type { PatchServices } from './model-patches.js'

export interface CodexContext {
  authorization: Pick<AuthorizationService, 'describe' | 'begin' | 'cancel'>
  credentials: Pick<CredentialProvider, 'readRecord' | 'deleteRecord'> & Partial<Pick<CredentialProvider, 'modifyRecord'>>
}

export interface WebContext {
  webServer: { register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void }
  webRuntime: { trustedHosts: string[] }
  on(event: 'webserver/index-inject', callback: (table: Array<{ kind: 'script'; placement: 'head'; text: string }>) => void): void
  effect(factory: () => () => Promise<void> | void, label: string): void
}

export interface PluginContext extends CodexContext {
  inject(services: string[], callback: (context: WebContext & PatchServices) => void): void
}

export interface ManagementState {
  state: 'idle' | 'pending' | 'authorized' | 'cancelled' | 'failed'
  notice?: AuthorizationNotice
  error?: string
}
