import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { sources, MODELS, canonicalizeModelId, getPreferredModelContext, getPreferredModelLabel, getScore, resolveAliasedModelId } from '../sources.js'
import { TAG_VOCABULARY, MODEL_TAGS, getModelTags as getBuiltInModelTags } from '../tags.js'
import {
  getAvg,
  getVerdict,
  getUptime,
  sortResults,
  findBestModel,
  rankModelsForRouting,
  getRoutingModelKey,
  latencyScore,
  computeQoS,
  DEFAULT_QOS_LATENCY_TARGET_MS,
  buildModelGroups,
  filterModelsByRequested,
  isRetryableProxyStatus,
  computeFailedRefreshRetryAt,
  parseContextSize,
  parseArgs,
  parseOpenRouterKeyRateLimit,
  selectNextApiKeyFromPool,
  VERDICT_ORDER,
} from '../lib/utils.js'
import { buildOpenClawProviderConfig } from '../lib/onboard.js'
import { normalizeMissingScoreId } from '../lib/score-fetcher.js'
import { buildOpenRouterQualityIndex, fitLinearRegression, qualityLookupKeys, resolveModelQuality } from '../lib/model-quality.js'
import { getConfiguredTagNames, getModelTagKey, getModelTags as getUserModelTags, normalizeTag, normalizeTags, setModelTags } from '../lib/tags.js'
import { resolveAutostartExecPath, resolveAutostartNodePath } from '../lib/autostart.js'
import { exportConfigToken, getApiKey, getApiKeyPool, getMaxTurns, getPinningMode, getProviderBaseUrl, getProviderModelId, getProviderPingIntervalMs, hasMultipleKeys, importConfigToken, normalizeConfigShape, isOpenAICompatibleInstanceKey, getBaseProviderKey, getOpenAICompatibleInstanceId, buildOpenAICompatibleInstanceKey, listOpenAICompatibleEndpoints, upsertOpenAICompatibleEndpoint, removeOpenAICompatibleEndpoint } from '../lib/config.js'
import { buildNpmInstallInvocation, buildWindowsPostUpdateRestartCommand, getForcedUpdateVersion, getLocalUpdateTarballPath, getLocalUpdateVersion, isRunningFromSource, shouldStopAutostartBeforeUpdate } from '../lib/update.js'
import { buildKiroRequestPayload, buildKiroSocialLoginUrl, buildOpencodeHeaders, buildOpencodeProjectId, buildProviderRequestBody, buildProviderRequestHeaders, exchangeKiroSocialAuthFlow, exchangeKiroSocialCode, extractKiroEmailFromAccessToken, extractOllamaModelRecords, extractOpenAICompatibleModelRecords, buildOpenAICompatibleModelsListUrl, getAccountStatus, getKiroRefreshToken, hasKiroAuthConfigured, getPinnedModelCandidate, getPinnedModelMatches, isProviderAuthOptional, isProviderBearerAuthEnabled, parseKiroEventFrame, pollKiroBuilderIdToken, providerWantsBearerAuth, resolveKiroOAuthAccessToken, shouldRetryOptionalProviderWithBearer, startKiroBuilderIdDeviceAuth, startKiroSocialAuthFlow, toOllamaModelMeta, toOpenAICompatibleDiscoveredModelMeta, toOpenCodeModelMeta, toOpenRouterModelMeta, toKiloCodeModelMeta, transformKiroResponse } from '../lib/server.js'
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

const TEST_CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  TEST_CRC32_TABLE[i] = c >>> 0
}

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = TEST_CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function encodeKiroFrame(headers, payload) {
  const encoder = new TextEncoder()
  const encodedHeaders = Object.entries(headers).map(([name, value]) => ({
    nameBytes: encoder.encode(name),
    valueBytes: encoder.encode(String(value)),
  }))
  const headersLength = encodedHeaders.reduce((sum, header) => sum + 1 + header.nameBytes.length + 1 + 2 + header.valueBytes.length, 0)
  const payloadBytes = encoder.encode(payload == null ? '' : JSON.stringify(payload))
  const totalLength = 12 + headersLength + payloadBytes.length + 4
  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)

  view.setUint32(0, totalLength, false)
  view.setUint32(4, headersLength, false)
  view.setUint32(8, crc32(frame.slice(0, 8)), false)

  let offset = 12
  for (const { nameBytes, valueBytes } of encodedHeaders) {
    frame[offset] = nameBytes.length
    offset += 1
    frame.set(nameBytes, offset)
    offset += nameBytes.length
    frame[offset] = 7
    offset += 1
    frame[offset] = (valueBytes.length >> 8) & 0xff
    frame[offset + 1] = valueBytes.length & 0xff
    offset += 2
    frame.set(valueBytes, offset)
    offset += valueBytes.length
  }
  frame.set(payloadBytes, offset)

  view.setUint32(totalLength - 4, crc32(frame.slice(0, totalLength - 4)), false)
  return frame
}

function encodeKiroEventFrame(eventType, payload) {
  return encodeKiroFrame({ ':event-type': eventType }, payload)
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

  it('includes Kiro provider', () => {
    assert.ok(sources.kiro)
    assert.equal(sources.kiro.name, 'Kiro')
    assert.ok(Array.isArray(sources.kiro.models))
  })

  it('does not enable discovery for Codestral because its API has no models endpoint', () => {
    assert.equal(sources.codestral.discoverable, undefined)
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

  it('flat MODELS tuples include context provenance', () => {
    for (const model of MODELS) {
      assert.ok(Array.isArray(model))
      assert.equal(model.length, 7)
      assert.equal(typeof model[0], 'string')
      assert.equal(typeof model[1], 'string')
      assert.equal(typeof model[4], 'string')
      assert.equal(model[5], 'curated')
      assert.equal(typeof model[6], 'string')
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

describe('tags data integrity', () => {
  const knownModelIds = new Set(MODELS.map(([modelId]) => modelId))

  it('has no duplicate entries in TAG_VOCABULARY', () => {
    assert.equal(TAG_VOCABULARY.length, new Set(TAG_VOCABULARY).size)
  })

  it('only assigns tags that are in TAG_VOCABULARY', () => {
    for (const [modelId, tags] of Object.entries(MODEL_TAGS)) {
      for (const tag of tags) {
        assert.ok(TAG_VOCABULARY.includes(tag), `Unknown tag "${tag}" on ${modelId}`)
      }
    }
  })

  it('does not assign duplicate tags to the same model', () => {
    for (const [modelId, tags] of Object.entries(MODEL_TAGS)) {
      assert.equal(tags.length, new Set(tags).size, `Duplicate tag on ${modelId}`)
    }
  })

  it('only keys MODEL_TAGS by model IDs that exist in sources.js', () => {
    for (const modelId of Object.keys(MODEL_TAGS)) {
      assert.ok(knownModelIds.has(modelId), `MODEL_TAGS has a stale key: ${modelId}`)
    }
  })

  it('assigns at least one tag to every model in sources.js', () => {
    for (const modelId of knownModelIds) {
      assert.ok(getBuiltInModelTags(modelId).length > 0, `No tags assigned to ${modelId}`)
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

  it('resolves Kiro OAuth refresh token from env and config', () => {
    const original = process.env.KIRO_REFRESH_TOKEN

    try {
      delete process.env.KIRO_REFRESH_TOKEN
      assert.equal(getKiroRefreshToken({ providers: {} }), null)
      assert.equal(getKiroRefreshToken({ providers: { kiro: { refreshToken: 'config-refresh-token' } } }), 'config-refresh-token')

      process.env.KIRO_REFRESH_TOKEN = 'env-refresh-token'
      assert.equal(getKiroRefreshToken({ providers: { kiro: { refreshToken: 'config-refresh-token' } } }), 'env-refresh-token')
    } finally {
      if (original === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = original
    }
  })

  it('reports Kiro auth configured when OAuth refresh token is present', () => {
    assert.equal(hasKiroAuthConfigured({ providers: {} }), false)
    assert.equal(hasKiroAuthConfigured({ providers: { kiro: { refreshToken: 'rtok' } } }), true)
  })

  it('refreshes Kiro OAuth access tokens from the Kiro refresh endpoint', async () => {
    const originalRefreshToken = process.env.KIRO_REFRESH_TOKEN
    const originalClientId = process.env.KIRO_OAUTH_CLIENT_ID
    const originalClientSecret = process.env.KIRO_OAUTH_CLIENT_SECRET
    const originalFetch = globalThis.fetch
    const refreshToken = 'aorAAAAAG-test-refresh-token'

    process.env.KIRO_REFRESH_TOKEN = refreshToken
    delete process.env.KIRO_OAUTH_CLIENT_ID
    delete process.env.KIRO_OAUTH_CLIENT_SECRET

    let callCount = 0
    globalThis.fetch = async (url, init) => {
      callCount += 1
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.headers?.['Content-Type'], 'application/json')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.refreshToken, refreshToken)
      return new Response(JSON.stringify({
        accessToken: 'oauth-access-token',
        refreshToken,
        expiresIn: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenA = await resolveKiroOAuthAccessToken({ providers: {} })
      const tokenB = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenA, 'oauth-access-token')
      assert.equal(tokenB, 'oauth-access-token')
      assert.equal(callCount, 1)
    } finally {
      globalThis.fetch = originalFetch
      if (originalRefreshToken === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = originalRefreshToken
      if (originalClientId === undefined) delete process.env.KIRO_OAUTH_CLIENT_ID
      else process.env.KIRO_OAUTH_CLIENT_ID = originalClientId
      if (originalClientSecret === undefined) delete process.env.KIRO_OAUTH_CLIENT_SECRET
      else process.env.KIRO_OAUTH_CLIENT_SECRET = originalClientSecret
    }
  })

  it('uses rotated refresh token for subsequent cache-miss refreshes', async () => {
    const originalRefreshToken = process.env.KIRO_REFRESH_TOKEN
    const originalClientId = process.env.KIRO_OAUTH_CLIENT_ID
    const originalClientSecret = process.env.KIRO_OAUTH_CLIENT_SECRET
    const originalFetch = globalThis.fetch
    const initialToken = 'aorAAAAAG-initial-refresh-token'
    const rotatedToken = 'aorAAAAAG-rotated-refresh-token'

    process.env.KIRO_REFRESH_TOKEN = initialToken
    delete process.env.KIRO_OAUTH_CLIENT_ID
    delete process.env.KIRO_OAUTH_CLIENT_SECRET

    let callCount = 0
    const tokensReceived = []
    // expiresIn: 1 puts the expiry inside the 60-second skew window so the cache immediately misses on the next call
    globalThis.fetch = async (url, init) => {
      callCount += 1
      const body = JSON.parse(String(init?.body || '{}'))
      tokensReceived.push(body.refreshToken)
      return new Response(JSON.stringify({
        accessToken: `oauth-access-token-${callCount}`,
        refreshToken: rotatedToken,
        expiresIn: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      // First call: cache miss → fetch with initialToken → response includes rotatedToken
      const tokenA = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenA, 'oauth-access-token-1')
      assert.equal(tokensReceived[0], initialToken)
      assert.equal(callCount, 1)

      // Second call: cache is expired (expiresIn:1 < skew), but sourceRefreshToken matches
      // so effectiveRefreshToken should be the rotated token, not the original
      const tokenB = await resolveKiroOAuthAccessToken({ providers: {} })
      assert.equal(tokenB, 'oauth-access-token-2')
      assert.equal(tokensReceived[1], rotatedToken)
      assert.equal(callCount, 2)
    } finally {
      globalThis.fetch = originalFetch
      if (originalRefreshToken === undefined) delete process.env.KIRO_REFRESH_TOKEN
      else process.env.KIRO_REFRESH_TOKEN = originalRefreshToken
      if (originalClientId === undefined) delete process.env.KIRO_OAUTH_CLIENT_ID
      else process.env.KIRO_OAUTH_CLIENT_ID = originalClientId
      if (originalClientSecret === undefined) delete process.env.KIRO_OAUTH_CLIENT_SECRET
      else process.env.KIRO_OAUTH_CLIENT_SECRET = originalClientSecret
    }
  })

  it('builds Kiro browser OAuth URLs for Google and GitHub', () => {
    const googleUrl = new URL(buildKiroSocialLoginUrl('google', 'challenge-google', 'state-google'))
    assert.equal(`${googleUrl.origin}${googleUrl.pathname}`, 'https://prod.us-east-1.auth.desktop.kiro.dev/login')
    assert.equal(googleUrl.searchParams.get('idp'), 'Google')
    assert.equal(googleUrl.searchParams.get('code_challenge'), 'challenge-google')
    assert.equal(googleUrl.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(googleUrl.searchParams.get('state'), 'state-google')
    assert.equal(googleUrl.searchParams.get('redirect_uri'), 'kiro://kiro.kiroAgent/authenticate-success')

    const githubUrl = new URL(buildKiroSocialLoginUrl('github', 'challenge-github', 'state-github'))
    assert.equal(githubUrl.searchParams.get('idp'), 'Github')
  })

  it('exchanges Kiro browser OAuth codes for tokens', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token')
      assert.equal(init?.method, 'POST')
      assert.equal(init?.headers?.['Content-Type'], 'application/json')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.code, 'browser-code')
      assert.equal(body.code_verifier, 'browser-verifier')
      assert.equal(body.redirect_uri, 'kiro://kiro.kiroAgent/authenticate-success')
      return new Response(JSON.stringify({
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-browser-refresh',
        profileArn: 'arn:aws:builder-profile',
        expiresIn: 1800,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenData = await exchangeKiroSocialCode('browser-code', 'browser-verifier')
      assert.deepEqual(tokenData, {
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-browser-refresh',
        profileArn: 'arn:aws:builder-profile',
        expiresIn: 1800,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps Kiro browser OAuth PKCE verifier server-side during exchange', async () => {
    const flow = startKiroSocialAuthFlow('google')
    assert.match(flow.flowId, /^[0-9a-f-]{36}$/)
    assert.equal(flow.codeVerifier, undefined)
    assert.equal(flow.authUrl.includes('code_challenge='), true)
    const state = new URL(flow.authUrl).searchParams.get('state')

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.code, 'browser-code')
      assert.match(body.code_verifier, /^[A-Fa-f0-9]{64}$/)
      assert.notEqual(body.code_verifier, 'attacker-controlled-verifier')
      return new Response(JSON.stringify({
        accessToken: 'access.jwt.token',
        refreshToken: 'aorAAAAAG-flow-refresh',
        expiresIn: 1800,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const tokenData = await exchangeKiroSocialAuthFlow(flow.flowId, 'browser-code', state)
      assert.equal(tokenData.refreshToken, 'aorAAAAAG-flow-refresh')
      await assert.rejects(
        () => exchangeKiroSocialAuthFlow(flow.flowId, 'browser-code', state),
        /Unknown or expired Kiro browser OAuth flow/
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('extracts Kiro auth email from JWT access tokens when present', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'kiro@example.com' }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    const token = `header.${payload}.signature`
    assert.equal(extractKiroEmailFromAccessToken(token), 'kiro@example.com')
    assert.equal(extractKiroEmailFromAccessToken('not-a-jwt'), null)
  })

  it('starts Kiro AWS Builder ID device authorization', async () => {
    const originalFetch = globalThis.fetch
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url) === 'https://oidc.us-east-1.amazonaws.com/client/register') {
        return new Response(JSON.stringify({
          clientId: 'builder-client-id',
          clientSecret: 'builder-client-secret',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (String(url) === 'https://oidc.us-east-1.amazonaws.com/device_authorization') {
        const body = JSON.parse(String(init?.body || '{}'))
        assert.equal(body.clientId, 'builder-client-id')
        assert.equal(body.clientSecret, 'builder-client-secret')
        assert.equal(body.startUrl, 'https://view.awsapps.com/start')
        return new Response(JSON.stringify({
          deviceCode: 'device-code-123',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://device.sso.aws/verify',
          verificationUriComplete: 'https://device.sso.aws/verify?user_code=ABCD-EFGH',
          expiresIn: 600,
          interval: 5,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }

    try {
      const auth = await startKiroBuilderIdDeviceAuth()
      assert.deepEqual(auth, {
        clientId: 'builder-client-id',
        clientSecret: 'builder-client-secret',
        deviceCode: 'device-code-123',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://device.sso.aws/verify',
        verificationUriComplete: 'https://device.sso.aws/verify?user_code=ABCD-EFGH',
        expiresIn: 600,
        interval: 5,
      })
      assert.equal(calls.length, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('polls Kiro AWS Builder ID tokens and surfaces pending status', async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'authorization_pending',
      error_description: 'Still waiting for approval',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })

    try {
      const pending = await pollKiroBuilderIdToken('device-code-123', 'builder-client-id', 'builder-client-secret')
      assert.deepEqual(pending, {
        success: false,
        pending: true,
        error: 'authorization_pending',
        errorDescription: 'Still waiting for approval',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('polls Kiro AWS Builder ID tokens and returns refresh credentials on success', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://oidc.us-east-1.amazonaws.com/token')
      assert.equal(init?.method, 'POST')
      const body = JSON.parse(String(init?.body || '{}'))
      assert.equal(body.clientId, 'builder-client-id')
      assert.equal(body.clientSecret, 'builder-client-secret')
      assert.equal(body.deviceCode, 'device-code-123')
      assert.equal(body.grantType, 'urn:ietf:params:oauth:grant-type:device_code')
      return new Response(JSON.stringify({
        accessToken: 'builder-access-token',
        refreshToken: 'aorAAAAAG-builder-refresh',
        expiresIn: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    try {
      const result = await pollKiroBuilderIdToken('device-code-123', 'builder-client-id', 'builder-client-secret')
      assert.deepEqual(result, {
        success: true,
        tokens: {
          accessToken: 'builder-access-token',
          refreshToken: 'aorAAAAAG-builder-refresh',
          expiresIn: 3600,
          clientId: 'builder-client-id',
          clientSecret: 'builder-client-secret',
        },
      })
    } finally {
      globalThis.fetch = originalFetch
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

  it('adds Kiro SDK headers to provider requests', () => {
    const headers = buildProviderRequestHeaders('kiro', {
      apiKey: 'kiro-key',
    })

    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers.Accept, 'application/vnd.amazon.eventstream')
    assert.equal(headers.Authorization, 'Bearer kiro-key')
    assert.equal(headers['X-Amz-Target'], 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse')
    assert.equal(headers['User-Agent'], 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0')
    assert.equal(headers['X-Amz-User-Agent'], 'aws-sdk-js/3.0.0 kiro-ide/1.0.0')
  })

  it('translates OpenAI chat payloads into Kiro conversation state', () => {
    const payload = buildKiroRequestPayload({
      messages: [
        { role: 'system', content: 'Keep it short.' },
        { role: 'user', content: 'Say hi.' },
      ],
      max_tokens: 32,
      temperature: 0.4,
    }, 'claude-haiku-4.5')

    assert.equal(payload.conversationState.chatTriggerType, 'MANUAL')
    assert.equal(payload.conversationState.currentMessage.userInputMessage.modelId, 'claude-haiku-4.5')
    assert.equal(payload.conversationState.currentMessage.userInputMessage.origin, 'AI_EDITOR')
    assert.match(payload.conversationState.currentMessage.userInputMessage.content, /\[Context: Current time is .*]\n\nSay hi\./)
    assert.equal(payload.conversationState.history.length, 1)
    assert.equal(payload.conversationState.history[0].userInputMessage.content, 'Keep it short.')
    assert.equal(payload.inferenceConfig.maxTokens, 32)
    assert.equal(payload.inferenceConfig.temperature, 0.4)
  })

  it('routes provider request body translation through Kiro only', () => {
    const kiroBody = buildProviderRequestBody('kiro', {
      model: 'claude-haiku-4.5',
      messages: [{ role: 'user', content: 'Hello there' }],
    }, 'claude-haiku-4.5')

    assert.ok(kiroBody.conversationState)
    assert.equal(kiroBody.model, undefined)

    const passthrough = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] }
    assert.equal(buildProviderRequestBody('openrouter', passthrough, 'gpt-4o-mini'), passthrough)
  })

  it('parses Kiro AWS EventStream frames', () => {
    const frame = encodeKiroEventFrame('assistantResponseEvent', { content: 'hello' })
    const parsed = parseKiroEventFrame(frame)

    assert.equal(parsed.headers[':event-type'], 'assistantResponseEvent')
    assert.equal(parsed.payload.content, 'hello')
  })

  it('transforms Kiro EventStream responses into OpenAI JSON responses', async () => {
    const bytes = Buffer.concat([
      Buffer.from(encodeKiroEventFrame('assistantResponseEvent', { content: 'Hello' })),
      Buffer.from(encodeKiroEventFrame('assistantResponseEvent', { content: ' there' })),
      Buffer.from(encodeKiroEventFrame('metricsEvent', { inputTokens: 11, outputTokens: 3 })),
      Buffer.from(encodeKiroEventFrame('messageStopEvent', {})),
    ])
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(transformed.headers.get('content-type'), 'application/json')
    assert.equal(data.choices[0].message.role, 'assistant')
    assert.equal(data.choices[0].message.content, 'Hello there')
    assert.equal(data.usage.prompt_tokens, 11)
    assert.equal(data.usage.completion_tokens, 3)
  })

  it('transforms Kiro EventStream exception frames into OpenAI error responses', async () => {
    const bytes = Buffer.from(encodeKiroFrame({
      ':message-type': 'exception',
      ':exception-type': 'ThrottlingException',
    }, { message: 'Rate exceeded' }))
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(transformed.status, 502)
    assert.equal(data.error.message, 'Rate exceeded')
    assert.equal(data.error.type, 'kiro_error')
    assert.equal(data.error.code, 'ThrottlingException')
  })

  it('assembles Kiro streaming tool call input.raw fragments into complete arguments', async () => {
    // Kiro sends toolUseEvent multiple times for the same toolId:
    // first with {toolUseId, name} announcing the tool, then with {toolUseId, input: {raw: "fragment"}}
    // carrying partial JSON fragments that must be concatenated.
    const toolId = 'tool-use-id-123'
    const bytes = Buffer.concat([
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, name: 'exec', input: null })),
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, input: { raw: '{"command"' } })),
      Buffer.from(encodeKiroEventFrame('toolUseEvent', { toolUseId: toolId, input: { raw: ': "echo hi"}' } })),
      Buffer.from(encodeKiroEventFrame('metricsEvent', { inputTokens: 5, outputTokens: 2 })),
      Buffer.from(encodeKiroEventFrame('messageStopEvent', {})),
    ])
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    })

    const transformed = await transformKiroResponse(response, 'claude-haiku-4.5', false)
    const data = JSON.parse(await transformed.text())

    assert.equal(data.choices[0].finish_reason, 'tool_calls')
    assert.equal(data.choices[0].message.tool_calls.length, 1)
    const tc = data.choices[0].message.tool_calls[0]
    assert.equal(tc.id, toolId)
    assert.equal(tc.function.name, 'exec')
    assert.equal(tc.function.arguments, '{"command": "echo hi"}')
  })

  it('does not add Kiro SDK headers for non-Kiro providers', () => {
    const headers = buildProviderRequestHeaders('openrouter', {
      apiKey: 'openrouter-key',
    })

    assert.equal(headers['User-Agent'], undefined)
    assert.equal(headers['X-Amz-User-Agent'], undefined)
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

describe('user-defined model tags', () => {
  it('normalizes and deduplicates tag input', () => {
    assert.equal(normalizeTag(' Code Review! '), 'code-review')
    assert.deepEqual(normalizeTags(['Fast', 'fast', 'agentic']), ['fast', 'agentic'])
  })

  it('stores tags under the canonical model id shared by providers', () => {
    const config = {}
    const updated = setModelTags(config, 'minimax-m2.5-free', ['Coding', 'agentic'])
    assert.equal(updated.key, 'minimax/minimax-m2.5')
    assert.deepEqual(getUserModelTags(config, 'minimax/minimax-m2.5:free'), ['coding', 'agentic'])
    assert.deepEqual(getConfiguredTagNames(config), ['agentic', 'coding'])
    assert.equal(getModelTagKey('minimax-m2.5-free'), 'minimax/minimax-m2.5')
  })

  it('clears persisted entries when the last tag is removed', () => {
    const config = { modelTags: { 'openai/gpt-oss-120b': ['general'] } }
    setModelTags(config, 'openai/gpt-oss-120b:free', [])
    assert.deepEqual(config.modelTags, {})
  })

  it('routes tag requests across all matching provider rows', () => {
    const results = [
      mockResult({ modelId: 'one', tags: ['coding'] }),
      mockResult({ modelId: 'two', tags: ['fast', 'coding'] }),
      mockResult({ modelId: 'three', tags: ['reasoning'] }),
    ]
    assert.deepEqual(filterModelsByRequested(results, 'tag:coding').map(model => model.modelId), ['one', 'two'])
    assert.deepEqual(filterModelsByRequested(results, 'tag:missing'), [])
    assert.deepEqual(filterModelsByRequested(results, 'tag:'), [])
  })

  it('filters tag requests by a min_ctx modifier', () => {
    const results = [
      mockResult({ modelId: 'small', tags: ['general'], ctx: '8k' }),
      mockResult({ modelId: 'medium', tags: ['general'], ctx: '32k' }),
      mockResult({ modelId: 'large', tags: ['general'], ctx: '1m' }),
      mockResult({ modelId: 'maximum-only', tags: ['general'], ctx: '1m', ctxSource: 'model-maximum' }),
      mockResult({ modelId: 'no-ctx', tags: ['general'], ctx: null }),
      mockResult({ modelId: 'wrong-tag', tags: ['coding'], ctx: '1m' }),
    ]

    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:32000').map(m => m.modelId),
      ['medium', 'large'],
    )
    // Exact boundary: a 32k model satisfies a 32000-token floor.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:32001').map(m => m.modelId),
      ['large'],
    )
    // Shorthand k/m suffixes on the modifier value itself.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:1m').map(m => m.modelId),
      ['large'],
    )
    // No modifier -- unchanged plain tag behavior, unparseable/missing ctx included.
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general').map(m => m.modelId),
      ['small', 'medium', 'large', 'maximum-only', 'no-ctx'],
    )
  })

  it('ignores unknown or malformed tag modifiers instead of rejecting the request', () => {
    const results = [mockResult({ modelId: 'one', tags: ['general'], ctx: '128k' })]
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+unknown_modifier:whatever').map(m => m.modelId),
      ['one'],
    )
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+min_ctx:not-a-number').map(m => m.modelId),
      ['one'],
    )
    assert.deepEqual(
      filterModelsByRequested(results, 'tag:general+').map(m => m.modelId),
      ['one'],
    )
  })

  it('filters auto-fastest by min_ctx regardless of capability tags (issue #42)', () => {
    const results = [
      mockResult({ modelId: 'small', tags: ['general'], ctx: '8k' }),
      mockResult({ modelId: 'medium', tags: ['coding'], ctx: '128k' }),
      mockResult({ modelId: 'large', ctx: '1m' }), // no tags at all -- still eligible
    ]

    assert.deepEqual(
      filterModelsByRequested(results, 'auto-fastest+min_ctx:128k').map(m => m.modelId),
      ['medium', 'large'],
    )
    // Plain auto-fastest is untouched -- still returns everything, unfiltered.
    assert.deepEqual(
      filterModelsByRequested(results, 'auto-fastest').map(m => m.modelId),
      ['small', 'medium', 'large'],
    )
    // A malformed/unknown modifier falls back to plain auto-fastest behavior.
    assert.deepEqual(
      filterModelsByRequested(results, 'auto-fastest+bogus:xyz').map(m => m.modelId),
      ['small', 'medium', 'large'],
    )
  })

  it('normalizes persisted model tags safely', () => {
    const normalized = normalizeConfigShape({
      modelTags: {
        ' Model/One ': [' Fast ', 'fast', 'Code Review!', null],
        broken: 'not-an-array',
      },
    })
    assert.deepEqual(normalized.modelTags, { 'model/one': ['fast', 'code-review'] })
  })
})

describe('OpenRouter model quality scoring', () => {
  const catalog = [
    {
      id: 'vendor/direct-model',
      created: 1_750_000_000,
      context_length: 131072,
      supported_parameters: ['reasoning', 'tools', 'structured_outputs'],
      benchmarks: {
        artificial_analysis: { coding_index: 72 },
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1300 }],
      },
    },
    {
      id: 'vendor/training-model',
      benchmarks: {
        artificial_analysis: { coding_index: 52 },
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1100 }],
      },
    },
    {
      id: 'vendor/arena-only:free',
      benchmarks: {
        design_arena: [{ arena: 'models', category: 'codecategories', elo: 1200 }],
      },
    },
    {
      id: 'vendor/metadata-only:free',
      created: 1_750_000_000,
      context_length: 262144,
      supported_parameters: ['reasoning', 'tools'],
    },
  ]

  it('normalizes provider and runtime variants for cross-catalog matching', () => {
    assert.ok(qualityLookupKeys('deepseek-v4-flash:0731').includes('deepseek-v4-flash-0731'))
    assert.ok(qualityLookupKeys('inclusionai/ling-3.0-flash:free').includes('ling-3.0-flash'))
  })

  it('fits a deterministic linear regression for Design Arena conversion', () => {
    assert.deepEqual(fitLinearRegression([[1000, 40], [1200, 60]]), {
      slope: 0.1,
      intercept: -60,
      sampleSize: 2,
    })
  })

  it('uses coding index, Design Arena, then metadata in that order', () => {
    const quality = buildOpenRouterQualityIndex(catalog, [...catalog].reverse(), 1_760_000_000_000)
    const direct = resolveModelQuality(quality, 'vendor/direct-model', 0.99)
    const arena = resolveModelQuality(quality, 'arena-only-free', 0.99)
    const metadata = resolveModelQuality(quality, 'vendor/metadata-only:free', 0.99)

    assert.equal(direct.score, 0.72)
    assert.equal(direct.source, 'artificial-analysis')
    assert.equal(direct.isEstimated, false)
    assert.equal(arena.score, 0.62)
    assert.equal(arena.source, 'design-arena')
    assert.equal(metadata.source, 'metadata')
    assert.ok(metadata.score >= 0.35 && metadata.score <= 0.65)
  })

  it('labels local and blind defaults when no catalog match exists', () => {
    const quality = buildOpenRouterQualityIndex(catalog)
    assert.equal(resolveModelQuality(quality, 'unknown/local', 0.61).source, 'local-fallback')
    assert.equal(resolveModelQuality(quality, 'unknown/blind').score, 0.45)
    assert.equal(resolveModelQuality(quality, 'unknown/blind').source, 'default-fallback')
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
    assert.equal(getScore('nemotron-3-super'), 0.377)
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
    assert.equal(getScore('google/gemma-4-26b-a4b-it:free'), 0.393)
    assert.equal(getScore('google/gemma-4-31b-it:free'), 0.8)
    assert.equal(getScore('kimi-k2.6'), 0.802)
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

  it('does not apply another provider context to Ollama discovery', () => {
    const model = toOllamaModelMeta({
      name: 'kimi-k2.6',
      model: 'kimi-k2.6',
    })

    assert.ok(model)
    assert.equal(model.label, 'Kimi K2.6')
    assert.equal(model.intell, 0.802)
    assert.equal(model.isEstimatedScore, false)
    assert.equal(model.ctx, null)
    assert.equal(model.ctxSource, null)
  })

  it('uses the allocated Ollama context before the model maximum', () => {
    const model = toOllamaModelMeta({
      name: 'gemma3',
      model: 'gemma3',
      _running: { context_length: 4096 },
      _show: { model_info: { 'gemma3.context_length': 131072 } },
    })

    assert.equal(model.ctx, '4096')
    assert.equal(model.ctxSource, 'runtime-allocated')
  })

  it('labels an unallocated Ollama model limit as a model maximum', () => {
    const model = toOllamaModelMeta({
      name: 'gemma3',
      model: 'gemma3',
      _show: { model_info: { 'gemma3.context_length': 131072 } },
    })

    assert.equal(model.ctx, '131072')
    assert.equal(model.ctxSource, 'model-maximum')
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

  it('uses researched score entries for newly discovered OpenRouter free coding models', () => {
    const cases = [
      ['baidu/cobuddy:free', 0.715],
      ['deepseek-v4-flash-free', 0.521],
      ['inclusionai/ring-2.6-1t:free', 0.727],
      ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 0.138],
      ['poolside/laguna-m.1:free', 0.725],
      ['poolside/laguna-xs.2:free', 0.682],
      ['ring-2.6-1t-free', 0.727],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('uses verified scores for the latest free coding models across providers', () => {
    const cases = [
      ['tencent/hy3:free', 0.78],
      ['hy3-free', 0.78],
      ['poolside/laguna-xs-2.1:free', 0.592],
      ['cohere/north-mini-code:free', 0.365],
      ['north-mini-code-free', 0.365],
      ['nvidia/nemotron-3-ultra-550b-a55b:free', 0.493],
      ['nemotron-3-ultra-free', 0.493],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('resolves every coding model reported by the refresh-scores audit', () => {
    const cases = [
      ['glm-5.2', 0.688],
      ['z-ai/glm-5.2', 0.688],
      ['kimi-k2.7-code', 0.62],
      ['moonshotai/kimi-k2.7-code', 0.62],
      ['mimo-v2.5-free', 0.568],
      ['minimax-m3', 0.586],
      ['minimaxai/minimax-m3', 0.586],
      ['nemotron-3-ultra', 0.493],
      ['stepfun/step-3.7-flash:free', 0.396],
      ['stepfun-ai/step-3.7-flash', 0.396],
    ]

    for (const [modelId, expectedScore] of cases) {
      assert.equal(getScore(modelId), expectedScore)
    }
  })

  it('keeps offline fallbacks for the newest discovered free models', () => {
    const cases = [
      ['deepseek-v4-flash:0731', 0.691],
      ['kimi-k3', 0.762],
      ['inclusionai/ling-3.0-flash:free', 0.608],
      ['ling-3.0-flash-free', 0.608],
      ['poolside/laguna-s-2.1:free', 0.625],
      ['laguna-s-2.1-free', 0.625],
    ]
    for (const [modelId, expectedScore] of cases) assert.equal(getScore(modelId), expectedScore)
  })

  it('includes newly available NIM coding models in the static catalog', () => {
    const nvidiaModelIds = new Set(sources.nvidia.models.map(([modelId]) => modelId))
    const expected = [
      'z-ai/glm-5.2',
      'moonshotai/kimi-k2.7-code',
      'minimaxai/minimax-m3',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'stepfun-ai/step-3.7-flash',
    ]

    for (const modelId of expected) {
      assert.equal(nvidiaModelIds.has(modelId), true, `Missing NIM model: ${modelId}`)
    }
  })

  it('ignores safety-only dynamic models that should not be routed as coding models', () => {
    assert.equal(toKiloCodeModelMeta({ id: 'meta-llama/llama-guard-4-12b:free' }), null)
    assert.equal(toOpenRouterModelMeta({ id: 'meta-llama/llama-guard-4-12b:free' }), null)
    assert.equal(toKiloCodeModelMeta({ id: 'nvidia/nemotron-3.5-content-safety:free' }), null)
    assert.equal(toOpenRouterModelMeta({ id: 'nvidia/nemotron-3.5-content-safety:free' }), null)
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

  it('does not copy Ling 2.6 context metadata between providers', () => {
    assert.equal(resolveAliasedModelId('ling-2.6-flash-free'), 'inclusionai/ling-2.6-flash')
    assert.equal(resolveAliasedModelId('inclusionai/ling-2.6-flash:free'), 'inclusionai/ling-2.6-flash')
    assert.equal(getScore('ling-2.6-flash-free'), 0.771)
    assert.equal(getScore('inclusionai/ling-2.6-flash:free'), 0.771)
    assert.equal(getPreferredModelContext('ling-2.6-flash-free'), '262k')

    const model = toOpenCodeModelMeta({ id: 'ling-2.6-flash-free' })

    assert.ok(model)
    assert.equal(model.label, 'Ling 2.6 Flash')
    assert.equal(model.ctx, null)
    assert.equal(model.ctxSource, null)
    assert.equal(model.intell, 0.771)
    assert.equal(model.isEstimatedScore, false)

    const openRouterModel = toOpenRouterModelMeta({
      id: 'inclusionai/ling-2.6-flash:free',
      name: 'inclusionAI: Ling-2.6-flash (free)',
      context_length: 262144,
    })

    assert.ok(openRouterModel)
    assert.equal(openRouterModel.intell, 0.771)
    assert.equal(openRouterModel.ctx, '262144')
    assert.equal(openRouterModel.ctxSource, 'provider-reported')
    assert.equal(openRouterModel.isEstimatedScore, false)
  })

  it('deduplicates missing score audit entries by canonical model id', () => {
    assert.equal(normalizeMissingScoreId('ling-2.6-flash-free'), 'inclusionai/ling-2.6-flash')
    assert.equal(normalizeMissingScoreId('inclusionai/ling-2.6-flash:free'), 'inclusionai/ling-2.6-flash')
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

describe('latencyScore', () => {
  it('returns 1 at zero latency and 0.5 exactly at the target', () => {
    assert.equal(latencyScore(0, 1000), 1)
    assert.equal(latencyScore(1000, 1000), 0.5)
  })

  it('decays continuously and never saturates to zero', () => {
    const at1s = latencyScore(1_000, 1000)
    const at10s = latencyScore(10_000, 1000)
    const at250s = latencyScore(250_000, 1000)
    assert.ok(at1s > at10s)
    assert.ok(at10s > at250s)
    assert.ok(at250s > 0)
  })

  it('treats missing ping data (Infinity/null avg) as the neutral midpoint', () => {
    assert.equal(latencyScore(Infinity, 1000), 0.5)
    assert.equal(latencyScore(null, 1000), 0.5)
  })

  it('defaults to DEFAULT_QOS_LATENCY_TARGET_MS when no target is given', () => {
    assert.equal(latencyScore(DEFAULT_QOS_LATENCY_TARGET_MS), 0.5)
  })
})

describe('QoS latency weighting (regression: nvidia/z-ai/glm-5.2 sat at a 200-290s avg for ~24h while still ranking near the top by quality score alone)', () => {
  it('a catastrophically slow but high-quality model no longer beats a fast, lower-quality one', () => {
    const catastrophicallySlow = mockResult({
      label: 'HighQualitySlow',
      intell: 0.9,
      pings: [{ ms: 250_000, code: '200' }, { ms: 240_000, code: '200' }],
    })
    const fastButLowerQuality = mockResult({
      label: 'FastLowerQuality',
      intell: 0.3,
      pings: [{ ms: 1_500, code: '200' }, { ms: 1_600, code: '200' }],
    })

    const ranked = rankModelsForRouting([catastrophicallySlow, fastButLowerQuality])
    assert.equal(ranked[0].label, 'FastLowerQuality')
  })

  it('still prefers the higher-quality model when both are reasonably fast', () => {
    const higherQuality = mockResult({ label: 'HigherQuality', intell: 0.9, pings: [{ ms: 1_200, code: '200' }] })
    const lowerQuality = mockResult({ label: 'LowerQuality', intell: 0.3, pings: [{ ms: 900, code: '200' }] })

    const ranked = rankModelsForRouting([higherQuality, lowerQuality])
    assert.equal(ranked[0].label, 'HigherQuality')
  })

  it('a stuck-slow model still scores above zero -- a last resort, not fully excluded', () => {
    const stuckSlow = mockResult({ label: 'StuckSlow', intell: 0.9, pings: [{ ms: 291_194, code: '200' }] })
    assert.ok(computeQoS(stuckSlow) > 0)
  })

  it('is tunable via latencyTargetMs for deployments with different latency expectations', () => {
    const model = mockResult({ intell: 0.5, pings: [{ ms: 5_000, code: '200' }] })
    const strict = computeQoS(model, 500)
    const lenient = computeQoS(model, 10_000)
    assert.ok(lenient > strict)
  })
})

describe('isRetryableProxyStatus', () => {
  it('returns true for 429 and 5xx', () => {
    assert.equal(isRetryableProxyStatus(429), true)
    assert.equal(isRetryableProxyStatus('500'), true)
    assert.equal(isRetryableProxyStatus(503), true)
  })

  it('returns true for 410 (model retired/gone upstream)', () => {
    assert.equal(isRetryableProxyStatus(410), true)
    assert.equal(isRetryableProxyStatus('410'), true)
  })

  it('returns false for non-retryable statuses', () => {
    assert.equal(isRetryableProxyStatus(200), false)
    assert.equal(isRetryableProxyStatus(400), false)
    assert.equal(isRetryableProxyStatus(404), false)
    assert.equal(isRetryableProxyStatus('not-a-status'), false)
  })
})

describe('computeFailedRefreshRetryAt', () => {
  it('allows a retry after retryBackoffMs instead of the full refresh TTL', () => {
    const now = 1_000_000_000
    const refreshIntervalMs = 60 * 60_000 // 1 hour, e.g. OpenCode Zen's TTL
    const retryBackoffMs = 2 * 60_000 // 2 minutes
    const stampedAt = computeFailedRefreshRetryAt(now, refreshIntervalMs, retryBackoffMs)

    // Immediately after the failure, the TTL guard (`now - stampedAt < refreshIntervalMs`)
    // must still say "not yet" -- otherwise every failure would retry on every ping cycle.
    assert.equal((now - stampedAt) < refreshIntervalMs, true)
    assert.ok((now - stampedAt) >= refreshIntervalMs - retryBackoffMs)

    // retryBackoffMs later, the TTL guard must allow a retry.
    const afterBackoff = now + retryBackoffMs
    assert.equal((afterBackoff - stampedAt) >= refreshIntervalMs, true)

    // Just before retryBackoffMs elapses, it must still be blocked.
    const justBefore = now + retryBackoffMs - 1
    assert.equal((justBefore - stampedAt) >= refreshIntervalMs, false)
  })

  it('never returns a timestamp in the future relative to a fresh success stamp', () => {
    const now = Date.now()
    const stampedAt = computeFailedRefreshRetryAt(now, 30 * 60_000, 2 * 60_000)
    assert.ok(stampedAt < now)
  })
})

describe('parseContextSize', () => {
  it('parses k and m suffixes into raw token counts', () => {
    assert.equal(parseContextSize('128k'), 128_000)
    assert.equal(parseContextSize('1m'), 1_000_000)
    assert.equal(parseContextSize('1M'), 1_000_000)
    assert.equal(parseContextSize('10M'), 10_000_000)
    assert.equal(parseContextSize('0.5m'), 500_000)
  })

  it('parses plain numbers, string or numeric', () => {
    assert.equal(parseContextSize('32000'), 32_000)
    assert.equal(parseContextSize(32000), 32_000)
  })

  it('returns null for unparseable, empty, or negative input', () => {
    assert.equal(parseContextSize(null), null)
    assert.equal(parseContextSize(undefined), null)
    assert.equal(parseContextSize(''), null)
    assert.equal(parseContextSize('—'), null)
    assert.equal(parseContextSize('not-a-number'), null)
    assert.equal(parseContextSize(-5), null)
    assert.equal(parseContextSize('-5'), null)
    assert.equal(parseContextSize('-5k'), null)
    assert.equal(parseContextSize('128garbage'), null)
    assert.equal(parseContextSize('1.2.3m'), null)
    assert.equal(parseContextSize(0), null)
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

  it('keeps duplicate raw model ids from different providers addressable', () => {
    const groups = buildModelGroups([
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local' }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote' }),
    ], canonicalizeModelId)

    assert.deepEqual(groups.map(group => group.id).sort(), [
      'openai-compatible:local/llama-3.1',
      'openai-compatible:remote/llama-3.1',
    ])
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

  it('filters duplicate raw model ids by endpoint-qualified group id', () => {
    const duplicateResults = [
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local' }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote' }),
    ]

    const filtered = filterModelsByRequested(duplicateResults, 'openai-compatible:remote/llama-3.1', canonicalizeModelId)

    assert.deepEqual(filtered.map(r => r.providerKey), ['openai-compatible:remote'])
  })
})

describe('model tag routing', () => {
  // moonshotai/kimi-k2.7-code -> ['coding'], qwen-qwq-32b -> ['reasoning'], z-ai/glm5 -> ['agentic', 'coding', 'general']
  const taggedResults = [
    mockResult({ modelId: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' }),
    mockResult({ modelId: 'qwen-qwq-32b', label: 'QwQ 32B' }),
    mockResult({ modelId: 'z-ai/glm5', label: 'GLM 5' }),
  ]

  it('routes tag: requests to models carrying that tag', () => {
    const filtered = filterModelsByRequested(taggedResults, 'tag:reasoning', canonicalizeModelId)
    assert.deepEqual(filtered.map(r => r.modelId), ['qwen-qwq-32b'])
  })

  it('matches a model tagged with multiple tags under each of its tags', () => {
    const codingMatches = filterModelsByRequested(taggedResults, 'tag:coding', canonicalizeModelId)
    assert.ok(codingMatches.some(r => r.modelId === 'moonshotai/kimi-k2.7-code'))
    assert.ok(codingMatches.some(r => r.modelId === 'z-ai/glm5'))

    const agenticMatches = filterModelsByRequested(taggedResults, 'tag:agentic', canonicalizeModelId)
    assert.deepEqual(agenticMatches.map(r => r.modelId), ['z-ai/glm5'])
  })

  it('is case-insensitive for tag names', () => {
    const filtered = filterModelsByRequested(taggedResults, 'TAG:Reasoning', canonicalizeModelId)
    assert.deepEqual(filtered.map(r => r.modelId), ['qwen-qwq-32b'])
  })

  it('returns no models for an unknown tag', () => {
    const filtered = filterModelsByRequested(taggedResults, 'tag:nonexistent', canonicalizeModelId)
    assert.equal(filtered.length, 0)
  })

  it('returns no models when no result carries the requested tag', () => {
    const filtered = filterModelsByRequested([mockResult({ modelId: 'moonshotai/kimi-k2.7-code' })], 'tag:reasoning', canonicalizeModelId)
    assert.equal(filtered.length, 0)
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

  it('can retry another provider with the same raw model id', () => {
    const duplicateResults = [
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:local', pings: [{ ms: 90, code: '200' }], intell: 10 }),
      mockResult({ modelId: 'llama-3.1', label: 'Llama 3.1', providerKey: 'openai-compatible:remote', pings: [{ ms: 100, code: '200' }], intell: 10 }),
    ]
    const first = rankModelsForRouting(duplicateResults)[0]
    const second = rankModelsForRouting(duplicateResults, [getRoutingModelKey(first)])[0]

    assert.equal(first.providerKey, 'openai-compatible:local')
    assert.equal(second.providerKey, 'openai-compatible:remote')
  })
})

describe('package and entrypoint sanity', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const binContent = readFileSync(join(ROOT, 'bin/modelrelay.js'), 'utf8')
  const dashboardContent = readFileSync(join(ROOT, 'public/index.html'), 'utf8')

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

  it('labels dashboard scores by the current coding-quality source', () => {
    assert.ok(dashboardContent.includes('>Coding <i class="sort-arrow"'))
    assert.ok(dashboardContent.includes('Artificial Analysis coding index'))
    assert.ok(dashboardContent.includes('Design Arena estimate'))
    assert.ok(dashboardContent.includes('Metadata estimate'))
    assert.equal(dashboardContent.includes('>SWE% <i class="sort-arrow"'), false)
    assert.equal(dashboardContent.includes('>SWE-bench</div>'), false)
  })

  it('includes the model tag editor and tag-routing guidance', () => {
    assert.ok(dashboardContent.includes('id="model-tags-input"'))
    assert.ok(dashboardContent.includes("fetch('/api/models/tags'"))
    assert.ok(dashboardContent.includes('Use <code>tag:name</code>'))
  })

  it('formats exact context sizes for display without changing routing data', () => {
    assert.match(dashboardContent, /function formatContextDisplay\(value\)/)
    assert.match(dashboardContent, /Math\.round\(tokens \/ 1_000\).*K/)
    assert.match(dashboardContent, /formatContextDisplay\(m\.ctx\)/)
  })

  it('includes working provider key reveal and copy controls', () => {
    assert.ok(dashboardContent.includes('toggleProviderKeyVisibility'))
    assert.ok(dashboardContent.includes('getConfiguredProviderKey'))
    assert.ok(dashboardContent.includes('copyProviderKey'))
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

describe('OpenAI-compatible multi-instance support', () => {
  it('detects instance keys and extracts ids', () => {
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible:default'), true)
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible:my-vllm'), true)
    assert.equal(isOpenAICompatibleInstanceKey('openai-compatible'), false)
    assert.equal(isOpenAICompatibleInstanceKey('groq'), false)

    assert.equal(getOpenAICompatibleInstanceId('openai-compatible:my-vllm'), 'my-vllm')
    assert.equal(getOpenAICompatibleInstanceId('groq'), null)

    assert.equal(getBaseProviderKey('openai-compatible:my-vllm'), 'openai-compatible')
    assert.equal(getBaseProviderKey('groq'), 'groq')
  })

  it('builds instance keys from human-friendly names', () => {
    assert.equal(buildOpenAICompatibleInstanceKey('My vLLM '), 'openai-compatible:my-vllm')
    assert.equal(buildOpenAICompatibleInstanceKey('Foo Bar 123'), 'openai-compatible:foo-bar-123')
    assert.equal(buildOpenAICompatibleInstanceKey(''), null)
    assert.equal(buildOpenAICompatibleInstanceKey('!!!'), null)
  })

  it('normalizeConfigShape migrates a legacy bare-key config to :default', () => {
    const legacy = {
      apiKeys: { 'openai-compatible': 'sk-legacy' },
      providers: { 'openai-compatible': { enabled: true, baseUrl: 'https://legacy.example/v1', modelId: 'old/model' } },
    }
    const normalized = normalizeConfigShape(legacy)
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
    assert.equal(normalized.apiKeys['openai-compatible:default'], 'sk-legacy')
    assert.deepEqual(normalized.providers['openai-compatible:default'], {
      enabled: true,
      baseUrl: 'https://legacy.example/v1',
      modelId: 'old/model',
      name: 'Default',
    })
  })

  it('normalizeConfigShape leaves a config without legacy entries alone', () => {
    const cfg = {
      apiKeys: { 'openai-compatible:my-vllm': 'sk-vllm' },
      providers: { 'openai-compatible:my-vllm': { name: 'vLLM', baseUrl: 'http://localhost:8000/v1', modelId: 'qwen' } },
    }
    const normalized = normalizeConfigShape(cfg)
    assert.equal(normalized.apiKeys['openai-compatible:my-vllm'], 'sk-vllm')
    assert.equal(normalized.providers['openai-compatible:my-vllm'].baseUrl, 'http://localhost:8000/v1')
    // The bare entry should not be (re)created.
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
  })

  it('normalizeConfigShape does not clobber an existing :default instance', () => {
    const legacy = {
      apiKeys: {
        'openai-compatible': 'sk-legacy',
        'openai-compatible:default': 'sk-already-here',
      },
      providers: {
        'openai-compatible': { baseUrl: 'https://legacy.example/v1' },
        'openai-compatible:default': { name: 'Pre-existing', baseUrl: 'https://default.example/v1', modelId: 'm' },
      },
    }
    const normalized = normalizeConfigShape(legacy)
    assert.equal(normalized.apiKeys['openai-compatible:default'], 'sk-already-here')
    assert.equal(normalized.providers['openai-compatible:default'].name, 'Pre-existing')
    assert.equal(normalized.apiKeys['openai-compatible'], undefined)
    assert.equal(normalized.providers['openai-compatible'], undefined)
  })

  it('legacy OPENAI_COMPATIBLE_* env vars feed the :default instance', () => {
    const originalKey = process.env.OPENAI_COMPATIBLE_API_KEY
    const originalBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL
    const originalModel = process.env.OPENAI_COMPATIBLE_MODEL

    try {
      process.env.OPENAI_COMPATIBLE_API_KEY = 'env-key'
      process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://env.example/v1'
      process.env.OPENAI_COMPATIBLE_MODEL = 'env/model'

      const config = { apiKeys: {}, providers: {} }
      assert.equal(getApiKey(config, 'openai-compatible:default'), 'env-key')
      assert.equal(getProviderBaseUrl(config, 'openai-compatible:default'), 'https://env.example/v1')
      assert.equal(getProviderModelId(config, 'openai-compatible:default'), 'env/model')

      // Env vars should NOT apply to a non-default instance.
      assert.equal(getApiKey(config, 'openai-compatible:other'), null)
      assert.equal(getProviderBaseUrl(config, 'openai-compatible:other'), null)
    } finally {
      if (originalKey == null) delete process.env.OPENAI_COMPATIBLE_API_KEY
      else process.env.OPENAI_COMPATIBLE_API_KEY = originalKey
      if (originalBaseUrl == null) delete process.env.OPENAI_COMPATIBLE_BASE_URL
      else process.env.OPENAI_COMPATIBLE_BASE_URL = originalBaseUrl
      if (originalModel == null) delete process.env.OPENAI_COMPATIBLE_MODEL
      else process.env.OPENAI_COMPATIBLE_MODEL = originalModel
    }
  })

  it('listOpenAICompatibleEndpoints returns instances in stable insertion order', () => {
    const config = normalizeConfigShape({
      apiKeys: {
        'openai-compatible:alpha': 'sk-a',
        'openai-compatible:beta': 'sk-b',
      },
      providers: {
        'openai-compatible:alpha': { name: 'Alpha', baseUrl: 'https://a/v1', modelId: 'a-model' },
        'openai-compatible:beta':  { name: 'Beta',  baseUrl: 'https://b/v1', modelId: 'b-model', enabled: false },
      },
    })

    const list = listOpenAICompatibleEndpoints(config)
    assert.equal(list.length, 2)
    assert.equal(list[0].instanceKey, 'openai-compatible:alpha')
    assert.equal(list[0].id, 'alpha')
    assert.equal(list[0].name, 'Alpha')
    assert.equal(list[0].baseUrl, 'https://a/v1')
    assert.equal(list[0].modelId, 'a-model')
    assert.equal(list[0].apiKey, 'sk-a')
    assert.equal(list[0].enabled, true)

    assert.equal(list[1].instanceKey, 'openai-compatible:beta')
    assert.equal(list[1].enabled, false)
  })

  it('upsertOpenAICompatibleEndpoint and remove round-trip cleanly', () => {
    const config = { apiKeys: {}, providers: {} }
    const key1 = upsertOpenAICompatibleEndpoint(config, { id: 'one', name: 'One', baseUrl: 'https://one/v1', modelId: 'm1', apiKey: 'sk-1' })
    assert.equal(key1, 'openai-compatible:one')
    assert.equal(config.apiKeys[key1], 'sk-1')
    assert.equal(config.providers[key1].baseUrl, 'https://one/v1')
    assert.equal(config.providers[key1].name, 'One')

    // Update preserves untouched fields.
    upsertOpenAICompatibleEndpoint(config, { instanceKey: key1, modelId: 'm1-new' })
    assert.equal(config.providers[key1].baseUrl, 'https://one/v1')
    assert.equal(config.providers[key1].modelId, 'm1-new')

    const removed = removeOpenAICompatibleEndpoint(config, key1)
    assert.equal(removed, true)
    assert.equal(config.apiKeys[key1], undefined)
    assert.equal(config.providers[key1], undefined)

    // Removing again is a no-op.
    assert.equal(removeOpenAICompatibleEndpoint(config, key1), false)
    // Refusing to remove a non-instance key.
    assert.equal(removeOpenAICompatibleEndpoint(config, 'groq'), false)
  })

  it('upsertOpenAICompatibleEndpoint persists discoverModels=false explicitly', () => {
    const config = { apiKeys: {}, providers: {} }
    upsertOpenAICompatibleEndpoint(config, { id: 'one', name: 'One', baseUrl: 'http://h/v1' })
    assert.equal(config.providers['openai-compatible:one'].discoverModels, undefined)

    upsertOpenAICompatibleEndpoint(config, { instanceKey: 'openai-compatible:one', discoverModels: false })
    assert.equal(config.providers['openai-compatible:one'].discoverModels, false)

    upsertOpenAICompatibleEndpoint(config, { instanceKey: 'openai-compatible:one', discoverModels: true })
    assert.equal('discoverModels' in config.providers['openai-compatible:one'], false)
  })

  it('config export/import preserves multi-instance shape', () => {
    const original = normalizeConfigShape({
      apiKeys: {
        'openai-compatible:alpha': 'sk-a',
        'openai-compatible:beta': 'sk-b',
      },
      providers: {
        'openai-compatible:alpha': { name: 'Alpha', baseUrl: 'https://a/v1', modelId: 'a-model' },
        'openai-compatible:beta':  { name: 'Beta',  baseUrl: 'https://b/v1', modelId: 'b-model' },
      },
    })

    const token = exportConfigToken(original)
    const reimported = importConfigToken(token)

    assert.equal(reimported.apiKeys['openai-compatible:alpha'], 'sk-a')
    assert.equal(reimported.apiKeys['openai-compatible:beta'], 'sk-b')
    assert.equal(reimported.providers['openai-compatible:alpha'].name, 'Alpha')
    assert.equal(reimported.providers['openai-compatible:beta'].modelId, 'b-model')
  })
})

describe('OpenAI-compatible model discovery', () => {
  it('builds the /v1/models URL from a variety of base URLs', () => {
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://api.example.com/v1/models'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'), 'https://generativelanguage.googleapis.com/v1beta/openai/models')
    assert.equal(buildOpenAICompatibleModelsListUrl('api.example.com/v1'), 'https://api.example.com/v1/models')
    assert.equal(buildOpenAICompatibleModelsListUrl(''), null)
    assert.equal(buildOpenAICompatibleModelsListUrl(null), null)
  })

  it('extracts records from common payload shapes', () => {
    assert.deepEqual(extractOpenAICompatibleModelRecords({ data: [{ id: 'a' }, { id: 'b' }] }), [{ id: 'a' }, { id: 'b' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords({ models: [{ id: 'a' }] }), [{ id: 'a' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords([{ id: 'a' }]), [{ id: 'a' }])
    assert.deepEqual(extractOpenAICompatibleModelRecords({}), [])
    assert.deepEqual(extractOpenAICompatibleModelRecords(null), [])
  })

  it('converts a discovered record to a model-meta tagged with the instance key', () => {
    const meta = toOpenAICompatibleDiscoveredModelMeta(
      { id: 'qwen2.5-coder:7b', context_length: 32768, name: 'Qwen2.5 Coder 7B' },
      'openai-compatible:my-vllm',
      'https://host/v1/chat/completions',
    )
    assert.ok(meta)
    assert.equal(meta.modelId, 'qwen2.5-coder:7b')
    assert.equal(meta.label, 'Qwen2.5 Coder 7B')
    assert.equal(meta.providerKey, 'openai-compatible:my-vllm')
    assert.equal(meta.providerUrl, 'https://host/v1/chat/completions')
    assert.equal(meta.ctx, '32768')
    assert.equal(meta.ctxSource, 'provider-reported')
  })

  it('falls back to a synthesized label when the record has none', () => {
    const meta = toOpenAICompatibleDiscoveredModelMeta({ id: 'some_unknown-model' }, 'openai-compatible:x')
    assert.ok(meta)
    assert.equal(meta.modelId, 'some_unknown-model')
    assert.equal(meta.label, 'Some Unknown Model')
    assert.equal(meta.isEstimatedScore, true)
  })

  it('rejects records without a usable id', () => {
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({}, 'openai-compatible:x'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: '   ' }, 'openai-compatible:x'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta('', 'openai-compatible:x'), null)
  })

  it('filters non-chat models from discovered provider catalogs', () => {
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: 'nvidia/nemotron-content-safety' }, 'nvidia'), null)
    assert.equal(toOpenAICompatibleDiscoveredModelMeta({ id: 'text-embedding-3-large' }, 'nvidia'), null)
    assert.ok(toOpenAICompatibleDiscoveredModelMeta({ id: 'qwen/qwen3-coder' }, 'nvidia'))
  })
})
