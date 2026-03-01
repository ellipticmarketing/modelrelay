/**
 * @file sources.js
 * @description Model sources for AI availability checker.
 */

export const sources = {
  "nvidia": {
    "name": "NIM",
    "url": "https://integrate.api.nvidia.com/v1/chat/completions",
    "models": [
      [
        "deepseek-ai/deepseek-v3.2",
        "DeepSeek V3.2",
        0.731,
        "128k"
      ],
      [
        "moonshotai/kimi-k2.5",
        "Kimi K2.5",
        0.768,
        "128k"
      ],
      [
        "z-ai/glm5",
        "GLM 5",
        0.778,
        "128k"
      ],
      [
        "z-ai/glm4.7",
        "GLM 4.7",
        0.738,
        "200k"
      ],
      [
        "moonshotai/kimi-k2-thinking",
        "Kimi K2 Thinking",
        0.713,
        "256k"
      ],
      [
        "minimaxai/minimax-m2.1",
        "MiniMax M2.1",
        0.74,
        "200k"
      ],
      [
        "stepfun-ai/step-3.5-flash",
        "Step 3.5 Flash",
        0.744,
        "256k"
      ],
      [
        "qwen/qwen3-coder-480b-a35b-instruct",
        "Qwen3 Coder 480B",
        0.706,
        "256k"
      ],
      [
        "qwen/qwen3-235b-a22b",
        "Qwen3 235B",
        0.7,
        "128k"
      ],
      [
        "mistralai/devstral-2-123b-instruct-2512",
        "Devstral 2 123B",
        0.722,
        "256k"
      ],
      [
        "deepseek-ai/deepseek-v3.1-terminus",
        "DeepSeek V3.1 Terminus",
        0.684,
        "128k"
      ],
      [
        "moonshotai/kimi-k2-instruct",
        "Kimi K2 Instruct",
        0.658,
        "128k"
      ],
      [
        "minimaxai/minimax-m2",
        "MiniMax M2",
        0.694,
        "128k"
      ],
      [
        "qwen/qwen3-next-80b-a3b-thinking",
        "Qwen3 80B Thinking",
        0.68,
        "128k"
      ],
      [
        "qwen/qwen3-next-80b-a3b-instruct",
        "Qwen3 80B Instruct",
        0.65,
        "128k"
      ],
      [
        "qwen/qwen3.5-397b-a17b",
        "Qwen3.5 400B",
        0.68,
        "128k"
      ],
      [
        "openai/gpt-oss-120b",
        "GPT OSS 120B",
        0.6,
        "128k"
      ],
      [
        "meta/llama-4-maverick-17b-128e-instruct",
        "Llama 4 Maverick",
        0.62,
        "1M"
      ],
      [
        "deepseek-ai/deepseek-v3.1",
        "DeepSeek V3.1",
        0.62,
        "128k"
      ],
      [
        "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        "Nemotron Ultra 253B",
        0.56,
        "128k"
      ],
      [
        "mistralai/mistral-large-3-675b-instruct-2512",
        "Mistral Large 675B",
        0.58,
        "256k"
      ],
      [
        "qwen/qwq-32b",
        "QwQ 32B",
        0.5,
        "131k"
      ],
      [
        "igenius/colosseum_355b_instruct_16k",
        "Colosseum 355B",
        0.52,
        "16k"
      ],
      [
        "mistralai/mistral-medium-3-instruct",
        "Mistral Medium 3",
        0.48,
        "128k"
      ],
      [
        "mistralai/magistral-small-2506",
        "Magistral Small",
        0.45,
        "32k"
      ],
      [
        "nvidia/llama-3.3-nemotron-super-49b-v1.5",
        "Nemotron Super 49B",
        0.49,
        "128k"
      ],
      [
        "meta/llama-4-scout-17b-16e-instruct",
        "Llama 4 Scout",
        0.44,
        "10M"
      ],
      [
        "nvidia/nemotron-3-nano-30b-a3b",
        "Nemotron Nano 30B",
        0.43,
        "128k"
      ],
      [
        "deepseek-ai/deepseek-r1-distill-qwen-32b",
        "R1 Distill 32B",
        0.439,
        "128k"
      ],
      [
        "openai/gpt-oss-20b",
        "GPT OSS 20B",
        0.42,
        "128k"
      ],
      [
        "qwen/qwen2.5-coder-32b-instruct",
        "Qwen2.5 Coder 32B",
        0.46,
        "32k"
      ],
      [
        "meta/llama-3.1-405b-instruct",
        "Llama 3.1 405B",
        0.44,
        "128k"
      ],
      [
        "meta/llama-3.3-70b-instruct",
        "Llama 3.3 70B",
        0.395,
        "128k"
      ],
      [
        "deepseek-ai/deepseek-r1-distill-qwen-14b",
        "R1 Distill 14B",
        0.377,
        "64k"
      ],
      [
        "bytedance/seed-oss-36b-instruct",
        "Seed OSS 36B",
        0.38,
        "32k"
      ],
      [
        "stockmark/stockmark-2-100b-instruct",
        "Stockmark 100B",
        0.36,
        "32k"
      ],
      [
        "mistralai/mixtral-8x22b-instruct-v0.1",
        "Mixtral 8x22B",
        0.32,
        "64k"
      ],
      [
        "mistralai/ministral-14b-instruct-2512",
        "Ministral 14B",
        0.34,
        "32k"
      ],
      [
        "ibm/granite-34b-code-instruct",
        "Granite 34B Code",
        0.3,
        "32k"
      ],
      [
        "deepseek-ai/deepseek-r1-distill-llama-8b",
        "R1 Distill 8B",
        0.282,
        "32k"
      ],
      [
        "deepseek-ai/deepseek-r1-distill-qwen-7b",
        "R1 Distill 7B",
        0.226,
        "32k"
      ],
      [
        "google/gemma-2-9b-it",
        "Gemma 2 9B",
        0.18,
        "8k"
      ],
      [
        "microsoft/phi-3.5-mini-instruct",
        "Phi 3.5 Mini",
        0.12,
        "128k"
      ],
      [
        "microsoft/phi-4-mini-instruct",
        "Phi 4 Mini",
        0.14,
        "128k"
      ]
    ]
  },
  "groq": {
    "name": "Groq",
    "url": "https://api.groq.com/openai/v1/chat/completions",
    "models": [
      [
        "llama-3.3-70b-versatile",
        "Llama 3.3 70B",
        0.395,
        "128k"
      ],
      [
        "meta-llama/llama-4-scout-17b-16e-preview",
        "Llama 4 Scout",
        0.44,
        "10M"
      ],
      [
        "meta-llama/llama-4-maverick-17b-128e-preview",
        "Llama 4 Maverick",
        0.62,
        "1M"
      ],
      [
        "deepseek-r1-distill-llama-70b",
        "R1 Distill 70B",
        0.439,
        "128k"
      ],
      [
        "qwen-qwq-32b",
        "QwQ 32B",
        0.5,
        "131k"
      ],
      [
        "moonshotai/kimi-k2-instruct",
        "Kimi K2 Instruct",
        0.658,
        "131k"
      ],
      [
        "llama-3.1-8b-instant",
        "Llama 3.1 8B",
        0.14,
        "128k"
      ],
      [
        "openai/gpt-oss-120b",
        "GPT OSS 120B",
        0.6,
        "128k"
      ],
      [
        "openai/gpt-oss-20b",
        "GPT OSS 20B",
        0.42,
        "128k"
      ],
      [
        "qwen/qwen3-32b",
        "Qwen3 32B",
        0.5,
        "131k"
      ]
    ]
  },
  "cerebras": {
    "name": "Cerebras",
    "url": "https://api.cerebras.ai/v1/chat/completions",
    "models": [
      [
        "llama3.3-70b",
        "Llama 3.3 70B",
        0.395,
        "128k"
      ],
      [
        "llama-4-scout-17b-16e-instruct",
        "Llama 4 Scout",
        0.44,
        "10M"
      ],
      [
        "qwen-3-32b",
        "Qwen3 32B",
        0.5,
        "128k"
      ],
      [
        "gpt-oss-120b",
        "GPT OSS 120B",
        0.6,
        "128k"
      ],
      [
        "qwen-3-235b-a22b",
        "Qwen3 235B",
        0.7,
        "128k"
      ],
      [
        "llama3.1-8b",
        "Llama 3.1 8B",
        0.14,
        "128k"
      ],
      [
        "glm-4.6",
        "GLM 4.6",
        0.7,
        "128k"
      ]
    ]
  },
  "openrouter": {
    "name": "OpenRouter",
    "url": "https://openrouter.ai/api/v1/chat/completions",
    "models": [
      [
        "qwen/qwen3-coder:free",
        "Qwen3 Coder",
        0.706,
        "256k"
      ],
      [
        "stepfun/step-3.5-flash:free",
        "Step 3.5 Flash",
        0.744,
        "256k"
      ],
      [
        "deepseek/deepseek-r1-0528:free",
        "DeepSeek R1 0528",
        0.439,
        "128k"
      ],
      [
        "qwen/qwen3-next-80b-a3b-instruct:free",
        "Qwen3 80B Instruct",
        0.65,
        "128k"
      ],
      [
        "openai/gpt-oss-120b:free",
        "GPT OSS 120B",
        0.6,
        "128k"
      ],
      [
        "openai/gpt-oss-20b:free",
        "GPT OSS 20B",
        0.42,
        "128k"
      ],
      [
        "nvidia/nemotron-3-nano-30b-a3b:free",
        "Nemotron Nano 30B",
        0.43,
        "128k"
      ],
      [
        "meta-llama/llama-3.3-70b-instruct:free",
        "Llama 3.3 70B",
        0.395,
        "128k"
      ]
    ]
  },
  "codestral": {
    "name": "Codestral",
    "url": "https://codestral.mistral.ai/v1/chat/completions",
    "models": [
      [
        "codestral-latest",
        "Codestral",
        0.58,
        "256k"
      ]
    ]
  },
  "scaleway": {
    "name": "Scaleway",
    "url": "https://api.scaleway.ai/v1/chat/completions",
    "models": [
      [
        "devstral-2-123b-instruct-2512",
        "Devstral 2 123B",
        0.722,
        "256k"
      ],
      [
        "qwen3-235b-a22b-instruct-2507",
        "Qwen3 235B",
        0.7,
        "128k"
      ],
      [
        "gpt-oss-120b",
        "GPT OSS 120B",
        0.6,
        "128k"
      ],
      [
        "qwen3-coder-30b-a3b-instruct",
        "Qwen3 Coder 30B",
        0.706,
        "32k"
      ],
      [
        "llama-3.3-70b-instruct",
        "Llama 3.3 70B",
        0.395,
        "128k"
      ],
      [
        "deepseek-r1-distill-llama-70b",
        "R1 Distill 70B",
        0.439,
        "128k"
      ],
      [
        "mistral-small-3.2-24b-instruct-2506",
        "Mistral Small 3.2",
        0.32,
        "128k"
      ]
    ]
  },
  "qwencode": {
    "name": "Qwen Code",
    "url": "https://coding.dashscope.aliyuncs.com/v1/chat/completions",
    "models": [
      [
        "coder-model",
        "Qwen Coder (OAuth)",
        0.696,
        "256k"
      ],
      [
        "vision-model",
        "Qwen Vision (OAuth)",
        0.67,
        "128k"
      ]
    ]
  },
  "kilocode": {
    "name": "KiloCode",
    "url": "https://api.kilo.ai/api/gateway/chat/completions",
    "models": []
  },
  "googleai": {
    "name": "Google AI",
    "url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "models": [
      [
        "gemma-3-27b-it",
        "Gemma 3 27B",
        0.18,
        "128k"
      ],
      [
        "gemma-3-12b-it",
        "Gemma 3 12B",
        0.18,
        "128k"
      ],
      [
        "gemma-3-4b-it",
        "Gemma 3 4B",
        0.18,
        "128k"
      ]
    ]
  }
}

export const MODELS = [
  [
    "deepseek-ai/deepseek-v3.2",
    "DeepSeek V3.2",
    0.731,
    "128k",
    "nvidia"
  ],
  [
    "moonshotai/kimi-k2.5",
    "Kimi K2.5",
    0.768,
    "128k",
    "nvidia"
  ],
  [
    "z-ai/glm5",
    "GLM 5",
    0.815,
    "128k",
    "nvidia"
  ],
  [
    "z-ai/glm4.7",
    "GLM 4.7",
    0.738,
    "200k",
    "nvidia"
  ],
  [
    "moonshotai/kimi-k2-thinking",
    "Kimi K2 Thinking",
    0.713,
    "256k",
    "nvidia"
  ],
  [
    "minimaxai/minimax-m2.1",
    "MiniMax M2.1",
    0.74,
    "200k",
    "nvidia"
  ],
  [
    "stepfun-ai/step-3.5-flash",
    "Step 3.5 Flash",
    0.744,
    "256k",
    "nvidia"
  ],
  [
    "qwen/qwen3-coder-480b-a35b-instruct",
    "Qwen3 Coder 480B",
    0.706,
    "256k",
    "nvidia"
  ],
  [
    "qwen/qwen3-235b-a22b",
    "Qwen3 235B",
    0.7,
    "128k",
    "nvidia"
  ],
  [
    "mistralai/devstral-2-123b-instruct-2512",
    "Devstral 2 123B",
    0.722,
    "256k",
    "nvidia"
  ],
  [
    "deepseek-ai/deepseek-v3.1-terminus",
    "DeepSeek V3.1 Terminus",
    0.684,
    "128k",
    "nvidia"
  ],
  [
    "moonshotai/kimi-k2-instruct",
    "Kimi K2 Instruct",
    0.658,
    "128k",
    "nvidia"
  ],
  [
    "minimaxai/minimax-m2",
    "MiniMax M2",
    0.694,
    "128k",
    "nvidia"
  ],
  [
    "qwen/qwen3-next-80b-a3b-thinking",
    "Qwen3 80B Thinking",
    0.68,
    "128k",
    "nvidia"
  ],
  [
    "qwen/qwen3-next-80b-a3b-instruct",
    "Qwen3 80B Instruct",
    0.65,
    "128k",
    "nvidia"
  ],
  [
    "qwen/qwen3.5-397b-a17b",
    "Qwen3.5 400B",
    0.68,
    "128k",
    "nvidia"
  ],
  [
    "openai/gpt-oss-120b",
    "GPT OSS 120B",
    0.6,
    "128k",
    "nvidia"
  ],
  [
    "meta/llama-4-maverick-17b-128e-instruct",
    "Llama 4 Maverick",
    0.62,
    "1M",
    "nvidia"
  ],
  [
    "deepseek-ai/deepseek-v3.1",
    "DeepSeek V3.1",
    0.62,
    "128k",
    "nvidia"
  ],
  [
    "nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "Nemotron Ultra 253B",
    0.56,
    "128k",
    "nvidia"
  ],
  [
    "mistralai/mistral-large-3-675b-instruct-2512",
    "Mistral Large 675B",
    0.58,
    "256k",
    "nvidia"
  ],
  [
    "qwen/qwq-32b",
    "QwQ 32B",
    0.5,
    "131k",
    "nvidia"
  ],
  [
    "igenius/colosseum_355b_instruct_16k",
    "Colosseum 355B",
    0.52,
    "16k",
    "nvidia"
  ],
  [
    "mistralai/mistral-medium-3-instruct",
    "Mistral Medium 3",
    0.48,
    "128k",
    "nvidia"
  ],
  [
    "mistralai/magistral-small-2506",
    "Magistral Small",
    0.45,
    "32k",
    "nvidia"
  ],
  [
    "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "Nemotron Super 49B",
    0.49,
    "128k",
    "nvidia"
  ],
  [
    "meta/llama-4-scout-17b-16e-instruct",
    "Llama 4 Scout",
    0.44,
    "10M",
    "nvidia"
  ],
  [
    "nvidia/nemotron-3-nano-30b-a3b",
    "Nemotron Nano 30B",
    0.43,
    "128k",
    "nvidia"
  ],
  [
    "deepseek-ai/deepseek-r1-distill-qwen-32b",
    "R1 Distill 32B",
    0.439,
    "128k",
    "nvidia"
  ],
  [
    "openai/gpt-oss-20b",
    "GPT OSS 20B",
    0.42,
    "128k",
    "nvidia"
  ],
  [
    "qwen/qwen2.5-coder-32b-instruct",
    "Qwen2.5 Coder 32B",
    0.46,
    "32k",
    "nvidia"
  ],
  [
    "meta/llama-3.1-405b-instruct",
    "Llama 3.1 405B",
    0.44,
    "128k",
    "nvidia"
  ],
  [
    "meta/llama-3.3-70b-instruct",
    "Llama 3.3 70B",
    0.395,
    "128k",
    "nvidia"
  ],
  [
    "deepseek-ai/deepseek-r1-distill-qwen-14b",
    "R1 Distill 14B",
    0.377,
    "64k",
    "nvidia"
  ],
  [
    "bytedance/seed-oss-36b-instruct",
    "Seed OSS 36B",
    0.38,
    "32k",
    "nvidia"
  ],
  [
    "stockmark/stockmark-2-100b-instruct",
    "Stockmark 100B",
    0.36,
    "32k",
    "nvidia"
  ],
  [
    "mistralai/mixtral-8x22b-instruct-v0.1",
    "Mixtral 8x22B",
    0.32,
    "64k",
    "nvidia"
  ],
  [
    "mistralai/ministral-14b-instruct-2512",
    "Ministral 14B",
    0.34,
    "32k",
    "nvidia"
  ],
  [
    "ibm/granite-34b-code-instruct",
    "Granite 34B Code",
    0.3,
    "32k",
    "nvidia"
  ],
  [
    "deepseek-ai/deepseek-r1-distill-llama-8b",
    "R1 Distill 8B",
    0.282,
    "32k",
    "nvidia"
  ],
  [
    "deepseek-ai/deepseek-r1-distill-qwen-7b",
    "R1 Distill 7B",
    0.226,
    "32k",
    "nvidia"
  ],
  [
    "google/gemma-2-9b-it",
    "Gemma 2 9B",
    0.18,
    "8k",
    "nvidia"
  ],
  [
    "microsoft/phi-3.5-mini-instruct",
    "Phi 3.5 Mini",
    0.12,
    "128k",
    "nvidia"
  ],
  [
    "microsoft/phi-4-mini-instruct",
    "Phi 4 Mini",
    0.14,
    "128k",
    "nvidia"
  ],
  [
    "llama-3.3-70b-versatile",
    "Llama 3.3 70B",
    0.395,
    "128k",
    "groq"
  ],
  [
    "meta-llama/llama-4-scout-17b-16e-preview",
    "Llama 4 Scout",
    0.44,
    "10M",
    "groq"
  ],
  [
    "meta-llama/llama-4-maverick-17b-128e-preview",
    "Llama 4 Maverick",
    0.62,
    "1M",
    "groq"
  ],
  [
    "deepseek-r1-distill-llama-70b",
    "R1 Distill 70B",
    0.439,
    "128k",
    "groq"
  ],
  [
    "qwen-qwq-32b",
    "QwQ 32B",
    0.5,
    "131k",
    "groq"
  ],
  [
    "moonshotai/kimi-k2-instruct",
    "Kimi K2 Instruct",
    0.658,
    "131k",
    "groq"
  ],
  [
    "llama-3.1-8b-instant",
    "Llama 3.1 8B",
    0.14,
    "128k",
    "groq"
  ],
  [
    "openai/gpt-oss-120b",
    "GPT OSS 120B",
    0.6,
    "128k",
    "groq"
  ],
  [
    "openai/gpt-oss-20b",
    "GPT OSS 20B",
    0.42,
    "128k",
    "groq"
  ],
  [
    "qwen/qwen3-32b",
    "Qwen3 32B",
    0.5,
    "131k",
    "groq"
  ],
  [
    "llama3.3-70b",
    "Llama 3.3 70B",
    0.395,
    "128k",
    "cerebras"
  ],
  [
    "llama-4-scout-17b-16e-instruct",
    "Llama 4 Scout",
    0.44,
    "10M",
    "cerebras"
  ],
  [
    "qwen-3-32b",
    "Qwen3 32B",
    0.5,
    "128k",
    "cerebras"
  ],
  [
    "gpt-oss-120b",
    "GPT OSS 120B",
    0.6,
    "128k",
    "cerebras"
  ],
  [
    "qwen-3-235b-a22b",
    "Qwen3 235B",
    0.7,
    "128k",
    "cerebras"
  ],
  [
    "llama3.1-8b",
    "Llama 3.1 8B",
    0.14,
    "128k",
    "cerebras"
  ],
  [
    "glm-4.6",
    "GLM 4.6",
    0.7,
    "128k",
    "cerebras"
  ],
  [
    "qwen/qwen3-coder:free",
    "Qwen3 Coder",
    0.706,
    "256k",
    "openrouter"
  ],
  [
    "stepfun/step-3.5-flash:free",
    "Step 3.5 Flash",
    0.744,
    "256k",
    "openrouter"
  ],
  [
    "deepseek/deepseek-r1-0528:free",
    "DeepSeek R1 0528",
    0.439,
    "128k",
    "openrouter"
  ],
  [
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "Qwen3 80B Instruct",
    0.65,
    "128k",
    "openrouter"
  ],
  [
    "openai/gpt-oss-120b:free",
    "GPT OSS 120B",
    0.6,
    "128k",
    "openrouter"
  ],
  [
    "openai/gpt-oss-20b:free",
    "GPT OSS 20B",
    0.42,
    "128k",
    "openrouter"
  ],
  [
    "nvidia/nemotron-3-nano-30b-a3b:free",
    "Nemotron Nano 30B",
    0.43,
    "128k",
    "openrouter"
  ],
  [
    "meta-llama/llama-3.3-70b-instruct:free",
    "Llama 3.3 70B",
    0.395,
    "128k",
    "openrouter"
  ],
  [
    "codestral-latest",
    "Codestral",
    0.58,
    "256k",
    "codestral"
  ],
  [
    "devstral-2-123b-instruct-2512",
    "Devstral 2 123B",
    0.722,
    "256k",
    "scaleway"
  ],
  [
    "qwen3-235b-a22b-instruct-2507",
    "Qwen3 235B",
    0.7,
    "128k",
    "scaleway"
  ],
  [
    "gpt-oss-120b",
    "GPT OSS 120B",
    0.6,
    "128k",
    "scaleway"
  ],
  [
    "qwen3-coder-30b-a3b-instruct",
    "Qwen3 Coder 30B",
    0.706,
    "32k",
    "scaleway"
  ],
  [
    "llama-3.3-70b-instruct",
    "Llama 3.3 70B",
    0.395,
    "128k",
    "scaleway"
  ],
  [
    "deepseek-r1-distill-llama-70b",
    "R1 Distill 70B",
    0.439,
    "128k",
    "scaleway"
  ],
  [
    "mistral-small-3.2-24b-instruct-2506",
    "Mistral Small 3.2",
    0.32,
    "128k",
    "scaleway"
  ],
  [
    "coder-model",
    "Qwen Coder (OAuth)",
    0.696,
    "256k",
    "qwencode"
  ],
  [
    "vision-model",
    "Qwen Vision (OAuth)",
    0.67,
    "128k",
    "qwencode"
  ],
  [
    "gemma-3-27b-it",
    "Gemma 3 27B",
    0.18,
    "128k",
    "googleai"
  ],
  [
    "gemma-3-12b-it",
    "Gemma 3 12B",
    0.18,
    "128k",
    "googleai"
  ],
  [
    "gemma-3-4b-it",
    "Gemma 3 4B",
    0.18,
    "128k",
    "googleai"
  ]
]
