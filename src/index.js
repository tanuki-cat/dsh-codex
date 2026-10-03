/**
 * ChatGPT sign-in for the official openai-codex route.
 *
 * DSH's llm-pi-ai mounts pi-ai's provider logins on the authorization seam,
 * but no surface calls them: the Models page sign-in slot belongs to the
 * DeepSeek account, and the provider-card slot has no registrant. This plugin
 * is that registrant — a settings-page surface for one flow the host already
 * implements.
 *
 * It deliberately owns no protocol: pi-ai speaks the wire format, writes the
 * credential, and refreshes it. Removing this plugin removes a button, not a
 * provider.
 * @module dsh-llm-chatgpt
 */
import { createCodexManagement, registerCodexManagement } from './management.js'

export const name = 'llm-chatgpt'
export const inject = ['credentials', 'authorization']

export function apply(ctx) {
  // Register independently of flow mount order. The status operation checks
  // availability dynamically, and the client hides the card until llm-pi-ai
  // offers the flow.
  ctx.inject(['webServer', 'webRuntime'], web => {
    registerCodexManagement(web, createCodexManagement(ctx))
  })
}
