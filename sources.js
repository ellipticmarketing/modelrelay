/**
 * @file sources.js
 * @description Model sources for AI availability checker.
 * Merged from modelrelay + free-coding-models to support 174+ models across 23 providers.
 */

import { scores } from './scores.js'

export const MODEL_ID_ALIASES = {
  'mimo-v2-omni-free': 'xiaomi/mimo-v2-omni:free',
  'Qwen3-32B': 'qwen3-32b',
  'mistralai/Mixtral-8x22B-Instruct-v0.1': 'mistralai/mixtral-8x22b-instruct-v0.1',
  'moonshotai/Kimi-K2-Instruct': 'moonshotai/kimi-k2-instruct',
  'Qwen/Qwen3-235B-A22B': 'qwen/qwen3-235b-a22b',
  'Qwen/Qwen2.5-Coder-32B-Instruct': 'qwen/qwen2.5-coder-32b-instruct',
  'meta-llama/Llama-3.3-70B-Instruct': 'meta-llama/llama-3.3-70b-instruct',
  'zai/glm-4.5-air': 'z-ai/glm-4.5-air',
  'Qwen/Qwen3-Coder-480B-A35B-Instruct': 'qwen/qwen3-coder-480b-a35b-instruct',
  'deepseek-ai/DeepSeek-V3.2': 'deepseek-ai/deepseek-v3.2',
  'deepseek-ai/DeepSeek-R1': 'deepseek-ai/deepseek-r1',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct': 'qwen/qwen3-coder-30b-a3b-instruct',
  'moonshotai/Kimi-K2.5': 'moonshotai/kimi-k2.5',
  'deepseek-ai/DeepSeek-V3.1': 'deepseek-ai/deepseek-v3.1',
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': 'meta-llama/llama-3.3-70b-instruct',
  '@cf/qwen/qwen2.5-coder-32b-instruct': 'qwen/qwen2.5-coder-32b-instruct',
  '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': 'deepseek-ai/deepseek-r1-distill-qwen-32b',
  '@cf/openai/gpt-oss-20b': 'openai/gpt-oss-20b',
  'TBStars2-200B-A13B': 'tbstars2-200b-a13b',
}

export const MODEL_LABEL_OVERRIDES = {
  'mimo-v2-omni-free': 'MiMo V2 Omni',
  'xiaomi/mimo-v2-omni:free': 'MiMo V2 Omni',
  'xiaomi/mimo-v2-pro:free': 'MiMo V2 Omni Pro',
  'x-ai/grok-code-fast-1:optimized:free': 'Grok Code Fast',
}

export function resolveAliasedModelId(modelId) {
  const raw = typeof modelId === 'string' ? modelId.trim() : ''
  if (!raw) return ''
  return MODEL_ID_ALIASES[raw] || raw
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
  const base = resolved.replace(/(?::[a-z0-9-]+)+$/i, '');
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
      ["zai-glm-4.7", "GLM 4.7", "200k"]
    ]
  },
  "sambanova": {
    "name": "SambaNova",
    "url": "https://api.sambanova.ai/v1/chat/completions",
    "models": [
      ["MiniMax-M2.5", "MiniMax M2.5", "160k"],
      ["DeepSeek-R1-0528", "DeepSeek R1 0528", "128k"],
      ["DeepSeek-V3.1", "DeepSeek V3.1", "128k"],
      ["DeepSeek-V3-0324", "DeepSeek V3 0324", "128k"],
      ["DeepSeek-V3.2", "DeepSeek V3.2", "8k"],
      ["Llama-4-Maverick-17B-128E-Instruct", "Llama 4 Maverick", "1M"],
      ["gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["DeepSeek-V3.1-Terminus", "DeepSeek V3.1 Terminus", "128k"],
      ["Qwen3-32B", "Qwen3 32B", "128k"],
      ["DeepSeek-R1-Distill-Llama-70B", "R1 Distill 70B", "128k"],
      ["Meta-Llama-3.3-70B-Instruct", "Llama 3.3 70B", "128k"],
      ["Meta-Llama-3.1-8B-Instruct", "Llama 3.1 8B", "128k"]
    ]
  },
  "openrouter": {
    "name": "OpenRouter",
    "url": "https://openrouter.ai/api/v1/chat/completions",
    "models": [
      ["qwen/qwen3-coder:free", "Qwen3 Coder 480B", "256k"],
      ["z-ai/glm-4.5-air:free", "GLM 4.5 Air", "128k"],
      ["google/gemma-3-27b-it:free", "Gemma 3 27B", "128k"],
      ["stepfun/step-3.5-flash:free", "Step 3.5 Flash", "256k"],
      ["qwen/qwen3-next-80b-a3b-instruct:free", "Qwen3 80B Instruct", "128k"],
      ["openai/gpt-oss-120b:free", "GPT OSS 120B", "128k"],
      ["openai/gpt-oss-20b:free", "GPT OSS 20B", "128k"],
      ["nvidia/nemotron-3-nano-30b-a3b:free", "Nemotron Nano 30B", "128k"],
      ["meta-llama/llama-3.3-70b-instruct:free", "Llama 3.3 70B", "128k"],
      ["mistralai/mistral-small-3.1-24b-instruct:free", "Mistral Small 3.1", "128k"],
      ["google/gemma-3-12b-it:free", "Gemma 3 12B", "128k"]
    ]
  },
  "huggingface": {
    "name": "Hugging Face",
    "url": "https://router.huggingface.co/v1/chat/completions",
    "models": [
      ["deepseek-ai/DeepSeek-V3-Coder", "DeepSeek V3 Coder", "128k"],
      ["bigcode/starcoder2-15b", "StarCoder2 15B", "16k"]
    ]
  },
  "replicate": {
    "name": "Replicate",
    "url": "https://api.replicate.com/v1/predictions",
    "models": [
      ["codellama/CodeLlama-70b-Instruct-hf", "CodeLlama 70B", "16k"]
    ]
  },
  "deepinfra": {
    "name": "DeepInfra",
    "url": "https://api.deepinfra.com/v1/openai/chat/completions",
    "models": [
      ["mistralai/Mixtral-8x22B-Instruct-v0.1", "Mixtral Code", "64k"],
      ["meta-llama/Meta-Llama-3.1-70B-Instruct", "Llama 3.1 70B", "128k"]
    ]
  },
  "fireworks": {
    "name": "Fireworks",
    "url": "https://api.fireworks.ai/inference/v1/chat/completions",
    "models": [
      ["accounts/fireworks/models/deepseek-v3", "DeepSeek V3", "128k"],
      ["accounts/fireworks/models/deepseek-r1", "DeepSeek R1", "128k"]
    ]
  },
  "codestral": {
    "name": "Codestral",
    "url": "https://codestral.mistral.ai/v1/chat/completions",
    "models": [
      ["codestral-latest", "Codestral", "256k"]
    ]
  },
  "hyperbolic": {
    "name": "Hyperbolic",
    "url": "https://api.hyperbolic.xyz/v1/chat/completions",
    "models": [
      ["qwen/qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B", "256k"],
      ["deepseek-ai/DeepSeek-R1-0528", "DeepSeek R1 0528", "128k"],
      ["moonshotai/Kimi-K2-Instruct", "Kimi K2 Instruct", "131k"],
      ["openai/gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["Qwen/Qwen3-235B-A22B", "Qwen3 235B", "128k"],
      ["qwen/qwen3-next-80b-a3b-instruct", "Qwen3 80B Instruct", "128k"],
      ["deepseek-ai/DeepSeek-V3-0324", "DeepSeek V3 0324", "128k"],
      ["Qwen/Qwen2.5-Coder-32B-Instruct", "Qwen2.5 Coder 32B", "32k"],
      ["meta-llama/Llama-3.3-70B-Instruct", "Llama 3.3 70B", "128k"],
      ["meta-llama/Meta-Llama-3.1-405B-Instruct", "Llama 3.1 405B", "128k"]
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
  "googleai": {
    "name": "Google AI",
    "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "models": [
      ["gemma-3-27b-it", "Gemma 3 27B", "128k"],
      ["gemma-3-12b-it", "Gemma 3 12B", "128k"],
      ["gemma-3-4b-it", "Gemma 3 4B", "128k"]
    ]
  },
  "zai": {
    "name": "ZAI",
    "url": "https://api.z.ai/api/coding/paas/v4/chat/completions",
    "models": [
      ["zai/glm-5", "GLM-5", "128k"],
      ["zai/glm-4.7", "GLM-4.7", "200k"],
      ["zai/glm-4.7-flash", "GLM-4.7-Flash", "200k"],
      ["zai/glm-4.5", "GLM-4.5", "128k"],
      ["zai/glm-4.5-air", "GLM-4.5-Air", "128k"],
      ["zai/glm-4.5-flash", "GLM-4.5-Flash", "128k"],
      ["zai/glm-4.6", "GLM-4.6", "128k"]
    ]
  },
  "siliconflow": {
    "name": "SiliconFlow",
    "url": "https://api.siliconflow.com/v1/chat/completions",
    "models": [
      ["Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen3 Coder 480B", "256k"],
      ["deepseek-ai/DeepSeek-V3.2", "DeepSeek V3.2", "128k"],
      ["Qwen/Qwen3-235B-A22B", "Qwen3 235B", "128k"],
      ["deepseek-ai/DeepSeek-R1", "DeepSeek R1", "128k"],
      ["Qwen/Qwen3-Coder-30B-A3B-Instruct", "Qwen3 Coder 30B", "32k"],
      ["Qwen/Qwen2.5-Coder-32B-Instruct", "Qwen2.5 Coder 32B", "32k"]
    ]
  },
  "together": {
    "name": "Together AI",
    "url": "https://api.together.xyz/v1/chat/completions",
    "models": [
      ["moonshotai/Kimi-K2.5", "Kimi K2.5", "128k"],
      ["Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8", "Qwen3 Coder 480B", "256k"],
      ["deepseek-ai/DeepSeek-V3.1", "DeepSeek V3.1", "128k"],
      ["deepseek-ai/DeepSeek-R1", "DeepSeek R1", "128k"],
      ["openai/gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["openai/gpt-oss-20b", "GPT OSS 20B", "128k"],
      ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B", "128k"]
    ]
  },
  "cloudflare": {
    "name": "Cloudflare AI",
    "url": "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions",
    "models": [
      ["@cf/openai/gpt-oss-120b", "GPT OSS 120B", "128k"],
      ["@cf/qwen/qwen2.5-coder-32b-instruct", "Qwen2.5 Coder 32B", "32k"],
      ["@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "R1 Distill 32B", "128k"],
      ["@cf/openai/gpt-oss-20b", "GPT OSS 20B", "128k"],
      ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "Llama 3.3 70B", "128k"],
      ["@cf/meta/llama-3.1-8b-instruct", "Llama 3.1 8B", "128k"]
    ]
  },
  "perplexity": {
    "name": "Perplexity",
    "url": "https://api.perplexity.ai/chat/completions",
    "models": [
      ["sonar-reasoning-pro", "Sonar Reasoning Pro", "128k"],
      ["sonar-reasoning", "Sonar Reasoning", "128k"],
      ["sonar-pro", "Sonar Pro", "128k"],
      ["sonar", "Sonar", "128k"]
    ]
  },
  "qwen": {
    "name": "Alibaba Cloud",
    "url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    "models": [
      ["qwen3-coder-plus", "Qwen3 Coder Plus", "256k"],
      ["qwen3-coder-480b-a35b-instruct", "Qwen3 Coder 480B", "256k"],
      ["qwen3-coder-max", "Qwen3 Coder Max", "256k"],
      ["qwen3-coder-next", "Qwen3 Coder Next", "256k"],
      ["qwen3-235b-a22b-instruct", "Qwen3 235B", "256k"],
      ["qwen3-next-80b-a3b-instruct", "Qwen3 80B Instruct", "128k"],
      ["qwen3-32b", "Qwen3 32B", "128k"],
      ["qwen2.5-coder-32b-instruct", "Qwen2.5 Coder 32B", "32k"]
    ]
  },
  "iflow": {
    "name": "iFlow",
    "url": "https://apis.iflow.cn/v1/chat/completions",
    "models": [
      ["TBStars2-200B-A13B", "TBStars2 200B", "128k"],
      ["deepseek-v3.2", "DeepSeek V3.2", "128k"],
      ["qwen3-coder-plus", "Qwen3 Coder Plus", "256k"],
      ["qwen3-235b-a22b-instruct", "Qwen3 235B", "256k"],
      ["deepseek-r1", "DeepSeek R1", "128k"],
      ["kimi-k2", "Kimi K2", "128k"],
      ["kimi-k2-0905", "Kimi K2 0905", "256k"],
      ["glm-4.6", "GLM 4.6", "200k"],
      ["deepseek-v3", "DeepSeek V3", "128k"],
      ["qwen3-32b", "Qwen3 32B", "128k"],
      ["qwen3-max", "Qwen3 Max", "256k"]
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
  "qwencode": {
    "name": "Qwen Code",
    "url": "https://coding.dashscope.aliyuncs.com/v1/chat/completions",
    "models": [
      ["coder-model", "Qwen Coder (OAuth)", "256k"],
      ["vision-model", "Qwen Vision (OAuth)", "128k"]
    ]
  },
  "kilocode": {
    "name": "KiloCode",
    "url": "https://api.kilo.ai/api/gateway/chat/completions",
    "models": [
      ["arcee-ai/trinity-large-preview", "Trinity Large", "128k"]
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
