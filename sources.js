/**
 * @file sources.js
 * @description Model sources for AI availability checker.
 */

import { scores } from './scores.js'

export const MODEL_ID_ALIASES = {
  'cogito-2.1:671b': 'cogito-2.1:671b',
  'deepseek-v3.1:671b': 'deepseek-ai/deepseek-v3.1',
  'deepseek-v3.2': 'deepseek-ai/deepseek-v3.2',
  'devstral-2:123b': 'devstral-2-123b-instruct-2512',
  'mimo-v2-omni-free': 'xiaomi/mimo-v2-omni:free',
  'devstral-small-2': 'devstral-small-2-24b',
  'devstral-small-2:24b': 'devstral-small-2-24b',
  'devstral-small-2:24b-instruct-2512-q4_k_m': 'devstral-small-2-24b',
  'gemma4:26b': 'google/gemma-4-26b-a4b-it',
  'gemma4:31b': 'google/gemma-4-31b-it',
  'gemma3:4b': 'gemma-3-4b-it',
  'gemma3:12b': 'gemma-3-12b-it',
  'gemma3:27b': 'gemma-3-27b-it',
  'glm-4.7': 'z-ai/glm4.7',
  'glm-4.6': 'glm-4.6',
  'glm-5': 'z-ai/glm5',
  'kimi-k2': 'moonshotai/kimi-k2-instruct',
  'kimi-k2-thinking': 'moonshotai/kimi-k2-thinking',
  'kimi-k2.5': 'moonshotai/kimi-k2.5',
  'kimi-k2:1t': 'moonshotai/kimi-k2-instruct',
  'mimo-v2-flash-free': 'mimo-v2-flash-free',
  'mimo-v2-pro-free': 'xiaomi/mimo-v2-pro',
  'qwen3:4b': 'qwen/qwen3-4b',
  'qwen3:32b': 'qwen/qwen3-32b',
  'gpt-oss:120b': 'openai/gpt-oss-120b',
  'gpt-oss:20b': 'openai/gpt-oss-20b',
  'minimax-m2': 'minimaxai/minimax-m2',
  'minimax-m2.1': 'minimaxai/minimax-m2.1',
  'minimax-m2.5': 'minimax/minimax-m2.5',
  'minimax-m2.5-free': 'minimax/minimax-m2.5',
  'minimax-m2.7:cloud': 'minimax-m2.7',
  'minimax-m2.7': 'minimax-m2.7',
  'ministral-3:3b': 'ministral-3:3b',
  'ministral-3:8b': 'ministral-3:8b',
  'ministral-3:14b': 'mistralai/ministral-14b-instruct-2512',
  'mistral-large-3:675b': 'mistralai/mistral-large-3-675b-instruct-2512',
  'nemotron-3-nano:30b': 'nvidia/nemotron-3-nano-30b-a3b',
  'nemotron-3-super': 'nvidia/nemotron-3-super-120b-a12b',
  'nemotron-3-super-free': 'nvidia/nemotron-3-super-120b-a12b',
  'qwen3.6-plus-free': 'qwen/qwen3.5-397b-a17b',
  'qwen/qwen3.6-plus-preview:free': 'qwen/qwen3.5-397b-a17b',
  'qwen3-vl:235b': 'qwen/qwen3-vl-235b-a22b',
  'qwen3-vl:235b-instruct': 'qwen/qwen3-vl-235b-a22b',
  'qwen3-coder-next': 'qwen3-coder-next',
  'qwen3-coder:480b': 'qwen/qwen3-coder-480b-a35b-instruct',
  'qwen3-next:80b': 'qwen/qwen3-next-80b-a3b-instruct',
  'qwen3.5:397b': 'qwen/qwen3.5-397b-a17b',
  'rnj-1:8b': 'rnj-1:8b',
  'trinity-large-preview-free': 'arcee-ai/trinity-large-preview',
}

export const MODEL_LABEL_OVERRIDES = {
  'deepseek-v3.1:671b': 'DeepSeek V3.1',
  'deepseek-v3.2': 'DeepSeek V3.2',
  'devstral-2:123b': 'Devstral 2 123B',
  'devstral-small-2': 'Devstral Small 2 24B',
  'devstral-small-2:24b': 'Devstral Small 2 24B',
  'devstral-small-2-24b': 'Devstral Small 2 24B',
  'arcee-ai/trinity-large-thinking': 'Trinity Large Thinking',
  'arcee-ai/trinity-large-thinking:free': 'Trinity Large Thinking',
  'bytedance-seed/dola-seed-2.0-pro': 'Dola Seed 2.0 Pro',
  'bytedance-seed/dola-seed-2.0-pro:free': 'Dola Seed 2.0 Pro',
  'gemma4:26b': 'Gemma 4 26B A4B',
  'gemma4:31b': 'Gemma 4 31B',
  'google/gemma-4-26b-a4b-it': 'Gemma 4 26B A4B',
  'google/gemma-4-31b-it': 'Gemma 4 31B',
  'gemma3:4b': 'Gemma 3 4B',
  'gemma3:12b': 'Gemma 3 12B',
  'gemma3:27b': 'Gemma 3 27B',
  'glm-4.6': 'GLM 4.6',
  'glm-4.7': 'GLM 4.7',
  'glm-5': 'GLM 5',
  'glm-5.1': 'GLM 5.1',
  'kimi-k2': 'Kimi K2',
  'kimi-k2-thinking': 'Kimi K2 Thinking',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2:1t': 'Kimi K2 Instruct',
  'mimo-v2-flash-free': 'MiMo V2 Flash',
  'mimo-v2-pro-free': 'MiMo V2 Omni Pro',
  'mimo-v2-omni-free': 'MiMo V2 Omni',
  'minimax-m2.5-free': 'MiniMax M2.5',
  'ministral-3:3b': 'Ministral 3 3B',
  'ministral-3:8b': 'Ministral 3 8B',
  'ministral-3:14b': 'Ministral 14B',
  'mistral-large-3:675b': 'Mistral Large 675B',
  'nemotron-3-nano:30b': 'Nemotron Nano 30B',
  'nemotron-3-super': 'Nemotron 3 Super',
  'nemotron-3-super-free': 'Nemotron 3 Super',
  'qwen3.6-plus-free': 'Qwen3.6 Plus',
  'qwen/qwen3.6-plus-preview:free': 'Qwen3.6 Plus Preview',
  'qwen3-vl:235b': 'Qwen3 VL 235B',
  'qwen3-vl:235b-instruct': 'Qwen3 VL 235B',
  'qwen3-coder-next': 'Qwen3 Coder Next',
  'qwen3-coder:480b': 'Qwen3 Coder 480B',
  'qwen3-next:80b': 'Qwen3 Next 80B',
  'qwen3.5:397b': 'Qwen3.5 400B',
  'rnj-1:8b': 'RNJ-1 8B',
  'trinity-large-preview-free': 'Trinity Large Preview',
  'xiaomi/mimo-v2-omni:free': 'MiMo V2 Omni',
  'xiaomi/mimo-v2-pro:free': 'MiMo V2 Omni Pro',
  'x-ai/grok-code-fast-1:optimized:free': 'Grok Code Fast',
}

export function resolveAliasedModelId(modelId) {
  const raw = typeof modelId === 'string' ? modelId.trim() : ''
  if (!raw) return ''
  return MODEL_ID_ALIASES[raw] || MODEL_ID_ALIASES[raw.toLowerCase()] || raw
}

export function cleanModelDisplayLabel(label) {
  if (typeof label !== 'string') return ''
  return label
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+\(free\)\s*$/i, '')
    .replace(/\s+free\s*$/i, '')
    .trim()
}

export function canonicalizeModelId(modelId) {
  const resolved = resolveAliasedModelId(modelId)
  // 1. Remove known runtime suffixes like :free, :optimized:free, or :cloud
  const base = resolved.replace(/(?::(?:free|optimized|cloud))+$/i, '');
  // 2. Remove provider prefix like google/
  const unprefixed = base.includes('/') ? base.split('/').pop() : base;
  return { base, unprefixed };
}

export function getPreferredModelLabel(modelId, fallback = null) {
  const resolved = resolveAliasedModelId(modelId)
  const override = MODEL_LABEL_OVERRIDES[modelId] || MODEL_LABEL_OVERRIDES[resolved]
  if (override) return override
  const cleanedFallback = cleanModelDisplayLabel(fallback)
  return cleanedFallback || fallback
}

export function getScore(modelId) {
  const { base, unprefixed } = canonicalizeModelId(modelId);
  // Try exact match first (e.g. google/gemma-3-4b-it), then fallback to unprefixed (e.g. gemma-3-4b-it)
  return scores[base] ?? scores[unprefixed] ?? null;
}

export const sources = {
  "nvidia": {
    "name": "NIM",
    "url": "https://integrate.api.nvidia.com/v1/chat/completions",
    "models": [
      ["deepseek-ai/deepseek-v3.2", "DeepSeek V3.2", "128k"],
      ["moonshotai/kimi-k2.5", "Kimi K2.5", "128k"],
      ["z-ai/glm5", "GLM 5", "128k"],
      ["z-ai/glm4.7", "GLM 4.7", "200k"],
      ["moonshotai/kimi-k2-thinking", "Kimi K2 Thinking", "256k"],
      ["minimaxai/minimax-m2.1", "MiniMax M2.1", "200k"],
      ["stepfun-ai/step-3.5-flash", "Step 3.5 Flash", "256k"],
      ["qwen/qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B", "256k"],
      ["qwen/qwen3-235b-a22b", "Qwen3 235B", "128k"],
      ["mistralai/devstral-2-123b-instruct-2512", "Devstral 2 123B", "256k"],
      ["deepseek-ai/deepseek-v3.1-terminus", "DeepSeek V3.1 Terminus", "128k"],
      ["moonshotai/kimi-k2-instruct", "Kimi K2 Instruct", "128k"],
      ["minimaxai/minimax-m2", "MiniMax M2", "128k"],
      ["qwen/qwen3-next-80b-a3b-thinking", "Qwen3 80B Thinking", "128k"],
      ["qwen/qwen3-next-80b-a3b-instruct", "Qwen3 80B Instruct", "128k"],
      ["qwen/qwen3.5-397b-a17b", "Qwen3.5 400B", "128k"],
      ["openai/gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["meta/llama-4-maverick-17b-128e-instruct", "Llama 4 Maverick", "1M"],
      ["deepseek-ai/deepseek-v3.1", "DeepSeek V3.1", "128k"],
      ["nvidia/llama-3.1-nemotron-ultra-253b-v1", "Nemotron Ultra 253B", "128k"],
      ["mistralai/mistral-large-3-675b-instruct-2512", "Mistral Large 675B", "256k"],
      ["qwen/qwq-32b", "QwQ 32B", "131k"],
      ["igenius/colosseum_355b_instruct_16k", "Colosseum 355B", "16k"],
      ["mistralai/mistral-medium-3-instruct", "Mistral Medium 3", "128k"],
      ["mistralai/magistral-small-2506", "Magistral Small", "32k"],
      ["nvidia/llama-3.3-nemotron-super-49b-v1.5", "Nemotron Super 49B", "128k"],
      ["meta/llama-4-scout-17b-16e-instruct", "Llama 4 Scout", "10M"],
      ["nvidia/nemotron-3-nano-30b-a3b", "Nemotron Nano 30B", "128k"],
      ["deepseek-ai/deepseek-r1-distill-qwen-32b", "R1 Distill 32B", "128k"],
      ["openai/gpt-oss-20b", "GPT OSS 20B", "128k"],
      ["qwen/qwen2.5-coder-32b-instruct", "Qwen2.5 Coder 32B", "32k"],
      ["meta/llama-3.1-405b-instruct", "Llama 3.1 405B", "128k"],
      ["meta/llama-3.3-70b-instruct", "Llama 3.3 70B", "128k"],
      ["deepseek-ai/deepseek-r1-distill-qwen-14b", "R1 Distill 14B", "64k"],
      ["bytedance/seed-oss-36b-instruct", "Seed OSS 36B", "32k"],
      ["stockmark/stockmark-2-100b-instruct", "Stockmark 100B", "32k"],
      ["mistralai/mixtral-8x22b-instruct-v0.1", "Mixtral 8x22B", "64k"],
      ["mistralai/ministral-14b-instruct-2512", "Ministral 14B", "32k"],
      ["ibm/granite-34b-code-instruct", "Granite 34B Code", "32k"],
      ["deepseek-ai/deepseek-r1-distill-llama-8b", "R1 Distill 8B", "32k"],
      ["deepseek-ai/deepseek-r1-distill-qwen-7b", "R1 Distill 7B", "32k"],
      ["google/gemma-2-9b-it", "Gemma 2 9B", "8k"],
      ["microsoft/phi-3.5-mini-instruct", "Phi 3.5 Mini", "128k"],
      ["microsoft/phi-4-mini-instruct", "Phi 4 Mini", "128k"]
    ]
  },
  "groq": {
    "name": "Groq",
    "url": "https://api.groq.com/openai/v1/chat/completions",
    "models": [
      ["llama-3.3-70b-versatile", "Llama 3.3 70B", "128k"],
      ["meta-llama/llama-4-scout-17b-16e-preview", "Llama 4 Scout", "10M"],
      ["meta-llama/llama-4-maverick-17b-128e-preview", "Llama 4 Maverick", "1M"],
      ["deepseek-r1-distill-llama-70b", "R1 Distill 70B", "128k"],
      ["qwen-qwq-32b", "QwQ 32B", "131k"],
      ["moonshotai/kimi-k2-instruct", "Kimi K2 Instruct", "131k"],
      ["llama-3.1-8b-instant", "Llama 3.1 8B", "128k"],
      ["openai/gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["openai/gpt-oss-20b", "GPT OSS 20B", "128k"],
      ["qwen/qwen3-32b", "Qwen3 32B", "131k"]
    ]
  },
  "cerebras": {
    "name": "Cerebras",
    "url": "https://api.cerebras.ai/v1/chat/completions",
    "models": [
      ["llama3.3-70b", "Llama 3.3 70B", "128k"],
      ["llama-4-scout-17b-16e-instruct", "Llama 4 Scout", "10M"],
      ["qwen-3-32b", "Qwen3 32B", "128k"],
      ["gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["qwen-3-235b-a22b", "Qwen3 235B", "128k"],
      ["llama3.1-8b", "Llama 3.1 8B", "128k"],
      ["glm-4.6", "GLM 4.6", "128k"]
    ]
  },
  "opencode": {
    "name": "OpenCode Zen",
    "url": "https://opencode.ai/zen/v1/chat/completions",
    "models": []
  },
  "openai-compatible": {
    "name": "OpenAI-Compatible",
    "url": "",
    "models": []
  },
  "ollama": {
    "name": "Ollama",
    "url": "",
    "models": []
  },
  "openrouter": {
    "name": "OpenRouter",
    "url": "https://openrouter.ai/api/v1/chat/completions",
    "models": [
      ["qwen/qwen3-coder:free", "Qwen3 Coder", "256k"],
      ["xiaomi/mimo-v2-pro:free", "MiMo V2 Omni Pro", "1M"],
      ["xiaomi/mimo-v2-omni:free", "MiMo V2 Omni", "1M"],
      ["stepfun/step-3.5-flash:free", "Step 3.5 Flash", "256k"],
      ["deepseek/deepseek-r1-0528:free", "DeepSeek R1 0528", "128k"],
      ["qwen/qwen3-next-80b-a3b-instruct:free", "Qwen3 80B Instruct", "128k"],
      ["openai/gpt-oss-120b:free", "GPT OSS 120B", "128k"],
      ["openai/gpt-oss-20b:free", "GPT OSS 20B", "128k"],
      ["nvidia/nemotron-3-nano-30b-a3b:free", "Nemotron Nano 30B", "128k"],
      ["meta-llama/llama-3.3-70b-instruct:free", "Llama 3.3 70B", "128k"],
      ["minimax/minimax-m2.5:free", "MiniMax M2.5", "128k"],
      ["corethink:free", "CoreThink", "128k"],
      ["giga-potato-thinking:free", "Giga Potato Thinking", "128k"]
    ]
  },
  "codestral": {
    "name": "Codestral",
    "url": "https://codestral.mistral.ai/v1/chat/completions",
    "models": [
      ["codestral-latest", "Codestral", "256k"]
    ]
  },
  "scaleway": {
    "name": "Scaleway",
    "url": "https://api.scaleway.ai/v1/chat/completions",
    "models": [
      ["devstral-2-123b-instruct-2512", "Devstral 2 123B", "256k"],
      ["qwen3-235b-a22b-instruct-2507", "Qwen3 235B", "128k"],
      ["gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["qwen3-coder-30b-a3b-instruct", "Qwen3 Coder 30B", "32k"],
      ["llama-3.3-70b-instruct", "Llama 3.3 70B", "128k"],
      ["deepseek-r1-distill-llama-70b", "R1 Distill 70B", "128k"],
      ["mistral-small-3.2-24b-instruct-2506", "Mistral Small 3.2", "128k"]
    ]
  },
  "kilocode": {
    "name": "KiloCode",
    "url": "https://api.kilo.ai/api/gateway/chat/completions",
    "models": [
      ["arcee-ai/trinity-large-preview", "Trinity Large", "128k"]
    ]
  },
  "googleai": {
    "name": "Google AI",
    "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "models": [
      ["gemma-3-27b-it", "Gemma 3 27B", "128k"],
      ["gemma-3-12b-it", "Gemma 3 12B", "128k"],
      ["gemma-3-4b-it", "Gemma 3 4B", "128k"]
    ]
  }
}

function buildModels() {
  const result = []
  for (const [providerKey, provider] of Object.entries(sources)) {
    for (const m of provider.models) {
      const [modelId, label, ctx] = m
      const intell = getScore(modelId)
      result.push([modelId, label, intell, ctx, providerKey])
    }
  }
  return result
}

export const MODELS = buildModels()
