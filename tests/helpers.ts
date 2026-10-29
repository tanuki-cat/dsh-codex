/**
 * Doubles shared by the plugin's tests.
 *
 * Only what the surviving modules actually touch: a credential store with the
 * harness record protocol, an HTTP response builder, and the resolver that
 * points host imports at one installed DSH.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Resolve matching imports out of one installed DSH rather than this project.
 *
 * Rebasing the parent URL makes the built-in resolver pick the install's copy.
 * Calling `require.resolve` from inside a `resolve` hook instead runs the hook
 * re-entrantly — Node 24 overflows the stack on it — so this stays the portable
 * form. Subpaths and export maps resolve the same way a bare name does.
 * @param root - Installed DSH package directory.
 * @param matches - Specifiers the install owns, e.g. host packages or `undici`.
 * @returns A `registerHooks` resolve callback.
 */
export function installedHostResolver(root, matches) {
  const parentURL = pathToFileURL(join(root, 'package.json')).href
  return (specifier, context, next) => matches(specifier) ? next(specifier, { ...context, parentURL }) : next(specifier, context)
}

/**
 * An in-memory credential store with the harness record semantics.
 *
 * modifyRecord returns the committed snapshot, propagates a mutation's own
 * rejection, and serializes writers so a test can rely on ordering.
 */
export function store(entries = []) {
  const values = new Map(entries)
  let tail = Promise.resolve()
  return {
    values,
    async readRecord(key) { return structuredClone(values.get(key)) },
    async listRecords() { return [...values.keys()].map(key => ({ key })) },
    modifyRecord(key, mutate) {
      const task = tail.then(async () => {
        const next = await mutate(structuredClone(values.get(key)))
        if (next !== undefined) values.set(key, structuredClone(next))
        return structuredClone(values.get(key))
      })
      tail = task.catch(() => {})
      return task
    },
    deleteRecord(key) {
      const task = tail.then(() => { values.delete(key) })
      tail = task.catch(() => {})
      return task
    },
  }
}

/**
 * The executor plugin carrying one tool presentation on this host generation.
 *
 * 0.2.2-alpha.2 moved the presentation out of `ToolRuntime`'s config and into
 * mounted executor plugins; the removed `mode` key now validates as `never`,
 * which leaves the registry fiber inactive rather than failing loudly.
 * @param mode - `native` (call tools by name) or `ptc` (reach them from `run_code`).
 * @returns The executor module, or undefined on a host that still takes `mode`.
 */
export async function toolExecutor(mode) {
  const name = mode === 'ptc' ? '@deepseek-ai/dsh-tool-executor-ptc' : '@deepseek-ai/dsh-tool-executor-native'
  return import(name).catch(() => undefined)
}

/**
 * Run one tool call and return the call's own result.
 *
 * 0.2.2-alpha.2 replaced the single-call `tools.execute({ name, arguments })`
 * with an executor-dispatched batch that takes `calls` and returns
 * `{ results }`. `selectExecutor` exists only on that generation, so it is the
 * capability probe; every earlier host keeps the single-call contract.
 * @param tools - Installed host tool registry.
 * @param call - Name, parsed arguments, and the caller's agent/signal/call id.
 * @returns That call's settled result, including any extra model contexts.
 */
export async function callTool(tools, call) {
  if (typeof tools.selectExecutor !== 'function') {
    return tools.execute({ name: call.name, arguments: call.arguments, agent: call.agent, callId: call.callId, signal: call.signal })
  }
  const block = { type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) }
  const batch = await tools.execute({ calls: [block], agent: call.agent, signal: call.signal })
  const result = batch.results[0].result
  return { ...result, additionalContexts: result.additionalContexts ?? batch.additionalContexts }
}

/** A JSON response with the content type every fetch double is read through. */
export const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
