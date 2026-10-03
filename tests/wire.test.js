import test from 'node:test'
import assert from 'node:assert/strict'
import { models, requestBody, sseEvents, streamResponse } from '../src/wire.js'
import { collect, grant, json, response } from './helpers.js'

const options = { provider: 'chatgpt-plan', model: 'test-model', messages: [] }
const completed = (output = [], usage) => ({ type: 'response.completed', response: { status: 'completed', output, usage } })
const tool = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }

test('request preserves instructions and tool-result order, omits unsupported options', () => {
  const body = requestBody({ ...options, system: 'base', temperature: 0.5, maxTokens: 1024, messages: [
    { role: 'system', content: [{ type: 'text', text: 'extra' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'result' }], source: { kind: 'tool', callId: 'call_1' } },
  ], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }] })
  assert.equal(body.instructions, 'base\n\nextra')
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.input[1].type, 'function_call')
  assert.equal(body.input[2].type, 'function_call_output')
  assert.equal(body.input[2].call_id, 'call_1')
  assert.equal(body.tools[0].type, 'namespace')
  assert.equal(body.tools[0].tools[0].name, 'read_file')
  for (const key of ['temperature', 'max_output_tokens', 'previous_response_id']) assert.equal(key in body, false)
})

test('multiple tool messages retain call correlation, empty output and failed result text', () => {
  const body = requestBody({ ...options, messages: [
    { role: 'tool', toolCallId: 'call_1', content: [], source: { kind: 'tool', callId: 'call_1' } },
    { role: 'tool', toolCallId: 'call_2', isError: true, content: [{ type: 'text', text: 'File not found' }], source: { kind: 'tool', callId: 'call_2' } },
  ] })
  assert.deepEqual(body.input, [
    { type: 'function_call_output', call_id: 'call_1', output: '' },
    { type: 'function_call_output', call_id: 'call_2', output: 'File not found' },
  ])
})

test('saved empty or partial replay never drops the tool call before its result', () => {
  const block = { type: 'tool-call', id: tool.call_id, name: tool.name, arguments: tool.arguments }
  for (const items of [[], [{ type: 'reasoning', summary: [] }], [{ ...tool, arguments: '{}' }]]) {
    const body = requestBody({ ...options, messages: [
      { role: 'assistant', content: [block], source: { replayState: { response: { model: options.model, items } } } },
      { role: 'tool', toolCallId: tool.call_id, content: [{ type: 'text', text: 'file result' }] },
    ] })
    assert.equal(body.input[0].type, 'function_call')
    assert.equal(body.input[1].type, 'function_call_output')
    assert.equal(body.input[0].call_id, body.input[1].call_id)
  }
})

test('empty terminal output preserves completed native items and their encrypted reasoning', async () => {
  const reasoning = { type: 'reasoning', encrypted_content: 'encrypted', summary: [] }
  const chunks = await collect(streamResponse(options, grant(), { fetcher: async () => response([
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: tool.arguments },
    { type: 'response.output_item.done', output_index: 1, item: tool },
    completed([]),
  ]) }))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.equal(chunks.at(-1).replayState.response.items[0].encrypted_content, 'encrypted')
  const body = requestBody({ ...options, messages: [
    { role: 'assistant', content: chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block),
      source: { replayState: chunks.at(-1).replayState } },
    { role: 'tool', toolCallId: tool.call_id, content: [{ type: 'text', text: 'result' }] },
  ] })
  assert.equal(body.input[1].type, 'function_call')
  assert.equal(body.input[2].type, 'function_call_output')
  assert.equal(body.input[1].call_id, body.input[2].call_id)
})

test('terminal output without completed native items does not save empty replay for streamed calls', async () => {
  const chunks = await collect(streamResponse(options, grant(), { fetcher: async () => response([
    { type: 'response.output_item.added', output_index: 0, item: { ...tool, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: tool.arguments },
    completed([]),
  ]) }))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.equal(chunks.at(-1).replayState, undefined)
})

test('unprojected developer tool updates fail explicitly', () => {
  assert.throws(() => requestBody({ ...options, messages: [
    { role: 'developer', content: [{ type: 'tool-addition', toolName: 'read_file' }] },
  ] }), error => error.code === 'UNSUPPORTED_CONTENT')
})

test('images and unsupported stop controls fail explicitly', () => {
  assert.throws(() => requestBody({ ...options, stop: ['end'] }), /stop/)
  assert.throws(() => requestBody({ ...options, messages: [{ role: 'user', content: [{ type: 'image' }] }] }), /text input only/)
})

test('SSE supports fragmented UTF-8, CRLF, comments, multiline data and trailing frame', async () => {
  const values = await collect(sseEvents(response([{ type: 'delta', text: '中文🙂' }], 1).body))
  assert.equal(values[0].text, '中文🙂')
  const body = new Response(': keepalive\n\ndata: {"type":\ndata: "x"}\n\ndata: [DONE]\n\ndata: {"type":"end"}').body
  assert.deepEqual(await collect(sseEvents(body)), [{ type: 'x' }, { type: 'end' }])
})

test('stream emits tool calls, disjoint usage and encrypted reasoning replay for the next tool turn', async () => {
  let wireRequest
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'test-encrypted', summary: [{ type: 'summary_text', text: 'think' }] }
  const events = [
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'think' },
    { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"a"}' },
    completed([reasoning, tool], { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 5 } }),
  ]
  const chunks = await collect(streamResponse(options, grant(), { headers: { 'user-agent': 'deepseek-harness/test' },
    fetcher: async (url, init) => { wireRequest = { url, init }; return response(events) } }))
  assert.equal(wireRequest.url, 'https://api.openai.com/v1/responses')
  assert.equal(wireRequest.init.headers.authorization, 'Bearer test-access')
  assert.equal(wireRequest.init.headers['user-agent'], 'deepseek-harness/test')
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5 })
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.equal(blocks[1].arguments, '{"path":"a"}')
  const next = requestBody({ ...options, messages: [
    { role: 'assistant', content: blocks, source: { replayState: chunks.at(-1).replayState } },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file text' }], source: { kind: 'tool', callId: 'call_1' } },
  ] })
  assert.equal(next.input[0].encrypted_content, 'test-encrypted')
  assert.equal(next.input[2].call_id, 'call_1')
  const second = await collect(streamResponse({ ...options, messages: [
    { role: 'assistant', content: blocks, source: { replayState: chunks.at(-1).replayState } },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'file text' }], source: { kind: 'tool', callId: 'call_1' } },
  ] }, grant(), { fetcher: async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.input[2].type, 'function_call_output')
    assert.equal(body.input[2].output, 'file text')
    return response([completed([{ type: 'message', content: [{ type: 'output_text', text: 'Read the file.' }] }])])
  } }))
  assert.equal(second.at(-1).reason.kind, 'stop')
})

test('completed text reconciles deltas without duplicating content', async () => {
  const chunks = await collect(streamResponse(options, grant(), { fetcher: async () => response([
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'he' },
    completed([{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }]),
  ]) }))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'hello')
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, 'hello')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('abrupt EOF and provider failure cannot report successful completion', async () => {
  for (const events of [[], [{ type: 'response.failed', response: { error: { message: 'sensitive' } } }],
    [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' }]]) {
    await assert.rejects(collect(streamResponse(options, grant(), { fetcher: async () => response(events) })),
      error => !error.message.includes('sensitive') && ['STREAM_ERROR', 'PROVIDER_ERROR'].includes(error.code))
  }
})

test('max token incomplete reports truncation and carries no successful replay', async () => {
  const chunks = await collect(streamResponse(options, grant(), { fetcher: async () => response([
    { type: 'response.incomplete', response: { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } } },
  ]) }))
  assert.equal(chunks.at(-1).reason.kind, 'max-tokens')
  assert.equal(chunks.at(-1).replayState, undefined)
})

test('rate limiting retains HTTP status and retry delay without response-body leakage', async () => {
  await assert.rejects(collect(streamResponse(options, grant(), { fetcher: async () => new Response('private-token', {
    status: 429, headers: { 'retry-after': '3' },
  }) })), error => error.code === 'RATE_LIMIT' && error.retryAfterMs === 3000 && !error.message.includes('private-token'))
})

test('models use the selected account token and filter the live subscription catalog', async () => {
  const result = await models(grant(), { fetcher: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models')
    assert.equal(init.headers.authorization, 'Bearer test-access')
    return json({ models: [{ slug: 'allowed', display_name: 'Allowed', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }] })
  } })
  assert.deepEqual(result, [{ id: 'allowed', name: 'Allowed', inputModalities: ['text'] }])
})
