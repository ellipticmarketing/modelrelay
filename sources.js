/**
 * @file sources.js
 * @description Model sources for AI availability checker.
 */

import { scores } from './scores.js'

function canonicalizeModelId(modelId) {
  return modelId.replace(/:[a-z0-9-]+$/i, '')
}

function getScore(modelId) {
  const canonical = canonicalizeModelId(modelId)
  return scores[canonical] ?? null
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
  "openrouter": {
    "name": "OpenRouter",
    "url": "https://openrouter.ai/api/v1/chat/completions",
    "models": [
      ["qwen/qwen3-coder:free", "Qwen3 Coder", "256k"],
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
