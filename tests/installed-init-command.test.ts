import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const root = process.env.DSH_INSTALL_ROOT
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('installed commands drive init in a separate real AgentLoop turn and preserve guarded creation conflicts', {
  skip: root ? false : 'Set DSH_INSTALL_ROOT to test installed init services.', timeout: 30_000,
}, async t => {
  const require = createRequire(resolve(root, 'package.json'))
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true }
    return next(specifier, context)
  } })
  t.after(() => hooks.deregister())
  const { Context } = await import('@deepseek-ai/cordis')
  const { SessionStore } = await import('@deepseek-ai/dsh-session')
  const { SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
  const { AgentRegistry } = await import('@deepseek-ai/dsh-agent')
  const { AgentLoop } = await import('@deepseek-ai/dsh-agent-loop')
  const { LlmRuntime, LlmAdapter, createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { CommandRuntime } = await import('@deepseek-ai/dsh-commands')
  const { LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local')
  const observation = await import('@deepseek-ai/dsh-fs-observation-policy')
  const fsTools = await import('@deepseek-ai/dsh-tool-fs')
  // 0.2.1-alpha.2 moved the working directory into its own service, which the
  // fs tool suite now injects; without it the suite registers no tools at all.
  // Absent on older hosts, where the suite took the directory from fs-local.
  const workingDirectory = await import('@deepseek-ai/dsh-working-directory').then(module => module.default).catch(() => undefined)
  const instructions = await import('@deepseek-ai/dsh-agent-instructions')
  const { registerInitCommand } = await import('../lib/init-command.js')
  const { INIT_PROMPT } = await import('../lib/init-prompt.js')
  const directory = await mkdtemp(join(tmpdir(), 'codex-init-host-'))
  const workspace = join(directory, 'project'), conflictWorkspace = join(directory, 'conflict')
  await mkdir(workspace); await mkdir(conflictWorkspace)
  await mkdir(join(workspace, '.git')); await mkdir(join(conflictWorkspace, '.git'))
  const ctx = new Context(), fibers = [], agents = []
  const entered = barrier(), release = barrier(), staged = barrier(), publish = barrier(), requests = []
  t.after(async () => {
    release.resolve(); publish.resolve()
    for (const agent of agents) { agent.cancel({ kind: 'user' }); await agent.whenIdle() }
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const mount = plugin => fibers.push(ctx.plugin(plugin))
  mount(SessionProjectionRegistry); mount(SessionStore); mount(AgentRegistry); mount(SystemPrompt)
  mount(ToolRuntime); mount(LlmRuntime); mount(CommandRuntime)
  fibers.push(ctx.plugin(LocalFileSystem, { cwd: directory }))
  if (workingDirectory) fibers.push(ctx.plugin(workingDirectory, { defaultDirectory: directory }))
  mount(observation); mount(fsTools)
  fibers.push(ctx.plugin(instructions, { dshHome: join(directory, 'home'), maxBytes: 4096 }))
  fibers.push(ctx.plugin(AgentLoop, { agents: [] }))
  await new Promise(done => setImmediate(done))
  assert.ok(ctx.agentLoop); assert.ok(ctx.tools); assert.ok(ctx.fs)
  const states = new Map()
  // The scripted provider tests host execution and refresh, not autonomous model adherence.
  class Adapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      const init = options.messages.findLast(message => message.role === 'user' && message.content.some(block => block.type === 'text' && block.text === INIT_PROMPT))
      if (!init) { entered.resolve(); await release.promise; yield { type: 'finish', reason: 'stop' }; return }
      const state = states.get(init.id) ?? { step: 0, writes: 0 }
      states.set(init.id, state)
      const toolResults = options.messages.filter(message => message.role === 'tool')
      const previous = toolResults.at(-1)
      let call
      if (state.step === 0) call = ['read', { file_path: 'AGENTS.md' }]
      else if (state.step === 1 && previous?.isError) { call = ['write', { file_path: 'AGENTS.md', content: '# Repository Guidelines\n\nUse the project build configuration.\n' }]; state.writes++ }
      else if (state.step === 2 && !previous?.isError) call = ['read', { file_path: 'AGENTS.md' }]
      state.step++
      if (!call) { yield { type: 'finish', reason: 'stop' }; return }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'init-call-' + init.id + '-' + state.step, name: call[0], argumentsDelta: JSON.stringify(call[1]) }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'init-call-' + init.id + '-' + state.step, name: call[0], arguments: call[1] } }
      yield { type: 'finish', reason: 'tool-calls' }
    }
  }
  const adapterRegistration = ctx.llm.registerAdapter(['init-test'], new Adapter())
  t.after(adapterRegistration)
  const registration = ctx.plugin({ name: 'init-integration', inject: ['commands'], apply(scope) { registerInitCommand(scope) } })
  fibers.push(registration)
  await new Promise(done => setImmediate(done))
  const agent = await ctx.agentLoop.create('init-host', { provider: 'init-test', model: 'fixture' }, { cwd: workspace })
  agents.push(agent)
  assert.ok(ctx.commands.list(agent).find(item => item.name === 'init'))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'busy' }], source: { kind: 'user' } }))
  await entered.promise
  const result = await ctx.commands.execute(agent, '/init', [], new AbortController().signal)
  assert.equal(result.result.kind, 'success')
  assert.equal(requests.length, 1)
  release.resolve()
  await agent.whenIdle()
  assert.match(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), /Repository Guidelines/)
  assert.ok(requests.some(request => request.messages.some(message => message.source?.kind === 'agent-instructions' && message.content.some(block => block.type === 'text' && block.text.includes('Use the project build configuration.')))), 'created rules refresh into a subsequent model request')
  const events = agent.session.snapshotEvents()
  const task = events.find(event => event.type === 'user/message' && event.data.source.kind === 'codex-init')
  assert.deepEqual(task?.data.source, { kind: 'codex-init', form: 'notice', summary: '初始化项目规则' })
  assert.equal(task?.data.content[0].text, INIT_PROMPT)
  assert.ok(requests.some(request => request.messages.some(message => message.source?.kind === 'codex-init' && message.content[0].text === INIT_PROMPT)), 'the real loop keeps full task instructions model-facing')
  const runs = events.filter(event => event.type === 'command/run'), done = events.filter(event => event.type === 'command/done')
  assert.equal(runs[0].data.commandId, done[0].data.commandId)
  assert.equal(events.filter(event => event.type === 'turn/start').length, 2)
  const before = await readFile(join(workspace, 'AGENTS.md'), 'utf8')
  await ctx.commands.execute(agent, '/init', [], new AbortController().signal); await agent.whenIdle()
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), before)

  const conflictAgent = await ctx.agentLoop.create('init-conflict', { provider: 'init-test', model: 'fixture' }, { cwd: conflictWorkspace })
  agents.push(conflictAgent)
  ctx.fs.internals.inspectTemp = async () => { staged.resolve(); await publish.promise }
  await ctx.commands.execute(conflictAgent, '/init', [], new AbortController().signal)
  await staged.promise
  await writeFile(join(conflictWorkspace, 'AGENTS.md'), 'concurrent-owner', { flag: 'wx' })
  publish.resolve(); await conflictAgent.whenIdle()
  assert.equal(await readFile(join(conflictWorkspace, 'AGENTS.md'), 'utf8'), 'concurrent-owner')
  const results = conflictAgent.session.snapshotEvents().filter(event => event.type === 'tool/result')
  assert.ok(results.some(event => event.data.message?.isError || event.data.isError), JSON.stringify(results))
  assert.equal(conflictAgent.session.snapshotEvents().filter(event => event.type === 'tool/call' && event.data.name === 'write').length, 1)
  await registration.dispose()
  assert.equal(ctx.commands.list(agent).some(item => item.name === 'init'), false)
})
