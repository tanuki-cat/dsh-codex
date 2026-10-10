/**
 * ChatGPT sign-in for the official openai-codex route.
 *
 * DSH's llm-pi-ai mounts pi-ai's provider logins on the authorization seam,
 * but no surface calls them: the Models page sign-in slot belongs to the
 * DeepSeek account, and the provider-card slot has no registrant. This plugin
 * is that registrant — a settings-page surface for one flow the host already
 * implements.
 *
 * pi-ai owns chat transport, login, and credential refresh. The optional
 * image_gen tool calls the standalone Codex image endpoint and stores results
 * through host attachments; removing this plugin does not remove the provider.
 * @module dsh-llm-chatgpt
 */
import { createCodexManagement, registerCodexManagement } from './management.js'
import { createModelPatches } from './model-patches.js'
import { createUsageService } from './usage.js'
import { registerUsageCommand } from './usage-command.js'
import { registerImageTool } from './image-tool.js'
import type { PluginContext } from './types.js'

export const name = 'llm-chatgpt'
export const inject = ['credentials', 'authorization']

export function apply(ctx: PluginContext) {
  // Register independently of flow mount order. The status operation checks
  // availability dynamically, and the client hides the card until llm-pi-ai
  // offers the flow.
  const usage = createUsageService(ctx)
  ctx.effect(() => () => usage.dispose(), 'codex usage service')
  ctx.inject(['commands'], commands => { registerUsageCommand(commands, usage) })
  ctx.inject(['tools', 'attachments', 'llm'], async services => { await registerImageTool(ctx, services) })
  let patches: ReturnType<typeof createModelPatches> | undefined
  ctx.inject(['settings', 'llm'], services => { patches = createModelPatches(ctx, services) })
  ctx.inject(['webServer', 'webRuntime'], web => {
    registerCodexManagement(web, createCodexManagement(ctx, paused => usage.setPaused(paused ?? false)), () => patches, usage)
  })
}
