/**
 * @file lib/utils.js
 * @description Pure utility functions for scoring and CLI parsing.
 */

import { MODELS, cleanModelDisplayLabel, getPreferredModelLabel, resolveAliasedModelId } from '../sources.js'

export const VERDICT_ORDER = ['Perfect', 'Normal', 'Slow', 'Very Slow', 'Overloaded', 'Unstable', 'Not Active', 'Pending']

export const DEFAULT_PING_WINDOW_MS = 35 * 60 * 1000

const QOS_REFERENCE_INTELL = MODELS
  .map(m => Number(m[2]))
  .filter(v => Number.isFinite(v) && v > 0)

export const getAvg = (r, windowMs = DEFAULT_PING_WINDOW_MS) => {
  const now = Date.now()
  const successfulPings = (r.pings || [])
    .filter(p => p.code === '200' && (p.ts == null || now - p.ts <= windowMs))
  if (successfulPings.length === 0) return Infinity
  return Math.round(successfulPings.reduce((a, b) => a + b.ms, 0) / successfulPings.length)
}

export const getVerdict = (r) => {
  const avg = getAvg(r)
  const wasUpBefore = r.pings.length > 0 && r.pings.some(p => p.code === '200')

  if (r.httpCode === '429') return 'Overloaded'
  if ((r.status === 'timeout' || r.status === 'down') && wasUpBefore) return 'Unstable'
  if (r.status === 'timeout' || r.status === 'down') return 'Not Active'
  if (avg === Infinity) return 'Pending'
  if (avg < 400) return 'Perfect'
  if (avg < 1000) return 'Normal'
  if (avg < 3000) return 'Slow'
  if (avg < 5000) return 'Very Slow'
  if (avg < 10000) return 'Unstable'
  return 'Unstable'
}

export const getUptime = (r) => {
  if (r.pings.length === 0) return 0
  const successful = r.pings.filter(p => p.code === '200').length
  return Math.round((successful / r.pings.length) * 100)
}

export const sortResults = (results, sortColumn, sortDirection) => {
  return [...results].sort((a, b) => {
    let cmp = 0

    switch (sortColumn) {
      case 'rank':
        cmp = a.idx - b.idx
        break
      case 'model':
        cmp = (a.label || '').localeCompare(b.label || '')
        break
      case 'intell':
        cmp = (a.intell || 0) - (b.intell || 0)
        break
      case 'avg':
        cmp = getAvg(a) - getAvg(b)
        break
      case 'ctx': {
        const parseCtx = (ctx) => {
          if (!ctx || ctx === '—') return 0
          const str = ctx.toLowerCase()
          if (str.includes('m')) {
            const num = parseFloat(str.replace('m', ''))
            return num * 1000
          }
          if (str.includes('k')) {
            const num = parseFloat(str.replace('k', ''))
            return num
          }
          return 0
        }
        cmp = parseCtx(a.ctx) - parseCtx(b.ctx)
        break
      }
      case 'condition':
        cmp = a.status.localeCompare(b.status)
        break
      case 'verdict': {
        const aVerdict = getVerdict(a)
        const bVerdict = getVerdict(b)
        cmp = VERDICT_ORDER.indexOf(aVerdict) - VERDICT_ORDER.indexOf(bVerdict)
        break
      }
      case 'uptime':
        cmp = getUptime(a) - getUptime(b)
        break
    }

    return sortDirection === 'asc' ? cmp : -cmp
  })
}

function toValidPositiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function percentileRank(values, target) {
  const n = values.length
  if (n === 0 || target == null) return null
  if (n === 1) return 100

  let lt = 0
  let eq = 0
  for (const v of values) {
    if (v < target) lt += 1
    else if (v === target) eq += 1
  }

  const rank01 = (lt + (0.5 * eq)) / n
  return rank01 * 100
}

function availabilityMultiplierForUptime(uptime) {
  if (uptime >= 95) return 1.0
  if (uptime >= 85) return 0.9
  if (uptime >= 70) return 0.6
  return 0.2
}

function computeQoSFromNormalizedScores(r, normalizedScores) {
  if (r.status !== 'up') return 0
  const qualityScore = normalizedScores.gpqa != null ? normalizedScores.gpqa : 0

  const avg = getAvg(r)
  const ping = (avg === Infinity || avg === null) ? 1000 : avg
  const pingTieBreaker = Math.max(0, 1000 - ping) / 1_000

  const uptime = getUptime(r)
  const availabilityScore = qualityScore * availabilityMultiplierForUptime(uptime)
  return availabilityScore + pingTieBreaker
}

export function computeQoSMap(results, excludedModelIds = []) {
  const excluded = new Set(excludedModelIds)
  const eligible = results.filter(r => isModelEligibleForRouting(r) && !excluded.has(r.modelId))

  const qosMap = new Map()
  for (const r of eligible) {
    const intellNorm = percentileRank(QOS_REFERENCE_INTELL, toValidPositiveNumber(r.intell))
    const qos = computeQoSFromNormalizedScores(r, { gpqa: intellNorm })
    qosMap.set(r, qos)
  }

  return qosMap
}

export function computeQoS(r) {
  const qosMap = computeQoSMap([r])
  return qosMap.get(r) || 0
}

export function isModelEligibleForRouting(r) {
  return r.status !== 'banned' && r.status !== 'disabled' && r.status !== 'excluded'
}

export function rankModelsForRouting(results, excludedModelIds = []) {
  const excluded = new Set(excludedModelIds)
  const eligible = results.filter(r => isModelEligibleForRouting(r) && !excluded.has(r.modelId))
  const qosMap = computeQoSMap(results, excludedModelIds)
  const scored = eligible.map(r => ({ r, qos: qosMap.get(r) || 0 }))
  scored.sort((a, b) => b.qos - a.qos)
  return scored.map(s => s.r)
}

export function findBestModel(results) {
  const ranked = rankModelsForRouting(results)
  return ranked[0] || null
}

function ensureKeyPoolAccount(entry, idx) {
  if (!entry.accounts.has(idx)) {
    entry.accounts.set(idx, { requests: 0, rateLimitedAt: 0 })
  }
  return entry.accounts.get(idx)
}

export function selectNextApiKeyFromPool(pool, entry, maxTurns, now, cooldownMs) {
  if (!Array.isArray(pool) || pool.length === 0) return null
  if (!entry || !(entry.accounts instanceof Map)) return null

  const isRateLimited = idx => {
    const acct = entry.accounts.get(idx)
    return !!(acct && acct.rateLimitedAt && (now - acct.rateLimitedAt) < cooldownMs)
  }

  const trySelect = (respectMaxTurns) => {
    for (let attempt = 0; attempt < pool.length; attempt++) {
      const idx = entry.currentIdx % pool.length
      const acct = entry.accounts.get(idx)
      const keyRateLimited = isRateLimited(idx)
      const hitMaxTurns = respectMaxTurns && maxTurns > 0 && acct && acct.requests >= maxTurns

      if (!keyRateLimited && !hitMaxTurns) {
        const selectedAccount = ensureKeyPoolAccount(entry, idx)
        selectedAccount.requests++
        entry.currentIdx = (idx + 1) % pool.length
        return pool[idx]
      }

      entry.currentIdx = (idx + 1) % pool.length
    }

    return null
  }

  const selected = trySelect(true)
  if (selected) return selected

  const hasNonRateLimitedKey = pool.some((_, idx) => !isRateLimited(idx))
  if (!hasNonRateLimitedKey) return null

  for (const [, acct] of entry.accounts) {
    acct.requests = 0
  }
  entry.currentIdx = 0

  return trySelect(false)
}

function normalizeModelAlias(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function normalizeModelLabel(label) {
  if (typeof label !== 'string') return ''
  return cleanModelDisplayLabel(label)
    .replace(/\s+\([^)]*\)\s*$/g, '')
    .toLowerCase()
}

function toDisplayModelLabel(label, fallback) {
  if (typeof label === 'string' && label.trim()) {
    const cleaned = cleanModelDisplayLabel(label).replace(/\s+\([^)]*\)\s*$/g, '')
    if (cleaned) return cleaned
  }
  return fallback
}

function getModelGroupKey(r, canonicalizeFn) {
  const labelKey = normalizeModelLabel(r?.label)
  if (labelKey) return labelKey

  if (typeof canonicalizeFn === 'function') {
    const { unprefixed, base } = canonicalizeFn(r?.modelId || '')
    return normalizeModelAlias(unprefixed || base)
  }

  return normalizeModelAlias(r?.modelId || '')
}

function collectModelAliases(r, canonicalizeFn) {
  const aliases = new Set()
  const push = value => {
    const normalized = normalizeModelAlias(value)
    if (normalized) aliases.add(normalized)
  }

  push(r?.modelId)
  push(resolveAliasedModelId(r?.modelId))
  push(r?.label)
  push(getPreferredModelLabel(r?.modelId))
  if (typeof canonicalizeFn === 'function') {
    const { base, unprefixed } = canonicalizeFn(r?.modelId || '')
    push(base)
    push(unprefixed)
  }
  return aliases
}

function getModelGroupId(r, canonicalizeFn, displayLabel) {
  if (typeof canonicalizeFn === 'function') {
    const { unprefixed, base } = canonicalizeFn(r?.modelId || '')
    const canonicalId = normalizeModelAlias(unprefixed || base)
    if (canonicalId) return canonicalId
  }

  const labelBasedId = normalizeModelLabel(displayLabel).replace(/\s+/g, '-')
  return labelBasedId || normalizeModelAlias(r?.modelId || '')
}

export function buildModelGroups(results, canonicalizeFn) {
  const groups = new Map()

  for (const r of results) {
    const key = getModelGroupKey(r, canonicalizeFn)
    if (!key) continue

    if (!groups.has(key)) {
      const displayLabel = toDisplayModelLabel(r.label, r.modelId)
      const groupId = getModelGroupId(r, canonicalizeFn, displayLabel)
      groups.set(key, {
        id: groupId,
        label: displayLabel,
        aliases: new Set(),
        models: [],
      })
    }

    const group = groups.get(key)
    group.models.push(r)
    for (const alias of collectModelAliases(r, canonicalizeFn)) {
      group.aliases.add(alias)
    }
  }

  return Array.from(groups.values())
    .map(group => ({
      id: group.id,
      label: group.label,
      aliases: Array.from(group.aliases),
      models: group.models,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

export function filterModelsByRequested(results, requestedModel, canonicalizeFn) {
  if (!requestedModel || requestedModel === 'auto-fastest') return results

  const requested = normalizeModelAlias(requestedModel)
  const exactMatches = results.filter(r => normalizeModelAlias(r.modelId) === requested)
  if (exactMatches.length > 0) return exactMatches

  if (typeof canonicalizeFn === 'function') {
    const baseMatches = results.filter(r => {
      const { base } = canonicalizeFn(r.modelId)
      return normalizeModelAlias(base) === requested
    })
    if (baseMatches.length > 0) return baseMatches
  }

  const groups = buildModelGroups(results, canonicalizeFn)
  const matchedGroup = groups.find(group => group.aliases.includes(requested))
  return matchedGroup ? matchedGroup.models : []
}

export function isRetryableProxyStatus(status) {
  const code = Number(status)
  if (!Number.isInteger(code)) return false
  return code === 429 || code >= 500
}

export function parseArgs(argv) {
  const args = argv.slice(2)
  const firstCommandToken = args.find(a => !a.startsWith('--'))
  const command = firstCommandToken ? firstCommandToken.toLowerCase() : 'run'
  const hasOnboardToken = args.some(a => a.toLowerCase() === 'onboard' || a.toLowerCase() === '--onboard')
  const hasAutostartToken = args.some(a => a.toLowerCase() === 'autostart' || a.toLowerCase() === '--autostart')
  const showHelp = args.some(a => ['--help', '-h', 'help'].includes(a.toLowerCase()))

  const hasLogFlag = args.some(a => a.toLowerCase() === '--log')
  const hasNoLogFlag = args.some(a => a.toLowerCase() === '--no-log')
  const enableLog = hasLogFlag && !hasNoLogFlag

  const hasInstallFlag = args.some(a => a.toLowerCase() === '--install')
  const hasStartFlag = args.some(a => a.toLowerCase() === '--start')
  const hasUninstallFlag = args.some(a => a.toLowerCase() === '--uninstall')
  const hasStatusFlag = args.some(a => a.toLowerCase() === '--status')
  const hasEnableFlag = args.some(a => a.toLowerCase() === '--enable')
  const hasDisableFlag = args.some(a => a.toLowerCase() === '--disable')

  let autostartAction = null
  let autoUpdateAction = null
  if (command === 'install' && hasAutostartToken) autostartAction = 'install'
  if (command === 'start' && hasAutostartToken) autostartAction = 'start'
  if (command === 'uninstall' && hasAutostartToken) autostartAction = 'uninstall'
  if (command === 'status' && hasAutostartToken) autostartAction = 'status'

  if (command === 'autostart') {
    const positionalAction = args.find((a, idx) => idx > 0 && ['install', 'start', 'uninstall', 'status'].includes(a.toLowerCase()))
    if (hasInstallFlag || positionalAction?.toLowerCase() === 'install') autostartAction = 'install'
    else if (hasStartFlag || positionalAction?.toLowerCase() === 'start') autostartAction = 'start'
    else if (hasUninstallFlag || positionalAction?.toLowerCase() === 'uninstall') autostartAction = 'uninstall'
    else if (hasStatusFlag || positionalAction?.toLowerCase() === 'status') autostartAction = 'status'
    else autostartAction = 'status'
  }

  if (command === 'autoupdate') {
    if (hasEnableFlag) autoUpdateAction = 'enable'
    else if (hasDisableFlag) autoUpdateAction = 'disable'
    else if (hasStatusFlag) autoUpdateAction = 'status'
    else autoUpdateAction = 'status'
  }

  if (hasEnableFlag && command !== 'autoupdate') autoUpdateAction = 'enable'
  if (hasDisableFlag && command !== 'autoupdate') autoUpdateAction = 'disable'

  const portIdx = args.findIndex(a => a.toLowerCase() === '--port')
  const portValueIdx = (portIdx !== -1 && args[portIdx + 1] && !args[portIdx + 1].startsWith('--'))
    ? portIdx + 1
    : -1

  const banIdx = args.findIndex(a => a.toLowerCase() === '--ban')
  const banValueIdx = (banIdx !== -1 && args[banIdx + 1] && !args[banIdx + 1].startsWith('--'))
    ? banIdx + 1
    : -1

  const intervalIdx = args.findIndex(a => a.toLowerCase() === '--interval')
  const intervalValueIdx = (intervalIdx !== -1 && args[intervalIdx + 1] && !args[intervalIdx + 1].startsWith('--'))
    ? intervalIdx + 1
    : -1

  let bannedModels = []
  if (banValueIdx !== -1) {
    bannedModels = args[banValueIdx].split(',').map(s => s.trim()).filter(Boolean)
  }

  let portValue = 7352
  if (portValueIdx !== -1) {
    portValue = parseInt(args[portValueIdx], 10) || 7352
  }

  let autoUpdateIntervalHours = null
  if (intervalValueIdx !== -1) {
    const parsed = Number(args[intervalValueIdx])
    if (Number.isFinite(parsed) && parsed > 0) {
      autoUpdateIntervalHours = parsed
    }
  }

  let configAction = null
  let configPayload = null
  let configProvider = null
  let configKeys = null
  let configMaxTurns = null
  if (command === 'config') {
    const actionIdx = args.findIndex((a, idx) => idx > 0 && !a.startsWith('--'))
    const action = actionIdx !== -1 ? args[actionIdx].toLowerCase() : null
    if (action === 'export' || action === 'import') {
      configAction = action
    }
    if (configAction === 'import' && actionIdx !== -1) {
      const payload = args.slice(actionIdx + 1).join(' ').trim()
      if (payload) configPayload = payload
    }
    if (action === 'set-keys' || action === 'add-key' || action === 'remove-key') {
      configAction = action
      if (args.length > 2) {
        configProvider = args[2]
      }
      if (args.length > 3) {
        configKeys = args.slice(3).join(' ')
      }
    }
    if (action === 'set-maxturns') {
      configAction = action
      if (args.length > 2) {
        configProvider = args[2]
      }
      if (args.length > 3) {
        configMaxTurns = args[3]
      }
    }
  }

  return {
    command,
    autostartAction,
    autoUpdateAction,
    portValue,
    enableLog,
    bannedModels,
    autoUpdateIntervalHours,
    configAction,
    configPayload,
    configProvider,
    configKeys,
    configMaxTurns,
    autostart: hasAutostartToken,
    onboard: hasOnboardToken,
    help: showHelp,
  }
}

function parseNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseDateToMs(value) {
  if (!value) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000)
  }
  if (typeof value !== 'string') return null

  const asNum = parseNumber(value)
  if (asNum != null) {
    return asNum > 1e12 ? Math.round(asNum) : Math.round(asNum * 1000)
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseResetToAbsoluteMs(value) {
  if (value == null || value === '') return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e12) return Math.round(value)
    if (value >= 1e10) return Math.round(value * 1000)
    return Date.now() + Math.round(value * 1000)
  }

  if (typeof value === 'string') {
    const numeric = parseNumber(value)
    if (numeric != null) return parseResetToAbsoluteMs(numeric)
  }

  return parseDateToMs(value)
}

export function parseOpenRouterKeyRateLimit(payload) {
  const data = payload && typeof payload === 'object'
    ? (payload.data && typeof payload.data === 'object' ? payload.data : payload)
    : null
  if (!data) return null

  const rateLimit = {}

  const creditLimit = parseNumber(data.limit)
  if (creditLimit != null) rateLimit.creditLimit = creditLimit

  const creditRemaining = parseNumber(data.limit_remaining)
  if (creditRemaining != null) rateLimit.creditRemaining = creditRemaining

  const creditResetAt = parseDateToMs(data.limit_reset)
  if (creditResetAt != null) rateLimit.creditResetAt = creditResetAt

  const legacy = data.rate_limit && typeof data.rate_limit === 'object' ? data.rate_limit : null
  if (legacy) {
    const reqLimit = parseNumber(legacy.limit_requests ?? legacy.requests_limit ?? legacy.request_limit ?? legacy.limit)
    if (reqLimit != null) rateLimit.limitRequests = reqLimit

    const reqRemaining = parseNumber(legacy.remaining_requests ?? legacy.requests_remaining ?? legacy.request_remaining ?? legacy.remaining)
    if (reqRemaining != null) rateLimit.remainingRequests = reqRemaining

    const reqResetAt = parseResetToAbsoluteMs(legacy.reset_requests ?? legacy.requests_reset ?? legacy.reset)
    if (reqResetAt != null) rateLimit.resetRequestsAt = reqResetAt

    const tokLimit = parseNumber(legacy.limit_tokens ?? legacy.tokens_limit)
    if (tokLimit != null) rateLimit.limitTokens = tokLimit

    const tokRemaining = parseNumber(legacy.remaining_tokens ?? legacy.tokens_remaining)
    if (tokRemaining != null) rateLimit.remainingTokens = tokRemaining

    const tokResetAt = parseResetToAbsoluteMs(legacy.reset_tokens ?? legacy.tokens_reset)
    if (tokResetAt != null) rateLimit.resetTokensAt = tokResetAt
  }

  return Object.keys(rateLimit).length > 0 ? rateLimit : null
}
