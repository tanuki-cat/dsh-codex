import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type LlmRouter from '@deepseek-ai/dsh-llm'
import type { ToolRuntime, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createImageService } from './image-service.js'
import { ImageError, MAX_PROMPT_LENGTH } from './image-api.js'
import type { CodexContext } from './types.js'

export interface ImageToolServices {
  tools: Pick<ToolRuntime, 'register'>
  attachments: Pick<AttachmentStore, 'imageLimits' | 'saveImage'>
  llm: Pick<LlmRouter, 'resolveModelInfo'>
  on(event: 'credentials/record-updated', callback: (key: string) => Promise<void>): (() => void) | void
  effect(factory: () => () => Promise<void> | void, label: string): void
}
export const IMAGE_TOOL_DESCRIPTION = 'Generate a raster image with ChatGPT and return a persistent image attachment for viewing and downloading. Use code-native assets for SVG or HTML/CSS instead. For nested calls, use a run_code timeoutMs of at least 240000. Consumes image quota; do not automatically repeat uncertain or storage-failed requests.'
const imageSchema = {
  type: 'object', additionalProperties: false, required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: { type: 'object', additionalProperties: false, properties: {
      width: { type: 'integer', required: true }, height: { type: 'integer', required: true },
    } },
  },
} as const
/** Require the same current image-capable route as the host read_image tool, before spending quota. */
async function assertImageRoute(ctx: ImageToolServices, exec: ToolRunContext) {
  const config = exec.agent?.session.requestHeader()?.config
  const provider = config?.provider ?? exec.agent?.options.provider
  const model = config?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) throw new ImageError('model-incapable')
  try {
    const active = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
    if (!active.inputModalities?.includes('image')) throw new ImageError('model-incapable')
  } catch { throw new ImageError(exec.signal.aborted ? 'cancelled' : 'model-incapable') }
}
/** Dynamic public imports keep the login plugin usable without the optional tool packages. */
export async function registerImageTool(auth: CodexContext, ctx: ImageToolServices, options: Parameters<typeof createImageService>[1] = {}) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')
  const { AttachmentId } = await import('@deepseek-ai/dsh-attachment')
  const service = createImageService({ credentials: auth.credentials, authorization: auth.authorization,
    attachments: ctx.attachments, on: ctx.on.bind(ctx) }, options)
  ctx.effect(() => () => service.dispose(), 'codex image service')
  const unregister = ctx.tools.register(defineTool({
    name: 'image_gen', description: IMAGE_TOOL_DESCRIPTION,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Describe the image, purpose, and constraints. Non-blank; at most ' + MAX_PROMPT_LENGTH + ' characters.' },
      transparent_background: { type: 'boolean', description: 'Request a transparent background. Default: false.', default: false },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        image: imageSchema, model: { type: 'string', const: 'gpt-image-2', required: true }, requestId: { type: 'string' },
      } },
      render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value) },
        { type: 'image', attachment: { ...value.image, attachmentId: AttachmentId(value.image.attachmentId) } },
      ],
    },
    timeoutMs: 210_000,
    async execute(args, exec) { await assertImageRoute(ctx, exec); return service.generate(args, exec.signal) },
    presentCall() { return { card: 'generic', title: 'Generate image', kind: 'other' } },
  }))
  ctx.effect(() => unregister, 'codex image tool')
  return service
}
