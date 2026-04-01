import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { sources, MODELS, canonicalizeModelId, getPreferredModelLabel } from '../sources.js'
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
  VERDICT_ORDER,
} from '../lib/utils.js'
import { buildOpenClawProviderConfig } from '../lib/onboard.js'
import { resolveAutostartExecPath, resolveAutostartNodePath } from '../lib/autostart.js'
import { exportConfigToken, getApiKey, getPinningMode, getProviderBaseUrl, getProviderModelId, getProviderPingIntervalMs, importConfigToken } from '../lib/config.js'
import { buildNpmInstallInvocation, buildWindowsPostUpdateRestartCommand, getForcedUpdateVersion, getLocalUpdateTarballPath, getLocalUpdateVersion, isRunningFromSource, shouldStopAutostartBeforeUpdate } from '../lib/update.js'
import { isQwenOauthAccessTokenValid, pollQwenOauthDeviceToken, resolveQwenCodeOauthAccessToken, startQwenOauthDeviceLogin } from '../lib/qwencodeAuth.js'
import { buildOpencodeHeaders, buildOpencodeProjectId, buildProviderRequestHeaders, getPinnedModelCandidate, getPinnedModelMatches, isProviderAuthOptional, isProviderBearerAuthEnabled, providerWantsBearerAuth, shouldRetryOptionalProviderWithBearer, toOpenCodeModelMeta, toOpenRouterModelMeta, toKiloCodeModelMeta } from '../lib/server.js'
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
        qwencode: { pingIntervalMinutes: '10' },
        openrouter: { pingIntervalMinutes: 0 }, // invalid
      }
    }

    assert.equal(getProviderPingIntervalMs(config, 'nvidia'), 5 * 60_000)
    assert.equal(getProviderPingIntervalMs(config, 'qwencode'), 10 * 60_000)
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
    const json = JSON.stringify({ apiKeys: { qwencode: 'abc' }, providers: {} })
    const plainBase64 = Buffer.from(json, 'utf8').toString('base64')
    const imported = importConfigToken(plainBase64)
    assert.equal(imported.apiKeys.qwencode, 'abc')
  })
})

describe('sources data integrity', () => {
  it('includes Qwen Code provider', () => {
    assert.ok(sources.qwencode)
    assert.equal(sources.qwencode.name, 'Qwen Code')
    assert.ok(Array.isArray(sources.qwencode.models))
    assert.ok(sources.qwencode.models.length > 0)
  })

  it('includes OpenAI-compatible provider', () => {
    assert.ok(sources['openai-compatible'])
    assert.equal(sources['openai-compatible'].name, 'OpenAI-Compatible')
    assert.ok(Array.isArray(sources['openai-compatible'].models))
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
  it('supports Qwen Code provider env var and DashScope fallback', () => {
    const originalQwen = process.env.QWEN_CODE_API_KEY
    const originalDashScope = process.env.DASHSCOPE_API_KEY

    try {
      delete process.env.QWEN_CODE_API_KEY
      delete process.env.DASHSCOPE_API_KEY
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), null)

      process.env.DASHSCOPE_API_KEY = 'dashscope-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), 'dashscope-key')

      process.env.QWEN_CODE_API_KEY = 'qwen-code-key'
      assert.equal(getApiKey({ apiKeys: {} }, 'qwencode'), 'qwen-code-key')
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

  it('treats OpenCode and KiloCode auth as optional bearer auth providers', () => {
    assert.equal(isProviderAuthOptional({}, 'opencode'), true)
    assert.equal(isProviderAuthOptional({}, 'kilocode'), true)
    assert.equal(isProviderAuthOptional({}, 'openrouter'), false)

    assert.equal(isProviderBearerAuthEnabled({}, 'opencode'), true)
    assert.equal(isProviderBearerAuthEnabled({}, 'kilocode'), true)
    assert.equal(isProviderBearerAuthEnabled({ providers: { opencode: { useBearerAuth: false } } }, 'opencode'), false)
    assert.equal(isProviderBearerAuthEnabled({ providers: { kilocode: { useBearerAuth: false } } }, 'kilocode'), false)

    assert.equal(providerWantsBearerAuth({}, 'opencode'), true)
    assert.equal(providerWantsBearerAuth({ providers: { opencode: { useBearerAuth: false } } }, 'opencode'), false)
    assert.equal(providerWantsBearerAuth({ providers: { kilocode: { useBearerAuth: false } } }, 'kilocode'), false)
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

  it('ignores OpenCode Zen models that are not chat-completions compatible', () => {
    assert.equal(toOpenCodeModelMeta({ id: 'gpt-5.4' }), null)
  })

  it('applies preferred MiMo display labels', () => {
    assert.equal(getPreferredModelLabel('mimo-v2-omni-free'), 'MiMo V2 Omni')
    assert.equal(getPreferredModelLabel('xiaomi/mimo-v2-omni:free'), 'MiMo V2 Omni')
    assert.equal(getPreferredModelLabel('xiaomi/mimo-v2-pro:free'), 'MiMo V2 Omni Pro')
    assert.equal(getPreferredModelLabel('x-ai/grok-code-fast-1:optimized:free'), 'Grok Code Fast')
    assert.equal(getPreferredModelLabel('minimax-m2.5-free', 'MiniMax M2.5 Free'), 'MiniMax M2.5')
    assert.equal(getPreferredModelLabel('nemotron-3-super-free', 'Nemotron 3 Super Free'), 'Nemotron 3 Super')
  })
})

describe('Qwen OAuth auth cycle', () => {
  it('starts Qwen OAuth device login with PKCE', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://chat.qwen.ai/api/v1/oauth2/device/code')
      assert.equal(options.method, 'POST')
      assert.equal(typeof options.body, 'string')
      assert.ok(options.body.includes('code_challenge='))
      return {
        ok: true,
        async json() {
          return {
            device_code: 'device-code',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://chat.qwen.ai/device',
            verification_uri_complete: 'https://chat.qwen.ai/device?code=ABCD-EFGH',
            expires_in: 600,
          }
        },
      }
    }

    try {
      const session = await startQwenOauthDeviceLogin()
      assert.equal(session.deviceCode, 'device-code')
      assert.equal(session.userCode, 'ABCD-EFGH')
      assert.equal(session.verificationUriComplete, 'https://chat.qwen.ai/device?code=ABCD-EFGH')
      assert.equal(typeof session.codeVerifier, 'string')
      assert.ok(session.codeVerifier.length > 20)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns pending for authorization_pending device polling', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      async json() {
        return { error: 'authorization_pending' }
      },
    })

    try {
      const result = await pollQwenOauthDeviceToken({ deviceCode: 'device-code', codeVerifier: 'code-verifier' })
      assert.equal(result.status, 'pending')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('accepts non-expired OAuth access tokens', () => {
    const now = Date.now()
    assert.equal(isQwenOauthAccessTokenValid({ access_token: 'token', expiry_date: now + 120_000 }, now), true)
    assert.equal(isQwenOauthAccessTokenValid({ access_token: 'token', expiry_date: now + 10_000 }, now), false)
  })

  it('refreshes Qwen OAuth token and writes updated credentials', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'modelrelay-qwen-oauth-'))
    const credsDir = join(tempDir, '.qwen')
    const credsPath = join(credsDir, 'oauth_creds.json')
    mkdirSync(credsDir, { recursive: true })
    writeFileSync(credsPath, JSON.stringify({
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expiry_date: Date.now() - 60_000,
    }, null, 2))

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://chat.qwen.ai/api/v1/oauth2/token')
      assert.equal(options.method, 'POST')
      assert.equal(typeof options.body, 'string')
      assert.ok(options.body.includes('grant_type=refresh_token'))
      return {
        ok: true,
        async json() {
          return {
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }
        },
      }
    }

    try {
      const token = await resolveQwenCodeOauthAccessToken({ credentialsPath: credsPath })
      assert.equal(token, 'new-access-token')

      const updated = JSON.parse(readFileSync(credsPath, 'utf8'))
      assert.equal(updated.access_token, 'new-access-token')
      assert.equal(updated.refresh_token, 'new-refresh-token')
      assert.equal(updated.token_type, 'Bearer')
      assert.equal(typeof updated.expiry_date, 'number')
      assert.ok(updated.expiry_date > Date.now())
    } finally {
      globalThis.fetch = originalFetch
      rmSync(tempDir, { recursive: true, force: true })
    }
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
