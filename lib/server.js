import express from 'express';
import chalk from 'chalk';
import path, { join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { MODELS, sources, canonicalizeModelId, getPreferredModelLabel, getScore, resolveAliasedModelId } from '../sources.js';
import { API_KEY_SIGNUP_URLS } from './providerLinks.js';
import { getApiKey, getApiKeyPool, getMaxTurns, getPinningMode, getProviderBaseUrl, getProviderModelId, hasMultipleKeys, isProviderEnabled, getProviderPingIntervalMs, loadConfig, saveConfig, exportConfigToken, importConfigToken } from './config.js';
import { buildModelGroups, computeQoSMap, findBestModel, getAvg, getUptime, getVerdict, isRetryableProxyStatus, rankModelsForRouting, parseOpenRouterKeyRateLimit, filterModelsByRequested, selectNextApiKeyFromPool } from './utils.js';
import { getPreferredLanIpv4Address } from './network.js';
import { createHash, randomUUID } from 'crypto';
import { getAutostartStatus } from './autostart.js';
import { buildWindowsPostUpdateRestartCommand, fetchLatestNpmVersion, isRunningFromSource, isVersionNewer, runUpdateCommand } from './update.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let APP_VERSION = 'unknown';
try {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  APP_VERSION = pkg.version || 'unknown';
} catch {
  APP_VERSION = 'unknown';
}

const PING_TIMEOUT = 15_000;
const PING_INTERVAL = 1 * 60_000;
const MAX_PROACTIVE_RETRIES = 5;
const NPM_LATEST_CACHE_MS = 10 * 60_000;
const KILOCODE_PROVIDER_KEY = 'kilocode';
const KILOCODE_MODELS_URL = 'https://api.kilo.ai/api/gateway/models';
const KILOCODE_MODELS_REFRESH_MS = 30 * 60_000;

const OPENCODE_PROVIDER_KEY = 'opencode';
const OPENCODE_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const OPENCODE_MODELS_REFRESH_MS = 60 * 60_000;

const OPENAI_COMPATIBLE_PROVIDER_KEY = 'openai-compatible';
const OLLAMA_PROVIDER_KEY = 'ollama';
const OLLAMA_MODELS_REFRESH_MS = 60 * 60_000;
const OPENROUTER_PROVIDER_KEY = 'openrouter';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_MODELS_REFRESH_MS = 60 * 60_000;
const OPTIONAL_BEARER_AUTH_PROVIDERS = new Set([KILOCODE_PROVIDER_KEY, OPENCODE_PROVIDER_KEY]);
const OPENCODE_CLIENT_HEADER = 'cli';

const DEFAULT_DYNAMIC_MODEL_INTELL = 0.45;
const DEFAULT_DYNAMIC_MODEL_CTX = '128k';
const EXCLUDED_DYNAMIC_MODEL_BASE_IDS = new Set([
  'meta-llama/llama-guard-4-12b',
]);

const OPENCODE_CHAT_COMPLETIONS_MODELS = new Map([
  ['minimax-m2.5-free', { label: 'MiniMax M2.5 Free', ctx: '128k', scoreId: 'minimax/minimax-m2.5' }],
  ['qwen3.6-plus-free', { label: 'Qwen3.6 Plus', ctx: '128k', scoreId: 'qwen/qwen3.5-397b-a17b' }],
  ['trinity-large-preview-free', { label: 'Trinity Large Preview', ctx: '128k', scoreId: 'arcee-ai/trinity-large-preview' }],
  ['mimo-v2-flash-free', { label: 'MiMo V2 Flash', ctx: '128k', scoreId: null }],
  ['mimo-v2-pro-free', { label: 'MiMo V2 Omni Pro', ctx: '128k', scoreId: 'xiaomi/mimo-v2-pro' }],
  ['mimo-v2-omni-free', { label: 'MiMo V2 Omni', ctx: '128k', scoreId: 'xiaomi/mimo-v2-omni' }],
  ['nemotron-3-super-free', { label: 'Nemotron 3 Super Free', ctx: '128k', scoreId: 'nvidia/nemotron-3-super-120b-a12b' }],
]);

function isOpenCodeFreeModelId(modelId) {
  if (!modelId) return false;
  if (OPENCODE_CHAT_COMPLETIONS_MODELS.has(modelId)) return true;
  return modelId.endsWith('-free');
}


const latestVersionCache = {
  value: null,
  fetchedAt: 0,
  inFlight: null,
};

let _keyPoolState = null;
function _setKeyPoolState(state) { _keyPoolState = state; }

export function getAccountStatus(config) {
  const providers = {}
  if (!_keyPoolState) return { providers }

  for (const [providerKey, entry] of _keyPoolState) {
    const pool = getApiKeyPool(config, providerKey)
    if (pool.length === 0) continue
    const maxTurns = getMaxTurns(config, providerKey)
    const now = Date.now()
    const accounts = pool.map((key, idx) => {
      const acct = entry.accounts.get(idx)
      const isRateLimited = acct && acct.rateLimitedAt && (now - acct.rateLimitedAt) < KEY_POOL_COOLDOWN_MS
      const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : `${key.slice(0, 2)}***`
      return {
        index: idx,
        masked,
        requests: acct ? acct.requests : 0,
        rateLimited: !!isRateLimited,
      }
    })
    providers[providerKey] = {
      keyCount: pool.length,
      currentIdx: entry.currentIdx % pool.length,
      maxTurns,
      accounts,
    }
  }
  return { providers }
}

export function toPinnedRowKey(result) {
  return `${result?.providerKey || ''}::${result?.modelId || ''}`;
}

export function getPinnedModelMatches(results, pinnedModelId, pinningMode = 'canonical', pinnedProviderKey = null) {
  if (!pinnedModelId) return [];
  if (pinningMode === 'exact') {
    return results.filter(r => r.modelId === pinnedModelId && (pinnedProviderKey ? r.providerKey === pinnedProviderKey : true));
  }

  const groups = buildModelGroups(results, canonicalizeModelId);
  const matchedGroup = groups.find(group => group.models.some(model => model.modelId === pinnedModelId && (pinnedProviderKey ? model.providerKey === pinnedProviderKey : true)));
  return matchedGroup ? matchedGroup.models : results.filter(r => r.modelId === pinnedModelId);
}

export function getPinnedModelCandidate(results, pinnedModelId, pinningMode = 'canonical', attemptedModelIds = [], pinnedProviderKey = null) {
  const attempted = new Set(attemptedModelIds);
  const matches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey)
    .filter(r => r.status !== 'banned' && r.status !== 'disabled' && !attempted.has(r.modelId));
  const ranked = rankModelsForRouting(matches, Array.from(attempted));
  return ranked[0] || null;
}

async function fetchLatestNpmVersionCached(force = false) {
  const now = Date.now();
  const cacheFresh = !force && (now - latestVersionCache.fetchedAt) < NPM_LATEST_CACHE_MS;
  if (cacheFresh && latestVersionCache.value) return latestVersionCache.value;
  if (latestVersionCache.inFlight) return latestVersionCache.inFlight;

  latestVersionCache.inFlight = (async () => {
    try {
      const version = await fetchLatestNpmVersion();
      if (version) {
        latestVersionCache.value = version;
        latestVersionCache.fetchedAt = Date.now();
      }
    } catch {
      // Keep stale cache value if request fails.
    } finally {
      latestVersionCache.inFlight = null;
    }
    return latestVersionCache.value;
  })();

  return latestVersionCache.inFlight;
}

// Parse NVIDIA/OpenAI duration strings like "1m30s", "12ms", "45s" into milliseconds
function parseDurationMs(str) {
  if (!str) return null;
  // Try numeric first (plain seconds or ms)
  const num = Number(str);
  if (!isNaN(num)) return num * 1000; // assume seconds
  let ms = 0;
  const match = str.match(/(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?/);
  if (match) {
    if (match[1]) ms += parseInt(match[1]) * 60000;
    if (match[2]) ms += parseFloat(match[2]) * 1000;
    if (match[3]) ms += parseInt(match[3]);
  }
  return ms || null;
}

function extractErrorMessage(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload.trim() || null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const msg = extractErrorMessage(item);
      if (msg) return msg;
    }
    return null;
  }
  if (typeof payload === 'object') {
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
    if (payload.error) {
      const msg = extractErrorMessage(payload.error);
      if (msg) return msg;
    }
    if (typeof payload.status === 'string' && payload.status.trim()) return payload.status.trim();
  }
  return null;
}

function parseErrorBodyText(rawText) {
  if (!rawText || !rawText.trim()) return null;
  const trimmed = rawText.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return extractErrorMessage(parsed) || trimmed.slice(0, 300);
  } catch {
    return trimmed.slice(0, 300);
  }
}

function getNetworkErrorMessage(err) {
  if (!err) return null;
  if (typeof err === 'string') return err;
  const direct = typeof err.message === 'string' ? err.message.trim() : '';
  const cause = err && typeof err === 'object' ? err.cause : null;
  const causeMessage = cause && typeof cause.message === 'string' ? cause.message.trim() : '';
  const causeCode = cause && typeof cause.code === 'string' ? cause.code.trim() : '';

  if (causeCode && causeMessage) return `${direct || 'Network error'} (${causeCode}: ${causeMessage})`;
  if (causeCode) return `${direct || 'Network error'} (${causeCode})`;
  if (causeMessage) return `${direct || 'Network error'} (${causeMessage})`;
  return direct || null;
}

function describeSyncError(err) {
  return getNetworkErrorMessage(err) || err?.message || 'unknown error';
}

function captureResolvedModel(logEntry, payload) {
  if (!logEntry || !payload || typeof payload !== 'object') return;
  if (typeof payload.model === 'string' && payload.model.trim()) {
    logEntry.resolvedModel = payload.model.trim();
  }
}

export function isProviderBearerAuthEnabled(config, providerKey) {
  if (!OPTIONAL_BEARER_AUTH_PROVIDERS.has(providerKey)) return true;
  const providerConfig = config?.providers?.[providerKey];
  if (!providerConfig || providerConfig.useBearerAuth == null) return true;
  return providerConfig.useBearerAuth !== false;
}

function isLocalOllamaBaseUrl(config) {
  const rawBaseUrl = getProviderBaseUrl(config, OLLAMA_PROVIDER_KEY);
  if (!rawBaseUrl) return false;

  let urlText = rawBaseUrl.trim();
  if (!urlText) return false;
  if (!/^https?:\/\//i.test(urlText)) {
    urlText = `http://${urlText}`;
  }

  try {
    const parsed = new URL(urlText);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function isProviderAuthOptional(config, providerKey) {
  if (providerKey === OLLAMA_PROVIDER_KEY && isLocalOllamaBaseUrl(config)) return true;
  return OPTIONAL_BEARER_AUTH_PROVIDERS.has(providerKey);
}

export function providerWantsBearerAuth(config, providerKey) {
  return isProviderBearerAuthEnabled(config, providerKey);
}

export function shouldRetryOptionalProviderWithBearer(config, providerKey, auth, code, errorMessage) {
  if (code !== '401') return false;
  if (!isProviderAuthOptional(config, providerKey)) return false;
  if (auth?.token) return false;

  const apiKey = getApiKey(config, providerKey);
  if (!apiKey) return false;

  const message = String(errorMessage || '').toLowerCase();
  if (!message) return true;

  return message.includes('missing api key')
    || message.includes('unauthorized')
    || message.includes('auth');
}

function normalizeOpenAICompatibleProviderUrl(resourceUrl) {
  if (!resourceUrl || typeof resourceUrl !== 'string') return null;
  const trimmed = resourceUrl.trim();
  if (!trimmed) return null;

  let urlText = trimmed;
  if (!/^https?:\/\//i.test(urlText)) {
    urlText = 'https://' + urlText;
  }

  try {
    const parsed = new URL(urlText);
    const pathname = (parsed.pathname || '/').replace(/\/+$/, '');

    if (pathname.endsWith('/chat/completions')) {
      parsed.pathname = pathname;
      return parsed.toString();
    }
    if (pathname.endsWith('/v1')) {
      parsed.pathname = pathname + '/chat/completions';
      return parsed.toString();
    }

    parsed.pathname = (pathname === '' ? '' : pathname) + '/v1/chat/completions';
    return parsed.toString();
  } catch {
    return null;
  }
}

function getDefaultProviderBaseUrl(providerKey) {
  if (providerKey === OLLAMA_PROVIDER_KEY) return 'https://ollama.com/v1';
  return null;
}

function formatGenericProviderModelLabel(modelId) {
  if (!modelId) return 'Custom Model';
  const leaf = modelId.split('/').pop() || modelId;
  return leaf
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function buildConfigurableProviderModelMeta(config, providerKey, defaultBaseUrl = null) {
  const modelId = getProviderModelId(config, providerKey);
  const configuredBaseUrl = getProviderBaseUrl(config, providerKey);
  const baseUrl = normalizeOpenAICompatibleProviderUrl(configuredBaseUrl || defaultBaseUrl);
  if (!modelId || !baseUrl) return null;

  const { base, unprefixed } = canonicalizeModelId(modelId);
  const known = knownModelMetaMap.get(base) || knownModelMetaMap.get(unprefixed) || null;
  const knownScore = normalizeIntelligenceScore(getScore(modelId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);

  return {
    modelId,
    label: known?.label || formatGenericProviderModelLabel(modelId),
    intell: knownScore ?? known?.intell ?? DEFAULT_DYNAMIC_MODEL_INTELL,
    isEstimatedScore: !hasScore,
    ctx: known?.ctx || DEFAULT_DYNAMIC_MODEL_CTX,
    providerKey,
    providerUrl: baseUrl,
  };
}

function buildOpenAICompatibleModelMeta(config) {
  return buildConfigurableProviderModelMeta(config, OPENAI_COMPATIBLE_PROVIDER_KEY);
}

function buildOllamaModelMeta(config) {
  return buildConfigurableProviderModelMeta(config, OLLAMA_PROVIDER_KEY, 'https://ollama.com/v1');
}

function getKnownModelMetaMap() {
  const map = new Map();
  for (const [modelId, label, intell, ctx] of MODELS) {
    if (!map.has(modelId)) map.set(modelId, { label, intell, ctx });
  }
  return map;
}

const knownModelMetaMap = getKnownModelMetaMap();

function extractKiloCodeModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === 'object') {
    if (Array.isArray(payload.data.models)) return payload.data.models;
    if (Array.isArray(payload.data.items)) return payload.data.items;
  }
  return [];
}

function parseKiloCodeContext(rawCtx) {
  if (rawCtx == null) return DEFAULT_DYNAMIC_MODEL_CTX;
  if (typeof rawCtx === 'number' && Number.isFinite(rawCtx) && rawCtx > 0) {
    if (rawCtx >= 1_000_000) return `${Math.round(rawCtx / 1_000_000)}M`;
    if (rawCtx >= 1000) return `${Math.round(rawCtx / 1000)}k`;
    return String(Math.round(rawCtx));
  }
  if (typeof rawCtx === 'string' && rawCtx.trim()) return rawCtx.trim();
  return DEFAULT_DYNAMIC_MODEL_CTX;
}

function normalizeIntelligenceScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 1 && n <= 100) return n / 100;
  return n;
}

function extractSWEPercentFromDescription(description) {
  if (typeof description !== 'string' || !description.trim()) return null;
  const match = description.match(/(\d+(?:\.\d+)?)%\s+on\s+SWE-?Bench(?:\s+Verified)?/i);
  if (!match) return null;
  return Number(match[1]);
}

function isExcludedDynamicModelId(modelId) {
  const raw = typeof modelId === 'string' ? modelId.trim() : '';
  if (!raw) return false;
  const { base } = canonicalizeModelId(raw);
  return EXCLUDED_DYNAMIC_MODEL_BASE_IDS.has(base);
}

export function toKiloCodeModelMeta(record) {
  const modelId = typeof record === 'string'
    ? record.trim()
    : String(record?.id || record?.model || record?.name || '').trim();
  if (!modelId || !modelId.endsWith(':free')) return null;
  if (isExcludedDynamicModelId(modelId)) return null;

  const known = knownModelMetaMap.get(modelId) || knownModelMetaMap.get(modelId.replace(/:free$/, '')) || null;
  let label = (typeof record === 'object' && record && typeof record.display_name === 'string' && record.display_name.trim())
    ? record.display_name.trim()
    : getPreferredModelLabel(modelId, known?.label || modelId);
  label = getPreferredModelLabel(modelId, label);
  const intellRaw = typeof record === 'object' && record
    ? (record.intell ?? record.swe ?? record.score ?? record.swe_score)
    : null;
  const swePercent = typeof record === 'object' && record
    ? extractSWEPercentFromDescription(record.description)
    : null;
  const normalizedIntell = normalizeIntelligenceScore(intellRaw);
  const normalizedSWE = normalizeIntelligenceScore(swePercent);
  const knownScore = normalizeIntelligenceScore(getScore(modelId));

  const hasScore = (normalizedIntell != null && normalizedIntell > 0)
    || (normalizedSWE != null && normalizedSWE > 0)
    || (knownScore != null && knownScore > 0)
    || (known != null && known.intell != null && known.intell > 0);
  const intell = normalizedIntell ?? normalizedSWE ?? knownScore ?? known?.intell ?? DEFAULT_DYNAMIC_MODEL_INTELL;
  const isEstimatedScore = !hasScore;

  const ctxRaw = typeof record === 'object' && record
    ? (record.context_length ?? record.contextLength ?? record.ctx)
    : null;
  const ctx = parseKiloCodeContext(ctxRaw) || known?.ctx || DEFAULT_DYNAMIC_MODEL_CTX;

  return { modelId, label, intell, isEstimatedScore, ctx, providerKey: KILOCODE_PROVIDER_KEY };
}

export async function fetchKiloCodeFreeModels(config) {
  const headers = { Accept: 'application/json' };
  const token = getApiKey(config, KILOCODE_PROVIDER_KEY);
  if (token && providerWantsBearerAuth(config, KILOCODE_PROVIDER_KEY)) {
    headers.Authorization = `Bearer ${token}`;
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    const response = await fetch(KILOCODE_MODELS_URL, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const records = extractKiloCodeModelRecords(payload);
    const seen = new Set();
    const models = [];

    for (const record of records) {
      const model = toKiloCodeModelMeta(record);
      if (!model || seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      models.push(model);
    }

    return models;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function extractOpenRouterModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

export function extractOllamaModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.models)) return payload.models;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

export function extractOpenCodeModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

export function toOllamaModelMeta(record) {
  const modelId = String(record?.model || record?.name || record?.id || '').trim();
  if (!modelId) return null;

  const remoteModelId = String(record?.remote_model || '').trim();
  const scoreLookupId = resolveAliasedModelId(remoteModelId || modelId);
  const { base, unprefixed } = canonicalizeModelId(scoreLookupId);
  const known = knownModelMetaMap.get(scoreLookupId) || knownModelMetaMap.get(base) || knownModelMetaMap.get(unprefixed) || knownModelMetaMap.get(modelId) || null;
  const knownScore = normalizeIntelligenceScore(getScore(scoreLookupId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);

  const recordName = typeof record?.name === 'string' ? record.name.trim() : '';
  let label = (recordName && recordName !== modelId)
    ? recordName
    : (known?.label || formatGenericProviderModelLabel(modelId));
  label = getPreferredModelLabel(scoreLookupId, label);

  return {
    modelId,
    label,
    intell: knownScore ?? known?.intell ?? DEFAULT_DYNAMIC_MODEL_INTELL,
    isEstimatedScore: !hasScore,
    ctx: known?.ctx || DEFAULT_DYNAMIC_MODEL_CTX,
    providerKey: OLLAMA_PROVIDER_KEY,
  };
}

function getOllamaModelsUrl(config) {
  const configuredBaseUrl = getProviderBaseUrl(config, OLLAMA_PROVIDER_KEY) || getDefaultProviderBaseUrl(OLLAMA_PROVIDER_KEY);
  let urlText = configuredBaseUrl.trim();
  if (!/^https?:\/\//i.test(urlText)) {
    urlText = `https://${urlText}`;
  }

  try {
    const parsed = new URL(urlText);
    parsed.pathname = '/api/tags';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return 'https://ollama.com/api/tags';
  }
}

export async function fetchOllamaModels(config) {
  const headers = { Accept: 'application/json' };
  const token = getApiKey(config, OLLAMA_PROVIDER_KEY);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    const response = await fetch(getOllamaModelsUrl(config), {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const records = extractOllamaModelRecords(payload);
    const seen = new Set();
    const models = [];

    for (const record of records) {
      const model = toOllamaModelMeta(record);
      if (!model || seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      models.push(model);
    }

    return models;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function toOpenCodeModelMeta(record) {
  const modelId = String(record?.id || record?.model || record?.name || '').trim();
  if (!modelId) return null;

  const meta = OPENCODE_CHAT_COMPLETIONS_MODELS.get(modelId);
  if (!meta && !isOpenCodeFreeModelId(modelId)) return null;

  const scoreModelId = meta?.scoreId || modelId;
  const { base, unprefixed } = canonicalizeModelId(scoreModelId);
  const known = knownModelMetaMap.get(scoreModelId) || knownModelMetaMap.get(base) || knownModelMetaMap.get(unprefixed) || knownModelMetaMap.get(modelId) || null;
  const knownScore = normalizeIntelligenceScore(getScore(scoreModelId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);

  return {
    modelId,
    label: getPreferredModelLabel(modelId, meta?.label || known?.label || formatGenericProviderModelLabel(modelId)),
    intell: knownScore ?? known?.intell ?? DEFAULT_DYNAMIC_MODEL_INTELL,
    isEstimatedScore: !hasScore,
    ctx: meta?.ctx || known?.ctx || DEFAULT_DYNAMIC_MODEL_CTX,
    providerKey: OPENCODE_PROVIDER_KEY,
  };
}

export async function fetchOpenCodeModels(config) {
  const headers = { Accept: 'application/json' };
  const token = getApiKey(config, OPENCODE_PROVIDER_KEY);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    const response = await fetch(OPENCODE_MODELS_URL, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const records = extractOpenCodeModelRecords(payload);
    const seen = new Set();
    const models = [];

    for (const record of records) {
      const model = toOpenCodeModelMeta(record);
      if (!model || seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      models.push(model);
    }

    return models;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function toOpenRouterModelMeta(record) {
  const modelId = String(record?.id || record?.model || record?.name || '').trim();
  if (!modelId || !modelId.endsWith(':free')) return null;
  if (isExcludedDynamicModelId(modelId)) return null;

  const { base, unprefixed } = canonicalizeModelId(modelId);
  const known = knownModelMetaMap.get(base) || knownModelMetaMap.get(unprefixed) || null;
  let label = (record && typeof record.name === 'string' && record.name.trim())
    ? record.name.trim()
    : (known?.label || modelId);

  // Clean label: "Google: Gemma 2B (free)" -> "Gemma 2B"
  if (label.includes(':')) {
    const parts = label.split(':');
    // If it looks like "Lab: Model", take the last part
    if (parts.length > 1) {
      label = parts[parts.length - 1].trim();
    }
  }
  // Remove "(free)" or "free" suffix case-insensitively
  label = label.replace(/\s*\(?free\)?\s*$/i, '').trim();

  if (!label) {
    label = known?.label || modelId;
  }

  label = getPreferredModelLabel(modelId, label);

  // OpenRouter doesn't provide a direct intelligence score, but we can use scores.js
  // before falling back to known meta/default.
  const knownScore = normalizeIntelligenceScore(getScore(modelId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);
  const intell = knownScore ?? known?.intell ?? DEFAULT_DYNAMIC_MODEL_INTELL;
  const isEstimatedScore = !hasScore;

  const ctxRaw = record?.context_length ?? record?.contextLength ?? record?.ctx;
  const ctx = parseKiloCodeContext(ctxRaw) || known?.ctx || DEFAULT_DYNAMIC_MODEL_CTX;

  return { modelId, label, intell, isEstimatedScore, ctx, providerKey: OPENROUTER_PROVIDER_KEY };
}

export async function fetchOpenRouterFreeModels(config) {
  const headers = { Accept: 'application/json' };
  const token = getApiKey(config, OPENROUTER_PROVIDER_KEY);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const records = extractOpenRouterModelRecords(payload);
    const seen = new Set();
    const models = [];

    for (const record of records) {
      const model = toOpenRouterModelMeta(record);
      if (!model || seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      models.push(model);
    }

    return models;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildOpencodeProjectId(seed = process.cwd()) {
  const normalized = String(seed || 'modelrelay').trim() || 'modelrelay';
  return createHash('sha1').update(normalized).digest('hex');
}

function makeOpencodeHeaderId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function buildOpencodeHeaders(options = {}) {
  return {
    'x-opencode-project': buildOpencodeProjectId(options.projectSeed),
    'x-opencode-session': options.sessionId || makeOpencodeHeaderId('ses'),
    'x-opencode-request': options.requestId || makeOpencodeHeaderId('req'),
    'x-opencode-client': options.client || OPENCODE_CLIENT_HEADER,
  };
}

export function buildProviderRequestHeaders(providerKey, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  if (providerKey === OPENCODE_PROVIDER_KEY) {
    Object.assign(headers, buildOpencodeHeaders(options));
  }

  return headers;
}

async function ping(apiKey, modelId, url, providerKey = null) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT)
  const t0 = performance.now()
  try {
    const headers = buildProviderRequestHeaders(providerKey, { apiKey })
    const resp = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers,
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
    })
    let errorMessage = null;
    if (!resp.ok) {
      try {
        const raw = await resp.text();
        errorMessage = parseErrorBodyText(raw);
      } catch {
        errorMessage = null;
      }
    }
    // Capture rate-limit headers for display purposes
    const rateLimit = {};
    const rl = resp.headers;
    const LR = rl.get('x-ratelimit-limit-requests'); if (LR) rateLimit.limitRequests = parseInt(LR);
    const RR = rl.get('x-ratelimit-remaining-requests'); if (RR) rateLimit.remainingRequests = parseInt(RR);
    const LT = rl.get('x-ratelimit-limit-tokens'); if (LT) rateLimit.limitTokens = parseInt(LT);
    const RT = rl.get('x-ratelimit-remaining-tokens'); if (RT) rateLimit.remainingTokens = parseInt(RT);

    const resetReq = rl.get('x-ratelimit-reset-requests');
    const resetTok = rl.get('x-ratelimit-reset-tokens');
    if (resetReq) {
      const ms = parseDurationMs(resetReq);
      if (ms != null) rateLimit.resetRequestsAt = Date.now() + ms;
    }
    if (resetTok) {
      const ms = parseDurationMs(resetTok);
      if (ms != null) rateLimit.resetTokensAt = Date.now() + ms;
    }

    return {
      code: String(resp.status),
      ms: Math.round(performance.now() - t0),
      rateLimit: Object.keys(rateLimit).length > 0 ? rateLimit : null,
      errorMessage,
    }
  } catch (err) {
    const isTimeout = err.name === 'AbortError'
    const message = getNetworkErrorMessage(err)
    return {
      code: isTimeout ? '000' : 'ERR',
      ms: isTimeout ? 'TIMEOUT' : Math.round(performance.now() - t0),
      errorMessage: isTimeout ? 'Request timed out while pinging provider.' : message,
    }
  } finally {
    clearTimeout(timer)
  }
}

function mergeRateLimits(primary, secondary) {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;
  return { ...primary, ...secondary };
}

async function fetchOpenRouterRateLimit(apiKey) {
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    if (!resp.ok) return null;

    const payload = await resp.json();
    return parseOpenRouterKeyRateLimit(payload);
  } catch {
    return null;
  }
}

async function resolveProviderAuthToken(config, providerKey, options = {}) {
  const apiKey = getApiKey(config, providerKey);
  if (apiKey && providerWantsBearerAuth(config, providerKey)) {
    return { token: apiKey, authSource: 'api-key', providerUrlOverride: null };
  }

  return { token: null, authSource: null, providerUrlOverride: null };
}

function resolveProviderUrl(config, providerKey, authProviderUrlOverride = null, resultProviderUrl = null) {
  if (authProviderUrlOverride) return authProviderUrlOverride;
  if (providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY || providerKey === OLLAMA_PROVIDER_KEY) {
    return normalizeOpenAICompatibleProviderUrl(resultProviderUrl || getProviderBaseUrl(config, providerKey) || getDefaultProviderBaseUrl(providerKey));
  }
  return sources[providerKey]?.url || sources.nvidia.url;
}

function normalizeAutoUpdateState(config) {
  if (!config.autoUpdate || typeof config.autoUpdate !== 'object') config.autoUpdate = {};
  if (config.autoUpdate.enabled == null) config.autoUpdate.enabled = true;
  if (!Number.isFinite(config.autoUpdate.intervalHours) || config.autoUpdate.intervalHours <= 0) config.autoUpdate.intervalHours = 24;
  if (!('lastCheckAt' in config.autoUpdate)) config.autoUpdate.lastCheckAt = null;
  if (!('lastUpdateAt' in config.autoUpdate)) config.autoUpdate.lastUpdateAt = null;
  if (!('lastVersionApplied' in config.autoUpdate)) config.autoUpdate.lastVersionApplied = null;
  if (!('lastError' in config.autoUpdate)) config.autoUpdate.lastError = null;
  return config.autoUpdate;
}

function getAutoUpdateStatusSnapshot() {
  const cfg = loadConfig();
  const state = normalizeAutoUpdateState(cfg);
  return {
    enabled: state.enabled !== false,
    intervalHours: state.intervalHours,
    lastCheckAt: state.lastCheckAt || null,
    lastUpdateAt: state.lastUpdateAt || null,
    lastVersionApplied: state.lastVersionApplied || null,
    lastError: state.lastError || null,
  };
}

export async function runServer(config, port, enableLog = true, bannedModels = []) {
  // 📖 pinnedModelId: when set, ALL proxy requests are locked to this model (in-memory, resets on restart)
  let pinnedModelId = null;
  let pinnedProviderKey = null;

  // Multi-account round-robin state
  const KEY_POOL_COOLDOWN_MS = 60_000
  const keyPoolState = new Map() // providerKey → { currentIdx, accounts: Map<idx, { requests, rateLimitedAt }> }
  _setKeyPoolState(keyPoolState)

  function getKeyPoolEntry(providerKey) {
    if (!keyPoolState.has(providerKey)) {
      keyPoolState.set(providerKey, { currentIdx: 0, accounts: new Map() })
    }
    return keyPoolState.get(providerKey)
  }

  function getNextApiKey(config, providerKey) {
    const pool = getApiKeyPool(config, providerKey)
    if (pool.length === 0) return null
    if (pool.length === 1) return pool[0]

    const entry = getKeyPoolEntry(providerKey)
    const maxTurns = getMaxTurns(config, providerKey)
    const now = Date.now()
    return selectNextApiKeyFromPool(pool, entry, maxTurns, now, KEY_POOL_COOLDOWN_MS)
  }

  function markRateLimited(providerKey, apiKey) {
    const pool = getApiKeyPool(loadConfig(), providerKey)
    const idx = pool.indexOf(apiKey)
    if (idx === -1) return
    const entry = getKeyPoolEntry(providerKey)
    if (!entry.accounts.has(idx)) entry.accounts.set(idx, { requests: 0, rateLimitedAt: 0 })
    entry.accounts.get(idx).rateLimitedAt = Date.now()
  }
  const currentConfigLoader = loadConfig();
  if (currentConfigLoader.bannedModels && currentConfigLoader.bannedModels.length > 0) {
    bannedModels = [...new Set([...bannedModels, ...currentConfigLoader.bannedModels])];
  }

  console.log(chalk.cyan(`  🚀 Starting modelrelay Web UI on port ${port}...`));
  if (bannedModels.length > 0) {
    console.log(chalk.yellow(`  🚫 Banned models: ${bannedModels.join(', ')}`));
  }
  if (!enableLog) {
    console.log(chalk.dim(`  📝 Request terminal logging disabled`));
  }

  let autoUpdateInProgress = false;

  const toResultRow = ([modelId, label, intell, ctx, providerKey], index, isEstimatedScoreOverride = null) => {
    const hasScore = intell != null;
    return {
      idx: index + 1,
      modelId,
      label: getPreferredModelLabel(modelId, label),
      intell: hasScore ? intell : DEFAULT_DYNAMIC_MODEL_INTELL,
      isEstimatedScore: isEstimatedScoreOverride ?? !hasScore,
      ctx,
      providerKey,
      status: 'pending',
      pings: [],
      httpCode: null,
      hidden: false,
      lastModelResponseAt: 0,
      lastPingAt: 0,
    };
  };

  let results = MODELS.map((row, i) => toResultRow(row, i));
  let lastKiloCodeModelRefreshAt = 0;
  let lastOpenCodeModelRefreshAt = 0;
  let lastOllamaModelRefreshAt = 0;
  let lastOpenRouterModelRefreshAt = 0;

  const reindexResults = () => {
    for (let i = 0; i < results.length; i += 1) {
      results[i].idx = i + 1;
    }
  };

  const mergeDynamicProviderModels = (providerKey, models) => {
    const byModelId = new Map(
      results
        .filter(r => r.providerKey === providerKey)
        .map(r => [r.modelId, r])
    );

    results = results.filter(r => r.providerKey !== providerKey);

    for (const model of models) {
      const existing = byModelId.get(model.modelId);
      if (existing) {
        existing.label = getPreferredModelLabel(model.modelId, model.label);
        existing.intell = model.intell;
        existing.isEstimatedScore = model.isEstimatedScore;
        existing.ctx = model.ctx;
        results.push(existing);
      } else {
        results.push(toResultRow([
          model.modelId,
          model.label,
          model.intell,
          model.ctx,
          providerKey,
        ], results.length, model.isEstimatedScore));
      }
    }

    reindexResults();
  };

  const refreshKiloCodeModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastKiloCodeModelRefreshAt) < KILOCODE_MODELS_REFRESH_MS) return;
    try {
      const currentConfig = loadConfig();
      if (!isProviderEnabled(currentConfig, KILOCODE_PROVIDER_KEY)) {
        mergeDynamicProviderModels(KILOCODE_PROVIDER_KEY, []);
        return [];
      }
      const models = await fetchKiloCodeFreeModels(currentConfig);
      mergeDynamicProviderModels(KILOCODE_PROVIDER_KEY, models);
      return models;
    } catch (err) {
      console.log(chalk.dim(`  [KiloCode] Model sync skipped: ${describeSyncError(err)}`));
      throw err;
    } finally {
      lastKiloCodeModelRefreshAt = Date.now();
    }
  };

  const refreshOpenCodeModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastOpenCodeModelRefreshAt) < OPENCODE_MODELS_REFRESH_MS) return;
    try {
      const currentConfig = loadConfig();
      if (!isProviderEnabled(currentConfig, OPENCODE_PROVIDER_KEY)) {
        mergeDynamicProviderModels(OPENCODE_PROVIDER_KEY, []);
        return [];
      }
      const models = await fetchOpenCodeModels(currentConfig);
      mergeDynamicProviderModels(OPENCODE_PROVIDER_KEY, models);
      return models;
    } catch (err) {
      console.log(chalk.dim(`  [OpenCode Zen] Model sync skipped: ${describeSyncError(err)}`));
      throw err;
    } finally {
      lastOpenCodeModelRefreshAt = Date.now();
    }
  };

  const refreshOpenRouterModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastOpenRouterModelRefreshAt) < OPENROUTER_MODELS_REFRESH_MS) return;
    try {
      const currentConfig = loadConfig();
      if (!isProviderEnabled(currentConfig, OPENROUTER_PROVIDER_KEY)) {
        mergeDynamicProviderModels(OPENROUTER_PROVIDER_KEY, []);
        return [];
      }
      const models = await fetchOpenRouterFreeModels(currentConfig);
      mergeDynamicProviderModels(OPENROUTER_PROVIDER_KEY, models);
      return models;
    } catch (err) {
      console.log(chalk.dim(`  [OpenRouter] Model sync skipped: ${describeSyncError(err)}`));
      throw err;
    } finally {
      lastOpenRouterModelRefreshAt = Date.now();
    }
  };

  const refreshOpenAICompatibleModels = async () => {
    const currentConfig = loadConfig();
    if (!isProviderEnabled(currentConfig, OPENAI_COMPATIBLE_PROVIDER_KEY)) {
      mergeDynamicProviderModels(OPENAI_COMPATIBLE_PROVIDER_KEY, []);
      return [];
    }

    const model = buildOpenAICompatibleModelMeta(currentConfig);
    mergeDynamicProviderModels(OPENAI_COMPATIBLE_PROVIDER_KEY, model ? [model] : []);
    return model ? [model] : [];
  };

  const refreshOllamaModels = async (force = false) => {
    const now = Date.now();
    if (!force && (now - lastOllamaModelRefreshAt) < OLLAMA_MODELS_REFRESH_MS) return;

    const currentConfig = loadConfig();
    if (!isProviderEnabled(currentConfig, OLLAMA_PROVIDER_KEY)) {
      mergeDynamicProviderModels(OLLAMA_PROVIDER_KEY, []);
      lastOllamaModelRefreshAt = Date.now();
      return [];
    }

    try {
      const discovered = await fetchOllamaModels(currentConfig);
      const fallbackModel = buildOllamaModelMeta(currentConfig);
      const models = fallbackModel
        ? [fallbackModel, ...discovered.filter(m => m.modelId !== fallbackModel.modelId)]
        : discovered;
      mergeDynamicProviderModels(OLLAMA_PROVIDER_KEY, models);
      return models;
    } catch (err) {
      const fallbackModel = buildOllamaModelMeta(currentConfig);
      mergeDynamicProviderModels(OLLAMA_PROVIDER_KEY, fallbackModel ? [fallbackModel] : []);
      console.log(chalk.dim(`  [Ollama] Model sync skipped: ${describeSyncError(err)}`));
      throw err;
    } finally {
      lastOllamaModelRefreshAt = Date.now();
    }
  };

  const refreshProviderModelsForApi = async (providerKey) => {
    if (!providerKey || !sources[providerKey]) {
      throw new Error('Unknown provider.');
    }

    if (providerKey === KILOCODE_PROVIDER_KEY) return await refreshKiloCodeModels(true);
    if (providerKey === OPENCODE_PROVIDER_KEY) return await refreshOpenCodeModels(true);
    if (providerKey === OPENROUTER_PROVIDER_KEY) return await refreshOpenRouterModels(true);
    if (providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY) return await refreshOpenAICompatibleModels();
    if (providerKey === OLLAMA_PROVIDER_KEY) return await refreshOllamaModels(true);

    return results
      .filter(r => r.providerKey === providerKey)
      .map(r => ({
        modelId: r.modelId,
        label: r.label,
        intell: r.intell,
        isEstimatedScore: r.isEstimatedScore,
        ctx: r.ctx,
        providerKey: r.providerKey,
      }));
  };

  const pingModel = async (r) => {
    // Refresh config every ping cycle just in case
    const currentConfig = loadConfig();
    const enabled = isProviderEnabled(currentConfig, r.providerKey);

    if (bannedModels.some(b => b === r.modelId || b === `${r.providerKey}/${r.modelId}`)) {
      r.status = 'banned';
      return;
    }

    const minSweScore = currentConfig.minSweScore;
    const excludedProviders = currentConfig.excludedProviders || [];

    if (excludedProviders.includes(r.providerKey)) {
      r.status = 'excluded';
      return;
    }

    if (typeof minSweScore === 'number' && typeof r.intell === 'number' && r.intell < minSweScore) {
      r.status = 'excluded';
      return;
    }

    if (!enabled) {
      r.status = 'disabled';
      return;
    }

    const auth = await resolveProviderAuthToken(currentConfig, r.providerKey);
    const providerApiKey = auth.token;
    const providerUrl = resolveProviderUrl(currentConfig, r.providerKey, auth.providerUrlOverride, r.providerUrl);

    let pingResult = await ping(providerApiKey, r.modelId, providerUrl, r.providerKey);
    if (shouldRetryOptionalProviderWithBearer(currentConfig, r.providerKey, auth, pingResult.code, pingResult.errorMessage)) {
      pingResult = await ping(getApiKey(currentConfig, r.providerKey), r.modelId, providerUrl, r.providerKey);
    }

    const { code, ms, rateLimit, errorMessage } = pingResult;
    const now = Date.now();
    r.lastPingAt = now;
    r.pings.push({ ms, code, ts: now });
    if (r.pings.length > 50) r.pings.shift(); // keep history bounded
    // Store ping rate-limit data for display, but only if no authoritative
    // proxy-sourced data exists yet (proxy data has a `capturedAt` field).
    if (rateLimit && (!r.rateLimit || !r.rateLimit.capturedAt)) {
      r.rateLimit = rateLimit;
    }

    // Auto-expire stale wasRateLimited flag from proxy 429 responses.
    // If all reset times have passed, clear the flag so the model becomes
    // eligible for routing again. Also refresh with fresh ping data.
    if (r.rateLimit && r.rateLimit.wasRateLimited === true) {
      const now = Date.now();
      const resetReq = r.rateLimit.resetRequestsAt || 0;
      const resetTok = r.rateLimit.resetTokensAt || 0;
      const latestReset = Math.max(resetReq, resetTok);
      // Expire if: reset times have passed, or 60s since capture (fallback if no reset times)
      const fallbackExpiry = (r.rateLimit.capturedAt || 0) + 60_000;
      if ((latestReset > 0 && latestReset < now) || (latestReset === 0 && fallbackExpiry < now)) {
        r.rateLimit.wasRateLimited = false;
        // Overwrite with fresh ping data now that rate limit has expired
        if (rateLimit) {
          r.rateLimit = rateLimit;
        }
      }
    }

    if (code === '200') {
      r.status = 'up';
      r.httpCode = null;
      r.lastError = null;
    }
    else if (code === '000') {
      r.status = 'timeout';
      r.lastError = {
        code,
        message: 'Request timed out while pinging provider.',
        updatedAt: now,
      };
    }
    else if (code === 'ERR') {
      r.status = 'down';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Network error while contacting provider.',
        updatedAt: now,
      };
    }
    else if (code === '401') {
      r.status = 'noauth';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || 'Unauthorized. Check API key.',
        updatedAt: now,
      };
    }
    else {
      r.status = 'down';
      r.httpCode = code;
      r.lastError = {
        code,
        message: errorMessage || `HTTP ${code}`,
        updatedAt: now,
      };
    }

    // Fetch OpenRouter key-level rate limit (credits) during ping cycles.
    // This is a read-only GET that doesn't consume any rate-limit slots.
    if (r.providerKey === 'openrouter') {
      const keyRateLimit = await fetchOpenRouterRateLimit(providerApiKey);
      if (keyRateLimit) {
        // Merge with any existing proxy-captured rate limit data
        const merged = mergeRateLimits(r.rateLimit, keyRateLimit);
        // Propagate to all OpenRouter models (credits are per-API-key)
        for (const other of results) {
          if (other.providerKey === 'openrouter') {
            other.rateLimit = merged;
          }
        }
      }
    }
  };

  const triggerImmediateProviderPing = async (providerKey) => {
    if (!providerKey) return;
    if (providerKey === KILOCODE_PROVIDER_KEY) {
      await refreshKiloCodeModels(true);
    }
    if (providerKey === OPENCODE_PROVIDER_KEY) {
      await refreshOpenCodeModels(true);
    }
    if (providerKey === OPENROUTER_PROVIDER_KEY) {
      await refreshOpenRouterModels(true);
    }
    if (providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY) {
      await refreshOpenAICompatibleModels();
    }
    if (providerKey === OLLAMA_PROVIDER_KEY) {
      await refreshOllamaModels(true);
    }
    const providerModels = results.filter(r => r.providerKey === providerKey);
    if (providerModels.length === 0) return;
    void Promise.allSettled(providerModels.map(r => pingModel(r)));
  };

  const safeRefreshProviderModels = async (refreshFn) => {
    try {
      return await refreshFn();
    } catch {
      return [];
    }
  };

  const schedulePing = () => {
    setTimeout(async () => {
      await safeRefreshProviderModels(() => refreshKiloCodeModels());
      await safeRefreshProviderModels(() => refreshOpenCodeModels());
      await safeRefreshProviderModels(() => refreshOpenRouterModels());
      await safeRefreshProviderModels(() => refreshOpenAICompatibleModels());
      await safeRefreshProviderModels(() => refreshOllamaModels());
      const currentConfig = loadConfig();
      const now = Date.now();
      for (const r of results) {
        const pingIntervalMs = getProviderPingIntervalMs(currentConfig, r.providerKey);
        const lastActivityAt = Math.max(r.lastModelResponseAt || 0, r.lastPingAt || 0);
        if (now - lastActivityAt < pingIntervalMs) continue;
        pingModel(r).catch(() => { });
      }
      schedulePing();
    }, PING_INTERVAL);
  };

  const maybeRunAutoUpdate = async (force = false) => {
    if (autoUpdateInProgress) return { ok: false, message: 'Auto-update already in progress.' };

    const currentConfig = loadConfig();
    const state = normalizeAutoUpdateState(currentConfig);
    const enabled = state.enabled !== false;
    if (!enabled && !force) return { ok: true, message: 'Auto-update is disabled.' };

    const now = Date.now();
    const intervalMs = Math.max(1, Number(state.intervalHours) || 24) * 60 * 60 * 1000;
    const lastCheckMs = state.lastCheckAt ? Date.parse(state.lastCheckAt) : 0;
    if (!force && lastCheckMs && !Number.isNaN(lastCheckMs) && (now - lastCheckMs) < intervalMs) {
      return { ok: true, message: 'Update check skipped (too recent).' };
    }

    autoUpdateInProgress = true;
    try {
      const freshConfig = loadConfig();
      const freshState = normalizeAutoUpdateState(freshConfig);
      freshState.lastCheckAt = new Date().toISOString();
      freshState.lastError = null;
      saveConfig(freshConfig);

      const latest = await fetchLatestNpmVersionCached(force);
      if (!latest) {
        throw new Error('Could not fetch latest version from npm registry.');
      }

      if (!isVersionNewer(latest, APP_VERSION)) {
        return { ok: true, message: `Already up to date (v${APP_VERSION}).` };
      }

      console.log(chalk.cyan(`  📦 Update available: v${latest}. Starting update...`));

      const updateResult = runUpdateCommand(latest, true);
      if (!updateResult.ok) {
        const failedConfig = loadConfig();
        const failedState = normalizeAutoUpdateState(failedConfig);
        failedState.lastError = updateResult.message;
        saveConfig(failedConfig);
        console.error(chalk.red(`  ✖ Auto-update failed: ${updateResult.message}`));
        return updateResult;
      }

      const successConfig = loadConfig();
      const successState = normalizeAutoUpdateState(successConfig);
      successState.lastUpdateAt = new Date().toISOString();
      successState.lastVersionApplied = latest;
      successState.lastError = null;
      saveConfig(successConfig);
      APP_VERSION = latest;
      latestVersionCache.value = latest;
      latestVersionCache.fetchedAt = Date.now();
      console.log(chalk.green(`  ✓ Auto-updated modelrelay to v${latest}. Restarting in 2 seconds...`));

      // Use a platform-aware detached restart script to avoid port conflicts
      const spawnOptions = { detached: true, stdio: 'ignore' };
      if (process.platform === 'win32') {
        const autostartStatus = getAutostartStatus();
        const cmd = buildWindowsPostUpdateRestartCommand(!!autostartStatus?.configured);
        import('node:child_process').then(({ spawn }) => {
          spawn('cmd.exe', ['/d', '/s', '/c', cmd], spawnOptions).unref();
          setTimeout(() => process.exit(0), 2000);
        });
      } else {
        // On Unix, autostart systems (systemd/launchd) usually handle restarts automatically
        // if we just exit(0), as they are configured with 'Restart=always'.
        setTimeout(() => process.exit(0), 2000);
      }

      return { ok: true, message: `Updated to v${latest}. Server is restarting.` };
    } catch (err) {
      const failedConfig = loadConfig();
      const failedState = normalizeAutoUpdateState(failedConfig);
      failedState.lastError = err?.message || 'Auto-update failed unexpectedly.';
      saveConfig(failedConfig);
      console.error(chalk.red(`  ✖ Auto-update error: ${failedState.lastError}`));
      return { ok: false, message: failedState.lastError };
    } finally {
      autoUpdateInProgress = false;
    }
  };

  const scheduleAutoUpdate = () => {
    setTimeout(() => {
      maybeRunAutoUpdate().catch(() => { });
      scheduleAutoUpdate();
    }, 10 * 60_000);
  };

  process.stdout.write(chalk.dim('  ⏳ Initializing model health checks... '));
  await safeRefreshProviderModels(() => refreshKiloCodeModels(true));
  await safeRefreshProviderModels(() => refreshOpenRouterModels(true));
  await safeRefreshProviderModels(() => refreshOpenAICompatibleModels());
  await safeRefreshProviderModels(() => refreshOllamaModels(true));
  await Promise.all(results.map(r => pingModel(r)));
  console.log(chalk.green('Done!'));

  schedulePing();
  await maybeRunAutoUpdate();
  scheduleAutoUpdate();

  const app = express();
  const jsonBodyLimit = process.env.MODELRELAY_JSON_LIMIT || '10mb';

  app.use(express.static(path.join(__dirname, '../public')));
  app.use(express.json({ limit: jsonBodyLimit }));

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // API for Web UI
  app.get('/api/meta', async (req, res) => {
    const latestVersion = await fetchLatestNpmVersionCached();
    const updateAvailable = !!latestVersion && isVersionNewer(latestVersion, APP_VERSION);
    const autoUpdate = getAutoUpdateStatusSnapshot();
    res.json({
      version: APP_VERSION,
      latestVersion: latestVersion || null,
      updateAvailable,
      autoUpdate,
    });
  });

  app.get('/api/models', (req, res) => {
    const currentConfig = loadConfig();
    const pinningMode = getPinningMode(currentConfig);
    const qosMap = computeQoSMap(results);
    const formatted = results.map(r => {
      const lastPing = r.pings.length > 0 ? r.pings[r.pings.length - 1] : null;
      const now = Date.now();
      const rateLimit = r.rateLimit || null;
      let isRateLimited = false;
      if (rateLimit) {
        if (rateLimit.wasRateLimited === true) {
          isRateLimited = true;
        }
        if (rateLimit.creditLimit > 0 && rateLimit.creditRemaining != null && rateLimit.creditRemaining <= 0) {
          isRateLimited = true;
        }
        if (rateLimit.resetRequestsAt && rateLimit.resetRequestsAt <= now) {
          // informative only; status is refreshed by ping cycle
        }
      }

      return {
        ...r,
        avg: getAvg(r),
        uptime: getUptime(r),
        verdict: getVerdict(r),
        qos: isRateLimited ? 0 : (qosMap.get(r) || 0),
        isRateLimited,
        lastPing: lastPing ? lastPing.ms : null,
        rateLimit,
        pings: r.pings  // full history (up to 50 entries) for the dashboard drawer
      };
    });
    const autoBest = findBestModel(results);
    const pinnedMatches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey);
    const pinnedResult = getPinnedModelCandidate(results, pinnedModelId, pinningMode, [], pinnedProviderKey);
    const pinnedModelIds = pinnedMatches.map(r => r.modelId);
    const pinnedRowKeys = pinnedMatches.map(toPinnedRowKey);
    const effectiveBest = pinnedResult || autoBest;
    res.json({ models: formatted, best: effectiveBest ? effectiveBest.modelId : null, pinnedModelId, pinnedProviderKey, pinnedModelIds, pinnedRowKeys, pinningMode });
  });

  app.get('/api/config', (req, res) => {
    const currentConfig = loadConfig();
    const providers = Object.keys(sources).map(key => {
      const pool = getApiKeyPool(currentConfig, key)
      const hasMultiple = pool.length > 1
      return {
        key,
        name: sources[key].name,
        enabled: isProviderEnabled(currentConfig, key),
        hasKey: pool.length > 0,
        signupUrl: API_KEY_SIGNUP_URLS[key] || null,
        supportsOptionalBearerAuth: isProviderAuthOptional(currentConfig, key),
        useBearerAuth: isProviderAuthOptional(currentConfig, key) ? isProviderBearerAuthEnabled(currentConfig, key) : null,
        pingIntervalMinutes: currentConfig.providers?.[key]?.pingIntervalMinutes || null,
        baseUrl: (key === OPENAI_COMPATIBLE_PROVIDER_KEY || key === OLLAMA_PROVIDER_KEY) ? (getProviderBaseUrl(currentConfig, key) || '') : null,
        modelId: (key === OPENAI_COMPATIBLE_PROVIDER_KEY || key === OLLAMA_PROVIDER_KEY) ? (getProviderModelId(currentConfig, key) || '') : null,
        hasMultipleKeys: hasMultiple,
        maxTurns: getMaxTurns(currentConfig, key),
        apiKeyPool: pool.map((k, i) => {
          const masked = k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : `${k.slice(0, 2)}***`
          return { index: i, masked, key: k }
        }),
      }
    });
    res.json(providers);
  });

  app.post('/api/providers/:providerKey/refresh', async (req, res) => {
    const { providerKey } = req.params;
    if (!sources[providerKey]) {
      return res.status(404).json({ error: 'Unknown provider.' });
    }

    try {
      const models = await refreshProviderModelsForApi(providerKey);
      const providerModels = results.filter(r => r.providerKey === providerKey);
      void Promise.allSettled(providerModels.map(r => pingModel(r)));
      return res.json({
        success: true,
        providerKey,
        providerName: sources[providerKey].name,
        models: models.map(model => ({
          modelId: model.modelId,
          label: model.label,
          ctx: model.ctx,
          intell: model.intell,
          isEstimatedScore: model.isEstimatedScore === true,
        })),
      });
    } catch (err) {
      return res.status(502).json({
        success: false,
        providerKey,
        providerName: sources[providerKey].name,
        error: describeSyncError(err),
      });
    }
  });

  app.get('/api/pinning', (req, res) => {
    const currentConfig = loadConfig();
    res.json({ pinningMode: getPinningMode(currentConfig) });
  });

  app.get('/api/config/export', (req, res) => {
    const currentConfig = loadConfig();
    res.json({ payload: exportConfigToken(currentConfig) });
  });

  app.post('/api/config/import', (req, res) => {
    const { payload } = req.body || {};
    if (typeof payload !== 'string' || !payload.trim()) {
      return res.status(400).json({ error: 'payload must be a non-empty string.' });
    }

    let importedConfig;
    try {
      importedConfig = importConfigToken(payload);
    } catch (err) {
      return res.status(400).json({ error: err?.message || 'Invalid config payload.' });
    }

    saveConfig(importedConfig);
    bannedModels = Array.isArray(importedConfig.bannedModels) ? [...new Set(importedConfig.bannedModels)] : [];

    const providerKeys = Object.keys(sources);
    void Promise.allSettled(providerKeys.map(key => triggerImmediateProviderPing(key)));

    return res.json({
      success: true,
      importedProviders: Object.keys(importedConfig.providers || {}).length,
      importedApiKeys: Object.keys(importedConfig.apiKeys || {}).length,
    });
  });

  app.get('/api/account-status', (req, res) => {
    const currentConfig = loadConfig()
    res.json(getAccountStatus(currentConfig))
  })

  app.get('/api/autoupdate', (req, res) => {
    const cfg = loadConfig();
    const state = normalizeAutoUpdateState(cfg);
    res.json({
      enabled: state.enabled !== false,
      intervalHours: state.intervalHours,
      lastCheckAt: state.lastCheckAt || null,
      lastUpdateAt: state.lastUpdateAt || null,
      lastVersionApplied: state.lastVersionApplied || null,
      lastError: state.lastError || null,
      version: APP_VERSION,
    });
  });

  app.post('/api/autoupdate', async (req, res) => {
    const { enabled, intervalHours, forceCheck } = req.body || {};
    const cfg = loadConfig();
    const state = normalizeAutoUpdateState(cfg);

    if (enabled !== undefined) {
      state.enabled = enabled !== false;
    }

    if (intervalHours !== undefined) {
      const parsed = Number(intervalHours);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'intervalHours must be a positive number.' });
      }
      state.intervalHours = parsed;
    }

    saveConfig(cfg);

    if (forceCheck) {
      // For force checks from the UI, we must NOT await the full update because
      // runNpmUpdate uses spawnSync which blocks the event loop (potentially 30+ seconds).
      // This would cause the browser fetch to time out with "Failed to fetch".
      // Instead: verify an update is available, respond immediately, then run the
      // blocking install in the background.
      try {
        if (autoUpdateInProgress) {
          return res.json({ success: true, updateResult: { ok: false, message: 'Auto-update already in progress.' }, autoUpdate: getAutoUpdateStatusSnapshot() });
        }
        if (isRunningFromSource()) {
          return res.json({ success: true, updateResult: { ok: false, message: 'Running from source (Git). Auto-update disabled. Please use "git pull" to update.' }, autoUpdate: getAutoUpdateStatusSnapshot() });
        }
        const latest = await fetchLatestNpmVersionCached(true);
        if (!latest) {
          return res.json({ success: true, updateResult: { ok: false, message: 'Could not fetch latest version from npm registry.' }, autoUpdate: getAutoUpdateStatusSnapshot() });
        }
        if (!isVersionNewer(latest, APP_VERSION)) {
          return res.json({ success: true, updateResult: { ok: true, message: `Already up to date (v${APP_VERSION}).` }, autoUpdate: getAutoUpdateStatusSnapshot() });
        }
        // An update IS available — respond immediately, then run the blocking install
        res.json({
          success: true,
          updateResult: { ok: true, message: `Update to v${latest} starting. Server will restart shortly.` },
          autoUpdate: getAutoUpdateStatusSnapshot(),
        });
        // Defer the blocking update to the next tick so the response is flushed first
        setTimeout(() => {
          maybeRunAutoUpdate(true).catch((err) => {
            console.error(chalk.red(`  ✖ Deferred auto-update error: ${err?.message || err}`));
          });
        }, 0);
      } catch (err) {
        return res.json({ success: true, updateResult: { ok: false, message: err?.message || 'Unexpected error.' }, autoUpdate: getAutoUpdateStatusSnapshot() });
      }
      return;
    }

    // Non-force: just trigger in the background (e.g. toggling enabled/interval settings)
    if (state.enabled !== false) {
      maybeRunAutoUpdate().catch(() => { });
    }

    return res.json({
      success: true,
      updateResult: null,
      autoUpdate: {
        enabled: state.enabled !== false,
        intervalHours: state.intervalHours,
        lastCheckAt: state.lastCheckAt || null,
        lastUpdateAt: state.lastUpdateAt || null,
        lastVersionApplied: state.lastVersionApplied || null,
        lastError: state.lastError || null,
      },
    });
  });

  app.post('/api/config', (req, res) => {
    const { providerKey, apiKey, enabled, useBearerAuth, pingIntervalMinutes, baseUrl, modelId, pinningMode, maxTurns, apiKeys } = req.body;
    const currentConfig = loadConfig();
    const wasEnabled = isProviderEnabled(currentConfig, providerKey);

    if (apiKey !== undefined) {
      if (apiKey === null || apiKey === '') {
        delete currentConfig.apiKeys[providerKey];
      } else {
        currentConfig.apiKeys[providerKey] = String(apiKey).trim();
      }
    }

    if (apiKeys !== undefined && Array.isArray(apiKeys)) {
      const validKeys = apiKeys.filter(k => typeof k === 'string' && k.trim())
      if (validKeys.length === 0) {
        delete currentConfig.apiKeys[providerKey];
      } else if (validKeys.length === 1) {
        currentConfig.apiKeys[providerKey] = validKeys[0].trim()
      } else {
        currentConfig.apiKeys[providerKey] = validKeys.map(k => k.trim())
      }
    }

    if (enabled !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      currentConfig.providers[providerKey].enabled = enabled;
    }

    if (useBearerAuth !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      currentConfig.providers[providerKey].useBearerAuth = useBearerAuth !== false;
    }

    if (baseUrl !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      if (baseUrl === null || baseUrl === '') delete currentConfig.providers[providerKey].baseUrl;
      else currentConfig.providers[providerKey].baseUrl = String(baseUrl).trim();
    }

    if (modelId !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      if (modelId === null || modelId === '') delete currentConfig.providers[providerKey].modelId;
      else currentConfig.providers[providerKey].modelId = String(modelId).trim();
    }

    if (pingIntervalMinutes !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      if (pingIntervalMinutes === null || pingIntervalMinutes === '' || pingIntervalMinutes === 0) {
        delete currentConfig.providers[providerKey].pingIntervalMinutes;
      } else {
        const parsed = Number(pingIntervalMinutes);
        if (Number.isFinite(parsed) && parsed >= 1) {
          currentConfig.providers[providerKey].pingIntervalMinutes = parsed;
        }
      }
    }

    if (maxTurns !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      const parsed = Math.floor(Number(maxTurns))
      if (!Number.isFinite(parsed) || parsed <= 0) {
        delete currentConfig.providers[providerKey].maxTurns
      } else {
        currentConfig.providers[providerKey].maxTurns = parsed
      }
    }

    if (pinningMode !== undefined) {
      currentConfig.pinningMode = pinningMode === 'exact' ? 'exact' : 'canonical';
    }

    saveConfig(currentConfig);

    const isNowEnabled = isProviderEnabled(currentConfig, providerKey);
    if (enabled === true && !wasEnabled && isNowEnabled) {
      void triggerImmediateProviderPing(providerKey);
    } else if (providerKey === OPENCODE_PROVIDER_KEY && apiKey !== undefined) {
      void triggerImmediateProviderPing(providerKey);
    } else if (isProviderAuthOptional(currentConfig, providerKey) && (apiKey !== undefined || useBearerAuth !== undefined)) {
      void triggerImmediateProviderPing(providerKey);
    } else if (providerKey === OPENROUTER_PROVIDER_KEY && apiKey !== undefined) {
      void triggerImmediateProviderPing(providerKey);
    } else if ((providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY || providerKey === OLLAMA_PROVIDER_KEY) && (apiKey !== undefined || baseUrl !== undefined || modelId !== undefined)) {
      void triggerImmediateProviderPing(providerKey);
    }

    res.json({ success: true });
  });

  app.get('/api/filter-rules', (req, res) => {
    const currentConfig = loadConfig();
    res.json({
      minSweScore: currentConfig.minSweScore,
      excludedProviders: currentConfig.excludedProviders || [],
    });
  });

  app.post('/api/filter-rules', (req, res) => {
    const { minSweScore, excludedProviders } = req.body;
    const currentConfig = loadConfig();

    if (minSweScore !== undefined) {
      if (minSweScore === null || minSweScore === '') {
        currentConfig.minSweScore = null;
      } else {
        const parsed = Number(minSweScore);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
          currentConfig.minSweScore = parsed;
        } else {
          return res.status(400).json({ error: 'minSweScore must be a number between 0 and 1, or null.' });
        }
      }
    }

    if (excludedProviders !== undefined) {
      if (Array.isArray(excludedProviders)) {
        currentConfig.excludedProviders = excludedProviders.filter(p => typeof p === 'string');
      } else {
        return res.status(400).json({ error: 'excludedProviders must be an array of provider keys.' });
      }
    }

    saveConfig(currentConfig);

    res.json({
      success: true,
      minSweScore: currentConfig.minSweScore,
      excludedProviders: currentConfig.excludedProviders || [],
    });
  });

  app.post('/api/models/ban', (req, res) => {
    const { modelId, banned } = req.body;
    if (!modelId) return res.status(400).json({ error: 'Missing modelId' });

    const currentConfig = loadConfig();
    let currentBans = currentConfig.bannedModels || [];

    if (banned) {
      if (!currentBans.includes(modelId)) currentBans.push(modelId);
      if (!bannedModels.includes(modelId)) bannedModels.push(modelId);
    } else {
      currentBans = currentBans.filter(m => m !== modelId);
      bannedModels = bannedModels.filter(m => m !== modelId);
    }

    currentConfig.bannedModels = currentBans;
    saveConfig(currentConfig);

    // Apply status change immediately
    const model = results.find(r => r.modelId === modelId);
    if (model) {
      if (banned) {
        model.status = 'banned';
      } else {
        model.status = 'pending'; // Let the next ping figure it out
        model.pings = [];
      }
    }

    // If the banned model was pinned, clear the pin
    if (banned && pinnedModelId === modelId) {
      pinnedModelId = null;
      pinnedProviderKey = null;
    }

    res.json({ success: true, bannedModels: currentBans });
  });

  app.post('/api/models/ping', async (req, res) => {
    const { modelId } = req.body || {};
    if (!modelId) return res.status(400).json({ error: 'Missing modelId' });

    const model = results.find(r => r.modelId === modelId);
    if (!model) return res.status(404).json({ error: 'Model not found' });

    try {
      await pingModel(model);
      res.json({
        success: true,
        model: {
          modelId: model.modelId,
          status: model.status,
          avg: getAvg(model),
          uptime: getUptime(model),
          verdict: getVerdict(model),
          lastPing: model.pings.length > 0 ? model.pings[model.pings.length - 1].ms : null,
          pings: model.pings,
          httpCode: model.httpCode,
        },
      });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to ping model' });
    }
  });

  const LOGS_PATH = join(homedir(), '.modelrelay-logs.json');
  const MAX_DISK_LOGS = 200;

  // Load persisted logs from disk on startup
  let requestLogs = [];
  if (existsSync(LOGS_PATH)) {
    try {
      const raw = readFileSync(LOGS_PATH, 'utf8');
      requestLogs = JSON.parse(raw);
      if (!Array.isArray(requestLogs)) requestLogs = [];
      console.log(chalk.dim(`  📋 Loaded ${requestLogs.length} persisted log entries`));
    } catch {
      requestLogs = [];
    }
  }

  function saveLogs() {
    try {
      const toSave = requestLogs.slice(0, MAX_DISK_LOGS);
      writeFileSync(LOGS_PATH, JSON.stringify(toSave, null, 2), { mode: 0o600 });
    } catch { /* silently fail */ }
  }

  app.get('/api/logs', (req, res) => {
    res.json(requestLogs);
  });

  // GET current pinned model
  app.get('/api/pinned', (req, res) => {
    const currentConfig = loadConfig();
    const pinningMode = getPinningMode(currentConfig);
    const pinnedMatches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey);
    res.json({
      pinnedModelId,
      pinnedProviderKey,
      pinnedModelIds: pinnedMatches.map(r => r.modelId),
      pinnedRowKeys: pinnedMatches.map(toPinnedRowKey),
      pinningMode,
    });
  });

  // POST to set or clear the pinned model
  app.post('/api/pinned', (req, res) => {
    const currentConfig = loadConfig();
    const pinningMode = getPinningMode(currentConfig);
    const { modelId, providerKey } = req.body;
    // modelId = null/undefined clears the pin (auto mode)
    pinnedModelId = modelId || null;
    pinnedProviderKey = modelId ? (providerKey || null) : null;
    console.log(chalk.cyan(`  [Router] 📌 Pinned model set to: ${pinnedModelId || '(auto)'}`));
    const pinnedMatches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey);
    res.json({
      success: true,
      pinnedModelId,
      pinnedProviderKey,
      pinnedModelIds: pinnedMatches.map(r => r.modelId),
      pinnedRowKeys: pinnedMatches.map(toPinnedRowKey),
      pinningMode,
    });
  });

  // Proxy endpoint
  app.get('/v1/models', (req, res) => {
    const groups = buildModelGroups(results, canonicalizeModelId)
    const data = [
      {
        id: 'auto-fastest',
        name: 'Auto Fastest',
        object: "model",
        created: Date.now(),
        owned_by: 'router'
      },
      ...groups.map(group => ({
        id: group.id,
        name: group.label,
        object: "model",
        created: Date.now(),
        owned_by: 'relay'
      }))
    ]

    res.json({
      object: "list",
      data
    });
  });

  const captureProxyRateLimit = async (model, response, providerApiKey) => {
    const rateLimit = {};
    const rh = response.headers;
    const LR = rh.get('x-ratelimit-limit-requests'); if (LR) rateLimit.limitRequests = parseInt(LR);
    const RR = rh.get('x-ratelimit-remaining-requests'); if (RR) rateLimit.remainingRequests = parseInt(RR);
    const LT = rh.get('x-ratelimit-limit-tokens'); if (LT) rateLimit.limitTokens = parseInt(LT);
    const RT = rh.get('x-ratelimit-remaining-tokens'); if (RT) rateLimit.remainingTokens = parseInt(RT);

    const resetReq = rh.get('x-ratelimit-reset-requests');
    const resetTok = rh.get('x-ratelimit-reset-tokens');
    if (resetReq) {
      const ms = parseDurationMs(resetReq);
      if (ms != null) rateLimit.resetRequestsAt = Date.now() + ms;
    }
    if (resetTok) {
      const ms = parseDurationMs(resetTok);
      if (ms != null) rateLimit.resetTokensAt = Date.now() + ms;
    }

    rateLimit.wasRateLimited = response.status === 429;
    rateLimit.capturedAt = Date.now();

    if (Object.keys(rateLimit).length > 0) {
      model.rateLimit = rateLimit;
      for (const r of results) {
        if (r.providerKey === model.providerKey) {
          r.rateLimit = rateLimit;
        }
      }
    }

    if (model.providerKey === 'openrouter') {
      const keyRateLimit = await fetchOpenRouterRateLimit(providerApiKey);
      if (keyRateLimit) {
        const merged = mergeRateLimits(model.rateLimit, keyRateLimit);
        for (const r of results) {
          if (r.providerKey === 'openrouter') {
            r.rateLimit = merged;
          }
        }
      }
    }
  };

  app.post('/v1/chat/completions', async (req, res) => {
    let logEntry = null;
    try {
      const payload = req.body;
      const attemptedModelIds = new Set();
      const attempts = [];
      const requestedModels = filterModelsByRequested(results, payload.model, canonicalizeModelId);

      if (payload.model && payload.model !== 'auto-fastest' && requestedModels.length === 0) {
        return res.status(404).json({ error: { message: `Requested model not found: ${payload.model}` } });
      }

      const pickNextModel = () => {
        if (pinnedModelId) {
          const pinningMode = getPinningMode(loadConfig());
          const pinned = getPinnedModelCandidate(results, pinnedModelId, pinningMode, Array.from(attemptedModelIds), pinnedProviderKey);
          if (pinned) {
            return pinned;
          }
        }

        const ranked = rankModelsForRouting(requestedModels, Array.from(attemptedModelIds));
        return ranked[0] || null;
      };

      logEntry = {
        timestamp: new Date().toISOString(),
        model: '(pending)',
        provider: '(pending)',
        messages: payload.messages || [],
        duration: null,
        ttft: null,
        status: 'pending',
        response: null,
        prompt_tokens: null,
        completion_tokens: null,
        tool_calls: null,
        function_call: null,
        attempts,
        retryCount: 0,
      };

      requestLogs.unshift(logEntry);
      if (requestLogs.length > 50) requestLogs.length = 50;

      if (enableLog) {
        console.log(chalk.dim('  ┌─────────────────── REQUEST PAYLOAD ───────────────────'));
        for (const msg of logEntry.messages) {
          const roleStr = msg.role.toUpperCase().padEnd(9);
          const color = msg.role === 'system' ? chalk.magenta : (msg.role === 'user' ? chalk.blue : chalk.green);
          let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

          if (content.length > 500) {
            content = content.substring(0, 500) + chalk.italic(' ...[truncated]');
          }
          console.log(color(`  │ [${roleStr}] ${content.replace(/\n/g, '\n  │           ')}`));
        }
        console.log(chalk.dim('  └───────────────────────────────────────────────────────\n'));
      }

      let selectedModel = null;
      let selectedResponse = null;
      let selectedT0 = 0;

      for (let retry = 0; retry <= MAX_PROACTIVE_RETRIES; retry++) {
        const best = pickNextModel();
        if (!best) break;

        attemptedModelIds.add(best.modelId);
        payload.model = best.modelId;

        const currentConfig = loadConfig();
        // Multi-account round-robin: use rotated key if pool configured
        const rotKey = getNextApiKey(currentConfig, best.providerKey)
        let providerAuth = rotKey
          ? { token: rotKey, authSource: 'api-key', providerUrlOverride: null }
          : await resolveProviderAuthToken(currentConfig, best.providerKey);
        let providerUrl = resolveProviderUrl(currentConfig, best.providerKey, providerAuth.providerUrlOverride, best.providerUrl);

        const attemptMeta = {
          index: retry + 1,
          model: best.modelId,
          provider: best.providerKey,
          status: 'pending',
          duration: null,
          retryable: false,
        };

        if (!providerAuth.token && !isProviderAuthOptional(currentConfig, best.providerKey)) {
          attemptMeta.status = 'NO_KEY';
          attemptMeta.error = `No API key configured for provider ${best.providerKey}.`;
          attempts.push(attemptMeta);
          continue;
        }

        if (!providerUrl) {
          attemptMeta.status = 'NO_URL';
          attemptMeta.error = `No provider URL configured for provider ${best.providerKey}.`;
          attempts.push(attemptMeta);
          continue;
        }

        console.log(chalk.dim(`  [Router] ➡️ Proxying request (attempt ${retry + 1}/${MAX_PROACTIVE_RETRIES + 1}) to ${best.providerKey}/${best.modelId} (${best.status === 'up' && best.pings.length > 0 ? best.pings[best.pings.length - 1].ms + 'ms' : 'fallback'})`));

        let headers = buildProviderRequestHeaders(best.providerKey, {
          apiKey: providerAuth.token,
          sessionId: makeOpencodeHeaderId('ses'),
          requestId: makeOpencodeHeaderId('req'),
        });

        const t0 = performance.now();
        let response;
        try {
          response = await fetch(providerUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
          });

          if (shouldRetryOptionalProviderWithBearer(currentConfig, best.providerKey, providerAuth, String(response.status), null)) {
            const fallbackToken = getNextApiKey(currentConfig, best.providerKey);
            if (fallbackToken) {
              providerAuth = { token: fallbackToken, authSource: 'api-key', providerUrlOverride: providerAuth.providerUrlOverride };
              headers = buildProviderRequestHeaders(best.providerKey, {
                apiKey: fallbackToken,
                sessionId: makeOpencodeHeaderId('ses'),
                requestId: makeOpencodeHeaderId('req'),
              });
              response = await fetch(providerUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
              });
            }
          }
        } catch (err) {
          attemptMeta.duration = Math.round(performance.now() - t0);
          attemptMeta.status = 'ERR';
          attemptMeta.error = err?.message || 'Unknown network error';
          attemptMeta.retryable = true;
          attempts.push(attemptMeta);
          if (retry === MAX_PROACTIVE_RETRIES) {
            throw err;
          }
          continue;
        }

        attemptMeta.duration = Math.round(performance.now() - t0);
        attemptMeta.status = String(response.status);
        attemptMeta.retryable = isRetryableProxyStatus(response.status);
        attempts.push(attemptMeta);

        // On 429: mark this account as rate-limited so next retry picks a different key
        if (response.status === 429 && hasMultipleKeys(currentConfig, best.providerKey)) {
          markRateLimited(best.providerKey, providerAuth.token)
        }

        await captureProxyRateLimit(best, response, providerAuth.token);

        if (response.ok) {
          const now = Date.now();
          best.lastModelResponseAt = now;
          best.pings.push({ ms: attemptMeta.duration, code: '200', ts: now });
          if (best.pings.length > 50) best.pings.shift();
          best.status = 'up';
          best.httpCode = null;
          best.lastError = null;
          selectedModel = best;
          selectedResponse = response;
          selectedT0 = t0;
          break;
        }

        if (attemptMeta.retryable && retry < MAX_PROACTIVE_RETRIES) {
          let retryBody = '';
          try {
            retryBody = await response.text();
            attemptMeta.error = retryBody;
          } catch {
            attemptMeta.error = '<Could not read retry response body>';
          }
          console.log(chalk.yellow(`  [Router] 🔁 Attempt failed with HTTP ${response.status}; retrying with a different model.`));
          continue;
        }

        selectedModel = best;
        selectedResponse = response;
        selectedT0 = t0;
        break;
      }

      if (!selectedResponse || !selectedModel) {
        logEntry.status = '503';
        logEntry.error = { message: 'No models currently available for this request.', attempts };
        logEntry.retryCount = Math.max(0, attempts.length - 1);
        saveLogs();
        return res.status(503).json({ error: { message: 'No models currently available for this request.' } });
      }

      logEntry.model = selectedModel.modelId;
      logEntry.provider = selectedModel.providerKey;
      logEntry.duration = Math.round(performance.now() - selectedT0);
      logEntry.status = String(selectedResponse.status);
      logEntry.retryCount = Math.max(0, attempts.length - 1);

      res.status(selectedResponse.status);

      for (const [key, value] of selectedResponse.headers.entries()) {
        if (['content-type', 'transfer-encoding', 'cache-control', 'connection'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      if (selectedResponse.body) {
        const { Readable, Transform } = await import('stream');

        let responseBodyText = '';
        let ttftCaptured = false;
        const MAX_LOG_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit for logging

        const captureStream = new Transform({
          transform(chunk, encoding, callback) {
            if (!ttftCaptured) {
              ttftCaptured = true;
              logEntry.ttft = Math.round(performance.now() - selectedT0);
            }
            // Only accumulate up to limit to prevent OOM
            if (responseBodyText.length < MAX_LOG_BODY_SIZE) {
              responseBodyText += chunk.toString();
            }
            callback(null, chunk);
          },
          flush(callback) {
            try {
              const wasTruncated = responseBodyText.length >= MAX_LOG_BODY_SIZE;

              if (selectedResponse.status >= 400) {
                try {
                  const errorData = JSON.parse(responseBodyText);
                  logEntry.error = errorData;
                } catch {
                  logEntry.error = responseBodyText + (wasTruncated ? '... (truncated)' : '');
                }
              } else if (payload.stream) {
                const lines = responseBodyText.split('\n');
                let fullContent = '';
                let toolCalls = [];
                let functionCall = null;
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                      const data = JSON.parse(trimmed.slice(6));
                      captureResolvedModel(logEntry, data);
                      if (data.choices && data.choices[0] && data.choices[0].delta) {
                        const delta = data.choices[0].delta;
                        if (delta.content) fullContent += delta.content;
                        if (delta.tool_calls) {
                          for (const tc of delta.tool_calls) {
                            if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
                            if (tc.id) toolCalls[tc.index].id = tc.id;
                            if (tc.type) toolCalls[tc.index].type = tc.type;
                            if (tc.function) {
                              if (tc.function.name) toolCalls[tc.index].function.name += tc.function.name;
                              if (tc.function.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                            }
                          }
                        }
                        if (delta.function_call) {
                          if (!functionCall) functionCall = { name: '', arguments: '' };
                          if (delta.function_call.name) functionCall.name += delta.function_call.name;
                          if (delta.function_call.arguments) functionCall.arguments += delta.function_call.arguments;
                        }
                      }
                      if (data.usage) {
                        if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
                        if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
                      }
                    } catch (e) { }
                  }
                }
                if (fullContent) logEntry.response = fullContent;
                if (toolCalls.length > 0) {
                  logEntry.tool_calls = toolCalls.filter(Boolean).map(tc => {
                    if (tc.function && tc.function.arguments) {
                      try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                    }
                    return tc;
                  });
                }
                if (functionCall) {
                  if (functionCall.arguments) {
                    try { functionCall.arguments = JSON.parse(functionCall.arguments); } catch (e) { }
                  }
                  logEntry.function_call = functionCall;
                }
              } else {
                const data = JSON.parse(responseBodyText);
                captureResolvedModel(logEntry, data);
                if (data.choices && data.choices[0] && data.choices[0].message) {
                  const msg = data.choices[0].message;
                  if (msg.content) logEntry.response = msg.content;
                  if (msg.tool_calls) {
                    logEntry.tool_calls = msg.tool_calls.map(tc => {
                      if (tc.function && typeof tc.function.arguments === 'string') {
                        try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                      }
                      return tc;
                    });
                  }
                  if (msg.function_call) {
                    logEntry.function_call = { ...msg.function_call };
                    if (typeof logEntry.function_call.arguments === 'string') {
                      try { logEntry.function_call.arguments = JSON.parse(logEntry.function_call.arguments); } catch (e) { }
                    }
                  }
                }
                if (data.usage) {
                  if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
                  if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
                }
              }
            } catch (e) {
              logEntry.response = "<Could not parse response payload>";
            }
            saveLogs();
            callback();
          }
        });

        Readable.fromWeb(selectedResponse.body).pipe(captureStream).pipe(res);
      } else {
        const text = await selectedResponse.text();
        logEntry.ttft = logEntry.duration;
        if (selectedResponse.status >= 400) {
          try {
            logEntry.error = JSON.parse(text);
          } catch {
            logEntry.error = text;
          }
        } else {
          try {
            const data = JSON.parse(text);
            captureResolvedModel(logEntry, data);
            if (data.choices && data.choices[0] && data.choices[0].message) {
              const msg = data.choices[0].message;
              if (msg.content) logEntry.response = msg.content;
              if (msg.tool_calls) {
                logEntry.tool_calls = msg.tool_calls.map(tc => {
                  if (tc.function && typeof tc.function.arguments === 'string') {
                    try { tc.function.arguments = JSON.parse(tc.function.arguments); } catch (e) { }
                  }
                  return tc;
                });
              }
              if (msg.function_call) {
                logEntry.function_call = { ...msg.function_call };
                if (typeof logEntry.function_call.arguments === 'string') {
                  try { logEntry.function_call.arguments = JSON.parse(logEntry.function_call.arguments); } catch (e) { }
                }
              }
            }
            if (data.usage) {
              if (data.usage.prompt_tokens != null) logEntry.prompt_tokens = data.usage.prompt_tokens;
              if (data.usage.completion_tokens != null) logEntry.completion_tokens = data.usage.completion_tokens;
            }
          } catch (e) { }
        }
        res.end(text);
        saveLogs();
      }
    } catch (e) {
      if (logEntry) {
        logEntry.status = 'err';
        logEntry.error = e.message;
      }
      console.error(chalk.red(`  [Router] Error processing request: ${e.message}`));
      if (logEntry) saveLogs();
      res.status(400).json({ error: { message: e.message } });
    }
  });

  app.listen(port, () => {
    const lanIp = getPreferredLanIpv4Address();
    console.log();
    console.log(chalk.green(`  ✅ Web UI active at ${chalk.bold(`http://localhost:${port}`)}`));
    if (lanIp) {
      console.log(chalk.green(`  ✅ Visit ${chalk.bold(`http://${lanIp}:${port}`)} to access the Web UI from another computer on your network.`));
    }
    console.log(chalk.green(`  ✅ Router proxy active at ${chalk.bold(`http://localhost:${port}/v1`)}`));
    console.log(chalk.dim(`  Usage in OpenCode/Cursor:`));
    console.log(chalk.dim(`  - Provider Base URL: http://localhost:${port}/v1`));
    console.log(chalk.dim(`  - API Key: (anything, ignored)`));
    console.log(chalk.dim(`  - Model: (anything, ignored)`));
    console.log();
  });

}








