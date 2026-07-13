import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import {
  mapModel,
  buildAnthropicModelsList,
  sanitizeToolName,
  createToolNameMapper,
  anthropicToOpenAI,
  openaiToAnthropic,
  createAnthropicStreamTransformer,
  AnthropicStreamTransformer,
} from '../lib/anthropic-adapter.js'

/* ------------------------------------------------------------------ */
/*  mapModel                                                          */
/* ------------------------------------------------------------------ */
describe('mapModel', () => {
  it('returns auto-fastest for known models by default', () => {
    assert.equal(mapModel('claude-sonnet-4-5'), 'auto-fastest')
    assert.equal(mapModel('claude-haiku-4-5'), 'auto-fastest')
    assert.equal(mapModel('claude-opus-4-5'), 'auto-fastest')
  })

  it('returns auto-fastest for unknown models', () => {
    assert.equal(mapModel('claude-3-opus-20240229'), 'auto-fastest')
    assert.equal(mapModel('claude-v1'), 'auto-fastest')
  })

  it('returns auto-fastest for null / undefined / empty', () => {
    assert.equal(mapModel(null), 'auto-fastest')
    assert.equal(mapModel(undefined), 'auto-fastest')
    assert.equal(mapModel(''), 'auto-fastest')
  })
})

/* ------------------------------------------------------------------ */
/*  buildAnthropicModelsList                                          */
/* ------------------------------------------------------------------ */
describe('buildAnthropicModelsList', () => {
  it('returns an object with a data array', () => {
    const result = buildAnthropicModelsList()
    assert.ok(Array.isArray(result.data))
    assert.ok(result.data.length > 0)
  })

  it('each entry has type and id', () => {
    const result = buildAnthropicModelsList()
    for (const entry of result.data) {
      assert.equal(entry.type, 'model')
      assert.equal(typeof entry.id, 'string')
      assert.ok(entry.id.length > 0)
    }
  })

  it('includes default model IDs', () => {
    const result = buildAnthropicModelsList()
    const ids = result.data.map(e => e.id)
    assert.ok(ids.includes('claude-sonnet-4-5'))
    assert.ok(ids.includes('claude-haiku-4-5'))
    assert.ok(ids.includes('claude-opus-4-5'))
  })
})

/* ------------------------------------------------------------------ */
/*  sanitizeToolName                                                  */
/* ------------------------------------------------------------------ */
describe('sanitizeToolName', () => {
  it('replaces slash, backslash, and @ with underscore', () => {
    assert.equal(sanitizeToolName('a/b'), 'a_b')
    assert.equal(sanitizeToolName('a\\b'), 'a_b')
    assert.equal(sanitizeToolName('a@b'), 'a_b')
  })

  it('leaves clean names unchanged', () => {
    assert.equal(sanitizeToolName('get_weather'), 'get_weather')
    assert.equal(sanitizeToolName('my-tool.v1'), 'my-tool.v1')
    assert.equal(sanitizeToolName('test123'), 'test123')
  })

  it('returns null/undefined as-is', () => {
    assert.equal(sanitizeToolName(null), null)
    assert.equal(sanitizeToolName(undefined), undefined)
  })

  it('handles empty string', () => {
    assert.equal(sanitizeToolName(''), '')
  })
})

/* ------------------------------------------------------------------ */
/*  createToolNameMapper                                              */
/* ------------------------------------------------------------------ */
describe('createToolNameMapper', () => {
  it('returns clean name for already-clean input', () => {
    const mapper = createToolNameMapper()
    assert.equal(mapper.outbound('get_weather'), 'get_weather')
  })

  it('sanitizes names with special characters', () => {
    const mapper = createToolNameMapper()
    assert.equal(mapper.outbound('my/tool'), 'my_tool')
    assert.equal(mapper.outbound('test@v1'), 'test_v1')
  })

  it('inbound() reverses outbound() for sanitized names', () => {
    const mapper = createToolNameMapper()
    const out = mapper.outbound('my/cool@tool')
    assert.equal(mapper.inbound(out), 'my/cool@tool')
  })

  it('inbound() returns input unchanged if not in reverse map', () => {
    const mapper = createToolNameMapper()
    assert.equal(mapper.inbound('get_weather'), 'get_weather')
  })

  it('getReverseMap() returns a Map with sanitized->original', () => {
    const mapper = createToolNameMapper()
    mapper.outbound('a/b')
    mapper.outbound('c@d')
    const rev = mapper.getReverseMap()
    assert.equal(rev.get('a_b'), 'a/b')
    assert.equal(rev.get('c_d'), 'c@d')
    assert.equal(rev.size, 2)
  })

  it('outbound() is idempotent — same input returns same sanitized value', () => {
    const mapper = createToolNameMapper()
    const first = mapper.outbound('foo/bar')
    const second = mapper.outbound('foo/bar')
    assert.equal(first, second)
  })
})

/* ------------------------------------------------------------------ */
/*  anthropicToOpenAI                                                 */
/* ------------------------------------------------------------------ */
describe('anthropicToOpenAI', () => {
  const MINIMAL = {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hello' }],
  }

  it('maps model via mapModel', () => {
    const result = anthropicToOpenAI(MINIMAL)
    assert.equal(result.model, 'auto-fastest')
  })

  it('sets stream flag', () => {
    assert.equal(anthropicToOpenAI({ ...MINIMAL, stream: true }).stream, true)
    assert.equal(anthropicToOpenAI({ ...MINIMAL, stream: false }).stream, false)
    assert.equal(anthropicToOpenAI(MINIMAL).stream, false)
  })

  it('defaults max_tokens to 16384', () => {
    assert.equal(anthropicToOpenAI(MINIMAL).max_tokens, 16384)
  })

  it('passes through max_tokens when provided', () => {
    const result = anthropicToOpenAI({ ...MINIMAL, max_tokens: 4096 })
    assert.equal(result.max_tokens, 4096)
  })

  it('converts system string to system message', () => {
    const result = anthropicToOpenAI({ ...MINIMAL, system: 'You are helpful.' })
    assert.deepEqual(result.messages[0], { role: 'system', content: 'You are helpful.' })
  })

  it('converts system array of blocks to joined text', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      system: [{ type: 'text', text: 'Be concise.' }, { type: 'text', text: 'Be accurate.' }],
    })
    assert.deepEqual(result.messages[0], { role: 'system', content: 'Be concise.\nBe accurate.' })
  })

  it('skips system if empty array', () => {
    const result = anthropicToOpenAI({ ...MINIMAL, system: [] })
    assert.equal(result.messages[0].role, 'user')
  })

  it('converts string content messages', () => {
    const result = anthropicToOpenAI(MINIMAL)
    assert.deepEqual(result.messages[0], { role: 'user', content: 'hello' })
  })

  it('converts content array with text blocks', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
    assert.equal(result.messages[0].content, 'hello')
  })

  it('collapses multiple text blocks joined by newline', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      }],
    })
    assert.equal(result.messages[0].content, 'a\nb')
  })

  it('converts image blocks to [image] placeholder', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ],
      }],
    })
    assert.equal(result.messages[0].content, 'describe this\n[image]')
  })

  it('converts assistant tool_use blocks to tool_calls', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will call a tool.' },
          { type: 'tool_use', id: 'toolu_abc123', name: 'get_weather', input: { location: 'NYC' } },
        ],
      }],
    })
    const msg = result.messages[0]
    assert.equal(msg.role, 'assistant')
    assert.equal(msg.content, null)
    assert.equal(msg.tool_calls.length, 1)
    assert.equal(msg.tool_calls[0].id, 'toolu_abc123')
    assert.equal(msg.tool_calls[0].function.name, 'get_weather')
    assert.equal(msg.tool_calls[0].function.arguments, JSON.stringify({ location: 'NYC' }))
  })

  it('converts tool result messages', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }] },
        { role: 'tool', tool_use_id: 'toolu_1', content: 'Sunny' },
      ],
    })
    const toolMsg = result.messages[2]
    assert.equal(toolMsg.role, 'tool')
    assert.equal(toolMsg.content, 'Sunny')
    assert.equal(toolMsg.tool_call_id, 'toolu_1')
  })

  it('supports tool_result_id as fallback field name', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'f', input: {} }] },
        { role: 'tool', tool_result_id: 'toolu_x', content: '42' },
      ],
    })
    assert.equal(result.messages[2].tool_call_id, 'toolu_x')
  })

  it('converts tools array with sanitization', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
    })
    assert.equal(result.tools.length, 1)
    assert.equal(result.tools[0].function.name, 'get_weather')
    assert.deepEqual(result.tools[0].function.parameters, { type: 'object' })
  })

  it('sanitizes tool names in tools array', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'my/tool', input_schema: { type: 'object' } }],
    })
    assert.equal(result.tools[0].function.name, 'my_tool')
  })

  it('sets tool_choice default to auto', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'f', input_schema: {} }],
    })
    assert.equal(result.tool_choice, 'auto')
  })

  it('passes through temperature, top_p, stop_sequences', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['\n\n', 'END'],
    })
    assert.equal(result.temperature, 0.5)
    assert.equal(result.top_p, 0.9)
    assert.deepEqual(result.stop, ['\n\n', 'END'])
  })

  it('includes temperature/top_p keys when undefined (set by ?? undefined)', () => {
    const result = anthropicToOpenAI(MINIMAL)
    assert.equal('temperature' in result, true)
    assert.equal(result.temperature, undefined)
    assert.equal(result.top_p, undefined)
  })

  it('attaches _anthropicToolReverseMap when tools are sanitized', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'my/tool', input_schema: {} }],
    })
    assert.deepEqual(result._anthropicToolReverseMap, { my_tool: 'my/tool' })
  })

  it('attaches _anthropicToolReverseMap for all tools (even clean names)', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'get_weather', input_schema: {} }],
    })
    assert.deepEqual(result._anthropicToolReverseMap, { get_weather: 'get_weather' })
  })

  it('attaches _anthropicToolReverseMap from assistant tool_use blocks', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'a/b', input: {} }],
      }],
    })
    assert.deepEqual(result._anthropicToolReverseMap, { a_b: 'a/b' })
  })

  it('preserves thinking blocks as reasoning_content for round-trip', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'Simple arithmetic.' },
          { type: 'text', text: '4' },
        ]},
      ],
    })
    assert.equal(result.messages.length, 2)
    assert.equal(result.messages[1].role, 'assistant')
    assert.equal(result.messages[1].reasoning_content, 'Simple arithmetic.')
    assert.equal(result.messages[1].content, '4')
  })

  it('handles thinking block without text content', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [
        { role: 'user', content: 'Think out loud' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'I am thinking through this step by step.' },
        ]},
      ],
    })
    assert.equal(result.messages.length, 2)
    assert.equal(result.messages[1].role, 'assistant')
    assert.equal(result.messages[1].reasoning_content, 'I am thinking through this step by step.')
    assert.equal(result.messages[1].content, '')
  })

  it('converts tool_result blocks in content array to tool role', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [
        { role: 'user', content: 'Calculate 2+2' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_001', name: 'calculator', input: { a: 2, b: 2 } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_001', content: '4' },
        ]},
      ],
    })
    assert.equal(result.messages.length, 3)
    assert.equal(result.messages[2].role, 'tool')
    assert.equal(result.messages[2].content, '4')
    assert.equal(result.messages[2].tool_call_id, 'tu_001')
  })

  it('converts tool_result with array content (text blocks)', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      messages: [
        { role: 'user', content: 'Search for X' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_002', name: 'search', input: { q: 'X' } },
        ]},
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'tu_002', content: [
            { type: 'text', text: 'Result page 1' },
            { type: 'text', text: 'Result page 2' },
          ]},
        ]},
      ],
    })
    assert.equal(result.messages.length, 3)
    assert.equal(result.messages[2].role, 'tool')
    assert.equal(result.messages[2].content, 'Result page 1\nResult page 2')
    assert.equal(result.messages[2].tool_call_id, 'tu_002')
  })

  it('maps tool_choice {type: "any"} to "auto"', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'calc', description: 'Add', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'any' },
    })
    assert.equal(result.tool_choice, 'auto')
  })

  it('maps tool_choice {type: "auto"} to "auto"', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'calc', description: 'Add', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'auto' },
    })
    assert.equal(result.tool_choice, 'auto')
  })

  it('maps tool_choice {type: "tool", name: "calc"} to OpenAI function format', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'calc', description: 'Add', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'calc' },
    })
    assert.deepEqual(result.tool_choice, { type: 'function', function: { name: 'calc' } })
  })

  it('sanitizes tool names in tool_choice and tools array', () => {
    const result = anthropicToOpenAI({
      ...MINIMAL,
      tools: [{ name: 'my/custom@tool', description: 'Test', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'my/custom@tool' },
    })
    assert.equal(result.tools[0].function.name, 'my_custom_tool')
    assert.equal(result.tool_choice.function.name, 'my_custom_tool')
  })
})

/* ------------------------------------------------------------------ */
/*  openaiToAnthropic                                                 */
/* ------------------------------------------------------------------ */
describe('openaiToAnthropic', () => {
  const BASE_OPENAI = {
    id: 'chatcmpl-abc',
    model: 'auto-fastest',
    usage: { prompt_tokens: 10, completion_tokens: 20 },
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Hello!' },
    }],
  }

  it('converts a basic text response', () => {
    const result = openaiToAnthropic(BASE_OPENAI, 'claude-sonnet-4-5')
    assert.equal(result.type, 'message')
    assert.equal(result.role, 'assistant')
    assert.equal(result.model, 'claude-sonnet-4-5')
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'text')
    assert.equal(result.content[0].text, 'Hello!')
    assert.equal(result.stop_reason, 'end_turn')
    assert.equal(result.usage.input_tokens, 10)
    assert.equal(result.usage.output_tokens, 20)
  })

  it('falls back to openaiResult.model when requestedModel not provided', () => {
    const result = openaiToAnthropic(BASE_OPENAI)
    assert.equal(result.model, 'auto-fastest')
  })

  it('falls back to default model when neither is available', () => {
    const result = openaiToAnthropic({ ...BASE_OPENAI, model: undefined })
    assert.equal(result.model, 'claude-sonnet-4-5')
  })

  it('maps finish_reason stop -> end_turn', () => {
    assert.equal(openaiToAnthropic(BASE_OPENAI).stop_reason, 'end_turn')
  })

  it('maps finish_reason length -> max_tokens', () => {
    const oai = { ...BASE_OPENAI, choices: [{ ...BASE_OPENAI.choices[0], finish_reason: 'length' }] }
    assert.equal(openaiToAnthropic(oai).stop_reason, 'max_tokens')
  })

  it('maps finish_reason tool_calls -> tool_use', () => {
    const oai = { ...BASE_OPENAI, choices: [{ ...BASE_OPENAI.choices[0], finish_reason: 'tool_calls' }] }
    assert.equal(openaiToAnthropic(oai).stop_reason, 'tool_use')
  })

  it('maps finish_reason content_filter -> stop_sequence', () => {
    const oai = { ...BASE_OPENAI, choices: [{ ...BASE_OPENAI.choices[0], finish_reason: 'content_filter' }] }
    assert.equal(openaiToAnthropic(oai).stop_reason, 'stop_sequence')
  })

  it('handles tool_calls in the response', () => {
    const oai = {
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"NYC"}' },
          }],
        },
      }],
    }
    const result = openaiToAnthropic(oai)
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'tool_use')
    assert.equal(result.content[0].id, 'call_123')
    assert.equal(result.content[0].name, 'get_weather')
    assert.deepEqual(result.content[0].input, { location: 'NYC' })
    assert.equal(result.stop_reason, 'tool_use')
  })

  it('reverses tool names using toolReverseMap', () => {
    const oai = {
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'my_tool', arguments: '{}' },
          }],
        },
      }],
    }
    const result = openaiToAnthropic(oai, 'claude-sonnet-4-5', { my_tool: 'my/tool' })
    assert.equal(result.content[0].name, 'my/tool')
  })

  it('handles tool arguments that are already parsed objects', () => {
    const oai = {
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'f', arguments: { key: 'value' } },
          }],
        },
      }],
    }
    const result = openaiToAnthropic(oai)
    assert.deepEqual(result.content[0].input, { key: 'value' })
  })

  it('handles invalid tool argument JSON gracefully', () => {
    const oai = {
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'f', arguments: '{bad json}' },
          }],
        },
      }],
    }
    const result = openaiToAnthropic(oai)
    assert.deepEqual(result.content[0].input, {})
  })

  it('converts reasoning_content to a thinking block', () => {
    const oai = {
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        message: { role: 'assistant', content: '', reasoning_content: 'thinking step by step' },
      }],
    }
    const result = openaiToAnthropic(oai)
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'thinking')
    assert.equal(result.content[0].thinking, 'thinking step by step')
  })

  it('adds both thinking and text blocks when both reasoning_content and content present', () => {
    const oai = {
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        message: { role: 'assistant', content: 'Final answer', reasoning_content: 'thinking...' },
      }],
    }
    const result = openaiToAnthropic(oai)
    assert.equal(result.content.length, 2)
    assert.equal(result.content[0].type, 'thinking')
    assert.equal(result.content[0].thinking, 'thinking...')
    assert.equal(result.content[1].type, 'text')
    assert.equal(result.content[1].text, 'Final answer')
  })

  it('skips text block when content is null (tool-only)', () => {
    const oai = {
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      }],
    }
    const result = openaiToAnthropic(oai)
    assert.equal(result.content.every(c => c.type === 'tool_use'), true)
  })

  it('handles missing choices gracefully', () => {
    const result = openaiToAnthropic({ id: 'x', model: 'm', usage: {}, choices: [] })
    assert.equal(result.content.length, 0)
  })

  it('converts reasoning_content and text to thinking + text blocks', () => {
    const result = openaiToAnthropic({
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        message: { role: 'assistant', content: '4', reasoning_content: 'Simple arithmetic.' },
      }],
    }, 'claude-sonnet-4-5')
    assert.equal(result.content.length, 2)
    assert.equal(result.content[0].type, 'thinking')
    assert.equal(result.content[0].thinking, 'Simple arithmetic.')
    assert.equal(result.content[1].type, 'text')
    assert.equal(result.content[1].text, '4')
  })

  it('converts reasoning_content alone (no text) to thinking block', () => {
    const result = openaiToAnthropic({
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        finish_reason: 'length',
        message: { role: 'assistant', content: '', reasoning_content: 'Thinking through the problem...' },
      }],
    }, 'claude-sonnet-4-5')
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'thinking')
    assert.equal(result.content[0].thinking, 'Thinking through the problem...')
    assert.equal(result.stop_reason, 'max_tokens')
  })

  it('reverses tool names via toolReverseMap', () => {
    const reverseMap = { my_custom_tool: 'my/custom@tool' }
    const result = openaiToAnthropic({
      ...BASE_OPENAI,
      choices: [{
        ...BASE_OPENAI.choices[0],
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_001',
            type: 'function',
            function: { name: 'my_custom_tool', arguments: '{}' },
          }],
        },
      }],
    }, 'claude-sonnet-4-5', reverseMap)
    assert.equal(result.content[0].name, 'my/custom@tool')
  })
})

/* ------------------------------------------------------------------ */
/*  AnthropicStreamTransformer.pushChunk                              */
/* ------------------------------------------------------------------ */
describe('AnthropicStreamTransformer', () => {
  function makeChunk(overrides = {}) {
    const { usage, delta, finish_reason, ...rest } = overrides
    const choiceOverrides = {}
    if (delta !== undefined) choiceOverrides.delta = delta
    if (finish_reason !== undefined) choiceOverrides.finish_reason = finish_reason
    const chunk = {
      id: 'chatcmpl-123',
      object: 'chat.completion.chunk',
      model: 'auto-fastest',
      choices: [{ index: 0, delta: {}, finish_reason: null, ...choiceOverrides }],
      ...rest,
    }
    if (usage !== undefined) chunk.usage = usage
    return chunk
  }

  function parseEvents(strEvents) {
    return strEvents.map(s => JSON.parse(s))
  }

  it('emits message_start on first chunk with empty content', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    const events = t.pushChunk(makeChunk({ delta: {} }))
    assert.equal(events.length, 1)
    const parsed = JSON.parse(events[0])
    assert.equal(parsed.type, 'message_start')
    assert.equal(parsed.message.model, 'auto-fastest')
  })

  it('emits content_block_start then content_block_delta for text', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    const e1 = t.pushChunk(makeChunk({ delta: { content: 'Hello' } }))
    assert.equal(e1.length, 2)
    let parsed = parseEvents(e1)
    assert.equal(parsed[0].type, 'message_start')
    assert.equal(parsed[1].type, 'content_block_start')
    assert.equal(parsed[1].content_block.text, 'Hello')
    assert.equal(parsed[1].index, 0)

    const e2 = t.pushChunk(makeChunk({ delta: { content: ' world' } }))
    assert.equal(e2.length, 1)
    parsed = parseEvents(e2)
    assert.equal(parsed[0].type, 'content_block_delta')
    assert.equal(parsed[0].delta.text, ' world')
    assert.equal(parsed[0].index, 0)
  })

  it('emits content_block_start for tool call', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    const events = t.pushChunk(makeChunk({
      delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] },
    }))
    const parsed = parseEvents(events)
    const start = parsed.find(e => e.type === 'content_block_start')
    assert.ok(start, 'should have content_block_start')
    assert.equal(start.content_block.type, 'tool_use')
    assert.equal(start.content_block.name, 'get_weather')
    assert.deepEqual(start.content_block.input, {})
  })

  it('accumulates tool arguments silently then emits stop on finish', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    t.pushChunk(makeChunk({ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"loc' } }] } }))
    t.pushChunk(makeChunk({ delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"NYC"}' } }] } }))
    const e3 = t.pushChunk(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
    const parsed = parseEvents(e3)
    const stopEvents = parsed.filter(e => e.type === 'content_block_stop')
    assert.equal(stopEvents.length, 1)
    assert.equal(stopEvents[0].index, 0)
    assert.ok(parsed.find(e => e.type === 'message_delta'))
    assert.ok(parsed.find(e => e.type === 'message_stop'))
  })

  it('handles multiple simultaneous tool calls', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    t.pushChunk(makeChunk({ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"loc":"NYC"}' } }] } }))
    const e2 = t.pushChunk(makeChunk({ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'search', arguments: '{"q":"hello"}' } }] } }))
    const parsed2 = parseEvents(e2)
    const starts = parsed2.filter(e => e.type === 'content_block_start')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].content_block.name, 'search')

    const e3 = t.pushChunk(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
    const parsed3 = parseEvents(e3)
    const stops = parsed3.filter(e => e.type === 'content_block_stop')
    assert.equal(stops.length, 2)
  })

  it('reverses tool names via toolReverseMap', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5', { my_tool: 'my/tool' })
    const events = t.pushChunk(makeChunk({ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'my_tool', arguments: '{}' } }] } }))
    const parsed = parseEvents(events)
    const start = parsed.find(e => e.type === 'content_block_start')
    assert.equal(start.content_block.name, 'my/tool')
  })

  it('emits message_delta with stop_reason and message_stop on finish', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    t.pushChunk(makeChunk({ delta: { content: 'hello' } }))
    const events = t.pushChunk(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    const parsed = parseEvents(events)
    const delta = parsed.find(e => e.type === 'message_delta')
    assert.ok(delta)
    assert.equal(delta.delta.stop_reason, 'end_turn')
    assert.ok(parsed.find(e => e.type === 'message_stop'))
  })

  it('returns empty array after done', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    t.pushChunk(makeChunk({ delta: { content: 'hello' } }))
    t.pushChunk(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    assert.equal(t.pushChunk(makeChunk({ delta: { content: 'extra' } })).length, 0)
  })

  it('tracks usage from chunk.usage', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    t.pushChunk(makeChunk({ delta: { content: 'hi' }, usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    const events = t.pushChunk(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    const parsed = parseEvents(events)
    const delta = parsed.find(e => e.type === 'message_delta')
    assert.equal(delta.usage.input_tokens, 10)
    assert.equal(delta.usage.output_tokens, 5)
  })

  it('closes text block when tool call starts', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    t.pushChunk(makeChunk({ delta: { content: 'I need to look this up.' } }))
    const e2 = t.pushChunk(makeChunk({ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":"x"}' } }] } }))
    const parsed = parseEvents(e2)
    const stop = parsed.find(e => e.type === 'content_block_stop')
    assert.ok(stop, 'text block should be closed before tool start')
    const start = parsed.find(e => e.type === 'content_block_start')
    assert.equal(start.content_block.type, 'tool_use')
  })

  it('does not emit content_block_start for empty delta', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    const events = t.pushChunk(makeChunk({ delta: {} }))
    assert.equal(events.length, 1) // only message_start
  })

  it('generates tool IDs with toolu_ prefix', () => {
    const t = new AnthropicStreamTransformer('claude-sonnet-4-5')
    const id = t.genToolId()
    assert.ok(id.startsWith('toolu_'))
    assert.ok(id.length > 6)
  })

  it('nextIndex returns 0 when no blocks exist', () => {
    const t = new AnthropicStreamTransformer('claude-sonnet-4-5')
    assert.equal(t.nextIndex(), 0)
  })

  it('reset clears state for reuse', () => {
    const t = new AnthropicStreamTransformer('claude-sonnet-4-5')
    t.pushChunk(makeChunk({ delta: { content: 'hello' } }))
    t.pushChunk(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    assert.equal(t.done, true)
    t.reset()
    assert.equal(t.done, false)
    assert.equal(t.messageStartSent, false)
    assert.equal(t.currentBlockType, null)
    assert.equal(t.currentBlockIndex, null)
    assert.equal(t.accumulatedTools.size, 0)
  })

  it('createAnthropicStreamTransformer is a factory', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5', { a: 'b' })
    assert.ok(t instanceof AnthropicStreamTransformer)
    assert.equal(t.requestedModel, 'claude-sonnet-4-5')
    assert.deepEqual(t.toolReverseMap, { a: 'b' })
  })

  it('streams text then tool then finish correctly', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    t.pushChunk(makeChunk({ delta: { content: 'Let me check.' } }))
    t.pushChunk(makeChunk({ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":"answer"}' } }] } }))
    const e3 = t.pushChunk(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
    const parsed = parseEvents(e3)
    const stops = parsed.filter(e => e.type === 'content_block_stop')
    // Text block was closed when tool started in chunk 2, so finish only has 1 tool stop
    assert.equal(stops.length, 1)
    assert.equal(stops[0].index, 0)
    const messageDelta = parsed.find(e => e.type === 'message_delta')
    assert.equal(messageDelta.delta.stop_reason, 'tool_use')
  })

  it('emits correct SSE events for reasoning_content chunks', () => {
    const t = createAnthropicStreamTransformer('claude-sonnet-4-5')
    // First chunk: message_start + content_block_start
    const e1 = t.pushChunk(makeChunk({ delta: { content: null, reasoning_content: 'Thinking' } }))
    const e1Types = parseEvents(e1).map(e => e.type)
    assert.ok(e1Types.includes('message_start'))
    assert.ok(e1Types.includes('content_block_start'))

    // Second chunk: content_block_delta
    const e2 = t.pushChunk(makeChunk({ delta: { content: null, reasoning_content: ' further' } }))
    const e2Types = parseEvents(e2).map(e => e.type)
    assert.ok(e2Types.includes('content_block_delta'))

    // Final chunk: content_block_stop + message_delta + message_stop
    const e3 = t.pushChunk(makeChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
    const e3Types = parseEvents(e3).map(e => e.type)
    assert.ok(e3Types.includes('content_block_stop'))
    assert.ok(e3Types.includes('message_delta'))
    assert.ok(e3Types.includes('message_stop'))
    assert.equal(t.done, true)
  })
})
