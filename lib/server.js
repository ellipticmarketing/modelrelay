import express from 'express';
import chalk from 'chalk';
import path, { join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { MODELS, sources, canonicalizeModelId, getPreferredModelContext, getPreferredModelLabel, getScore, resolveAliasedModelId } from '../sources.js';
import { API_KEY_SIGNUP_URLS } from './providerLinks.js';
import { getApiKey, getApiKeyPool, getMaxTurns, getPinningMode, getProviderBaseUrl, getProviderModelId, hasMultipleKeys, isProviderEnabled, getProviderPingIntervalMs, isAutoPingEnabled, loadConfig, saveConfig, exportConfigToken, importConfigToken, isOpenAICompatibleInstanceKey, getBaseProviderKey, listOpenAICompatibleEndpoints, upsertOpenAICompatibleEndpoint, removeOpenAICompatibleEndpoint, buildOpenAICompatibleInstanceKey, getOpenAICompatibleInstanceId } from './config.js';
import { buildModelGroups, computeQoSMap, findBestModel, getAvg, getUptime, getVerdict, isRetryableProxyStatus, rankModelsForRouting, getRoutingModelKey, parseOpenRouterKeyRateLimit, filterModelsByRequested, selectNextApiKeyFromPool } from './utils.js';
import { getPreferredLanIpv4Address } from './network.js';
import { createHash, randomUUID } from 'crypto';
import { getAutostartStatus } from './autostart.js';
import { buildWindowsPostUpdateRestartCommand, fetchLatestNpmVersion, isRunningFromSource, isVersionNewer, runUpdateCommand } from './update.js';
import * as anthropicAdapter from './anthropic-adapter.js';
import { setupAnthropicRoutes } from './anthropic-routes.js';

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
const OPENAI_COMPATIBLE_MODELS_REFRESH_MS = 30 * 60_000;
const OLLAMA_PROVIDER_KEY = 'ollama';
const OLLAMA_MODELS_REFRESH_MS = 60 * 60_000;
const OPENROUTER_PROVIDER_KEY = 'openrouter';
const KIRO_PROVIDER_KEY = 'kiro';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_MODELS_REFRESH_MS = 60 * 60_000;
const OPTIONAL_BEARER_AUTH_PROVIDERS = new Set([KILOCODE_PROVIDER_KEY, OPENCODE_PROVIDER_KEY]);
const OPENCODE_CLIENT_HEADER = 'cli';
// Kiro expects AWS SDK-style user-agent headers (mirrors OmniRoute's Kiro header profile).
const KIRO_SDK_USER_AGENT = 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0';
const KIRO_AMZ_USER_AGENT = 'aws-sdk-js/3.0.0 kiro-ide/1.0.0';
const KIRO_STREAM_ACCEPT = 'application/vnd.amazon.eventstream';
const KIRO_STREAMING_TARGET = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';
const KIRO_AUTH_SERVICE_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev';
const KIRO_SOCIAL_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const KIRO_SOCIAL_TOKEN_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token';
const KIRO_SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success';
const KIRO_OIDC_REGISTER_URL = 'https://oidc.us-east-1.amazonaws.com/client/register';
const KIRO_OIDC_DEVICE_AUTH_URL = 'https://oidc.us-east-1.amazonaws.com/device_authorization';
const KIRO_OIDC_TOKEN_URL = 'https://oidc.us-east-1.amazonaws.com/token';
const KIRO_BUILDER_ID_START_URL = 'https://view.awsapps.com/start';
const KIRO_OIDC_ISSUER_URL = 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6';
const KIRO_OIDC_SCOPES = ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'];
const KIRO_OIDC_GRANT_TYPES = ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'];
const KIRO_REFRESH_TOKEN_PREFIX = 'aorAAAAAG';
const KIRO_TOKEN_EXPIRY_SKEW_MS = 60_000;
const KIRO_DEFAULT_TOKEN_EXPIRY_MS = 50 * 60_000;
const KIRO_BROWSER_AUTH_PROVIDERS = new Set(['google', 'github']);
const KIRO_MAX_CONTEXT_TOKENS = 200_000; // Kiro/Claude model max context window for usage estimation

const DEFAULT_DYNAMIC_MODEL_INTELL = 0.45;
const DEFAULT_DYNAMIC_MODEL_CTX = '128k';
const EXCLUDED_DYNAMIC_MODEL_BASE_IDS = new Set([
  'meta-llama/llama-guard-4-12b',
  'nvidia/nemotron-3.5-content-safety',
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
let _kiroOAuthCache = null;
let _kiroRefreshTokenDiscoveryCache = { token: null, checkedAt: 0 };
// Server-side store for in-progress device auth flows (clientSecret never leaves the server)
const _kiroDeviceFlows = new Map();
const _kiroSocialFlows = new Map();
const KIRO_DISCOVERY_CACHE_MS = 30_000;
const KIRO_SOCIAL_FLOW_EXPIRY_MS = 10 * 60_000;
const KIRO_CONVERSATION_NAMESPACE = '34f7193f-561d-4050-bc84-9547d953d6bf';
const KIRO_CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  KIRO_CRC32_TABLE[i] = c >>> 0;
}

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

export function getPinnedModelCandidate(results, pinnedModelId, pinningMode = 'canonical', attemptedModelKeys = [], pinnedProviderKey = null) {
  const attempted = new Set(attemptedModelKeys);
  const matches = getPinnedModelMatches(results, pinnedModelId, pinningMode, pinnedProviderKey)
    .filter(r => r.status !== 'banned' && r.status !== 'disabled' && !attempted.has(getRoutingModelKey(r)) && !attempted.has(r.modelId));
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
  return buildOpenAICompatibleResourceUrl(resourceUrl, '/chat/completions');
}

export function buildOpenAICompatibleModelsListUrl(resourceUrl) {
  return buildOpenAICompatibleResourceUrl(resourceUrl, '/models');
}

function buildOpenAICompatibleResourceUrl(resourceUrl, suffix) {
  if (!resourceUrl || typeof resourceUrl !== 'string') return null;
  const trimmed = resourceUrl.trim();
  if (!trimmed) return null;

  let urlText = trimmed;
  if (!/^https?:\/\//i.test(urlText)) {
    urlText = 'https://' + urlText;
  }

  try {
    const parsed = new URL(urlText);
    let pathname = (parsed.pathname || '/').replace(/\/+$/, '');

    // 📖 If the configured URL already names a specific OpenAI v1 verb,
    // 📖 strip it so `suffix` lands at the v1 root.
    if (pathname.endsWith('/chat/completions')) {
      pathname = pathname.slice(0, -'/chat/completions'.length);
    } else if (pathname.endsWith('/models')) {
      pathname = pathname.slice(0, -'/models'.length);
    }

    if (pathname.endsWith('/v1')) {
      parsed.pathname = pathname + suffix;
      return parsed.toString();
    }

    parsed.pathname = (pathname === '' ? '' : pathname) + '/v1' + suffix;
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

function buildOpenAICompatibleModelMeta(config, instanceKey) {
  return buildConfigurableProviderModelMeta(config, instanceKey);
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

export function extractOpenAICompatibleModelRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  return [];
}

export function toOpenAICompatibleDiscoveredModelMeta(record, instanceKey, providerUrl = null) {
  const modelId = typeof record === 'string'
    ? record.trim()
    : String(record?.id || record?.model || record?.name || '').trim();
  if (!modelId) return null;
  if (isExcludedDynamicModelId(modelId)) return null;

  const scoreLookupId = resolveAliasedModelId(modelId);
  const { base, unprefixed } = canonicalizeModelId(scoreLookupId);
  const known = knownModelMetaMap.get(scoreLookupId)
    || knownModelMetaMap.get(base)
    || knownModelMetaMap.get(unprefixed)
    || knownModelMetaMap.get(modelId)
    || null;
  const knownScore = normalizeIntelligenceScore(getScore(scoreLookupId));
  const hasScore = (knownScore != null && knownScore > 0) || (known != null && known.intell != null);

  const recordLabel = (record && typeof record === 'object' && typeof record.name === 'string' && record.name.trim())
    ? record.name.trim()
    : null;
  const label = getPreferredModelLabel(scoreLookupId, recordLabel || known?.label || formatGenericProviderModelLabel(modelId));

  const ctxRaw = record && typeof record === 'object'
    ? (record.context_length ?? record.contextLength ?? record.ctx ?? null)
    : null;
  const ctx = parseKiloCodeContext(ctxRaw) || known?.ctx || DEFAULT_DYNAMIC_MODEL_CTX;

  return {
    modelId,
    label,
    intell: knownScore ?? known?.intell ?? DEFAULT_DYNAMIC_MODEL_INTELL,
    isEstimatedScore: !hasScore,
    ctx,
    providerKey: instanceKey,
    providerUrl: providerUrl || undefined,
  };
}

export async function fetchOpenAICompatibleDiscoveredModels(config, instanceKey) {
  const baseUrl = getProviderBaseUrl(config, instanceKey);
  if (!baseUrl) return [];
  const modelsUrl = buildOpenAICompatibleModelsListUrl(baseUrl);
  if (!modelsUrl) return [];

  const headers = { Accept: 'application/json' };
  const apiKey = getApiKey(config, instanceKey);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), PING_TIMEOUT);
  try {
    const response = await fetch(modelsUrl, { method: 'GET', headers, signal: ctrl.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    const records = extractOpenAICompatibleModelRecords(payload);
    const seen = new Set();
    const models = [];
    const chatUrl = normalizeOpenAICompatibleProviderUrl(baseUrl);
    for (const record of records) {
      const model = toOpenAICompatibleDiscoveredModelMeta(record, instanceKey, chatUrl);
      if (!model || seen.has(model.modelId)) continue;
      seen.add(model.modelId);
      models.push(model);
    }
    return models;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isOpenAICompatibleDiscoveryEnabled(config, instanceKey) {
  const providerConfig = config?.providers?.[instanceKey];
  if (!providerConfig) return true;
  return providerConfig.discoverModels !== false;
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
    ctx: getPreferredModelContext(scoreLookupId, known?.ctx || DEFAULT_DYNAMIC_MODEL_CTX),
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
    ctx: meta?.ctx || getPreferredModelContext(scoreModelId, known?.ctx || DEFAULT_DYNAMIC_MODEL_CTX),
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
  } else if (providerKey === KIRO_PROVIDER_KEY) {
    headers.Accept = KIRO_STREAM_ACCEPT;
    headers['X-Amz-Target'] = KIRO_STREAMING_TARGET;
    headers['User-Agent'] = KIRO_SDK_USER_AGENT;
    headers['X-Amz-User-Agent'] = KIRO_AMZ_USER_AGENT;
    headers['Amz-Sdk-Request'] = 'attempt=1; max=3';
    headers['Amz-Sdk-Invocation-Id'] = randomUUID();
    headers['x-amzn-bedrock-cache-control'] = 'enable';
    headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
  }

  return headers;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = KIRO_CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function deterministicUuidFromSeed(seed) {
  const hex = createHash('sha1').update(String(seed || randomUUID())).digest('hex').slice(0, 32);
  const chars = hex.padEnd(32, '0').split('');
  chars[12] = '5';
  chars[16] = 'a';
  const normalized = chars.join('');
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`;
}

function getOpenAIMessageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseKiroToolInput(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeKiroToolSpecs(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(tool => {
    const name = tool?.function?.name || tool?.name || 'tool';
    const description = tool?.function?.description || tool?.description || `Tool: ${name}`;
    return {
      toolSpecification: {
        name,
        description: description.trim() || `Tool: ${name}`,
        inputSchema: {
          json: tool?.function?.parameters || tool?.parameters || tool?.input_schema || {},
        },
      },
    };
  });
}

/**
 * Convert OpenAI messages into Kiro history + currentMessage.
 *
 * Rules (mirrors OmniRoute openai-to-kiro translator):
 *   - system messages become standalone user-role history entries (not merged with subsequent turns)
 *   - tool role is normalized to user; consecutive user messages are merged into a single turn
 *   - tool-role messages add only to pendingToolResults (never to pendingUserContent)
 *   - tool_result blocks inside array content also add only to pendingToolResults
 *   - assistant messages with tool_calls flush and attach toolUses, then reset currentRole so
 *     the next message always starts a new turn
 *   - tools spec goes on the first history entry (seed for AWS cache) and on currentMessage;
 *     it is removed from history entries during clean-up
 */
function convertKiroMessages(messages, tools, modelId) {
  const history = [];
  let currentMessage = null;

  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let currentRole = null;

  const flushPending = () => {
    if (currentRole === 'user') {
      const content = pendingUserContent.join('\n\n').trim() || 'continue';
      const userMsg = { userInputMessage: { content, modelId: '' } };

      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = { toolResults: [...pendingToolResults] };
      }

      if (tools && tools.length > 0 && history.length === 0) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        userMsg.userInputMessage.userInputMessageContext.tools = tools;
      }

      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
    } else if (currentRole === 'assistant') {
      const content = pendingAssistantContent.join('\n\n').trim() || '...';
      history.push({ assistantResponseMessage: { content } });
      pendingAssistantContent = [];
    }
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;

    const originalRole = msg.role;

    // System messages: flush any pending turns, add as a standalone history user entry,
    // then reset so the next message starts a fresh turn (not merged with this one).
    if (originalRole === 'system') {
      if (currentRole !== null) flushPending();
      currentRole = null;

      const textContent = typeof msg.content === 'string'
        ? msg.content
        : getOpenAIMessageText(msg.content);
      if (textContent) {
        const sysMsg = { userInputMessage: { content: textContent, modelId: '' } };
        if (tools && tools.length > 0 && history.length === 0) {
          sysMsg.userInputMessage.userInputMessageContext = { tools };
        }
        history.push(sysMsg);
      }
      continue;
    }

    let role = originalRole;
    if (role === 'tool') role = 'user';

    if (role !== currentRole && currentRole !== null) flushPending();
    currentRole = role;

    if (role === 'user') {
      if (originalRole === 'tool') {
        // Tool result: goes only into toolResults, not into user text
        const toolContent = typeof msg.content === 'string'
          ? msg.content
          : getOpenAIMessageText(msg.content);
        pendingToolResults.push({
          toolUseId: msg.tool_call_id || randomUUID(),
          status: 'success',
          content: [{ text: toolContent || 'Tool completed successfully.' }],
        });
      } else {
        // User message: extract text and any tool_result blocks
        let textContent = '';
        if (typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
            .map(c => c.text || '');
          textContent = textParts.join('\n');

          // Anthropic-style tool_result blocks
          const toolResultBlocks = msg.content.filter(c => c && c.type === 'tool_result');
          for (const block of toolResultBlocks) {
            const text = Array.isArray(block.content)
              ? block.content.map(c => c?.text || '').filter(Boolean).join('\n')
              : typeof block.content === 'string'
                ? block.content
                : '';
            pendingToolResults.push({
              toolUseId: block.tool_use_id || randomUUID(),
              status: 'success',
              content: [{ text }],
            });
          }
        }

        if (textContent) pendingUserContent.push(textContent);
      }
    } else if (role === 'assistant') {
      let textContent = '';
      let toolUses = [];

      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(c => c && c.type === 'text');
        textContent = textBlocks.map(b => b.text || '').join('\n').trim();

        // Anthropic-style tool_use blocks
        const toolUseBlocks = msg.content.filter(c => c && c.type === 'tool_use');
        if (toolUseBlocks.length > 0) {
          toolUses = toolUseBlocks.map(tc => ({
            toolUseId: tc.id || randomUUID(),
            name: tc.name || 'tool',
            input: parseKiroToolInput(tc.input),
          }));
        }
      } else if (typeof msg.content === 'string') {
        textContent = msg.content.trim();
      }

      // OpenAI-style tool_calls array takes precedence
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls.map(tc => ({
          toolUseId: tc.id || randomUUID(),
          name: tc.function?.name || tc.name || 'tool',
          input: parseKiroToolInput(tc.function?.arguments),
        }));
      }

      if (textContent) pendingAssistantContent.push(textContent);

      if (toolUses.length > 0) {
        // Flush accumulated assistant text → creates assistantResponseMessage
        flushPending();
        // Attach toolUses to the just-created assistant message
        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = toolUses;
        }
        // Reset so the next message always opens a fresh turn
        currentRole = null;
      }
    }
  }

  if (currentRole !== null) flushPending();

  // Pop last user message as currentMessage
  if (history.length > 0 && history[history.length - 1].userInputMessage) {
    currentMessage = history.pop();
  } else {
    currentMessage = { userInputMessage: { content: 'continue', modelId: '' } };
  }

  // Propagate tools to currentMessage (tools live only on currentMessage in the final payload)
  if (Array.isArray(tools) && tools.length > 0) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = tools;
  } else {
    const firstHistoryItem = history[0];
    if (
      firstHistoryItem?.userInputMessage?.userInputMessageContext?.tools &&
      !currentMessage?.userInputMessage?.userInputMessageContext?.tools
    ) {
      if (!currentMessage.userInputMessage.userInputMessageContext) {
        currentMessage.userInputMessage.userInputMessageContext = {};
      }
      currentMessage.userInputMessage.userInputMessageContext.tools =
        firstHistoryItem.userInputMessage.userInputMessageContext.tools;
    }
  }

  // Clean up history: remove tools from history entries, set modelId
  for (const item of history) {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }
    if (
      item.userInputMessage?.userInputMessageContext &&
      Object.keys(item.userInputMessage.userInputMessageContext).length === 0
    ) {
      delete item.userInputMessage.userInputMessageContext;
    }
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = modelId;
    }
  }

  return { history, currentMessage };
}

export function buildKiroRequestPayload(body, modelId, options = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = normalizeKiroToolSpecs(body?.tools);
  const profileArn = options?.profileArn || null;

  const { history, currentMessage } = convertKiroMessages(messages, tools, modelId);

  const timestamp = new Date().toISOString();
  const rawContent = currentMessage?.userInputMessage?.content || 'continue';
  currentMessage.userInputMessage = {
    ...currentMessage.userInputMessage,
    content: `[Context: Current time is ${timestamp}]\n\n${rawContent}`,
    modelId,
    origin: 'AI_EDITOR',
  };

  // Deterministic conversationId: based on first history message (or currentMessage if no history)
  const firstContent = history.length > 0 && history[0].userInputMessage?.content
    ? history[0].userInputMessage.content
    : rawContent;
  const conversationId = deterministicUuidFromSeed(`${KIRO_CONVERSATION_NAMESPACE}:${firstContent.slice(0, 4000)}`);

  const payload = {
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      currentMessage,
      history,
    },
  };

  if (profileArn) payload.profileArn = profileArn;

  const inferenceConfig = {};
  const maxTokens = body?.max_tokens ?? body?.max_completion_tokens;
  if (Number.isFinite(maxTokens) && maxTokens > 0) inferenceConfig.maxTokens = maxTokens;
  if (typeof body?.temperature === 'number') inferenceConfig.temperature = body.temperature;
  if (typeof body?.top_p === 'number') inferenceConfig.topP = body.top_p;
  if (Object.keys(inferenceConfig).length > 0) payload.inferenceConfig = inferenceConfig;

  return payload;
}

export function buildProviderRequestBody(providerKey, body, modelId, options = {}) {
  if (providerKey === KIRO_PROVIDER_KEY) {
    return buildKiroRequestPayload(body, modelId || body?.model, options);
  }
  return body;
}

export function parseKiroEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);

    if (totalLength < 16 || totalLength !== data.length) return null;

    const preludeCrc = view.getUint32(8, false);
    if (preludeCrc !== crc32(data.slice(0, 8))) return null;

    const messageCrc = view.getUint32(data.length - 4, false);
    if (messageCrc !== crc32(data.slice(0, data.length - 4))) return null;

    const headers = {};
    let offset = 12;
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLength = data[offset];
      offset += 1;
      const name = new TextDecoder().decode(data.slice(offset, offset + nameLength));
      offset += nameLength;

      const headerType = data[offset];
      offset += 1;
      if (headerType !== 7) return null;

      const valueLength = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      const value = new TextDecoder().decode(data.slice(offset, offset + valueLength));
      offset += valueLength;
      headers[name] = value;
    }

    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4;
    const payloadText = new TextDecoder().decode(data.slice(payloadStart, payloadEnd)).trim();

    return {
      headers,
      payload: payloadText ? JSON.parse(payloadText) : null,
    };
  } catch {
    return null;
  }
}

function getKiroToolCallArgumentString(input) {
  if (typeof input === 'string') return input;
  if (input == null) return '';
  // Kiro streams tool input as partial JSON fragments via input.raw.
  // Emit the raw string directly so callers can concatenate fragments.
  if (typeof input.raw === 'string') return input.raw;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function getKiroFrameError(frame) {
  if (!frame) return null;
  const headers = frame.headers || {};
  const eventType = headers[':event-type'] || '';
  const messageType = headers[':message-type'] || '';
  const exceptionType = headers[':exception-type'] || headers[':error-code'] || '';
  const payload = frame.payload;
  const isErrorFrame =
    messageType === 'exception'
    || /(?:exception|error)$/i.test(eventType)
    || Boolean(exceptionType);

  if (!isErrorFrame) return null;

  const message = normalizeSecretValue(
    payload?.message
    || payload?.Message
    || payload?.error
    || payload?.errorMessage
    || payload?.error_description
  ) || 'Kiro provider returned an EventStream error.';

  return {
    message,
    code: normalizeSecretValue(exceptionType || eventType || messageType) || 'KiroEventStreamError',
  };
}

function createKiroErrorResponse(error, status = 502) {
  return new Response(JSON.stringify({
    error: {
      message: error?.message || 'Kiro provider returned an EventStream error.',
      type: 'kiro_error',
      code: error?.code || 'KiroEventStreamError',
    },
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

export async function transformKiroResponse(response, modelId, stream = false) {
  if (!response?.ok) return response;

  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    let finishSent = false;
    let toolCallIndex = 0;
    const seenToolIds = new Map();
    let usage = null;
    let totalContentLength = 0;
    let contextUsagePercentage = 0;

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        const nextBuffer = new Uint8Array(buffer.length + chunk.length);
        nextBuffer.set(buffer);
        nextBuffer.set(chunk, buffer.length);
        buffer = nextBuffer;

        while (buffer.length >= 16) {
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const totalLength = view.getUint32(0, false);
          if (totalLength < 16 || buffer.length < totalLength) break;

          const frameBytes = buffer.slice(0, totalLength);
          buffer = buffer.slice(totalLength);
          const frame = parseKiroEventFrame(frameBytes);
          if (!frame) continue;

          const eventType = frame.headers[':event-type'] || '';
          const payload = frame.payload;
          const error = getKiroFrameError(frame);
          if (error && !finishSent) {
            finishSent = true;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ error: { ...error, type: 'kiro_error' } })}\n\n`));
            continue;
          }

          if ((eventType === 'assistantResponseEvent' || eventType === 'codeEvent') && typeof payload?.content === 'string' && payload.content) {
            totalContentLength += payload.content.length;
            const chunkPayload = {
              id: responseId,
              object: 'chat.completion.chunk',
              created,
              model: modelId,
              choices: [{
                index: 0,
                delta: chunkIndex === 0 ? { role: 'assistant', content: payload.content } : { content: payload.content },
                finish_reason: null,
              }],
            };
            chunkIndex += 1;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunkPayload)}\n\n`));
            continue;
          }

          if (eventType === 'toolUseEvent' && payload) {
            const toolEvents = Array.isArray(payload) ? payload : [payload];
            for (const toolEvent of toolEvents) {
              const toolId = toolEvent?.toolUseId || randomUUID();
              let index = seenToolIds.get(toolId);
              if (index == null) {
                index = toolCallIndex++;
                seenToolIds.set(toolId, index);
                const startChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      ...(chunkIndex === 0 ? { role: 'assistant' } : {}),
                      tool_calls: [{
                        index,
                        id: toolId,
                        type: 'function',
                        function: {
                          name: toolEvent?.name || 'tool',
                          arguments: '',
                        },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                chunkIndex += 1;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(startChunk)}\n\n`));
              }

              const args = getKiroToolCallArgumentString(toolEvent?.input);
              if (args) {
                const argsChunk = {
                  id: responseId,
                  object: 'chat.completion.chunk',
                  created,
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index,
                        function: { arguments: args },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
                chunkIndex += 1;
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(argsChunk)}\n\n`));
              }
            }
            continue;
          }

          if (eventType === 'metricsEvent') {
            const metrics = payload?.metricsEvent && typeof payload.metricsEvent === 'object'
              ? payload.metricsEvent
              : payload;
            if (metrics && typeof metrics === 'object') {
              const promptTokens = Number(metrics.inputTokens || 0);
              const completionTokens = Number(metrics.outputTokens || 0);
              usage = {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              };
            }
            continue;
          }

          if (eventType === 'contextUsageEvent' && !usage) {
            const pct = typeof payload?.contextUsagePercentage === 'number'
              ? payload.contextUsagePercentage
              : 0;
            if (pct > 0) contextUsagePercentage = pct;
            continue;
          }

          if (eventType === 'messageStopEvent' && !finishSent) {
            // Fallback: estimate usage from contextUsageEvent if metricsEvent was absent
            if (!usage && (totalContentLength > 0 || contextUsagePercentage > 0)) {
              const estOutput = totalContentLength > 0 ? Math.max(1, Math.floor(totalContentLength / 4)) : 0;
              const estInput = contextUsagePercentage > 0 ? Math.floor((contextUsagePercentage * KIRO_MAX_CONTEXT_TOKENS) / 100) : 0;
              if (estInput > 0 || estOutput > 0) {
                usage = { prompt_tokens: estInput, completion_tokens: estOutput, total_tokens: estInput + estOutput };
              }
            }
            finishSent = true;
            const stopChunk = {
              id: responseId,
              object: 'chat.completion.chunk',
              created,
              model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: seenToolIds.size > 0 ? 'tool_calls' : 'stop',
              }],
              ...(usage ? { usage } : {}),
            };
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
          }
        }
      },
      flush(controller) {
        if (!finishSent) {
          const stopChunk = {
            id: responseId,
            object: 'chat.completion.chunk',
            created,
            model: modelId,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop',
            }],
            ...(usage ? { usage } : {}),
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
        }
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      },
    });

    return new Response(response.body.pipeThrough(transformStream), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  let offset = 0;
  let content = '';
  let usage = null;
  let finishReason = 'stop';
  const toolCallsMap = new Map(); // toolId → { id, name, args }
  let totalContentLength = 0;
  let contextUsagePercentage = 0;

  while (offset + 16 <= bytes.length) {
    const frameLength = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset).getUint32(0, false);
    if (frameLength < 16 || offset + frameLength > bytes.length) break;

    const frame = parseKiroEventFrame(bytes.slice(offset, offset + frameLength));
    offset += frameLength;
    if (!frame) continue;

    const eventType = frame.headers[':event-type'] || '';
    const payload = frame.payload;
    const error = getKiroFrameError(frame);
    if (error) return createKiroErrorResponse(error);

    if ((eventType === 'assistantResponseEvent' || eventType === 'codeEvent') && typeof payload?.content === 'string') {
      totalContentLength += payload.content.length;
      content += payload.content;
      continue;
    }

    if (eventType === 'toolUseEvent' && payload) {
      const toolEvents = Array.isArray(payload) ? payload : [payload];
      for (const toolEvent of toolEvents) {
        const toolId = toolEvent?.toolUseId || randomUUID();
        if (!toolCallsMap.has(toolId)) {
          toolCallsMap.set(toolId, { id: toolId, name: toolEvent?.name || 'tool', args: '' });
        }
        const entry = toolCallsMap.get(toolId);
        if (toolEvent?.name) entry.name = toolEvent.name;
        const fragment = getKiroToolCallArgumentString(toolEvent?.input);
        if (fragment) entry.args += fragment;
      }
      continue;
    }

    if (eventType === 'metricsEvent') {
      const metrics = payload?.metricsEvent && typeof payload.metricsEvent === 'object'
        ? payload.metricsEvent
        : payload;
      if (metrics && typeof metrics === 'object') {
        const promptTokens = Number(metrics.inputTokens || 0);
        const completionTokens = Number(metrics.outputTokens || 0);
        usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        };
      }
      continue;
    }

    if (eventType === 'contextUsageEvent' && !usage) {
      const pct = typeof payload?.contextUsagePercentage === 'number'
        ? payload.contextUsagePercentage
        : 0;
      if (pct > 0) contextUsagePercentage = pct;
      continue;
    }

    if (eventType === 'messageStopEvent') {
      if (toolCallsMap.size > 0) finishReason = 'tool_calls';
    }
  }

  const toolCalls = [...toolCallsMap.values()].map(entry => ({
    id: entry.id,
    type: 'function',
    function: { name: entry.name, arguments: entry.args },
  }));

  // Fallback: estimate usage from contextUsageEvent if metricsEvent was absent
  if (!usage && (totalContentLength > 0 || contextUsagePercentage > 0)) {
    const estOutput = totalContentLength > 0 ? Math.max(1, Math.floor(totalContentLength / 4)) : 0;
    const estInput = contextUsagePercentage > 0 ? Math.floor((contextUsagePercentage * KIRO_MAX_CONTEXT_TOKENS) / 100) : 0;
    if (estInput > 0 || estOutput > 0) {
      usage = { prompt_tokens: estInput, completion_tokens: estOutput, total_tokens: estInput + estOutput };
    }
  }

  const openAiPayload = {
    id: responseId,
    object: 'chat.completion',
    created,
    model: modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
    }],
    ...(usage ? { usage } : {}),
  };

  return new Response(JSON.stringify(openAiPayload), {
    status: response.status,
    statusText: response.statusText,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function ping(apiKey, modelId, url, providerKey = null) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT)
  const t0 = performance.now()
  try {
    const headers = buildProviderRequestHeaders(providerKey, { apiKey })
    const payload = buildProviderRequestBody(providerKey, {
      model: modelId,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    }, modelId)
    const resp = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers,
      body: JSON.stringify(payload),
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

function normalizeSecretValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateKiroPkce() {
  const codeVerifier = `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  const codeChallenge = toBase64Url(createHash('sha256').update(codeVerifier).digest());
  return {
    codeVerifier,
    codeChallenge,
    state: randomUUID(),
  };
}

export function buildKiroSocialLoginUrl(provider, codeChallenge, state) {
  const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (!KIRO_BROWSER_AUTH_PROVIDERS.has(normalizedProvider)) {
    throw new Error('Unsupported Kiro browser auth provider.');
  }

  const idp = normalizedProvider === 'google' ? 'Google' : 'Github';
  const params = new URLSearchParams({
    idp,
    redirect_uri: KIRO_SOCIAL_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });

  return `${KIRO_AUTH_SERVICE_URL}/login?${params.toString()}`;
}

function pruneKiroSocialFlows(now = Date.now()) {
  for (const [flowId, flow] of Array.from(_kiroSocialFlows)) {
    if (!flow || flow.expiresAt <= now) _kiroSocialFlows.delete(flowId);
  }
}

export function startKiroSocialAuthFlow(provider) {
  const normalizedProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (!KIRO_BROWSER_AUTH_PROVIDERS.has(normalizedProvider)) {
    throw new Error('Unsupported Kiro browser auth provider.');
  }

  pruneKiroSocialFlows();
  const { codeVerifier, codeChallenge, state } = generateKiroPkce();
  const flowId = randomUUID();
  const expiresAt = Date.now() + KIRO_SOCIAL_FLOW_EXPIRY_MS;
  _kiroSocialFlows.set(flowId, {
    provider: normalizedProvider,
    codeVerifier,
    state,
    expiresAt,
  });

  return {
    flowId,
    provider: normalizedProvider,
    authUrl: buildKiroSocialLoginUrl(normalizedProvider, codeChallenge, state),
    state,
    expiresIn: Math.floor(KIRO_SOCIAL_FLOW_EXPIRY_MS / 1000),
  };
}

export function extractKiroEmailFromAccessToken(accessToken) {
  const raw = normalizeSecretValue(accessToken);
  if (!raw) return null;

  try {
    const parts = raw.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );

    return normalizeSecretValue(payload?.email || payload?.username || payload?.['cognito:username']) || null;
  } catch {
    return null;
  }
}

export async function exchangeKiroSocialCode(code, codeVerifier) {
  const response = await fetch(KIRO_SOCIAL_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: KIRO_SOCIAL_REDIRECT_URI,
    }),
  });

  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const detail = normalizeSecretValue(payload?.error || payload?.message || raw);
    throw new Error(detail || `Kiro token exchange failed (${response.status}).`);
  }

  const accessToken = normalizeSecretValue(payload?.accessToken || payload?.access_token);
  const refreshToken = normalizeSecretValue(payload?.refreshToken || payload?.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new Error('Kiro token exchange did not return both access and refresh tokens.');
  }

  return {
    accessToken,
    refreshToken,
    profileArn: normalizeSecretValue(payload?.profileArn || payload?.profile_arn) || null,
    expiresIn: Number(payload?.expiresIn || payload?.expires_in) || 3600,
  };
}

export async function exchangeKiroSocialAuthFlow(flowId, code, state = null) {
  const normalizedFlowId = normalizeSecretValue(flowId);
  const normalizedCode = normalizeSecretValue(code);
  const normalizedState = normalizeSecretValue(state);
  if (!normalizedFlowId || !normalizedCode) {
    throw new Error('flowId and code are required.');
  }

  pruneKiroSocialFlows();
  const flow = _kiroSocialFlows.get(normalizedFlowId);
  if (!flow) {
    throw new Error('Unknown or expired Kiro browser OAuth flow. Start a new browser OAuth flow.');
  }
  if (flow.expiresAt <= Date.now()) {
    _kiroSocialFlows.delete(normalizedFlowId);
    throw new Error('Unknown or expired Kiro browser OAuth flow. Start a new browser OAuth flow.');
  }
  if (normalizedState && normalizedState !== flow.state) {
    throw new Error('Kiro browser OAuth state did not match the active flow.');
  }

  const tokens = await exchangeKiroSocialCode(normalizedCode, flow.codeVerifier);
  _kiroSocialFlows.delete(normalizedFlowId);
  return tokens;
}

export async function startKiroBuilderIdDeviceAuth() {
  const registerResponse = await fetch(KIRO_OIDC_REGISTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      clientName: 'kiro-oauth-client',
      clientType: 'public',
      scopes: KIRO_OIDC_SCOPES,
      grantTypes: KIRO_OIDC_GRANT_TYPES,
      issuerUrl: KIRO_OIDC_ISSUER_URL,
    }),
  });

  const registerRaw = await registerResponse.text();
  let registerPayload = {};
  try {
    registerPayload = registerRaw ? JSON.parse(registerRaw) : {};
  } catch {
    registerPayload = {};
  }
  if (!registerResponse.ok) {
    const detail = normalizeSecretValue(registerPayload?.error || registerPayload?.message || registerRaw);
    throw new Error(detail || `Kiro client registration failed (${registerResponse.status}).`);
  }

  const clientId = normalizeSecretValue(registerPayload?.clientId || registerPayload?.client_id);
  const clientSecret = normalizeSecretValue(registerPayload?.clientSecret || registerPayload?.client_secret);
  if (!clientId || !clientSecret) {
    throw new Error('Kiro client registration did not return a client ID and secret.');
  }

  const deviceResponse = await fetch(KIRO_OIDC_DEVICE_AUTH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      startUrl: KIRO_BUILDER_ID_START_URL,
    }),
  });

  const deviceRaw = await deviceResponse.text();
  let devicePayload = {};
  try {
    devicePayload = deviceRaw ? JSON.parse(deviceRaw) : {};
  } catch {
    devicePayload = {};
  }
  if (!deviceResponse.ok) {
    const detail = normalizeSecretValue(devicePayload?.error || devicePayload?.message || deviceRaw);
    throw new Error(detail || `Kiro device authorization failed (${deviceResponse.status}).`);
  }

  return {
    clientId,
    clientSecret,
    deviceCode: normalizeSecretValue(devicePayload?.deviceCode || devicePayload?.device_code),
    userCode: normalizeSecretValue(devicePayload?.userCode || devicePayload?.user_code),
    verificationUri: normalizeSecretValue(devicePayload?.verificationUri || devicePayload?.verification_uri),
    verificationUriComplete: normalizeSecretValue(devicePayload?.verificationUriComplete || devicePayload?.verification_uri_complete),
    expiresIn: Number(devicePayload?.expiresIn || devicePayload?.expires_in) || 600,
    interval: Number(devicePayload?.interval) || 5,
  };
}

export async function pollKiroBuilderIdToken(deviceCode, clientId, clientSecret) {
  const response = await fetch(KIRO_OIDC_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      clientId,
      clientSecret,
      deviceCode,
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });

  const raw = await response.text();
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const accessToken = normalizeSecretValue(payload?.accessToken || payload?.access_token);
  if (accessToken) {
    const refreshToken = normalizeSecretValue(payload?.refreshToken || payload?.refresh_token);
    if (!refreshToken) {
      return {
        success: false,
        pending: false,
        error: 'missing_refresh_token',
        errorDescription: 'Kiro device authorization completed without returning a refresh token.',
      };
    }
    return {
      success: true,
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: Number(payload?.expiresIn || payload?.expires_in) || 3600,
        clientId,
        clientSecret,
      },
    };
  }

  return {
    success: false,
    pending: payload?.error === 'authorization_pending' || payload?.error === 'slow_down',
    error: normalizeSecretValue(payload?.error) || `Kiro device polling failed (${response.status}).`,
    errorDescription: normalizeSecretValue(payload?.error_description || payload?.message || raw) || null,
  };
}

function extractKiroRefreshTokenFromAwsCache() {
  const cacheDir = join(homedir(), '.aws', 'sso', 'cache');
  if (!existsSync(cacheDir)) return null;

  try {
    const files = readdirSync(cacheDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const payload = JSON.parse(readFileSync(join(cacheDir, file), 'utf8'));
        const refreshToken = normalizeSecretValue(payload?.refreshToken);
        if (refreshToken.startsWith(KIRO_REFRESH_TOKEN_PREFIX)) return refreshToken;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getKiroOAuthClientConfig(config) {
  const providerCfg = config?.providers?.[KIRO_PROVIDER_KEY] || {};
  const clientId = normalizeSecretValue(process.env.KIRO_OAUTH_CLIENT_ID || providerCfg.clientId);
  const clientSecret = normalizeSecretValue(process.env.KIRO_OAUTH_CLIENT_SECRET || providerCfg.clientSecret);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getKiroRefreshToken(config) {
  const envToken = normalizeSecretValue(process.env.KIRO_REFRESH_TOKEN);
  if (envToken) return envToken;

  const cfgToken = normalizeSecretValue(config?.providers?.[KIRO_PROVIDER_KEY]?.refreshToken);
  if (cfgToken) return cfgToken;

  const now = Date.now();
  if ((now - _kiroRefreshTokenDiscoveryCache.checkedAt) < KIRO_DISCOVERY_CACHE_MS) {
    return _kiroRefreshTokenDiscoveryCache.token;
  }

  const discovered = extractKiroRefreshTokenFromAwsCache();
  _kiroRefreshTokenDiscoveryCache = {
    token: discovered,
    checkedAt: now,
  };

  return discovered;
}

function ensureProviderConfig(config, providerKey) {
  if (!config.providers) config.providers = {};
  if (!config.providers[providerKey]) config.providers[providerKey] = {};
  return config.providers[providerKey];
}

function clearKiroTokenCaches() {
  _kiroOAuthCache = null;
  _kiroRefreshTokenDiscoveryCache = { token: null, checkedAt: 0 };
}

function clearKiroAuthMetadata(providerConfig) {
  if (!providerConfig || typeof providerConfig !== 'object') return;
  delete providerConfig.authMode;
  delete providerConfig.authProvider;
  delete providerConfig.authEmail;
  delete providerConfig.profileArn;
  delete providerConfig.clientId;
  delete providerConfig.clientSecret;
}

export function hasKiroAuthConfigured(config) {
  const apiKey = getApiKey(config, KIRO_PROVIDER_KEY);
  if (apiKey) return true;
  return !!getKiroRefreshToken(config);
}

export async function resolveKiroOAuthAccessToken(config) {
  const refreshToken = getKiroRefreshToken(config);
  if (!refreshToken) return null;

  const client = getKiroOAuthClientConfig(config);

  // Cache hit: match on either the original source token or the latest rotated token
  if (
    _kiroOAuthCache
    && (_kiroOAuthCache.sourceRefreshToken === refreshToken || _kiroOAuthCache.latestRefreshToken === refreshToken)
    && _kiroOAuthCache.clientId === (client?.clientId || null)
    && _kiroOAuthCache.expiresAt > (Date.now() + KIRO_TOKEN_EXPIRY_SKEW_MS)
    && _kiroOAuthCache.accessToken
  ) {
    return _kiroOAuthCache.accessToken;
  }

  // If the cache's source token matches the incoming token, use the latest rotated token for the actual request
  const effectiveRefreshToken = (
    _kiroOAuthCache?.sourceRefreshToken === refreshToken && _kiroOAuthCache?.latestRefreshToken
  ) ? _kiroOAuthCache.latestRefreshToken : refreshToken;

  const requestBody = client
    ? {
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      refreshToken: effectiveRefreshToken,
      grantType: 'refresh_token',
    }
    : { refreshToken: effectiveRefreshToken };
  const tokenUrl = client ? KIRO_OIDC_TOKEN_URL : KIRO_SOCIAL_REFRESH_URL;

  try {
    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    if (!resp.ok) {
      let details = '';
      try {
        details = await resp.text();
      } catch {
        details = '';
      }
      console.warn(`[Kiro OAuth] token refresh failed (${resp.status})${details ? `: ${details.slice(0, 200)}` : ''}`);
      return null;
    }
    const payload = await resp.json();
    const accessToken = normalizeSecretValue(payload?.accessToken);
    if (!accessToken) return null;

    const expiresIn = Number(payload?.expiresIn);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + (expiresIn * 1000)
      : Date.now() + KIRO_DEFAULT_TOKEN_EXPIRY_MS;
    const nextRefreshToken = normalizeSecretValue(payload?.refreshToken) || effectiveRefreshToken;

    _kiroOAuthCache = {
      sourceRefreshToken: refreshToken,
      latestRefreshToken: nextRefreshToken,
      accessToken,
      expiresAt,
      clientId: client?.clientId || null,
    };

    // Persist rotated refresh token back to config when it changes (skip if token came from env)
    const envRefreshToken = normalizeSecretValue(process.env.KIRO_REFRESH_TOKEN);
    if (nextRefreshToken !== refreshToken && refreshToken !== envRefreshToken && config?.providers?.[KIRO_PROVIDER_KEY]) {
      config.providers[KIRO_PROVIDER_KEY].refreshToken = nextRefreshToken;
      try {
        saveConfig(config);
      } catch {
        // non-fatal: rotation is tracked in cache even if persist fails
      }
    }

    return accessToken;
  } catch {
    return null;
  }
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
  if (providerKey === KIRO_PROVIDER_KEY) {
    const oauthToken = await resolveKiroOAuthAccessToken(config);
    if (oauthToken) return { token: oauthToken, authSource: 'oauth-refresh-token', providerUrlOverride: null };
  }

  const apiKey = getApiKey(config, providerKey);
  if (apiKey && providerWantsBearerAuth(config, providerKey)) {
    return { token: apiKey, authSource: 'api-key', providerUrlOverride: null };
  }

  return { token: null, authSource: null, providerUrlOverride: null };
}

function resolveProviderUrl(config, providerKey, authProviderUrlOverride = null, resultProviderUrl = null) {
  if (authProviderUrlOverride) return authProviderUrlOverride;
  if (isOpenAICompatibleInstanceKey(providerKey) || providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY || providerKey === OLLAMA_PROVIDER_KEY) {
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
  const lastOpenAICompatibleDiscoveryAt = new Map();

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

  const refreshOpenAICompatibleModels = async (onlyInstanceKey = null, force = false) => {
    const currentConfig = loadConfig();
    const endpoints = listOpenAICompatibleEndpoints(currentConfig);
    const instanceKeys = new Set(endpoints.map(e => e.instanceKey));

    // Drop result rows for instances that no longer exist.
    const orphaned = new Set(
      results
        .filter(r => isOpenAICompatibleInstanceKey(r.providerKey) && !instanceKeys.has(r.providerKey))
        .map(r => r.providerKey)
    );
    for (const ok of orphaned) {
      mergeDynamicProviderModels(ok, []);
      lastOpenAICompatibleDiscoveryAt.delete(ok);
    }

    const refreshed = [];
    const now = Date.now();
    for (const ep of endpoints) {
      if (onlyInstanceKey && ep.instanceKey !== onlyInstanceKey) continue;
      if (!ep.enabled) {
        mergeDynamicProviderModels(ep.instanceKey, []);
        continue;
      }

      const fallbackModel = buildOpenAICompatibleModelMeta(currentConfig, ep.instanceKey);
      const discoveryEnabled = isOpenAICompatibleDiscoveryEnabled(currentConfig, ep.instanceKey);
      const lastDiscoveredAt = lastOpenAICompatibleDiscoveryAt.get(ep.instanceKey) || 0;
      const ttlExpired = (now - lastDiscoveredAt) >= OPENAI_COMPATIBLE_MODELS_REFRESH_MS;
      const shouldDiscover = discoveryEnabled && (force || ttlExpired);

      let discovered = [];
      if (shouldDiscover) {
        try {
          discovered = await fetchOpenAICompatibleDiscoveredModels(currentConfig, ep.instanceKey);
          lastOpenAICompatibleDiscoveryAt.set(ep.instanceKey, Date.now());
        } catch (err) {
          console.log(chalk.dim(`  [OpenAI-Compatible:${ep.id}] Model discovery skipped: ${describeSyncError(err)}`));
        }
      } else if (discoveryEnabled) {
        // 📖 Within the TTL window: keep the previously-discovered rows visible
        // 📖 instead of dropping them when this refresh path was just a ping cycle.
        discovered = results
          .filter(r => r.providerKey === ep.instanceKey)
          .map(r => ({
            modelId: r.modelId,
            label: r.label,
            intell: r.intell,
            isEstimatedScore: r.isEstimatedScore,
            ctx: r.ctx,
            providerKey: ep.instanceKey,
            providerUrl: r.providerUrl,
          }));
      }

      // Merge fallback (manually-configured modelId) with discovered list, de-duped.
      const merged = fallbackModel
        ? [fallbackModel, ...discovered.filter(m => m.modelId !== fallbackModel.modelId)]
        : discovered;
      mergeDynamicProviderModels(ep.instanceKey, merged);
      refreshed.push(...merged);
    }
    return refreshed;
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
    const baseKey = getBaseProviderKey(providerKey);
    if (!providerKey || !sources[baseKey]) {
      throw new Error('Unknown provider.');
    }

    if (providerKey === KILOCODE_PROVIDER_KEY) return await refreshKiloCodeModels(true);
    if (providerKey === OPENCODE_PROVIDER_KEY) return await refreshOpenCodeModels(true);
    if (providerKey === OPENROUTER_PROVIDER_KEY) return await refreshOpenRouterModels(true);
    if (isOpenAICompatibleInstanceKey(providerKey)) return await refreshOpenAICompatibleModels(providerKey, true);
    if (providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY) return await refreshOpenAICompatibleModels(null, true);
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
    if (isOpenAICompatibleInstanceKey(providerKey)) {
      await refreshOpenAICompatibleModels(providerKey, true);
    } else if (providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY) {
      await refreshOpenAICompatibleModels(null, true);
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
      const currentConfig = loadConfig();
      if (!isAutoPingEnabled(currentConfig)) {
        schedulePing();
        return;
      }
      await safeRefreshProviderModels(() => refreshKiloCodeModels());
      await safeRefreshProviderModels(() => refreshOpenCodeModels());
      await safeRefreshProviderModels(() => refreshOpenRouterModels());
      await safeRefreshProviderModels(() => refreshOpenAICompatibleModels());
      await safeRefreshProviderModels(() => refreshOllamaModels());
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
  await safeRefreshProviderModels(() => refreshOpenAICompatibleModels(null, true));
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
  app.get('/api/oauth/kiro/auto-import', (req, res) => {
    try {
      const refreshToken = extractKiroRefreshTokenFromAwsCache();
      if (!refreshToken) {
        return res.json({
          found: false,
          error: 'Kiro refresh token not found in ~/.aws/sso/cache. Sign in to Kiro first or paste a token manually.',
        });
      }

      // Save the token directly — never return it in the response body
      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, KIRO_PROVIDER_KEY);
      clearKiroAuthMetadata(providerConfig);
      providerConfig.refreshToken = refreshToken;
      providerConfig.authMode = 'aws-cache';
      delete currentConfig.apiKeys[KIRO_PROVIDER_KEY];
      saveConfig(currentConfig);
      clearKiroTokenCaches();
      void triggerImmediateProviderPing(KIRO_PROVIDER_KEY);

      return res.json({ found: true });
    } catch (err) {
      return res.status(500).json({
        found: false,
        error: err?.message || 'Failed to inspect the AWS SSO cache.',
      });
    }
  });

  app.get('/api/oauth/kiro/device-code', async (req, res) => {
    try {
      const deviceAuth = await startKiroBuilderIdDeviceAuth();
      const flowId = randomUUID();
      const expiresAt = Date.now() + (Math.max(60, Number(deviceAuth.expiresIn || 600)) * 1000);

      // Store secrets server-side; the client only receives an opaque flowId
      _kiroDeviceFlows.set(flowId, {
        clientId: deviceAuth.clientId,
        clientSecret: deviceAuth.clientSecret,
        deviceCode: deviceAuth.deviceCode,
        expiresAt,
      });

      // Prune stale entries to avoid unbounded growth
      const now = Date.now();
      for (const [id, flow] of Array.from(_kiroDeviceFlows)) {
        if (flow.expiresAt <= now) _kiroDeviceFlows.delete(id);
      }

      return res.json({
        flowId,
        userCode: deviceAuth.userCode,
        verificationUri: deviceAuth.verificationUri,
        verificationUriComplete: deviceAuth.verificationUriComplete,
        expiresIn: deviceAuth.expiresIn,
        interval: deviceAuth.interval,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed to start Kiro device authorization.' });
    }
  });

  app.post('/api/oauth/kiro/poll', async (req, res) => {
    try {
      const flowId = normalizeSecretValue(req.body?.flowId);
      if (!flowId) {
        return res.status(400).json({ error: 'flowId is required.' });
      }

      const flow = _kiroDeviceFlows.get(flowId);
      if (!flow) {
        return res.status(400).json({ error: 'Unknown or expired flow. Start a new device authorization.' });
      }
      if (flow.expiresAt <= Date.now()) {
        _kiroDeviceFlows.delete(flowId);
        return res.status(400).json({ error: 'Device authorization expired. Start a new flow.' });
      }

      const { deviceCode, clientId, clientSecret } = flow;
      const pollResult = await pollKiroBuilderIdToken(deviceCode, clientId, clientSecret);
      if (!pollResult.success) {
        return res.json({
          success: false,
          pending: pollResult.pending === true,
          error: pollResult.error,
          errorDescription: pollResult.errorDescription,
        });
      }

      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, KIRO_PROVIDER_KEY);
      providerConfig.refreshToken = pollResult.tokens.refreshToken;
      providerConfig.clientId = pollResult.tokens.clientId;
      providerConfig.clientSecret = pollResult.tokens.clientSecret;
      providerConfig.authMode = 'builder-id';
      providerConfig.authProvider = 'aws-builder-id';
      delete providerConfig.profileArn;
      const email = extractKiroEmailFromAccessToken(pollResult.tokens.accessToken);
      if (email) providerConfig.authEmail = email;
      else delete providerConfig.authEmail;
      delete currentConfig.apiKeys[KIRO_PROVIDER_KEY];
      saveConfig(currentConfig);
      clearKiroTokenCaches();
      _kiroDeviceFlows.delete(flowId);
      void triggerImmediateProviderPing(KIRO_PROVIDER_KEY);

      return res.json({
        success: true,
        email,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed while polling Kiro device authorization.' });
    }
  });

  app.get('/api/oauth/kiro/social-authorize', (req, res) => {
    try {
      const provider = normalizeSecretValue(req.query?.provider).toLowerCase();
      if (!KIRO_BROWSER_AUTH_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: "Invalid provider. Use 'google' or 'github'." });
      }

      return res.json(startKiroSocialAuthFlow(provider));
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Failed to initialize Kiro browser OAuth.' });
    }
  });

  app.post('/api/oauth/kiro/social-exchange', async (req, res) => {
    try {
      const provider = normalizeSecretValue(req.body?.provider).toLowerCase();
      const code = normalizeSecretValue(req.body?.code);
      const flowId = normalizeSecretValue(req.body?.flowId);
      const state = normalizeSecretValue(req.body?.state);

      if (!KIRO_BROWSER_AUTH_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: "Invalid provider. Use 'google' or 'github'." });
      }
      if (!code || !flowId) {
        return res.status(400).json({ error: 'code and flowId are required.' });
      }

      const tokens = await exchangeKiroSocialAuthFlow(flowId, code, state);
      const currentConfig = loadConfig();
      const providerConfig = ensureProviderConfig(currentConfig, KIRO_PROVIDER_KEY);
      clearKiroAuthMetadata(providerConfig);
      providerConfig.refreshToken = tokens.refreshToken;
      providerConfig.authMode = 'browser-oauth';
      providerConfig.authProvider = provider;
      if (tokens.profileArn) providerConfig.profileArn = tokens.profileArn;
      else delete providerConfig.profileArn;
      const email = extractKiroEmailFromAccessToken(tokens.accessToken);
      if (email) providerConfig.authEmail = email;
      else delete providerConfig.authEmail;
      delete currentConfig.apiKeys[KIRO_PROVIDER_KEY];
      saveConfig(currentConfig);
      clearKiroTokenCaches();
      void triggerImmediateProviderPing(KIRO_PROVIDER_KEY);

      return res.json({
        success: true,
        email,
      });
    } catch (err) {
      return res.status(502).json({ error: err?.message || 'Failed to complete Kiro browser OAuth.' });
    }
  });

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

  const buildProviderConfigEntry = (currentConfig, key, displayName) => {
    const baseKey = getBaseProviderKey(key);
    const pool = getApiKeyPool(currentConfig, key)
    const hasMultiple = pool.length > 1
    const providerConfig = currentConfig.providers?.[key] || {}
    const hasKiroOAuth = key === KIRO_PROVIDER_KEY ? hasKiroAuthConfigured(currentConfig) : false
    const isOaiInstance = isOpenAICompatibleInstanceKey(key);
    const supportsBaseUrlAndModelId = isOaiInstance || baseKey === OLLAMA_PROVIDER_KEY;
    const sourceName = sources[baseKey]?.name || key;
    return {
      key,
      name: displayName || sourceName,
      enabled: isProviderEnabled(currentConfig, key),
      hasKey: pool.length > 0 || hasKiroOAuth,
      signupUrl: API_KEY_SIGNUP_URLS[baseKey] || null,
      supportsOptionalBearerAuth: isProviderAuthOptional(currentConfig, key),
      useBearerAuth: isProviderAuthOptional(currentConfig, key) ? isProviderBearerAuthEnabled(currentConfig, key) : null,
      pingIntervalMinutes: providerConfig.pingIntervalMinutes || null,
      baseUrl: supportsBaseUrlAndModelId ? (getProviderBaseUrl(currentConfig, key) || '') : null,
      modelId: supportsBaseUrlAndModelId ? (getProviderModelId(currentConfig, key) || '') : null,
      isOpenAICompatibleInstance: isOaiInstance,
      openAICompatibleInstanceId: isOaiInstance ? getOpenAICompatibleInstanceId(key) : null,
      discoverModels: isOaiInstance ? (providerConfig.discoverModels !== false) : null,
      hasMultipleKeys: hasMultiple,
      maxTurns: getMaxTurns(currentConfig, key),
      authMode: key === KIRO_PROVIDER_KEY ? (normalizeSecretValue(providerConfig.authMode) || null) : null,
      authProvider: key === KIRO_PROVIDER_KEY ? (normalizeSecretValue(providerConfig.authProvider) || null) : null,
      authEmail: key === KIRO_PROVIDER_KEY ? (normalizeSecretValue(providerConfig.authEmail) || null) : null,
      apiKeyPool: pool.map((k, i) => {
        const masked = k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : `${k.slice(0, 2)}***`
        return { index: i, masked, key: k }
      }),
    }
  };

  app.get('/api/config', (req, res) => {
    const currentConfig = loadConfig();
    const providers = [];
    for (const key of Object.keys(sources)) {
      // The bare 'openai-compatible' source is a template; its instances are emitted separately.
      if (key === OPENAI_COMPATIBLE_PROVIDER_KEY) continue;
      providers.push(buildProviderConfigEntry(currentConfig, key));
    }
    for (const ep of listOpenAICompatibleEndpoints(currentConfig)) {
      providers.push(buildProviderConfigEntry(currentConfig, ep.instanceKey, ep.name));
    }
    res.json(providers);
  });

  app.post('/api/openai-compatible/endpoints', (req, res) => {
    const { id, name, baseUrl, modelId, apiKey, enabled, discoverModels } = req.body || {};
    if (!name && !id) return res.status(400).json({ error: 'name or id is required.' });

    const currentConfig = loadConfig();
    const desiredKey = buildOpenAICompatibleInstanceKey(id || name);
    if (!desiredKey) return res.status(400).json({ error: 'Could not derive a valid instance id from the supplied name.' });
    if (currentConfig.providers?.[desiredKey]) {
      return res.status(409).json({ error: `Endpoint with id "${getOpenAICompatibleInstanceId(desiredKey)}" already exists.` });
    }

    upsertOpenAICompatibleEndpoint(currentConfig, {
      instanceKey: desiredKey,
      name: name || getOpenAICompatibleInstanceId(desiredKey),
      baseUrl: baseUrl || '',
      modelId: modelId || '',
      apiKey: apiKey === undefined ? undefined : apiKey,
      enabled: enabled !== false,
      discoverModels: discoverModels === undefined ? undefined : (discoverModels !== false),
    });
    saveConfig(currentConfig);

    void triggerImmediateProviderPing(desiredKey);

    return res.json({ success: true, instanceKey: desiredKey, id: getOpenAICompatibleInstanceId(desiredKey) });
  });

  app.delete('/api/openai-compatible/endpoints/:id', (req, res) => {
    const id = req.params.id;
    const instanceKey = buildOpenAICompatibleInstanceKey(id);
    if (!instanceKey) return res.status(400).json({ error: 'Invalid id.' });

    const currentConfig = loadConfig();
    const removed = removeOpenAICompatibleEndpoint(currentConfig, instanceKey);
    if (!removed) return res.status(404).json({ error: 'Endpoint not found.' });
    saveConfig(currentConfig);

    // Drop result rows for the removed instance so it disappears from the dashboard.
    void refreshOpenAICompatibleModels();

    return res.json({ success: true });
  });

  app.post('/api/providers/:providerKey/refresh', async (req, res) => {
    const { providerKey } = req.params;
    const baseKey = getBaseProviderKey(providerKey);
    if (!sources[baseKey]) {
      return res.status(404).json({ error: 'Unknown provider.' });
    }
    const providerName = sources[baseKey].name;

    try {
      const models = await refreshProviderModelsForApi(providerKey);
      const providerModels = results.filter(r => r.providerKey === providerKey);
      void Promise.allSettled(providerModels.map(r => pingModel(r)));
      return res.json({
        success: true,
        providerKey,
        providerName,
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
        providerName,
        error: describeSyncError(err),
      });
    }
  });

  app.post('/api/providers/refresh-all', async (req, res) => {
    const currentConfig = loadConfig();
    const sourceKeys = Object.keys(sources)
      .filter(key => key !== OPENAI_COMPATIBLE_PROVIDER_KEY)
      .filter(key => isProviderEnabled(currentConfig, key));
    const instanceKeys = listOpenAICompatibleEndpoints(currentConfig)
      .filter(ep => ep.enabled)
      .map(ep => ep.instanceKey);
    const providerKeys = [...sourceKeys, ...instanceKeys];
    const results_arr = [];

    for (const providerKey of providerKeys) {
      const providerName = sources[getBaseProviderKey(providerKey)]?.name || providerKey;
      try {
        const models = await refreshProviderModelsForApi(providerKey);
        results_arr.push({
          success: true,
          providerKey,
          providerName,
          modelCount: models.length,
        });
      } catch (err) {
        results_arr.push({
          success: false,
          providerKey,
          providerName,
          error: describeSyncError(err),
        });
      }
    }

    // Ping all models after refreshing
    void Promise.allSettled(results.map(r => pingModel(r)));

    return res.json({
      success: true,
      providers: results_arr,
    });
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

  app.get('/api/auto-ping', (req, res) => {
    const cfg = loadConfig();
    res.json({ enabled: isAutoPingEnabled(cfg) });
  });

  app.post('/api/auto-ping', (req, res) => {
    const { enabled } = req.body || {};
    if (enabled === undefined) {
      return res.status(400).json({ error: 'enabled field is required.' });
    }
    const cfg = loadConfig();
    cfg.autoPingEnabled = enabled !== false;
    saveConfig(cfg);
    return res.json({ enabled: cfg.autoPingEnabled });
  });

  app.post('/api/config', (req, res) => {
    const { providerKey, apiKey, enabled, useBearerAuth, pingIntervalMinutes, baseUrl, modelId, pinningMode, maxTurns, apiKeys, discoverModels } = req.body;
    const currentConfig = loadConfig();
    const wasEnabled = isProviderEnabled(currentConfig, providerKey);
    let didUpdateKiroAuth = false;

    if (apiKey !== undefined) {
      if (providerKey === KIRO_PROVIDER_KEY) {
        const providerConfig = ensureProviderConfig(currentConfig, providerKey);
        const value = normalizeSecretValue(apiKey);
        if (!value) {
          delete providerConfig.refreshToken;
          clearKiroAuthMetadata(providerConfig);
        } else {
          clearKiroAuthMetadata(providerConfig);
          providerConfig.refreshToken = value;
          providerConfig.authMode = 'manual-token';
        }
        delete currentConfig.apiKeys[providerKey];
        clearKiroTokenCaches();
        didUpdateKiroAuth = true;
      } else {
        if (apiKey === null || apiKey === '') {
          delete currentConfig.apiKeys[providerKey];
        } else {
          currentConfig.apiKeys[providerKey] = String(apiKey).trim();
        }
      }
    }

    if (apiKeys !== undefined && Array.isArray(apiKeys)) {
      if (providerKey === KIRO_PROVIDER_KEY) {
        const providerConfig = ensureProviderConfig(currentConfig, providerKey);
        const validTokens = apiKeys.filter(k => typeof k === 'string' && k.trim())
        if (validTokens.length === 0) {
          delete providerConfig.refreshToken;
          clearKiroAuthMetadata(providerConfig);
        } else {
          clearKiroAuthMetadata(providerConfig);
          providerConfig.refreshToken = validTokens[0].trim();
          providerConfig.authMode = 'manual-token';
        }
        delete currentConfig.apiKeys[providerKey];
        clearKiroTokenCaches();
        didUpdateKiroAuth = true;
      } else {
        const validKeys = apiKeys.filter(k => typeof k === 'string' && k.trim())
        if (validKeys.length === 0) {
          delete currentConfig.apiKeys[providerKey];
        } else if (validKeys.length === 1) {
          currentConfig.apiKeys[providerKey] = validKeys[0].trim()
        } else {
          currentConfig.apiKeys[providerKey] = validKeys.map(k => k.trim())
        }
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

    if (discoverModels !== undefined && isOpenAICompatibleInstanceKey(providerKey)) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      if (discoverModels === false) currentConfig.providers[providerKey].discoverModels = false;
      else delete currentConfig.providers[providerKey].discoverModels;
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
    } else if (providerKey === KIRO_PROVIDER_KEY && didUpdateKiroAuth) {
      void triggerImmediateProviderPing(providerKey);
    } else if (providerKey === OPENCODE_PROVIDER_KEY && apiKey !== undefined) {
      void triggerImmediateProviderPing(providerKey);
    } else if (isProviderAuthOptional(currentConfig, providerKey) && (apiKey !== undefined || useBearerAuth !== undefined)) {
      void triggerImmediateProviderPing(providerKey);
    } else if (providerKey === OPENROUTER_PROVIDER_KEY && apiKey !== undefined) {
      void triggerImmediateProviderPing(providerKey);
    } else if ((isOpenAICompatibleInstanceKey(providerKey) || providerKey === OPENAI_COMPATIBLE_PROVIDER_KEY || providerKey === OLLAMA_PROVIDER_KEY) && (apiKey !== undefined || baseUrl !== undefined || modelId !== undefined || discoverModels !== undefined)) {
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

  // Proxy endpoint — serves both OpenAI and Anthropic model lists
  setupAnthropicRoutes(app, port);
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
      const attemptedModelKeys = new Set();
      const attempts = [];
      const requestedModels = filterModelsByRequested(results, payload.model, canonicalizeModelId);

      if (payload.model && payload.model !== 'auto-fastest' && requestedModels.length === 0) {
        return res.status(404).json({ error: { message: `Requested model not found: ${payload.model}` } });
      }

      const pickNextModel = () => {
        if (pinnedModelId) {
          const pinningMode = getPinningMode(loadConfig());
          const pinned = getPinnedModelCandidate(results, pinnedModelId, pinningMode, Array.from(attemptedModelKeys), pinnedProviderKey);
          if (pinned) {
            return pinned;
          }
        }

        const ranked = rankModelsForRouting(requestedModels, Array.from(attemptedModelKeys));
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

        attemptedModelKeys.add(getRoutingModelKey(best));
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
        const kiroOptions = best.providerKey === KIRO_PROVIDER_KEY
          ? { profileArn: currentConfig?.providers?.kiro?.profileArn || null }
          : {};
        let providerPayload = buildProviderRequestBody(best.providerKey, payload, best.modelId, kiroOptions);

        const t0 = performance.now();
        let response;
        try {
          response = await fetch(providerUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(providerPayload)
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
              providerPayload = buildProviderRequestBody(best.providerKey, payload, best.modelId, kiroOptions);
              response = await fetch(providerUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(providerPayload)
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
          if (best.providerKey === KIRO_PROVIDER_KEY) {
            response = await transformKiroResponse(response, best.modelId, Boolean(payload.stream));
          }
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
