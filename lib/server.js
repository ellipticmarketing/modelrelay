import express from 'express';
import chalk from 'chalk';
import path, { join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { MODELS, sources } from '../sources.js';
import { API_KEY_SIGNUP_URLS } from './providerLinks.js';
import { getApiKey, isProviderEnabled, loadConfig, saveConfig } from './config.js';
import { findBestModel, getAvg, getUptime, getVerdict, isRetryableProxyStatus, rankModelsForRouting, parseOpenRouterKeyRateLimit } from './utils.js';
import { getPreferredLanIpv4Address } from './network.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let APP_VERSION = 'unknown';
try {
  const versionFromEnv = process.env.npm_package_version;
  if (typeof versionFromEnv === 'string' && versionFromEnv.trim()) {
    APP_VERSION = versionFromEnv.trim();
  } else {
    const candidatePaths = [
      path.join(__dirname, '../package.json'),
      path.join(process.cwd(), 'package.json'),
    ];
    for (const candidatePath of candidatePaths) {
      if (!existsSync(candidatePath)) continue;
      const pkgRaw = readFileSync(candidatePath, 'utf8');
      const pkg = JSON.parse(pkgRaw);
      if (pkg && typeof pkg.version === 'string' && pkg.version.trim()) {
        APP_VERSION = pkg.version.trim();
        break;
      }
    }
  }
} catch {
  APP_VERSION = 'unknown';
}

const PING_TIMEOUT = 15_000;
const PING_INTERVAL = 30 * 60_000;
const MAX_PROACTIVE_RETRIES = 5;
const NPM_LATEST_URL = 'https://registry.npmjs.org/modelrelay/latest';
const NPM_LATEST_CACHE_MS = 10 * 60_000;

const latestVersionCache = {
  value: null,
  fetchedAt: 0,
  inFlight: null,
};

function parseVersionParts(version) {
  if (typeof version !== 'string' || !version.trim()) return null;
  const core = version.trim().split('-')[0];
  const parts = core.split('.').map((part) => Number(part));
  if (parts.some((n) => Number.isNaN(n))) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
}

function isVersionNewer(latest, current) {
  const latestParts = parseVersionParts(latest);
  const currentParts = parseVersionParts(current);
  if (!latestParts || !currentParts) return false;
  const len = Math.max(latestParts.length, currentParts.length);
  for (let i = 0; i < len; i++) {
    const a = latestParts[i] ?? 0;
    const b = currentParts[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

async function fetchLatestNpmVersionCached() {
  const now = Date.now();
  const cacheFresh = (now - latestVersionCache.fetchedAt) < NPM_LATEST_CACHE_MS;
  if (cacheFresh && latestVersionCache.value) return latestVersionCache.value;
  if (latestVersionCache.inFlight) return latestVersionCache.inFlight;

  latestVersionCache.inFlight = (async () => {
    try {
      const resp = await fetch(NPM_LATEST_URL, { method: 'GET' });
      if (resp.ok) {
        const payload = await resp.json();
        if (payload && typeof payload.version === 'string' && payload.version.trim()) {
          latestVersionCache.value = payload.version.trim();
        }
      }
    } catch {
      // Keep stale cache value if request fails.
    } finally {
      latestVersionCache.fetchedAt = Date.now();
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

async function ping(apiKey, modelId, url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT)
  const t0 = performance.now()
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
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
    return {
      code: isTimeout ? '000' : 'ERR',
      ms: isTimeout ? 'TIMEOUT' : Math.round(performance.now() - t0),
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

export async function runServer(config, port, enableLog = true, bannedModels = []) {
  // 📖 pinnedModelId: when set, ALL proxy requests are locked to this model (in-memory, resets on restart)
  let pinnedModelId = null;
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

  let results = MODELS
    .map(([modelId, label, intell, coding, termbench, ctx, providerKey], i) => ({
      idx: i + 1, modelId, label, intell, coding, termbench, ctx, providerKey,
      status: 'pending',
      pings: [],
      httpCode: null,
      hidden: false,
      lastModelResponseAt: 0,
    }));


  const pingModel = async (r) => {
    // Refresh config every ping cycle just in case
    const currentConfig = loadConfig();
    const enabled = isProviderEnabled(currentConfig, r.providerKey);

    if (bannedModels.some(b => b === r.modelId || b === `${r.providerKey}/${r.modelId}`)) {
      r.status = 'banned';
      return;
    }

    if (!enabled) {
      r.status = 'disabled';
      return;
    }

    const providerApiKey = getApiKey(currentConfig, r.providerKey) ?? null;
    const providerUrl = sources[r.providerKey]?.url ?? sources.nvidia.url;

    const { code, ms, rateLimit, errorMessage } = await ping(providerApiKey, r.modelId, providerUrl);
    const now = Date.now();
    r.pings.push({ ms, code, ts: now });
    if (r.pings.length > 50) r.pings.shift(); // keep history bounded
    // Store ping rate-limit data for display, but only if no authoritative
    // proxy-sourced data exists yet (proxy data has a `capturedAt` field).
    if (rateLimit && (!r.rateLimit || !r.rateLimit.capturedAt)) {
      r.rateLimit = rateLimit;
    }

    // If ping fails with 429, mark as rate-limited immediately
    if (code === '429') {
      if (!r.rateLimit) r.rateLimit = {};
      r.rateLimit.wasRateLimited = true;
      r.rateLimit.capturedAt = Date.now();
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

  const schedulePing = () => {
    setTimeout(async () => {
      const now = Date.now();
      for (const r of results) {
        if (now - (r.lastModelResponseAt || 0) < PING_INTERVAL) continue;
        pingModel(r).catch(() => { });
      }
      schedulePing();
    }, PING_INTERVAL);
  };

  process.stdout.write(chalk.dim('  ⏳ Initializing model health checks... '));
  await Promise.all(results.map(r => pingModel(r)));
  console.log(chalk.green('Done!'));

  schedulePing();

  const app = express();

  app.use(express.static(path.join(__dirname, '../public')));
  app.use(express.json());

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
    res.json({
      version: APP_VERSION,
      latestVersion: latestVersion || null,
      updateAvailable,
    });
  });

  app.get('/api/models', (req, res) => {
    const formatted = results.map(r => {
      const lastPing = r.pings.length > 0 ? r.pings[r.pings.length - 1] : null;
      return {
        ...r,
        avg: getAvg(r),
        uptime: getUptime(r),
        verdict: getVerdict(r),
        lastPing: lastPing ? lastPing.ms : null,
        rateLimit: r.rateLimit || null,
        pings: r.pings  // full history (up to 50 entries) for the dashboard drawer
      };
    });
    const autoBest = findBestModel(results);
    // If a pinned model is set and still valid (not banned/disabled), report it as the effective best
    const pinnedResult = pinnedModelId ? results.find(r => r.modelId === pinnedModelId) : null;
    const effectiveBest = (pinnedResult && pinnedResult.status !== 'banned' && pinnedResult.status !== 'disabled')
      ? pinnedResult
      : autoBest;
    res.json({ models: formatted, best: effectiveBest ? effectiveBest.modelId : null, pinnedModelId });
  });

  app.get('/api/config', (req, res) => {
    const currentConfig = loadConfig();
    const providers = Object.keys(sources).map(key => ({
      key,
      name: sources[key].name,
      enabled: isProviderEnabled(currentConfig, key),
      hasKey: !!currentConfig.apiKeys[key],
      signupUrl: API_KEY_SIGNUP_URLS[key] || null
    }));
    res.json(providers);
  });

  app.post('/api/config', (req, res) => {
    const { providerKey, apiKey, enabled } = req.body;
    const currentConfig = loadConfig();

    if (apiKey !== undefined) {
      currentConfig.apiKeys[providerKey] = apiKey;
    }
    if (enabled !== undefined) {
      if (!currentConfig.providers) currentConfig.providers = {};
      if (!currentConfig.providers[providerKey]) currentConfig.providers[providerKey] = {};
      currentConfig.providers[providerKey].enabled = enabled;
    }
    saveConfig(currentConfig);
    res.json({ success: true });
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
    }

    res.json({ success: true, bannedModels: currentBans });
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
    res.json({ pinnedModelId });
  });

  // POST to set or clear the pinned model
  app.post('/api/pinned', (req, res) => {
    const { modelId } = req.body;
    // modelId = null/undefined clears the pin (auto mode)
    pinnedModelId = modelId || null;
    console.log(chalk.cyan(`  [Router] 📌 Pinned model set to: ${pinnedModelId || '(auto)'}`));
    res.json({ success: true, pinnedModelId });
  });

  // Proxy endpoint
  app.get('/v1/models', (req, res) => {
    const best = findBestModel(results);

    // Always present the "auto-fastest" virtual model
    const data = [{
      id: "auto-fastest",
      object: "model",
      created: Date.now(),
      owned_by: "router"
    }];

    // Also list all individual models so clients can discover them
    // Filter out banned/disabled models
    for (const r of results) {
      if (r.status !== 'banned' && r.status !== 'disabled') {
        data.push({
          id: r.modelId,
          object: "model",
          created: Date.now(),
          owned_by: r.providerKey
        });
      }
    }

    res.json({ object: "list", data });
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

      const pickNextModel = () => {
        if (pinnedModelId) {
          const pinned = results.find(r => r.modelId === pinnedModelId);
          if (pinned && pinned.status !== 'banned' && pinned.status !== 'disabled' && !attemptedModelIds.has(pinned.modelId)) {
            return pinned;
          }
        }
        const ranked = rankModelsForRouting(results, Array.from(attemptedModelIds));
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
      let selectedProviderApiKey = null;
      let selectedResponse = null;
      let selectedT0 = 0;

      for (let retry = 0; retry <= MAX_PROACTIVE_RETRIES; retry++) {
        const best = pickNextModel();
        if (!best) break;

        attemptedModelIds.add(best.modelId);
        payload.model = best.modelId;

        const currentConfig = loadConfig();
        const providerApiKey = getApiKey(currentConfig, best.providerKey);
        const providerUrl = sources[best.providerKey]?.url;

        const attemptMeta = {
          index: retry + 1,
          model: best.modelId,
          provider: best.providerKey,
          status: 'pending',
          duration: null,
          retryable: false,
        };

        if (!providerApiKey) {
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

        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${providerApiKey}`
        };

        const t0 = performance.now();
        let response;
        try {
          response = await fetch(providerUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload)
          });
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

        await captureProxyRateLimit(best, response, providerApiKey);

        if (response.ok) {
          const now = Date.now();
          best.lastModelResponseAt = now;
          best.pings.push({ ms: attemptMeta.duration, code: '200', ts: now });
          if (best.pings.length > 50) best.pings.shift();
          best.status = 'up';
          best.httpCode = null;
          best.lastError = null;
          selectedModel = best;
          selectedProviderApiKey = providerApiKey;
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
        selectedProviderApiKey = providerApiKey;
        selectedResponse = response;
        selectedT0 = t0;
        break;
      }

      if (!selectedResponse || !selectedModel || !selectedProviderApiKey) {
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
        const MAX_LOG_BODY_SIZE = 1 * 1024 * 1024; // 1MB limit for logging

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

  const server = app.listen(port, () => {
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

  // Keep-alive timeouts to prevent client disconnects
  server.keepAliveTimeout = 61 * 1000;
  server.headersTimeout = 62 * 1000;
}
