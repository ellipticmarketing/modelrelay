/**
 * Anthropic Messages API ↔ ModelRelay (OpenAI-compatible) Adapter
 *
 * Converts Anthropic requests to OpenAI format and streams responses back.
 * Based on LiteLLM's proven patterns.
 */

const DEFAULT_MODEL_MAP = {
  'claude-sonnet-4-5': 'auto-fastest',
  'claude-haiku-4-5':  'auto-fastest',
  'claude-opus-4-5':   'auto-fastest',
};

let MODEL_MAP = { ...DEFAULT_MODEL_MAP };

function initModelMap() {
  const env = process.env.ANTHROPIC_MODEL_MAP;
  if (env) {
    try {
      const pairs = env.split(',').map(s => s.trim()).filter(Boolean);
      for (const pair of pairs) {
        const [k, v] = pair.split('=');
        if (k && v) MODEL_MAP[k.trim()] = v.trim();
      }
    } catch (e) {
      console.warn('Invalid ANTHROPIC_MODEL_MAP:', e.message);
    }
  }
}
initModelMap();

function mapModel(anthropicModel) {
  if (!anthropicModel) return 'auto-fastest';
  return MODEL_MAP[anthropicModel] || 'auto-fastest';
}

function buildAnthropicModelsList() {
  return { data: Object.keys(MODEL_MAP).map(id => ({ type: 'model', id })) };
}

function sanitizeToolName(name) {
  return name ? name.replace(/[/\\@]/g, '_') : name;
}

function createToolNameMapper() {
  const forward = new Map();
  const reverse = new Map();
  return {
    outbound(original) {
      if (forward.has(original)) return forward.get(original);
      const sanitized = sanitizeToolName(original);
      forward.set(original, sanitized);
      reverse.set(sanitized, original);
      return sanitized;
    },
    inbound(sanitized) {
      return reverse.get(sanitized) || sanitized;
    },
    getReverseMap() { return reverse; }
  };
}

function anthropicToOpenAI(body) {
  const { model, messages, system, max_tokens, temperature, top_p, top_k, stop_sequences, stream, tools, tool_choice } = body;
  const openai = {
    model: mapModel(model),
    messages: [],
    stream: !!stream,
    max_tokens: max_tokens || 16384,
    temperature: temperature ?? undefined,
    top_p: top_p ?? undefined,
    stop: stop_sequences || undefined,
  };

  if (system) {
    let sys = '';
    if (Array.isArray(system)) {
      sys = system.filter(b => b.type === 'text').map(b => b.text).join('\n');
    } else {
      sys = String(system);
    }
    if (sys) openai.messages.push({ role: 'system', content: sys });
  }

  const toolNameMapper = createToolNameMapper();
  for (const msg of messages) {
    const { role, content } = msg;
    if (role === 'assistant' || role === 'user') {
      const outMsg = { role };
      let texts = [];
      let toolCalls = [];

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            texts.push(block.text);
          } else if (block.type === 'thinking') {
            // Anthropic thinking blocks → reasoning_content (DeepSeek thinking mode)
            outMsg.reasoning_content = block.thinking;
          } else if (block.type === 'tool_use') {
            const sanitized = toolNameMapper.outbound(block.name);
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: sanitized,
                arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
              }
            });
          } else if (block.type === 'image') {
            texts.push('[image]');
          } else if (block.type === 'tool_result') {
            // Anthropic tool_result blocks in user messages → OpenAI tool role
            const resultContent = typeof block.content === 'string'
              ? block.content
              : (Array.isArray(block.content)
                  ? block.content.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n')
                  : JSON.stringify(block.content || ''));
            openai.messages.push({
              role: 'tool',
              content: resultContent,
              tool_call_id: block.tool_use_id
            });
          }
        }
      } else {
        texts.push(String(content || ''));
      }

      // Only emit the user/assistant message if there's actual content, tool_calls, or reasoning_content
      if (toolCalls.length > 0) {
        outMsg.content = null;
        outMsg.tool_calls = toolCalls;
        openai.messages.push(outMsg);
      } else if (texts.length > 0 || outMsg.reasoning_content) {
        outMsg.content = texts.join('\n');
        openai.messages.push(outMsg);
      }
    } else if (role === 'tool') {
      openai.messages.push({
        role: 'tool',
        content: String(content || ''),
        tool_call_id: msg.tool_use_id || msg.tool_result_id
      });
    }
  }

  if (tools && Array.isArray(tools)) {
    openai.tools = tools.map(t => ({
      type: 'function',
      function: {
        name: toolNameMapper.outbound(t.name),
        parameters: t.input_schema || {}
      }
    }));
    // Map Anthropic tool_choice to OpenAI format
    //   {type: "auto"}       → "auto"       (model decides)
    //   {type: "any"}        → "auto"       (most models don't support "required", notably DeepSeek thinking mode)
    //   {type: "tool", name} → {type: "function", function: {name}}
    if (tool_choice && typeof tool_choice === 'object') {
      if (tool_choice.type === 'any' || tool_choice.type === 'auto') {
        openai.tool_choice = 'auto';
      } else if (tool_choice.type === 'tool' && tool_choice.name) {
        openai.tool_choice = { type: 'function', function: { name: toolNameMapper.outbound(tool_choice.name) } };
      } else {
        openai.tool_choice = 'auto';
      }
    } else {
      openai.tool_choice = tool_choice || 'auto';
    }
  }

  if (toolNameMapper.getReverseMap().size > 0) {
    const rev = {};
    for (const [s, o] of toolNameMapper.getReverseMap()) rev[s] = o;
    openai._anthropicToolReverseMap = rev;
  }

  return openai;
}

function mapFinishReason(fr) {
  switch (fr) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'stop_sequence';
    default: return 'end_turn';
  }
}

function openaiToAnthropic(openaiResult, requestedModel, toolReverseMap = null) {
  const msg = openaiResult.choices?.[0]?.message || {};
  const { content, reasoning_content, tool_calls } = msg;
  const finishReason = openaiResult.choices?.[0]?.finish_reason;

  const anthropic = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: [],
    model: requestedModel || openaiResult.model || 'claude-sonnet-4-5',
    stop_reason: mapFinishReason(finishReason),
    usage: {
      input_tokens: openaiResult.usage?.prompt_tokens || 0,
      output_tokens: openaiResult.usage?.completion_tokens || 0
    }
  };

  if (reasoning_content) {
    anthropic.content.push({ type: 'thinking', thinking: reasoning_content });
  }
  if (content) {
    anthropic.content.push({ type: 'text', text: content });
  }

  if (tool_calls && tool_calls.length > 0) {
    for (const tc of tool_calls) {
      let name = tc.function?.name || '';
      if (toolReverseMap && toolReverseMap[name]) name = toolReverseMap[name];
      let args = {};
      try {
        args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
      } catch (e) {
        args = {};
      }
      anthropic.content.push({
        type: 'tool_use',
        id: tc.id,
        name: name,
        input: args
      });
    }
  }

  return anthropic;
}

class AnthropicStreamTransformer {
  constructor(requestedModel, toolReverseMap = null) {
    this.requestedModel = requestedModel;
    this.toolReverseMap = toolReverseMap || null;
    this.reset();
  }

  reset() {
    this.responseId = `msg_${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.model = null;
    this.toolIndex = -1;
    this.currentBlockType = null;
    this.currentBlockIndex = null;
    this.accumulatedTools = new Map();
    this.messageStartSent = false;
    this.usageAccum = { input_tokens: 0, output_tokens: 0 };
    this.finalUsage = null;
    this.done = false;
  }

  pushChunk(chunk) {
    if (this.done) return [];

    const events = [];
    const choices = chunk.choices || [];
    const delta = choices[0]?.delta || {};
    const usage = chunk.usage || null;

    if (!this.messageStartSent) {
      this.model = chunk.model || this.requestedModel || 'auto-fastest';
      events.push(JSON.stringify({
        type: 'message_start',
        message: { id: this.responseId, content: [], model: this.model, usage: { input_tokens: 0, output_tokens: 0 } }
      }));
      this.messageStartSent = true;
    }

    if (usage) {
      if (usage.prompt_tokens != null) this.usageAccum.input_tokens = usage.prompt_tokens;
      if (usage.completion_tokens != null) this.usageAccum.output_tokens = usage.completion_tokens;
      this.finalUsage = this.usageAccum;
    }

    // Support both content and reasoning_content (DeepSeek-style thinking models)
    const textContent = delta.content || delta.reasoning_content;
    if (textContent) {
      if (this.currentBlockType !== 'text') {
        this.closeCurrentBlock(events);
        this.currentBlockType = 'text';
        this.currentBlockIndex = this.nextIndex();
        events.push(JSON.stringify({
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: { type: 'text', text: textContent }
        }));
      } else {
        events.push(JSON.stringify({
          type: 'content_block_delta',
          index: this.currentBlockIndex,
          delta: { type: 'text_delta', text: textContent }
        }));
      }
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index !== undefined ? tc.index : ++this.toolIndex;
        const existing = this.accumulatedTools.get(idx);
        if (existing) {
          if (tc.function?.arguments) existing.args += tc.function.arguments;
        } else {
          this.closeCurrentBlock(events);
          this.currentBlockType = 'tool_use';
          this.currentBlockIndex = idx;
          const tool = {
            id: tc.id || this.genToolId(),
            name: this.mapToolName(tc.function?.name || ''),
            args: tc.function?.arguments || ''
          };
          this.accumulatedTools.set(idx, tool);
          events.push(JSON.stringify({
            type: 'content_block_start',
            index: idx,
            content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} }
          }));
        }
      }
    }

    if (choices[0]?.finish_reason) {
      // Close any open text block (tool blocks handled by loop below)
      if (this.currentBlockType === 'text' && this.currentBlockIndex !== null) {
        events.push(JSON.stringify({ type: 'content_block_stop', index: this.currentBlockIndex }));
      }
      this.currentBlockType = null;
      this.currentBlockIndex = null;
      // Close all accumulated tool blocks
      for (const [idx] of this.accumulatedTools) {
        events.push(JSON.stringify({ type: 'content_block_stop', index: idx }));
      }
      this.accumulatedTools.clear();
      const stopReason = mapFinishReason(choices[0].finish_reason);
      events.push(JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { input_tokens: this.finalUsage?.input_tokens || 0, output_tokens: this.finalUsage?.output_tokens || 0 }
      }));
      events.push(JSON.stringify({ type: 'message_stop' }));
      this.done = true;
      return events;
    }

    return events;
  }

  nextIndex() {
    // Next sequential index after highest used in tools or we start at 0
    if (this.accumulatedTools.size === 0 && this.currentBlockIndex === null) return 0;
    const maxIdx = Math.max(
      this.accumulatedTools.size > 0 ? Math.max(...this.accumulatedTools.keys()) : -1,
      this.currentBlockIndex ?? -1
    );
    return maxIdx + 1;
  }

  closeCurrentBlock(events) {
    if (this.currentBlockType !== null && this.currentBlockIndex !== null) {
      events.push(JSON.stringify({ type: 'content_block_stop', index: this.currentBlockIndex }));
      this.currentBlockType = null;
      this.currentBlockIndex = null;
    }
  }

  mapToolName(outbound) {
    if (!outbound) return outbound;
    return (this.toolReverseMap && this.toolReverseMap[outbound]) || outbound;
  }

  genToolId() {
    return 'toolu_' + (Date.now()).toString(36) + Math.random().toString(36).slice(2, 8);
  }
}

function createAnthropicStreamTransformer(requestedModel, toolReverseMap = null) {
  return new AnthropicStreamTransformer(requestedModel, toolReverseMap);
}

export {
  mapModel,
  buildAnthropicModelsList,
  createToolNameMapper,
  sanitizeToolName,
  anthropicToOpenAI,
  openaiToAnthropic,
  createAnthropicStreamTransformer,
  AnthropicStreamTransformer
};
