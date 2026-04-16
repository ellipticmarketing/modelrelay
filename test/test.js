import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { sources, MODELS, canonicalizeModelId, getPreferredModelLabel, getScore, resolveAliasedModelId } from '../sources.js'
import {
  getAvg,
  getVerdict,
  getUptime,
  sortResults,
  findBestModel,
  rankModelsForRouting,
  buildModelGroups,
  filterModelsByRequested,
  isRetryableProxyStatus,
  parseArgs,
  parseOpenRouterKeyRateLimit,
  selectNextApiKeyFromPool,
  VERDICT_ORDER,
} from '../lib/utils.js'
import { buildOpenClawProviderConfig } from '../lib/onboard.js'
import { resolveAutostartExecPath, resolveAutostartNodePath } from '../lib/autostart.js'
import { exportConfigToken, getApiKey, getApiKeyPool, getMaxTurns, getPinningMode, getProviderBaseUrl, getProviderModelId, getProviderPingIntervalMs, hasMultipleKeys, importConfigToken, normalizeConfigShape } from '../lib/config.js'
import { buildNpmInstallInvocation, buildWindowsPostUpdateRestartCommand, getForcedUpdateVersion, getLocalUpdateTarballPath, getLocalUpdateVersion, isRunningFromSource, shouldStopAutostartBeforeUpdate } from '../lib/update.js'
import { buildOpencodeHeaders, buildOpencodeProjectId, buildProviderRequestHeaders, extractOllamaModelRecords, getAccountStatus, getPinnedModelCandidate, getPinnedModelMatches, isProviderAuthOptional, isProviderBearerAuthEnabled, providerWantsBearerAuth, shouldRetryOptionalProviderWithBearer, toOllamaModelMeta, toOpenCodeModelMeta, toOpenRouterModelMeta, toKiloCodeModelMeta } from '../lib/server.js'
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function mockResult(overrides = {}) {
  return {
    idx: 1,
    modelId: 'test/model',
    label: 'Test Model',
    providerKey: 'nvidia',
    intell: 10,
    ctx: '128k',
    status: 'up',
    pings: [],
    httpCode: null,
    ...overrides,
  }
}

function withEnv(overrides, fn) {
  const previous = {}
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key]
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }

  try {
    return fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('config helpers', () => {
  it('resolves provider-specific ping intervals', () => {
    const config = {
      providers: {
        nvidia: { pingIntervalMinutes: 5 },
        kilocode: { pingIntervalMinutes: '10' },
        openrouter: { pingIntervalMinutes: 0 }, // invalid
      }
    }

    assert.equal(getProviderPingIntervalMs(config, 'nvidia'), 5 * 60_000)
    assert.equal(getProviderPingIntervalMs(config, 'kilocode'), 10 * 60_000)
    assert.equal(getProviderPingIntervalMs(config, 'openrouter'), 30 * 60_000) // default
    assert.equal(getProviderPingIntervalMs(config, 'missing'), 30 * 60_000) // default
    assert.equal(getPinningMode(config), 'canonical')
  })

  it('exports/imports full config through transfer token', () => {
    const config = {
      apiKeys: { nvidia: '  nv-key  ', groq: 'gsk-key' },
      providers: { nvidia: { enabled: true }, groq: { enabled: false } },
      bannedModels: ['a', 'b'],
      autoUpdate: { enabled: true, intervalHours: 12 },
      minSweScore: 0.45,
      excludedProviders: ['openrouter'],
      pinningMode: 'exact',
    }

    const token = exportConfigToken(config)
    assert.equal(token.startsWith('mrconf:v1:'), true)

    const imported = importConfigToken(token)
    assert.equal(imported.apiKeys.nvidia, 'nv-key')
    assert.equal(imported.apiKeys.groq, 'gsk-key')
    assert.equal(imported.providers.groq.enabled, false)
    assert.deepEqual(imported.bannedModels, ['a', 'b'])
    assert.equal(imported.autoUpdate.intervalHours, 12)
    assert.equal(imported.minSweScore, 0.45)
    assert.deepEqual(imported.excludedProviders, ['openrouter'])
    assert.equal(imported.pinningMode, 'exact')
  })

  it('imports legacy plain-base64 config payloads', () => {
    const json = JSON.stringify({ apiKeys: { kilocode: 'abc' }, providers: {} })
    const plainBase64 = Buffer.from(json, 'utf8').toString('base64')
    const imported = importConfigToken(plainBase64)
    assert.equal(imported.apiKeys.kilocode, 'abc')
  })
})

describe('sources data integrity', () => {
  it('does not include the removed Qwen Code provider', () => {
    assert.equal('qwencode' in sources, false)
  })

  it('includes OpenAI-compatible provider', () => {
    assert.ok(sources['openai-compatible'])
    assert.equal(sources['openai-compatible'].name, 'OpenAI-Compatible')
    assert.ok(Array.isArray(sources['openai-compatible'].models))
  })

  it('includes Ollama provider', () => {
    assert.ok(sources.ollama)
    assert.equal(sources.ollama.name, 'Ollama')
    assert.ok(Array.isArray(sources.ollama.models))
  })

  it('includes OpenCode Zen provider', () => {
    assert.ok(sources.opencode)
    assert.equal(sources.opencode.name, 'OpenCode Zen')
    assert.ok(Array.isArray(sources.opencode.models))
  })

  it('has expected provider structure', () => {
    for (const [providerKey, provider] of Object.entries(sources)) {
      assert.equal(typeof providerKey, 'string')
      assert.equal(typeof provider.name, 'string')
      assert.equal(typeof provider.url, 'string')
      assert.ok(Array.isArray(provider.models))
    }
  })

  it('provider model tuples have 3 fields', () => {
    for (const provider of Object.values(sources)) {
      for (const model of provider.models) {
        assert.ok(Array.isArray(model))
        assert.equal(model.length, 3)
        assert.equal(typeof model[0], 'string')
        assert.equal(typeof model[1], 'string')
        assert.equal(typeof model[2], 'string')
      }
    }
  })

  it('flat MODELS tuples have 5 fields', () => {
    for (const model of MODELS) {
      assert.ok(Array.isArray(model))
      assert.equal(model.length, 5)
      assert.equal(typeof model[0], 'string')
      assert.equal(typeof model[1], 'string')
      assert.equal(typeof model[4], 'string')
    }
  })

  it('flat MODELS count matches sources sum', () => {
    const sum = Object.values(sources).reduce((acc, provider) => acc + provider.models.length, 0)
    assert.equal(MODELS.length, sum)
  })

  it('has no duplicate provider/model IDs', () => {
    const seen = new Set()
    for (const [modelId, , , , providerKey] of MODELS) {
      const key = `${providerKey}/${modelId}`
      assert.equal(seen.has(key), false, `Duplicate model key found: ${key}`)
      seen.add(key)
    }
  })
})

describe('provider api key resolution', () => {
  it('does not resolve the removed Qwen Code provider from env vars', () => {
    const originalQwen = process.env.QWEN_CODE_API_KEY
    const originalDashScope = process.env.DASHSCOPE_API_KEY

    try {
      delete process.env.QWEN_CODE_API_KEY
      delete process.env.DASHSCOPE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)

      process.env.DASHSCOPE_API_KEY = 'dashscope-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)

      process.env.QWEN_CODE_API_KEY = 'qwen-code-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)
    } finally {
      if (originalQwen == null) delete process.env.QWEN_CODE_API_KEY
      else process.env.QWEN_CODE_API_KEY = originalQwen

      if (originalDashScope == null) delete process.env.DASHSCOPE_API_KEY
      else process.env.DASHSCOPE_API_KEY = originalDashScope
    }
  })

  it('supports KiloCode provider env var override', () => {
    const original = process.env.KILOCODE_API_KEY

    try {
      delete process.env.KILOCODE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'kilocode'), null)

      process.env.KILOCODE_API_KEY = 'kilocode-env-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'kilocode'), 'kilocode-env-key')

      assert.equal(getApiKey({ apiKeys: { kilocode: 'file-key' } }, 'kilocode'), 'kilocode-env-key')
    } finally {
      if (original == null) delete process.env.KILOCODE_API_KEY
      else process.env.KILOCODE_API_KEY = original
    }
  })

  it('supports OpenAI-compatible provider env vars for key, base URL, and model', () => {
    const originalKey = process.env.OPENAI_COMPATIBLE_API_KEY
    const originalBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const originalModel = process.env.OPENAI_COMPATIBLE_MODEL

    try {
      delete process.env.OPENAI_COMPATIBLE_API_KEY
      delete process.env.OPENAI_COMPATIBLE_BASE_URL
      delete process.env.OPENAI_COMPATIBLE_MODEL

      const config = {
        apiKeys: { 'openai-compatible': 'config-key' },
        providers: { 'openai-compatible': { baseUrl: 'https://example.test/v1', modelId: 'foo/bar' } },
      }

      assert.equal(getApiKey(config, 'openai-compatible'), 'config-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible'), 'https://example.test/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible'), 'foo/bar')

      process.env.OPENAI_COMPATIBLE_API_KEY = 'env-key'
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://env.example/v1'
      process.env.OPENAI_COMPATIBLE_MODEL = 'env/model'

      assert.equal(getApiKey(config, 'openai-compatible'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible'), 'https://env.example/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible'), 'env/model')
    } finally {
      if (originalKey == null) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = originalKey

      if (originalBaseUrl == null) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = originalBaseUrl

      if (originalModel == null) delete process.env.OPENAI_COMPATIBLE_MODEL
      else process.env.OPENAI_COMPATIBLE_MODEL = originalModel
    }
  })

  it('supports Ollama provider env vars for key, base URL, and model', () => {
    const originalKey = process.env.OLLAMA_API_KEY
    const originalBaseUrl = process.env.OLLAMA_BASE_URL
    const originalModel = process.env.OLLAMA_MODEL

    try {
      delete process.env.OLLAMA_API_KEY
      delete process.env.OLLAMA_BASE_URL
      delete process.env.OLLAMA_MODEL

      const config = {
        apiKeys: { ollama: 'config-key' },
        providers: { ollama: { baseUrl: 'https://ollama.com/v1', modelId: 'gpt-oss:120b' } },
      }

      assert.equal(getApiKey(config, 'ollama'), 'config-key')
      assert.equal(getProviderBaseUrl(config, 'ollama'), 'https://ollama.com/v1')
      assert.equal(getProviderModelId(config, 'ollama'), 'gpt-oss:120b')

      process.env.OLLAMA_API_KEY = 'env-key'
      process.env.OLLAMA_BASE_URL = 'https://ollama.com/v1'
      process.env.OLLAMA_MODEL = 'llama3.3'

      assert.equal(getApiKey(config, 'ollama'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'ollama'), 'https://ollama.com/v1')
      assert.equal(getProviderModelId(config, 'ollama'), 'llama3.3')
    } finally {
      if (originalKey == null) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = originalKey

      if (originalBaseUrl == null) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = originalBaseUrl

      if (originalModel == null) delete process.env.OLLAMA_MODEL
      else process.env.OLLAMA_MODEL = originalModel
    }
  })

  it('uses Ollama cloud base URL when none is configured', () => {
    const originalBaseUrl = process.env.OLLAMA_BASE_URL

    try {
      delete process.env.OLLAMA_BASE_URL
      assert.equal(getProviderBaseUrl({ providers: { ollama: {} } }, 'ollama'), null)
    } finally {
      if (originalBaseUrl == null) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = originalBaseUrl
    }
  })

  it('supports OpenCode provider env var override', () => {
    const original = process.env.OPENCODE_API_KEY

    try {
      delete process.env.OPENCODE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'opencode'), null)

      process.env.OPENCODE_API_KEY = 'opencode-env-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'opencode'), 'opencode-env-key')
      assert.equal(getApiKey({ apiKeys: { opencode: 'file-key' } }, 'opencode'), 'opencode-env-key')
    } finally {
      if (original == null) delete process.env.OPENCODE_API_KEY
      else process.env.OPENCODE_API_KEY = original
    }
  })

  it('treats OpenCode and KiloCode auth as optional bearer auth providers, and local Ollama as optional', () => {
    assert.equal(isProviderAuthOptional({}, 'opencode'), true)
    assert.equal(isProviderAuthOptional({}, 'kilocode'), true)
    assert.equal(isProviderAuthOptional({}, 'ollama'), false)
    assert.equal(isProviderAuthOptional({ providers: { ollama: { baseUrl: 'http://127.0.0.1:11434' } } }, 'ollama'), true)
    assert.equal(isProviderAuthOptional({ providers: { ollama: { baseUrl: 'http://localhost:11434' } } }, 'ollama'), true)
    assert.equal(isProviderAuthOptional({}, 'openrouter'), false)

    assert.equal(isProviderBearerAuthEnabled({}, 'opencode'), true)
    assert.equal(isProviderBearerAuthEnabled({}, 'kilocode'), true)
    assert.equal(isProviderBearerAuthEnabled({}, 'ollama'), true)
    assert.equal(isProviderBearerAuthEnabled({ providers: { opencode: { useBearerAuth: false } } }, 'opencode'), false)
    assert.equal(isProviderBearerAuthEnabled({ providers: { kilocode: { useBearerAuth: false } } }, 'kilocode'), false)
    assert.equal(isProviderBearerAuthEnabled({ providers: { ollama: { useBearerAuth: false } } }, 'ollama'), true)

    assert.equal(providerWantsBearerAuth({}, 'opencode'), true)
    assert.equal(providerWantsBearerAuth({ providers: { opencode: { useBearerAuth: false } } }, 'opencode'), false)
    assert.equal(providerWantsBearerAuth({ providers: { kilocode: { useBearerAuth: false } } }, 'kilocode'), false)
    assert.equal(providerWantsBearerAuth({ providers: { ollama: { useBearerAuth: false } } }, 'ollama'), true)
    assert.equal(providerWantsBearerAuth({}, 'openrouter'), true)
  })

  it('builds stable OpenCode CLI headers for unauthenticated requests', () => {
    assert.equal(buildOpencodeProjectId('C:/example/project'), buildOpencodeProjectId('C:/example/project'))
    assert.match(buildOpencodeProjectId('C:/example/project'), /^[a-f0-9]{40}$/)

    const headers = buildOpencodeHeaders({
      projectSeed: 'C:/example/project',
      sessionId: 'ses_test',
      requestId: 'req_test',
    })

    assert.deepEqual(headers, {
      'x-opencode-project': buildOpencodeProjectId('C:/example/project'),
      'x-opencode-session': 'ses_test',
      'x-opencode-request': 'req_test',
      'x-opencode-client': 'cli',
    })
  })

  it('adds OpenCode CLI headers to provider requests without requiring a bearer token', () => {
    const headers = buildProviderRequestHeaders('opencode', {
      projectSeed: 'C:/example/project',
      sessionId: 'ses_test',
      requestId: 'req_test',
    })

    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers.Authorization, undefined)
    assert.equal(headers['x-opencode-project'], buildOpencodeProjectId('C:/example/project'))
    assert.equal(headers['x-opencode-session'], 'ses_test')
    assert.equal(headers['x-opencode-request'], 'req_test')
    assert.equal(headers['x-opencode-client'], 'cli')
  })

  it('retries optional providers with bearer auth when an unauthenticated probe is rejected', () => {
    const config = {
      apiKeys: { opencode: 'opencode-key' },
      providers: { opencode: { useBearerAuth: false } },
    }

    assert.equal(
      shouldRetryOptionalProviderWithBearer(config, 'opencode', { token: null }, '401', 'Missing API key.'),
      true
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer(config, 'opencode', { token: null }, '401', 'Unauthorized'),
      true
    )
  })

  it('does not retry optional providers with bearer auth when there is no fallback key or a token was already used', () => {
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: {}, providers: { opencode: { useBearerAuth: false } } }, 'opencode', { token: null }, '401', 'Missing API key.'),
      false
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: { opencode: 'opencode-key' } }, 'opencode', { token: 'already-used' }, '401', 'Missing API key.'),
      false
    )
    assert.equal(
      shouldRetryOptionalProviderWithBearer({ apiKeys: { openrouter: 'openrouter-key' } }, 'openrouter', { token: null }, '401', 'Unauthorized'),
      false
    )
  })
})

describe('dynamic model score resolution', () => {
  it('extracts Ollama model records from tags payloads', () => {
    const payload = {
      models: [
        { name: 'gpt-oss:120b', model: 'gpt-oss:120b' },
        { name: 'llama3.3', model: 'llama3.3' },
      ],
    }

    assert.deepEqual(extractOllamaModelRecords(payload), payload.models)
    assert.deepEqual(extractOllamaModelRecords(null), [])
  })

  it('uses scores.js entries for Ollama models when available', () => {
    const model = toOllamaModelMeta({
      name: 'openai/gpt-oss-120b',
      model: 'openai/gpt-oss-120b',
    })

    assert.ok(model)
    assert.equal(model.providerKey, 'ollama')
    assert.equal(model.label, 'GPT OSS 120B')
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps Ollama-style aliases like qwen3:4b to existing score entries', () => {
    assert.equal(resolveAliasedModelId('qwen3:4b'), 'qwen/qwen3-4b')
    assert.equal(getScore('qwen3:4b'), 0.542)

    const model = toOllamaModelMeta({
      name: 'qwen3:4b',
      model: 'qwen3:4b',
      details: { family: 'qwen3', parameter_size: '4.0B' },
    })

    assert.ok(model)
    assert.equal(model.label, 'Qwen3:4b')
    assert.equal(model.intell, 0.542)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps Devstral Small 2 Ollama IDs to a verified score entry', () => {
    assert.equal(resolveAliasedModelId('devstral-small-2:24b'), 'devstral-small-2-24b')
    assert.equal(getScore('devstral-small-2:24b'), 0.658)

    const model = toOllamaModelMeta({
      name: 'devstral-small-2:24b',
      model: 'devstral-small-2:24b',
    })

    assert.ok(model)
    assert.equal(model.label, 'Devstral Small 2 24B')
    assert.equal(model.intell, 0.658)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps common Ollama cloud aliases onto existing benchmark entries', () => {
    assert.equal(getScore('deepseek-v3.2'), 0.731)
    assert.equal(getScore('cogito-2.1:671b'), 0.42)
    assert.equal(getScore('gemma3:4b'), 0.428)
    assert.equal(getScore('glm-5'), 0.778)
    assert.equal(getScore('kimi-k2.5'), 0.768)
    assert.equal(getScore('mimo-v2-pro-free'), 0.78)
    assert.equal(getScore('minimax-m2.5-free'), 0.802)
    assert.equal(getScore('ministral-3:3b'), 0.548)
    assert.equal(getScore('ministral-3:8b'), 0.616)
    assert.equal(getScore('mistral-large-3:675b'), 0.58)
    assert.equal(getScore('nemotron-3-super'), 0.6047)
    assert.equal(getScore('qwen/qwen3.6-plus-preview:free'), 0.68)
    assert.equal(getScore('qwen3-vl:235b'), 0.7)
    assert.equal(getScore('qwen3-vl:235b-instruct'), 0.7)
    assert.equal(getScore('qwen3-coder:480b'), 0.706)
    assert.equal(getScore('qwen3-next:80b'), 0.65)
    assert.equal(getScore('qwen3.5:397b'), 0.68)
  })

  it('applies direct score entries for new cloud-only models we track explicitly', () => {
    assert.equal(getScore('gemini-3-flash-preview'), 0.78)
    assert.equal(getScore('qwen3-coder-next'), 0.706)
    assert.equal(getScore('rnj-1:8b'), 0.208)
  })

  it('resolves researched benchmark scores for newly discovered coding models', () => {
    assert.equal(getScore('arcee-ai/trinity-large-thinking:free'), 0.632)
    assert.equal(getScore('bytedance-seed/dola-seed-2.0-pro:free'), 0.765)
    assert.equal(getScore('glm-5.1'), 0.584)
    assert.equal(getScore('google/gemma-4-26b-a4b-it:free'), 0.771)
    assert.equal(getScore('google/gemma-4-31b-it:free'), 0.8)
  })

  it('maps Gemma 4 Ollama aliases onto researched score entries', () => {
    assert.equal(resolveAliasedModelId('gemma4:26b'), 'google/gemma-4-26b-a4b-it')
    assert.equal(resolveAliasedModelId('gemma4:31b'), 'google/gemma-4-31b-it')
    assert.equal(getScore('gemma4:31b'), 0.8)

    const model = toOllamaModelMeta({
      name: 'gemma4:31b',
      model: 'gemma4:31b',
    })

    assert.ok(model)
    assert.equal(model.label, 'Gemma 4 31B')
    assert.equal(model.intell, 0.8)
    assert.equal(model.isEstimatedScore, false)
  })

  it('maps Ollama cloud remote models to canonical score entries', () => {
    const model = toOllamaModelMeta({
      name: 'Minimax-m2.7:cloud',
      model: 'Minimax-m2.7:cloud',
      remote_model: 'minimax-m2.7',
    })

    assert.ok(model)
    assert.equal(model.intell, 0.822)
    assert.equal(model.isEstimatedScore, false)
  })

  it('keeps MiniMax M-series SWE scores monotonic as versions increase', () => {
    assert.ok(getScore('minimax-m2') < getScore('minimax-m2.1'))
    assert.ok(getScore('minimax-m2.1') < getScore('minimax-m2.5'))
    assert.ok(getScore('minimax-m2.5') < getScore('minimax-m2.7'))
  })

  it('uses scores.js entry for OpenRouter models outside static sources', () => {
    const model = toOpenRouterModelMeta({
      id: 'google/gemma-3n-e2b-it:free',
      name: 'Google: Gemma 3N E2B (free)',
      context_length: 32768,
    })

    assert.ok(model)
    assert.equal(model.intell, 0.25)
    assert.equal(model.isEstimatedScore, false)
  })

  it('uses researched score entries for newly discovered OpenRouter coding models', () => {
    const gemma = toOpenRouterModelMeta({
      id: 'google/gemma-4-31b-it:free',
      name: 'Google: Gemma 4 31B (free)',
      context_length: 262144,
    })

    assert.ok(gemma)
    assert.equal(gemma.label, 'Gemma 4 31B')
    assert.equal(gemma.intell, 0.8)
    assert.equal(gemma.isEstimatedScore, false)
  })

  it('ignores safety-only dynamic models that should not be routed as coding models', () => {
    assert.equal(toKiloCodeModelMeta({ id: 'meta-llama/llama-guard-4-12b:free' }), null)
    assert.equal(toOpenRouterModelMeta({ id: 'meta-llama/llama-guard-4-12b:free' }), null)
  })

  it('uses scores.js entry for KiloCode models when payload omits scores', () => {
    const model = toKiloCodeModelMeta({
      id: 'google/gemma-3n-e2b-it:free',
      display_name: 'Gemma 3N E2B',
      context_length: 32768,
    })

    assert.ok(model)
    assert.equal(model.intell, 0.25)
    assert.equal(model.isEstimatedScore, false)
  })

  it('uses researched score entries for newly discovered KiloCode coding models', () => {
    const model = toKiloCodeModelMeta({
      id: 'arcee-ai/trinity-large-thinking:free',
      display_name: 'Arcee Trinity Large Thinking',
    })

    assert.ok(model)
    assert.equal(model.label, 'Trinity Large Thinking')
    assert.equal(model.intell, 0.632)
    assert.equal(model.isEstimatedScore, false)
  })

  it('applies preferred labels to KiloCode dynamic models', () => {
    const model = toKiloCodeModelMeta({
      id: 'xiaomi/mimo-v2-omni:free',
      display_name: 'xiaomi/mimo-v2-omni:free',
    })

    assert.ok(model)
    assert.equal(model.label, 'MiMo V2 Omni')
  })

  it('uses aliased scores.js entries for OpenCode Zen chat models', () => {
    const model = toOpenCodeModelMeta({
      id: 'minimax-m2.5-free',
    })

    assert.ok(model)
    assert.equal(model.label, 'MiniMax M2.5')
    assert.equal(model.intell, 0.802)
    assert.equal(model.isEstimatedScore, false)
  })

  it('includes OpenCode Zen free models that end with -free', () => {
    const qwen = toOpenCodeModelMeta({ id: 'qwen3.6-plus-free' })
    const trinity = toOpenCodeModelMeta({ id: 'trinity-large-preview-free' })
    const flash = toOpenCodeModelMeta({ id: 'mimo-v2-flash-free' })

    assert.ok(qwen)
    assert.equal(qwen.intell, 0.68)
    assert.equal(qwen.isEstimatedScore, false)

    assert.ok(trinity)
    assert.equal(trinity.intell, 0.778)
    assert.equal(trinity.isEstimatedScore, false)

    assert.ok(flash)
    assert.equal(flash.intell, 0.734)
    assert.equal(flash.isEstimatedScore, false)
  })

  it('ignores OpenCode Zen models that are not free/chat-compatible for routing', () => {
    assert.equal(toOpenCodeModelMeta({ id: 'gpt-5.4' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'big-pickle' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'glm-5' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'kimi-k2' }), null)
    assert.equal(toOpenCodeModelMeta({ id: 'minimax-m2.5' }), null)
  })

  it('applies preferred MiMo display labels', () => {
    assert.equal(getPreferredModelLabel('mimo-v2-omni-free'), 'MiMo V2 Omni')
    assert.equal(getPreferredModelLabel('xiaomi/mimo-v2-omni:free'), 'MiMo V2 Omni')
    assert.equal(getPreferredModelLabel('xiaomi/mimo-v2-pro:free'), 'MiMo V2 Omni Pro')
    assert.equal(getPreferredModelLabel('x-ai/grok-code-fast-1:optimized:free'), 'Grok Code Fast')
    assert.equal(getPreferredModelLabel('minimax-m2.5-free', 'MiniMax M2.5 Free'), 'MiniMax M2.5')
    assert.equal(getPreferredModelLabel('nemotron-3-super-free', 'Nemotron 3 Super Free'), 'Nemotron 3 Super')
  })

  it('preserves Ollama size tags while stripping runtime suffixes', () => {
    assert.deepEqual(canonicalizeModelId('devstral-small-2:24b'), { base: 'devstral-small-2-24b', unprefixed: 'devstral-small-2-24b' })
    assert.deepEqual(canonicalizeModelId('qwen3:4b'), { base: 'qwen/qwen3-4b', unprefixed: 'qwen3-4b' })
    assert.deepEqual(canonicalizeModelId('gpt-oss:120b'), { base: 'openai/gpt-oss-120b', unprefixed: 'gpt-oss-120b' })
    assert.deepEqual(canonicalizeModelId('Minimax-m2.7:cloud'), { base: 'minimax-m2.7', unprefixed: 'minimax-m2.7' })
    assert.deepEqual(canonicalizeModelId('x-ai/grok-code-fast-1:optimized:free'), { base: 'x-ai/grok-code-fast-1', unprefixed: 'grok-code-fast-1' })
  })
})

describe('getAvg', () => {
  it('returns Infinity with no successful pings', () => {
    assert.equal(getAvg(mockResult({ pings: [] })), Infinity)
    assert.equal(getAvg(mockResult({ pings: [{ ms: 20, code: '500' }] })), Infinity)
  })

  it('uses only HTTP 200 pings', () => {
    const result = mockResult({
      pings: [
        { ms: 200, code: '200' },
        { ms: 400, code: '200' },
        { ms: 800, code: '429' },
      ],
    })
    assert.equal(getAvg(result), 300)
  })

  it('applies sliding window when ts is present', () => {
    const now = Date.now()
    const result = mockResult({
      pings: [
        { ms: 100, code: '200', ts: now - 5_000 },
        { ms: 900, code: '200', ts: now - 60_000 },
      ],
    })
    assert.equal(getAvg(result, 10_000), 100)
  })

  it('keeps successful pings within the default long window', () => {
    const now = Date.now()
    const result = mockResult({
      pings: [
        { ms: 240, code: '200', ts: now - 20 * 60_000 },
        { ms: 900, code: '200', ts: now - 40 * 60_000 },
      ],
    })
    assert.equal(getAvg(result), 240)
  })
})

describe('getVerdict', () => {
  it('maps overloaded and inactive states', () => {
    assert.equal(getVerdict(mockResult({ httpCode: '429', pings: [{ ms: 0, code: '429' }] })), 'Overloaded')
    assert.equal(getVerdict(mockResult({ status: 'timeout', pings: [{ ms: 0, code: '000' }] })), 'Not Active')
  })

  it('maps unstable when model was previously up', () => {
    const result = mockResult({
      status: 'down',
      pings: [{ ms: 150, code: '200' }, { ms: 0, code: '500' }],
    })
    assert.equal(getVerdict(result), 'Unstable')
  })

  it('maps latency tiers', () => {
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 200, code: '200' }] })), 'Perfect')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 600, code: '200' }] })), 'Normal')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 1_600, code: '200' }] })), 'Slow')
    assert.equal(getVerdict(mockResult({ pings: [{ ms: 4_000, code: '200' }] })), 'Very Slow')
  })
})

describe('getUptime', () => {
  it('returns percentage of successful pings', () => {
    assert.equal(getUptime(mockResult({ pings: [] })), 0)
    assert.equal(getUptime(mockResult({ pings: [{ ms: 10, code: '200' }, { ms: 20, code: '200' }] })), 100)
    assert.equal(getUptime(mockResult({ pings: [{ ms: 10, code: '200' }, { ms: 0, code: '500' }] })), 50)
  })
})

describe('sortResults', () => {
  it('sorts by avg', () => {
    const results = [
      mockResult({ label: 'Slow', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'Fast', pings: [{ ms: 100, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'avg', 'asc')
    assert.equal(sorted[0].label, 'Fast')
  })

  it('sorts by verdict using VERDICT_ORDER', () => {
    const results = [
      mockResult({ label: 'Pending', pings: [] }),
      mockResult({ label: 'Perfect', pings: [{ ms: 100, code: '200' }] }),
    ]
    const sorted = sortResults(results, 'verdict', 'asc')
    assert.equal(sorted[0].label, 'Perfect')
    assert.equal(VERDICT_ORDER.includes('Pending'), true)
  })

  it('sorts ctx values with k/m suffixes', () => {
    const results = [
      mockResult({ label: 'Small', ctx: '8k' }),
      mockResult({ label: 'Large', ctx: '1m' }),
      mockResult({ label: 'Mid', ctx: '128k' }),
    ]
    const sorted = sortResults(results, 'ctx', 'asc')
    assert.deepEqual(sorted.map(r => r.label), ['Small', 'Mid', 'Large'])
  })

  it('does not mutate the original array', () => {
    const results = [
      mockResult({ label: 'B', pings: [{ ms: 500, code: '200' }] }),
      mockResult({ label: 'A', pings: [{ ms: 100, code: '200' }] }),
    ]
    const copy = [...results]
    sortResults(results, 'avg', 'asc')
    assert.equal(results[0].label, copy[0].label)
  })
})

describe('findBestModel', () => {
  it('returns null on empty input', () => {
    assert.equal(findBestModel([]), null)
  })

  it('ignores banned and disabled models', () => {
    const results = [
      mockResult({ label: 'Banned', status: 'banned', pings: [{ ms: 10, code: '200' }] }),
      mockResult({ label: 'Disabled', status: 'disabled', pings: [{ ms: 10, code: '200' }] }),
      mockResult({ label: 'Valid', status: 'up', pings: [{ ms: 300, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Valid')
  })

  it('prefers better QoS among eligible models', () => {
    const results = [
      mockResult({ label: 'Slower', status: 'up', pings: [{ ms: 700, code: '200' }, { ms: 900, code: '200' }] }),
      mockResult({ label: 'Faster', status: 'up', pings: [{ ms: 120, code: '200' }, { ms: 200, code: '200' }] }),
    ]
    assert.equal(findBestModel(results).label, 'Faster')
  })
})

describe('rankModelsForRouting', () => {
  it('returns candidates sorted by QoS', () => {
    const results = [
      mockResult({ label: 'Slower', status: 'up', pings: [{ ms: 900, code: '200' }] }),
      mockResult({ label: 'Faster', status: 'up', pings: [{ ms: 120, code: '200' }] }),
    ]

    const ranked = rankModelsForRouting(results)
    assert.equal(ranked[0].label, 'Faster')
    assert.equal(ranked[1].label, 'Slower')
  })

  it('excludes requested model IDs and ineligible states', () => {
    const results = [
      mockResult({ modelId: 'a', label: 'A', status: 'up', pings: [{ ms: 100, code: '200' }] }),
      mockResult({ modelId: 'b', label: 'B', status: 'banned', pings: [{ ms: 50, code: '200' }] }),
      mockResult({ modelId: 'c', label: 'C', status: 'disabled', pings: [{ ms: 50, code: '200' }] }),
      mockResult({ modelId: 'd', label: 'D', status: 'up', pings: [{ ms: 300, code: '200' }] }),
    ]

    const ranked = rankModelsForRouting(results, ['a'])
    assert.deepEqual(ranked.map(r => r.modelId), ['d'])
  })
})

describe('isRetryableProxyStatus', () => {
  it('returns true for 429 and 5xx', () => {
    assert.equal(isRetryableProxyStatus(429), true)
    assert.equal(isRetryableProxyStatus('500'), true)
    assert.equal(isRetryableProxyStatus(503), true)
  })

  it('returns false for non-retryable statuses', () => {
    assert.equal(isRetryableProxyStatus(200), false)
    assert.equal(isRetryableProxyStatus(400), false)
    assert.equal(isRetryableProxyStatus(404), false)
    assert.equal(isRetryableProxyStatus('not-a-status'), false)
  })
})

describe('parseArgs', () => {
  const argv = (...args) => ['node', 'script', ...args]

  it('parses router runtime flags', () => {
    const result = parseArgs(argv('--port', '8080', '--ban', 'a,b,c', '--log'))
    assert.equal(result.portValue, 8080)
    assert.deepEqual(result.bannedModels, ['a', 'b', 'c'])
    assert.equal(result.enableLog, true)
  })

  it('defaults to port 7352 and logs disabled', () => {
    const result = parseArgs(argv())
    assert.equal(result.portValue, 7352)
    assert.equal(result.enableLog, false)
  })

  it('lets --no-log override --log', () => {
    const result = parseArgs(argv('--log', '--no-log'))
    assert.equal(result.enableLog, false)
  })

  it('detects onboard subcommand and flag', () => {
    assert.equal(parseArgs(argv('onboard')).onboard, true)
    assert.equal(parseArgs(argv('--onboard')).onboard, true)
  })

  it('detects help aliases', () => {
    assert.equal(parseArgs(argv('--help')).help, true)
    assert.equal(parseArgs(argv('-h')).help, true)
    assert.equal(parseArgs(argv('help')).help, true)
  })

  it('parses autostart command variants', () => {
    const install = parseArgs(argv('install', '--autostart'))
    assert.equal(install.command, 'install')
    assert.equal(install.autostart, true)
    assert.equal(install.autostartAction, 'install')

    const start = parseArgs(argv('start', '--autostart'))
    assert.equal(start.command, 'start')
    assert.equal(start.autostart, true)
    assert.equal(start.autostartAction, 'start')

    const uninstall = parseArgs(argv('uninstall', 'autostart'))
    assert.equal(uninstall.command, 'uninstall')
    assert.equal(uninstall.autostart, true)
    assert.equal(uninstall.autostartAction, 'uninstall')

    const status = parseArgs(argv('status', '--autostart'))
    assert.equal(status.command, 'status')
    assert.equal(status.autostart, true)
    assert.equal(status.autostartAction, 'status')
  })

  it('parses autostart alias commands', () => {
    assert.equal(parseArgs(argv('autostart')).autostartAction, 'status')
    assert.equal(parseArgs(argv('autostart', '--status')).autostartAction, 'status')
    assert.equal(parseArgs(argv('autostart', '--install')).autostartAction, 'install')
    assert.equal(parseArgs(argv('autostart', '--start')).autostartAction, 'start')
    assert.equal(parseArgs(argv('autostart', 'uninstall')).autostartAction, 'uninstall')
  })

  it('parses update subcommand', () => {
    const result = parseArgs(argv('update'))
    assert.equal(result.command, 'update')
    assert.equal(result.autostartAction, null)
  })

  it('parses autoupdate status by default', () => {
    const result = parseArgs(argv('autoupdate'))
    assert.equal(result.command, 'autoupdate')
    assert.equal(result.autoUpdateAction, 'status')
  })

  it('parses autoupdate enable/disable with interval', () => {
    const enabled = parseArgs(argv('autoupdate', '--enable', '--interval', '12'))
    assert.equal(enabled.autoUpdateAction, 'enable')
    assert.equal(enabled.autoUpdateIntervalHours, 12)

    const disabled = parseArgs(argv('autoupdate', '--disable'))
    assert.equal(disabled.autoUpdateAction, 'disable')
    assert.equal(disabled.autoUpdateIntervalHours, null)
  })

  it('parses config export/import commands', () => {
    const exported = parseArgs(argv('config', 'export'))
    assert.equal(exported.command, 'config')
    assert.equal(exported.configAction, 'export')
    assert.equal(exported.configPayload, null)

    const imported = parseArgs(argv('config', 'import', 'mrconf:v1:abc123'))
    assert.equal(imported.command, 'config')
    assert.equal(imported.configAction, 'import')
    assert.equal(imported.configPayload, 'mrconf:v1:abc123')
  })

  it('parses config set-keys command', () => {
    const result = parseArgs(argv('config', 'set-keys', 'kilocode', 'key1,key2,key3'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-keys')
    assert.equal(result.configProvider, 'kilocode')
    assert.equal(result.configKeys, 'key1,key2,key3')
  })

  it('parses config add-key command', () => {
    const result = parseArgs(argv('config', 'add-key', 'nvidia', 'nvapi-extra'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'add-key')
    assert.equal(result.configProvider, 'nvidia')
    assert.equal(result.configKeys, 'nvapi-extra')
  })

  it('parses config remove-key command', () => {
    const result = parseArgs(argv('config', 'remove-key', 'groq', '1'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'remove-key')
    assert.equal(result.configProvider, 'groq')
    assert.equal(result.configKeys, '1')
  })

  it('parses config set-maxturns command', () => {
    const result = parseArgs(argv('config', 'set-maxturns', 'kilocode', '20'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-maxturns')
    assert.equal(result.configProvider, 'kilocode')
    assert.equal(result.configMaxTurns, '20')
  })

  it('parses config set-maxturns with 0 to disable', () => {
    const result = parseArgs(argv('config', 'set-maxturns', 'kilocode', '0'))
    assert.equal(result.command, 'config')
    assert.equal(result.configAction, 'set-maxturns')
    assert.equal(result.configMaxTurns, '0')
  })

  it('parses status command', () => {
    const result = parseArgs(argv('status'))
    assert.equal(result.command, 'status')
  })
})

describe('parseOpenRouterKeyRateLimit', () => {
  it('extracts credit limits from key payload', () => {
    const parsed = parseOpenRouterKeyRateLimit({
      data: {
        limit: 25,
        limit_remaining: 12.5,
        limit_reset: '2026-03-01T00:00:00.000Z',
      }
    })

    assert.equal(parsed.creditLimit, 25)
    assert.equal(parsed.creditRemaining, 12.5)
    assert.equal(parsed.creditResetAt, Date.parse('2026-03-01T00:00:00.000Z'))
  })

  it('parses deprecated nested rate_limit shape when present', () => {
    const parsed = parseOpenRouterKeyRateLimit({
      data: {
        rate_limit: {
          limit_requests: 20,
          remaining_requests: 8,
          reset_requests: 120,
          limit_tokens: 40000,
          remaining_tokens: 15000,
          reset_tokens: 45,
        }
      }
    })

    assert.equal(parsed.limitRequests, 20)
    assert.equal(parsed.remainingRequests, 8)
    assert.equal(parsed.limitTokens, 40000)
    assert.equal(parsed.remainingTokens, 15000)
    assert.ok(parsed.resetRequestsAt > Date.now())
    assert.ok(parsed.resetTokensAt > Date.now())
  })

  it('returns null for invalid payloads', () => {
    assert.equal(parseOpenRouterKeyRateLimit(null), null)
    assert.equal(parseOpenRouterKeyRateLimit({ data: {} }), null)
  })
})

describe('update restart coordination', () => {
  it('keeps Unix-like services alive long enough to self-update when restart is deferred', () => {
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'linux'), false)
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'darwin'), false)
  })

  it('still stops background instances for normal updates and Windows handoff', () => {
    assert.equal(shouldStopAutostartBeforeUpdate(false, 'linux'), true)
    assert.equal(shouldStopAutostartBeforeUpdate(true, 'win32'), true)
  })
})

describe('local update overrides', () => {
  it('detects local tarball updates and derives the version from the filename', () => {
    const tarballPath = join(ROOT, 'modelrelay-9.8.7.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ MODELRELAY_UPDATE_TARBALL: tarballPath, MODELRELAY_UPDATE_VERSION: null }, () => {
        assert.equal(getLocalUpdateTarballPath(), tarballPath)
        assert.equal(getLocalUpdateVersion(), '9.8.7')
        assert.equal(isRunningFromSource(), false)
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })

  it('prefers an explicit local update version override', () => {
    const tarballPath = join(ROOT, 'modelrelay-build-under-test.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ MODELRELAY_UPDATE_TARBALL: tarballPath, MODELRELAY_UPDATE_VERSION: '3.2.1' }, () => {
        assert.equal(getLocalUpdateVersion(), '3.2.1')
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })

  it('accepts a forced update version for simpler local upgrade testing', () => {
    withEnv({ MODELRELAY_FORCE_UPDATE_VERSION: '9.9.9' }, () => {
      assert.equal(getForcedUpdateVersion(), '9.9.9')
    })
  })

  it('ignores invalid forced update versions', () => {
    withEnv({ MODELRELAY_FORCE_UPDATE_VERSION: 'next-build' }, () => {
      assert.equal(getForcedUpdateVersion(), null)
    })
  })
})

describe('npm install invocation', () => {
  it('builds a shell-safe Windows npm command for local tarballs', () => {
    const tarballPath = join(ROOT, 'modelrelay-1.8.4.tgz')
    writeFileSync(tarballPath, 'placeholder', 'utf8')

    try {
      withEnv({ MODELRELAY_UPDATE_TARBALL: tarballPath }, () => {
        const invocation = buildNpmInstallInvocation('latest', 'win32')
        assert.equal(invocation.command, 'npm')
        assert.deepEqual(invocation.args, ['install', '-g', tarballPath])
        assert.equal(invocation.shell, true)
      })
    } finally {
      rmSync(tarballPath, { force: true })
    }
  })
})

describe('post-update restart command', () => {
  it('restarts the autostart target only when autostart is configured', () => {
    assert.equal(buildWindowsPostUpdateRestartCommand(true), 'timeout /t 2 /nobreak && modelrelay start --autostart')
    assert.equal(buildWindowsPostUpdateRestartCommand(false), 'timeout /t 2 /nobreak && modelrelay')
  })
})

describe('autostart', () => {
  it('resolves absolute executable path when available', () => {
    const binPath = join(ROOT, 'bin', 'modelrelay.js')
    assert.equal(resolveAutostartExecPath(binPath), binPath)
  })

  it('falls back to command name when path is missing', () => {
    assert.equal(resolveAutostartExecPath('/definitely/not/a/file/modelrelay'), 'modelrelay')
  })

  it('resolves node executable path when available', () => {
    assert.equal(resolveAutostartNodePath(process.execPath), process.execPath)
  })

  it('falls back to node command when node path is missing', () => {
    assert.equal(resolveAutostartNodePath('/definitely/not/a/file/node'), 'node')
  })
})

describe('onboard integrations', () => {
  it('builds OpenClaw provider config with required models array', () => {
    const provider = buildOpenClawProviderConfig(7352)

    assert.equal(provider.baseUrl, 'http://127.0.0.1:7352/v1')
    assert.equal(provider.api, 'openai-completions')
    assert.equal(provider.apiKey, 'no-key')
    assert.deepEqual(provider.models, [{ id: 'auto-fastest', name: 'Auto Fastest' }])
  })
})

describe('model grouping and filtering', () => {
  const results = [
    mockResult({ modelId: 'nvidia/glm4.7', label: 'GLM 4.7 (NVIDIA)' }),
    mockResult({ modelId: 'openrouter/glm4.7:free', label: 'GLM 4.7 (OpenRouter)' }),
    mockResult({ modelId: 'meta/llama3.3-70b', label: 'Llama 3.3 (Meta)' }),
  ]

  it('builds one catalog entry per normalized label group', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' }),
      mockResult({ modelId: 'openrouter/moonshotai/kimi-k2.5:free', label: 'Kimi K2.5' }),
      mockResult({ modelId: 'moonshotai/kimi-k2-thinking', label: 'Kimi K2 Thinking' }),
    ], canonicalizeModelId)

    assert.equal(groups.length, 2)
    const kimiGroup = groups.find(group => group.id === 'kimi-k2.5')
    assert.ok(kimiGroup)
    assert.equal(kimiGroup.label, 'Kimi K2.5')
    assert.equal(kimiGroup.models.length, 2)
    assert.ok(kimiGroup.aliases.includes('kimi k2.5'))
    assert.ok(kimiGroup.aliases.includes('moonshotai/kimi-k2.5'))
    assert.ok(kimiGroup.aliases.includes('kimi-k2.5'))
  })

  it('uses the canonical unprefixed model id for grouped entries', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'minimax/minimax-m2.5:free', label: 'MiniMax M2.5' }),
      mockResult({ modelId: 'vendor/minimax-m2.5', label: 'MiniMax M2.5' }),
    ], canonicalizeModelId)

    assert.equal(groups.length, 1)
    assert.equal(groups[0].id, 'minimax-m2.5')
  })

  it('groups MiMo Omni aliases under one model name', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'mimo-v2-omni-free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-omni:free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-pro:free', label: 'MiMo V2 Omni Pro' }),
    ], canonicalizeModelId)

    const omniGroup = groups.find(group => group.id === 'mimo-v2-omni')
    assert.ok(omniGroup)
    assert.equal(omniGroup.label, 'MiMo V2 Omni')
    assert.equal(omniGroup.models.length, 2)
    assert.ok(omniGroup.aliases.includes('mimo-v2-omni-free'))
    assert.ok(omniGroup.aliases.includes('xiaomi/mimo-v2-omni:free'))

    const proGroup = groups.find(group => group.id === 'mimo-v2-pro')
    assert.ok(proGroup)
    assert.equal(proGroup.label, 'MiMo V2 Omni Pro')
    assert.equal(proGroup.models.length, 1)
  })

  it('filters by exact model ID', () => {
    const filtered = filterModelsByRequested(results, 'nvidia/glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].modelId, 'nvidia/glm4.7')
  })

  it('filters by canonical base ID (removes :free)', () => {
    const filtered = filterModelsByRequested(results, 'openrouter/glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].modelId, 'openrouter/glm4.7:free')
  })

  it('filters by unprefixed canonical name (grouping)', () => {
    const filtered = filterModelsByRequested(results, 'glm4.7', canonicalizeModelId)
    assert.equal(filtered.length, 2)
    assert.ok(filtered.some(r => r.modelId === 'nvidia/glm4.7'))
    assert.ok(filtered.some(r => r.modelId === 'openrouter/glm4.7:free'))
  })

  it('filters by MiMo Omni alias name', () => {
    const filtered = filterModelsByRequested([
      mockResult({ modelId: 'mimo-v2-omni-free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-omni:free', label: 'MiMo V2 Omni' }),
      mockResult({ modelId: 'xiaomi/mimo-v2-pro:free', label: 'MiMo V2 Omni Pro' }),
    ], 'mimo-v2-omni', canonicalizeModelId)

    assert.equal(filtered.length, 2)
    assert.ok(filtered.some(r => r.modelId === 'mimo-v2-omni-free'))
    assert.ok(filtered.some(r => r.modelId === 'xiaomi/mimo-v2-omni:free'))
  })

  it('canonicalizes stacked model suffixes', () => {
    const canonical = canonicalizeModelId('x-ai/grok-code-fast-1:optimized:free')
    assert.equal(canonical.base, 'x-ai/grok-code-fast-1')
    assert.equal(canonical.unprefixed, 'grok-code-fast-1')
  })

  it('returns no models if no match is found', () => {
    const filtered = filterModelsByRequested(results, 'non-existent-model', canonicalizeModelId)
    assert.equal(filtered.length, 0)
  })

  it('returns all models for auto-fastest', () => {
    const filtered = filterModelsByRequested(results, 'auto-fastest', canonicalizeModelId)
    assert.equal(filtered.length, 3)
  })
})

describe('pinned model routing', () => {
  const results = [
    mockResult({ modelId: 'nvidia/glm4.7', label: 'GLM 4.7', providerKey: 'nvidia', pings: [{ ms: 90, code: '200' }], intell: 0.7 }),
    mockResult({ modelId: 'glm4.7', label: 'GLM 4.7', providerKey: 'vendor-a', pings: [{ ms: 120, code: '200' }], intell: 0.69 }),
    mockResult({ modelId: 'glm4.7', label: 'GLM 4.7', providerKey: 'vendor-b', pings: [{ ms: 150, code: '200' }], intell: 0.65 }),
    mockResult({ modelId: 'openrouter/glm4.7:free', label: 'GLM 4.7', providerKey: 'openrouter', pings: [{ ms: 140, code: '200' }], intell: 0.68 }),
  ]

  it('matches the full canonical group by default', () => {
    const matches = getPinnedModelMatches(results, 'nvidia/glm4.7', 'canonical')
    assert.deepEqual(matches.map(r => `${r.providerKey}:${r.modelId}`), [
      'nvidia:nvidia/glm4.7',
      'vendor-a:glm4.7',
      'vendor-b:glm4.7',
      'openrouter:openrouter/glm4.7:free',
    ])
  })

  it('matches only the exact row in exact mode', () => {
    const matches = getPinnedModelMatches(results, 'glm4.7', 'exact', 'vendor-a')
    assert.deepEqual(matches.map(r => `${r.providerKey}:${r.modelId}`), ['vendor-a:glm4.7'])
  })

  it('routes to the best eligible provider within a canonical pin group', () => {
    const candidate = getPinnedModelCandidate(results, 'nvidia/glm4.7', 'canonical')
    assert.equal(candidate?.modelId, 'nvidia/glm4.7')
  })
})

describe('package and entrypoint sanity', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const binContent = readFileSync(join(ROOT, 'bin/modelrelay.js'), 'utf8')

  it('package fields are valid', () => {
    assert.ok(pkg.name)
    assert.ok(pkg.version)
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
    assert.equal(pkg.type, 'module')
    assert.ok(pkg.bin.modelrelay)
    assert.ok(existsSync(join(ROOT, pkg.bin.modelrelay)))
  })

  it('CLI script has shebang and required imports', () => {
    assert.ok(binContent.startsWith('#!/usr/bin/env node'))
    assert.ok(binContent.includes("from '../lib/utils.js'"))
    assert.ok(binContent.includes("from '../lib/onboard.js'"))
  })
})

describe('multi-account round-robin', () => {
  describe('getApiKeyPool', () => {
    it('returns single-element array for string key', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.deepEqual(getApiKeyPool(config, 'nvidia'), ['nvapi-key1'])
    })

    it('returns array for array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2', 'key3'] } }
      assert.deepEqual(getApiKeyPool(config, 'kilocode'), ['key1', 'key2', 'key3'])
    })

    it('returns empty array for missing provider', () => {
      const config = { apiKeys: {} }
      assert.deepEqual(getApiKeyPool(config, 'nvidia'), [])
    })

    it('filters empty strings from array', () => {
      const config = { apiKeys: { groq: ['key1', '', '  ', 'key2'] } }
      assert.deepEqual(getApiKeyPool(config, 'groq'), ['key1', 'key2'])
    })

    it('trims whitespace from keys', () => {
      const config = { apiKeys: { groq: ['  key1  ', '  key2  '] } }
      assert.deepEqual(getApiKeyPool(config, 'groq'), ['key1', 'key2'])
    })

    it('env var overrides return single-element array', () => {
      withEnv({ NVIDIA_API_KEY: 'env-key' }, () => {
        const config = { apiKeys: { nvidia: ['file-key1', 'file-key2'] } }
        assert.deepEqual(getApiKeyPool(config, 'nvidia'), ['env-key'])
      })
    })

    it('ignores Qwen-specific env vars for the removed provider', () => {
      withEnv({ DASHSCOPE_API_KEY: 'dashscope-key' }, () => {
        assert.deepEqual(getApiKeyPool({ apiKeys: {} }, 'qwencode'), [])
      })
      withEnv({ QWEN_CODE_API_KEY: 'qwen-code-key' }, () => {
        assert.deepEqual(getApiKeyPool({ apiKeys: {} }, 'qwencode'), [])
      })
    })
  })

  describe('getApiKey backward compatibility', () => {
    it('returns first element for array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2', 'key3'] } }
      assert.equal(getApiKey(config, 'kilocode'), 'key1')
    })

    it('returns string for string keys', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.equal(getApiKey(config, 'nvidia'), 'nvapi-key1')
    })

    it('returns null for empty array', () => {
      const config = { apiKeys: { groq: [] } }
      assert.equal(getApiKey(config, 'groq'), null)
    })
  })

  describe('hasMultipleKeys', () => {
    it('returns true for multiple array keys', () => {
      const config = { apiKeys: { kilocode: ['key1', 'key2'] } }
      assert.equal(hasMultipleKeys(config, 'kilocode'), true)
    })

    it('returns false for single string key', () => {
      const config = { apiKeys: { nvidia: 'nvapi-key1' } }
      assert.equal(hasMultipleKeys(config, 'nvidia'), false)
    })

    it('returns false for single-element array', () => {
      const config = { apiKeys: { groq: ['key1'] } }
      assert.equal(hasMultipleKeys(config, 'groq'), false)
    })

    it('returns false for missing provider', () => {
      assert.equal(hasMultipleKeys({ apiKeys: {} }, 'nvidia'), false)
    })
  })

  describe('getMaxTurns', () => {
    it('returns configured value', () => {
      const config = { providers: { kilocode: { maxTurns: 20 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 20)
    })

    it('returns 0 when not configured', () => {
      assert.equal(getMaxTurns({ providers: {} }, 'kilocode'), 0)
      assert.equal(getMaxTurns({ providers: { kilocode: {} } }, 'kilocode'), 0)
    })

    it('returns 0 for invalid values', () => {
      const config = { providers: { kilocode: { maxTurns: -1 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 0)
      const config2 = { providers: { kilocode: { maxTurns: 'abc' } } }
      assert.equal(getMaxTurns(config2, 'kilocode'), 0)
    })

    it('floors fractional values', () => {
      const config = { providers: { kilocode: { maxTurns: 10.7 } } }
      assert.equal(getMaxTurns(config, 'kilocode'), 10)
    })
  })

  describe('normalizeConfigShape with arrays', () => {
    it('normalizes array apiKeys by trimming and filtering', () => {
      const config = {
        apiKeys: { kilocode: ['  key1  ', '', 'key2'] },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.deepEqual(normalized.apiKeys.kilocode, ['key1', 'key2'])
    })

    it('preserves string apiKeys unchanged', () => {
      const config = {
        apiKeys: { nvidia: '  nv-key  ' },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.equal(normalized.apiKeys.nvidia, 'nv-key')
    })

    it('handles mixed string and array apiKeys', () => {
      const config = {
        apiKeys: { nvidia: 'nv-key', kilocode: ['key1', 'key2'] },
        providers: {},
      }
      const normalized = normalizeConfigShape(config)
      assert.equal(normalized.apiKeys.nvidia, 'nv-key')
      assert.deepEqual(normalized.apiKeys.kilocode, ['key1', 'key2'])
    })

    it('round-trips through export/import with array keys', () => {
      const config = {
        apiKeys: { kilocode: ['key1', 'key2'], nvidia: 'nv-key' },
        providers: { kilocode: { enabled: true } },
      }
      const token = exportConfigToken(config)
      const imported = importConfigToken(token)
      assert.deepEqual(imported.apiKeys.kilocode, ['key1', 'key2'])
      assert.equal(imported.apiKeys.nvidia, 'nv-key')
    })
  })

  describe('getAccountStatus', () => {
    it('returns empty when pool state is not initialized', () => {
      const result = getAccountStatus({ apiKeys: { kilocode: ['k1', 'k2'] } })
      assert.deepEqual(result, { providers: {} })
    })
  })

  describe('selectNextApiKeyFromPool', () => {
    it('returns null when every key is still inside cooldown', () => {
      const now = 1_000_000
      const pool = ['key1', 'key2']
      const entry = {
        currentIdx: 0,
        accounts: new Map([
          [0, { requests: 1, rateLimitedAt: now - 10_000 }],
          [1, { requests: 1, rateLimitedAt: now - 20_000 }],
        ]),
      }

      const selected = selectNextApiKeyFromPool(pool, entry, 0, now, 60_000)

      assert.equal(selected, null)
      assert.equal(entry.currentIdx, 0)
      assert.equal(entry.accounts.get(0).requests, 1)
      assert.equal(entry.accounts.get(1).requests, 1)
    })

    it('resets counters when only maxTurns exhaustion blocks the pool', () => {
      const now = 1_000_000
      const pool = ['key1', 'key2']
      const entry = {
        currentIdx: 0,
        accounts: new Map([
          [0, { requests: 2, rateLimitedAt: 0 }],
          [1, { requests: 2, rateLimitedAt: 0 }],
        ]),
      }

      const selected = selectNextApiKeyFromPool(pool, entry, 2, now, 60_000)

      assert.equal(selected, 'key1')
      assert.equal(entry.currentIdx, 1)
      assert.equal(entry.accounts.get(0).requests, 1)
      assert.equal(entry.accounts.get(1).requests, 0)
    })
  })
})
