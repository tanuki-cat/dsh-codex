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
import { codexFlow } from './codex.js'

export const name = 'llm-chatgpt'
export const inject = ['credentials', 'authorization']

export function apply(ctx) {
  // No flow means no llm-pi-ai in this composition, so there is nothing to
  // sign into and no endpoint is worth registering: the page then shows no
  // button instead of one that cannot work.
  if (codexFlow(ctx) === undefined) return
  ctx.inject(['webServer', 'webRuntime'], web => {
    registerCodexManagement(web, createCodexManagement(ctx))
  })
}
