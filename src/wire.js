import { API, PlanError, boundedSignal, checkedFetch, jsonFetch } from './http.js'

function textContent(blocks) {
  return blocks.map(block => {
    if (block.type !== 'text') throw new PlanError('This ChatGPT plugin currently accepts text input only.', 'UNSUPPORTED_CONTENT')
    return block.text
  }).join('\n')
}

function usableReplay(items, content) {
  if (!Array.isArray(items) || items.length === 0) return false
  const calls = items.filter(item => item.type === 'function_call')
  const expectedCalls = content.filter(block => block.type === 'tool-call')
  if (calls.length !== expectedCalls.length || !expectedCalls.every(block => calls.some(item =>
    item.call_id === block.id && item.name === block.name && item.arguments === block.arguments))) return false
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('')
  const nativeText = items.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
    .map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '').join('')
  return text === nativeText
}

export function requestBody(options) {
  if (options.stop?.length) throw new PlanError('ChatGPT plan requests do not support stop sequences.', 'UNSUPPORTED_OPTION')
  const input = []
  const instructions = options.system ? [options.system] : []
  for (const message of options.messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: textContent(message.content) })
      continue
    }
    // LlmRuntime removes tool-update developer messages for this route.
    if (message.role === 'developer') throw new PlanError('Developer tool updates must be projected by DSH before dispatch.', 'UNSUPPORTED_CONTENT')
    if (message.role === 'system') {
      instructions.push(textContent(message.content))
      continue
    }
    const replay = message.source?.replayState?.response
    if (message.role === 'assistant' && replay?.model === options.model && usableReplay(replay.items, message.content)) {
      input.push(...replay.items)
      continue
    }
    let text = []
    const flush = () => {
      if (text.length) input.push({ role: message.role, content: text.join('') })
      text = []
    }
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text)
      else if (block.type === 'reasoning') continue
      else if (block.type === 'tool-call') {
        flush()
        input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
      } else throw new PlanError('This ChatGPT plugin currently accepts text input only.', 'UNSUPPORTED_CONTENT')
    }
    flush()
  }
  const body = { model: options.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'] }
  if (instructions.length) body.instructions = instructions.join('\n\n')
  if (options.reasoningEffort) body.reasoning = { effort: options.reasoningEffort, summary: 'auto' }
  if (options.tools?.length) body.tools = [{ type: 'namespace', name: 'dsh',
    description: 'Tools executed by DeepSeek Harness.', tools: options.tools.map(tool => ({
      type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
    })) }]
  return body
}

export async function* sseEvents(body) {
  if (!body) throw new PlanError('ChatGPT returned no response stream.', 'STREAM_ERROR')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data || data === '[DONE]') return undefined
    try { return JSON.parse(data) } catch { throw new PlanError('Invalid ChatGPT stream event.', 'STREAM_ERROR') }
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (frame.length > 8 * 1024 * 1024) throw new PlanError('ChatGPT stream event is too large.', 'STREAM_ERROR')
        const event = parse(frame)
        if (event) yield event
      }
      if (buffer.length > 8 * 1024 * 1024) throw new PlanError('ChatGPT stream event is too large.', 'STREAM_ERROR')
      if (done) {
        if (buffer.trim()) {
          const event = parse(buffer)
          if (event) yield event
        }
        break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function models(grant, { fetcher = fetch, headers = {}, signal } = {}) {
  const result = await jsonFetch(fetcher, `${API}/models`, {
    signal: boundedSignal(signal), headers: { ...headers, authorization: `Bearer ${grant.accessToken}` },
  })
  if (!Array.isArray(result.models)) throw new PlanError('Invalid ChatGPT model catalog.', 'BAD_RESPONSE')
  return result.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string' && model.slug)
    .map(model => ({ id: model.slug, name: typeof model.display_name === 'string' ? model.display_name : model.slug,
      inputModalities: ['text'] }))
}

export async function* streamResponse(options, grant, { fetcher = fetch, headers = {}, timeoutMs = 600_000 } = {}) {
  const body = requestBody(options)
  const response = await checkedFetch(fetcher, `${API}/responses`, {
    method: 'POST', signal: boundedSignal(options.signal, timeoutMs),
    headers: { ...headers, authorization: `Bearer ${grant.accessToken}`,
      'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  })
  const blocks = new Map()
  const completedItems = new Map()
  let calls = false
  function* update(key, type, value, item, complete = false) {
    let entry = blocks.get(key)
    if (!entry) {
      if (type === 'tool-call' && (!item?.call_id || !item?.name)) throw new PlanError('Incomplete ChatGPT tool call.', 'STREAM_ERROR')
      entry = { index: blocks.size, type, value: '', item }
      blocks.set(key, entry)
      yield { type: 'block-start', index: entry.index, blockType: type }
    }
    if (typeof value !== 'string') throw new PlanError('Invalid ChatGPT stream delta.', 'STREAM_ERROR')
    if (complete && !value.startsWith(entry.value)) throw new PlanError('Inconsistent ChatGPT stream content.', 'STREAM_ERROR')
    const delta = complete ? value.slice(entry.value.length) : value
    entry.value += delta
    if (type === 'tool-call') {
      calls = true
      yield { type: 'tool-call-delta', index: entry.index, id: entry.item.call_id,
        name: entry.item.name, argumentsDelta: delta }
    } else if (delta) yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: entry.index, text: delta }
  }
  for await (const event of sseEvents(response.body)) {
    const index = event.output_index
    if (event.type === 'response.output_item.done') {
      if (!Number.isInteger(index) || index < 0 || !event.item) throw new PlanError('Invalid ChatGPT completed output item.', 'STREAM_ERROR')
      completedItems.set(index, event.item)
    } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      yield* update(`${index}:call`, 'tool-call', event.item.arguments ?? '', event.item)
    } else if (event.type === 'response.output_text.delta') {
      yield* update(`${index}:text:${event.content_index}`, 'text', event.delta)
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      yield* update(`${index}:reasoning:${event.summary_index}`, 'reasoning', event.delta)
    } else if (event.type === 'response.function_call_arguments.delta') {
      if (!blocks.has(`${index}:call`)) throw new PlanError('Tool arguments arrived before the ChatGPT tool call.', 'STREAM_ERROR')
      yield* update(`${index}:call`, 'tool-call', event.delta)
    } else if (event.type === 'error' || event.type === 'response.failed') {
      throw new PlanError('ChatGPT inference failed. Check account access and usage in ChatGPT settings.', 'PROVIDER_ERROR')
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const result = event.response
      const incomplete = event.type === 'response.incomplete'
      if (!result || result.status !== (incomplete ? 'incomplete' : 'completed') || !Array.isArray(result.output)) {
        throw new PlanError('Invalid ChatGPT completion event.', 'STREAM_ERROR')
      }
      if (incomplete && result.incomplete_details?.reason !== 'max_output_tokens') {
        throw new PlanError('ChatGPT returned an incomplete response.', 'PROVIDER_ERROR')
      }
      const outputEntries = result.output.length ? [...result.output.entries()]
        : [...completedItems.entries()].sort(([left], [right]) => left - right)
      for (const [outputIndex, item] of outputEntries) {
        if (item.type === 'message') {
          for (const [contentIndex, part] of (item.content ?? []).entries()) {
            if (part.type === 'output_text') yield* update(`${outputIndex}:text:${contentIndex}`, 'text', part.text, undefined, true)
            else if (part.type === 'refusal') yield* update(`${outputIndex}:text:${contentIndex}`, 'text', part.refusal, undefined, true)
            else throw new PlanError('Unsupported ChatGPT output content.', 'UNSUPPORTED_CONTENT')
          }
        } else if (item.type === 'function_call') {
          yield* update(`${outputIndex}:call`, 'tool-call', item.arguments, item, true)
        } else if (item.type === 'reasoning') {
          for (const [summaryIndex, part] of (item.summary ?? []).entries()) {
            yield* update(`${outputIndex}:reasoning:${summaryIndex}`, 'reasoning', part.text, undefined, true)
          }
        } else throw new PlanError('Unsupported ChatGPT output item.', 'UNSUPPORTED_CONTENT')
      }
      for (const entry of blocks.values()) {
        const block = entry.type === 'tool-call'
          ? { type: 'tool-call', id: entry.item.call_id, name: entry.item.name, arguments: entry.value }
          : { type: entry.type, text: entry.value }
        if (entry.type === 'tool-call' && !incomplete) {
          try { JSON.parse(entry.value) } catch { throw new PlanError('Invalid ChatGPT tool arguments.', 'STREAM_ERROR') }
        }
        yield { type: 'block-end', index: entry.index, block }
      }
      if (result.usage) {
        const usage = result.usage
        const cached = usage.input_tokens_details?.cached_tokens ?? 0
        yield { type: 'usage', usage: {
          inputTokens: Math.max(0, usage.input_tokens - cached), outputTokens: usage.output_tokens,
          cacheReadTokens: cached, reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        } }
      }
      const output = outputEntries.map(([, item]) => item)
      const content = [...blocks.values()].map(entry => entry.type === 'tool-call'
        ? { type: 'tool-call', id: entry.item.call_id, name: entry.item.name, arguments: entry.value }
        : { type: entry.type, text: entry.value })
      yield { type: 'finish', reason: { kind: incomplete ? 'max-tokens' : calls ? 'tool-calls' : 'stop' },
        ...!incomplete && usableReplay(output, content)
          ? { replayState: { response: { model: options.model, items: output } } } : {} }
      return
    }
  }
  throw new PlanError('ChatGPT stream ended without a completion event.', 'STREAM_ERROR')
}
