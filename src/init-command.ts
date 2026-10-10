import type { createUserMessage } from '@deepseek-ai/dsh-llm'
import { INIT_PROMPT } from './init-prompt.js'

export interface InitTaskSource {
  kind: 'codex-init'
  form: 'notice'
  summary: string
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'codex-init': InitTaskSource }
}

type MessageFactory = typeof createUserMessage
export type InitCommandResult = { kind: 'success' | 'error'; text: string }
export interface InitCommandInvocation {
  rawInput: string
  signal: AbortSignal
  attachments?: readonly unknown[]
  agent?: { followup(message: ReturnType<MessageFactory>): void }
}
export interface InitCommandServices {
  commands: { register(definition: { name: string; description: string; handler(invocation: InitCommandInvocation): Promise<InitCommandResult> }): () => void }
  effect(factory: () => () => void, label: string): void
}

export function createInitCommand(
  loadMessage: () => Promise<MessageFactory> = async () => (await import('@deepseek-ai/dsh-llm')).createUserMessage,
  closed: () => boolean = () => false,
) {
  return async (invocation: InitCommandInvocation): Promise<InitCommandResult> => {
    const error = (text: string): InitCommandResult => ({ kind: 'error', text })
    const stopped = () => invocation.signal.aborted ? error('项目规则初始化已取消')
      : closed() ? error('项目规则初始化命令已卸载') : undefined
    if (invocation.rawInput.trim() || invocation.attachments?.length) return error('用法：/init（无需参数或附件）')
    const initialStop = stopped()
    if (initialStop) return initialStop
    const agent = invocation.agent
    if (typeof agent?.followup !== 'function') return error('当前宿主不支持初始化任务，请更新 DSH')
    try {
      const makeMessage = await loadMessage()
      const finalStop = stopped()
      if (finalStop) return finalStop
      agent.followup(makeMessage({ content: [{ type: 'text', text: INIT_PROMPT }], source: { kind: 'codex-init', form: 'notice', summary: '初始化项目规则' } }))
      return { kind: 'success', text: '已提交项目规则初始化任务；生成结果将在会话中展示' }
    } catch {
      return stopped() ?? error('无法提交初始化任务，请检查宿主消息服务后重试')
    }
  }
}

export function registerInitCommand(ctx: InitCommandServices, loadMessage?: () => Promise<MessageFactory>) {
  let closed = false
  const unregister = ctx.commands.register({
    name: 'init', description: '由当前模型生成项目 AGENTS.md；保留已有文件',
    handler: createInitCommand(loadMessage, () => closed),
  })
  const dispose = () => { if (!closed) { closed = true; unregister() } }
  ctx.effect(() => dispose, 'codex init command')
  return dispose
}
