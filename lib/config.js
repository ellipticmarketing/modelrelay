/**
 * @file lib/config.js
 * @description JSON config management for modelrelay multi-provider support.
 *
 * 📖 This module manages ~/.modelrelay.json, the config file that
 *    stores API keys and per-provider enabled/disabled state for all providers
 *    (NVIDIA NIM, Groq, Cerebras, etc.).
 *
 * 📖 Config file location: ~/.modelrelay.json
 * 📖 File permissions: 0o600 (user read/write only — contains API keys)
 *
 * 📖 Config JSON structure:
 *   {
 *     "apiKeys": {
 *       "nvidia":     "nvapi-xxx",
 *       "groq":       "gsk_xxx",
 *       "cerebras":   "csk_xxx",
 *       "openrouter": "sk-or-xxx",
 *       "codestral":  "csk-xxx",
 *       "scaleway":   "scw-xxx",
 *       "googleai":   "AIza..."
 *     },
 *     "providers": {
 *       "nvidia":     { "enabled": true },
 *       "groq":       { "enabled": true },
 *       "cerebras":   { "enabled": true },
 *       "openrouter": { "enabled": true },
 *       "codestral":  { "enabled": true },
 *       "scaleway":   { "enabled": true },
 *       "googleai":   { "enabled": true }
 *     }
 *   }
 *
 * 📖 Multi-account round-robin:
 *   apiKeys values can be string | string[].
 *   Array = multiple accounts, rotated per-request with max-turns + 429 backoff.
 *
 * @functions
 *   → loadConfig() — Read ~/.modelrelay.json
 *   → saveConfig(config) — Write config to ~/.modelrelay.json with 0o600 permissions
 *   → getApiKey(config, providerKey) — Get first API key (backward-compatible)
 *   → getApiKeyPool(config, providerKey) — Get all API keys as array
 *   → hasMultipleKeys(config, providerKey) — Whether provider has multiple accounts
 *
 * @exports loadConfig, saveConfig, getApiKey, getApiKeyPool, hasMultipleKeys
 * @exports CONFIG_PATH — path to the JSON config file
 *
 * @see bin/modelrelay.js — main CLI that uses these functions
 * @see sources.js — provider keys come from Object.keys(sources)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// 📖 Primary JSON config path — stores all providers' API keys + enabled state
export const CONFIG_PATH = join(homedir(), '.modelrelay.json')
const CONFIG_TRANSFER_PREFIX = 'mrconf:v1:'

// 📖 Environment variable names per provider
// 📖 These allow users to override config via env vars (useful for CI/headless setups)
const ENV_VARS = {
  nvidia: 'NVIDIA_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  codestral: 'CODESTRAL_API_KEY',
  scaleway: 'SCALEWAY_API_KEY',
  googleai: 'GOOGLE_API_KEY',
  kilocode: 'KILOCODE_API_KEY',
}

const PROVIDER_BASE_URL_ENV_VARS = {
  'openai-compatible': 'OPENAI_COMPATIBLE_BASE_URL',
  ollama: 'OLLAMA_BASE_URL',
}

const PROVIDER_MODEL_ID_ENV_VARS = {
  'openai-compatible': 'OPENAI_COMPATIBLE_MODEL',
  ollama: 'OLLAMA_MODEL',
}

function normalizeSecret(value) {
  return typeof value === 'string'
    ? value.replace(/[\s\u2580-\u259F]+$/g, '').trim()
    : ''
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 📖 loadConfig: Read the JSON config from disk.
 *
 * 📖 Fallback chain:
 *   1. Try to read ~/.modelrelay.json
 *   2. If missing or invalid, return an empty default config
 *
 * @returns {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, bannedModels: string[], autoUpdate: { enabled: boolean, intervalHours: number, lastCheckAt: string|null, lastUpdateAt: string|null, lastVersionApplied: string|null, lastError: string|null }, minSweScore: number|null, excludedProviders: string[] }}
 */
export function loadConfig() {
  const current = _readConfigFile(CONFIG_PATH)
  if (current) return current

  return _emptyConfig()
}

/**
 * 📖 saveConfig: Write the config object to ~/.modelrelay.json.
 *
 * 📖 Uses mode 0o600 so the file is only readable by the owning user (API keys!).
 * 📖 Pretty-prints JSON for human readability.
 *
 * @param {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}> }} config
 */
export function saveConfig(config) {
  try {
    const normalized = normalizeConfigShape(config)
    writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), { mode: 0o600 })
  } catch {
    // 📖 Silently fail — the app is still usable, keys just won't persist
  }
}

export function exportConfigToken(config) {
  const normalized = normalizeConfigShape(config)
  const json = JSON.stringify(normalized)
  const encoded = Buffer.from(json, 'utf8').toString('base64url')
  return `${CONFIG_TRANSFER_PREFIX}${encoded}`
}

export function importConfigToken(token) {
  const raw = typeof token === 'string' ? token.trim() : ''
  if (!raw) throw new Error('Config token is empty.')

  let parsed = null

  if (raw.startsWith('{')) {
    parsed = JSON.parse(raw)
  } else if (raw.startsWith(CONFIG_TRANSFER_PREFIX)) {
    const encoded = raw.slice(CONFIG_TRANSFER_PREFIX.length)
    if (!encoded) throw new Error('Config token payload is missing.')
    const json = Buffer.from(encoded, 'base64url').toString('utf8')
    parsed = JSON.parse(json)
  } else {
    // Backward-compatible import path for plain base64 payloads.
    const json = Buffer.from(raw, 'base64').toString('utf8')
    parsed = JSON.parse(json)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config payload must be a JSON object.')
  }

  return normalizeConfigShape(parsed)
}

/**
 * 📖 getApiKey: Get the effective API key for a provider.
 *
 * 📖 Priority order (first non-empty wins):
 *   1. Environment variable (e.g. NVIDIA_API_KEY) — for CI/headless
 *   2. Config file value — from ~/.modelrelay.json
 *   3. null — no key configured
 *
 * @param {{ apiKeys: Record<string,string> }} config
 * @param {string} providerKey — e.g. 'nvidia', 'groq', 'cerebras'
 * @returns {string|null}
 */
export function getApiKey(config, providerKey) {
  // 📖 Env var override — takes precedence over everything
  const envVar = ENV_VARS[providerKey]
  if (envVar && process.env[envVar]) {
    return normalizeSecret(process.env[envVar]);
  }
  // 📖 Config file value (string or array — return first element)
  const key = config?.apiKeys?.[providerKey]
  if (Array.isArray(key)) return normalizeSecret(key[0]) || null
  if (key) return normalizeSecret(key)
  return null
}

/**
 * 📖 getApiKeyPool: Get all configured API keys for a provider.
 * Returns an array of keys. Env var override returns single-element array.
 * @param {object} config
 * @param {string} providerKey
 * @returns {string[]}
 */
export function getApiKeyPool(config, providerKey) {
  const envVar = ENV_VARS[providerKey]
  if (envVar && process.env[envVar]) {
    const k = normalizeSecret(process.env[envVar])
    return k ? [k] : []
  }
  const raw = config?.apiKeys?.[providerKey]
  if (Array.isArray(raw)) return raw.map(normalizeSecret).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) return [normalizeSecret(raw)]
  return []
}

/**
 * 📖 hasMultipleKeys: Check if a provider has multiple API key accounts.
 * @param {object} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function hasMultipleKeys(config, providerKey) {
  return getApiKeyPool(config, providerKey).length > 1
}

/**
 * 📖 getMaxTurns: Get the per-account max-turns threshold for a provider.
 * When an account reaches this many requests, rotate to the next one
 * (proactive switching before hitting rate limits).
 * @param {object} config
 * @param {string} providerKey
 * @returns {number} 0 = no limit
 */
export function getMaxTurns(config, providerKey) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig) return 0
  const val = Number(providerConfig.maxTurns)
  if (!Number.isFinite(val) || val < 1) return 0
  return Math.floor(val)
}

export function getProviderBaseUrl(config, providerKey) {
  const envVar = PROVIDER_BASE_URL_ENV_VARS[providerKey]
  if (envVar && process.env[envVar]) {
    return normalizeText(process.env[envVar]) || null
  }

  const baseUrl = config?.providers?.[providerKey]?.baseUrl
  return normalizeText(baseUrl) || null
}

export function getProviderModelId(config, providerKey) {
  const envVar = PROVIDER_MODEL_ID_ENV_VARS[providerKey]
  if (envVar && process.env[envVar]) {
    return normalizeText(process.env[envVar]) || null
  }

  const modelId = config?.providers?.[providerKey]?.modelId
  return normalizeText(modelId) || null
}

/**
 * 📖 isProviderEnabled: Check if a provider is enabled in config.
 *
 * 📖 Providers are enabled by default if not explicitly set to false.
 * 📖 A provider without an API key should still appear in settings (just can't ping).
 *
 * @param {{ providers: Record<string,{enabled:boolean}> }} config
 * @param {string} providerKey
 * @returns {boolean}
 */
export function isProviderEnabled(config, providerKey) {
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig) {
    if (providerKey === 'kilocode') return false // 📖 KiloCode: disabled by default
    return true // 📖 Default: enabled
  }
  return providerConfig.enabled !== false
}

export function getProviderPingIntervalMs(config, providerKey) {
  const DEFAULT_PING_INTERVAL_MS = 30 * 60_000
  const providerConfig = config?.providers?.[providerKey]
  if (!providerConfig?.pingIntervalMinutes) return DEFAULT_PING_INTERVAL_MS
  const mins = Number(providerConfig.pingIntervalMinutes)
  if (!Number.isFinite(mins) || mins < 1) return DEFAULT_PING_INTERVAL_MS
  return mins * 60_000
}

export function getPinningMode(config) {
  return config?.pinningMode === 'exact' ? 'exact' : 'canonical'
}

// 📖 Internal helper: create a blank config with the right shape
function _emptyConfig() {
  return {
    apiKeys: {},
    providers: {},
    bannedModels: [],
    autoUpdate: {
      enabled: true,
      intervalHours: 24,
      lastCheckAt: null,
      lastUpdateAt: null,
      lastVersionApplied: null,
      lastError: null,
    },
    minSweScore: null,
    excludedProviders: [],
    pinningMode: 'canonical',
  }
}

function _readConfigFile(path) {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return normalizeConfigShape(parsed)
  } catch {
    return null
  }
}

export function normalizeConfigShape(config) {
  const base = config && typeof config === 'object' && !Array.isArray(config)
    ? { ...config }
    : {}

  if (!base.apiKeys || typeof base.apiKeys !== 'object' || Array.isArray(base.apiKeys)) {
    base.apiKeys = {}
  }
  if (!base.providers || typeof base.providers !== 'object' || Array.isArray(base.providers)) {
    base.providers = {}
  }
  if (!Array.isArray(base.bannedModels)) base.bannedModels = []

  if (!base.autoUpdate || typeof base.autoUpdate !== 'object' || Array.isArray(base.autoUpdate)) {
    base.autoUpdate = {}
  }
  if (base.autoUpdate.enabled == null) base.autoUpdate.enabled = true
  if (!Number.isFinite(base.autoUpdate.intervalHours) || base.autoUpdate.intervalHours <= 0) base.autoUpdate.intervalHours = 24
  if (!('lastCheckAt' in base.autoUpdate)) base.autoUpdate.lastCheckAt = null
  if (!('lastUpdateAt' in base.autoUpdate)) base.autoUpdate.lastUpdateAt = null
  if (!('lastVersionApplied' in base.autoUpdate)) base.autoUpdate.lastVersionApplied = null
  if (!('lastError' in base.autoUpdate)) base.autoUpdate.lastError = null

  if (!('minSweScore' in base) || base.minSweScore === null) base.minSweScore = null
  else if (typeof base.minSweScore === 'number' && base.minSweScore >= 0 && base.minSweScore <= 1) base.minSweScore = base.minSweScore
  else base.minSweScore = null

  if (!Array.isArray(base.excludedProviders)) base.excludedProviders = []
  base.pinningMode = base.pinningMode === 'exact' ? 'exact' : 'canonical'

  // Trim API key strings to avoid copy/paste artifacts.
  for (const provider in base.apiKeys) {
    const val = base.apiKeys[provider]
    if (Array.isArray(val)) {
      base.apiKeys[provider] = val.map(normalizeSecret).filter(Boolean)
    } else if (typeof val === 'string') {
      base.apiKeys[provider] = normalizeSecret(val)
    }
  }

  for (const provider in base.providers) {
    const providerConfig = base.providers[provider]
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) {
      base.providers[provider] = {}
      continue
    }
    if (typeof providerConfig.baseUrl === 'string') {
      providerConfig.baseUrl = normalizeText(providerConfig.baseUrl)
    }
    if (typeof providerConfig.modelId === 'string') {
      providerConfig.modelId = normalizeText(providerConfig.modelId)
    }
  }

  return base
}
