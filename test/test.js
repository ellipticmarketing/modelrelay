import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sources, MODELS } from '../sources.js'
import {
  getAvg,
  getVerdict,
  getUptime,
  sortResults,
  findBestModel,
  rankModelsForRouting,
  isRetryableProxyStatus,
  parseArgs,
  parseOpenRouterKeyRateLimit,
  VERDICT_ORDER,
} from '../lib/utils.js'
import { buildOpenClawProviderConfig } from '../lib/onboard.js'
import { resolveAutostartExecPath, resolveAutostartNodePath } from '../lib/autostart.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function mockResult(overrides = {}) {
  return {
    idx: 1,
    modelId: 'test/model',
    label: 'Test Model',
    providerKey: 'nvidia',
    intell: 10,
    coding: 10,
    termbench: 0.1,
    ctx: '128k',
    status: 'up',
    pings: [],
    httpCode: null,
    ...overrides,
  }
}

describe('sources data integrity', () => {
  it('has expected provider structure', () => {
    for (const [providerKey, provider] of Object.entries(sources)) {
      assert.equal(typeof providerKey, 'string')
      assert.equal(typeof provider.name, 'string')
      assert.equal(typeof provider.url, 'string')
      assert.ok(Array.isArray(provider.models))
    }
  })

  it('provider model tuples have 6 fields', () => {
    for (const provider of Object.values(sources)) {
      for (const model of provider.models) {
        assert.ok(Array.isArray(model))
        assert.equal(model.length, 6)
        assert.equal(typeof model[0], 'string')
        assert.equal(typeof model[1], 'string')
      }
    }
  })

  it('flat MODELS tuples have 7 fields', () => {
    for (const model of MODELS) {
      assert.ok(Array.isArray(model))
      assert.equal(model.length, 7)
      assert.equal(typeof model[0], 'string')
      assert.equal(typeof model[1], 'string')
      assert.equal(typeof model[6], 'string')
    }
  })

  it('flat MODELS count matches sources sum', () => {
    const sum = Object.values(sources).reduce((acc, provider) => acc + provider.models.length, 0)
    assert.equal(MODELS.length, sum)
  })

  it('has no duplicate provider/model IDs', () => {
    const seen = new Set()
    for (const [modelId, , , , , , providerKey] of MODELS) {
      const key = `${providerKey}/${modelId}`
      assert.equal(seen.has(key), false, `Duplicate model key found: ${key}`)
      seen.add(key)
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
    assert.equal(provider.api, 'openai')
    assert.equal(provider.apiKey, 'no-key')
    assert.deepEqual(provider.models, [{ id: 'auto-fastest', name: 'Auto Fastest' }])
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
