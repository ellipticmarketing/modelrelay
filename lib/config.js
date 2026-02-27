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
 * @functions
 *   → loadConfig() — Read ~/.modelrelay.json
 *   → saveConfig(config) — Write config to ~/.modelrelay.json with 0o600 permissions
 *   → getApiKey(config, providerKey) — Get effective API key (env var override > config > null)
 *
 * @exports loadConfig, saveConfig, getApiKey
 * @exports CONFIG_PATH — path to the JSON config file
 *
 * @see bin/modelrelay.js — main CLI that uses these functions
 * @see sources.js — provider keys come from Object.keys(sources)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// 📖 Primary JSON config path — stores all providers' API keys + enabled state
export const CONFIG_PATH = join(homedir(), '.modelrelay.json')

// 📖 Environment variable names per provider
// 📖 These allow users to override config via env vars (useful for CI/headless setups)
const ENV_VARS = {
  nvidia: 'NVIDIA_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  codestral: 'CODESTRAL_API_KEY',
  scaleway: 'SCALEWAY_API_KEY',
  googleai: 'GOOGLE_API_KEY',
}

/**
 * 📖 loadConfig: Read the JSON config from disk.
 *
 * 📖 Fallback chain:
 *   1. Try to read ~/.modelrelay.json
 *   2. If missing or invalid, return an empty default config
 *
 * @returns {{ apiKeys: Record<string,string>, providers: Record<string,{enabled:boolean}>, bannedModels: string[] }}
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
    // 📖 Ensure the shape is complete before saving
    if (!config.bannedModels) config.bannedModels = []

    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
  } catch {
    // 📖 Silently fail — the app is still usable, keys just won't persist
  }
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
    return process.env[envVar].trim();
  }

  // 📖 Config file value
  const key = config?.apiKeys?.[providerKey]
  if (key) {
    return key.trim();
  }

  return null
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
  if (!providerConfig) return true // 📖 Default: enabled
  return providerConfig.enabled !== false
}

// 📖 Internal helper: create a blank config with the right shape
function _emptyConfig() {
  return {
    apiKeys: {},
    providers: {},
    bannedModels: [],
  }
}

function _readConfigFile(path) {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const parsed = JSON.parse(raw)
    if (!parsed.apiKeys) parsed.apiKeys = {}
    if (!parsed.providers) parsed.providers = {}
    if (!parsed.bannedModels) parsed.bannedModels = []
    return parsed
  } catch {
    return null
  }
}
