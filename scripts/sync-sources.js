#!/usr/bin/env node
/**
 * @file scripts/sync-sources.js
 * @description Syncs model definitions from free-coding-models upstream.
 *
 * Usage:
 *   npm run sync:sources        # apply sync
 *   npm run sync:sources:dry    # preview changes (dry run + verbose)
 *
 * Reads free-coding-models-src/sources.js and merges new/updated models into
 * the local sources.js. Preserves:
 * - modelrelay-specific providers (kilocode, openai-compatible, qwencode, opencode)
 * - Provider URLs and metadata
 * - Model ID aliases and label overrides defined in sources.js
 *
 * Model array format:
 *   modelrelay:  [modelId, label, ctx]
 *   upstream fcm: [modelId, label, tier, sweScore, ctx]
 *
 * The script uses the upstream modelId, label, and ctx; tier/sweScore
 * are handled separately in scores.js.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const LOCAL_SOURCES = resolve(ROOT_DIR, 'sources.js');
const UPSTREAM_SOURCES = resolve(ROOT_DIR, '..', 'free-coding-models-src', 'sources.js');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('-n');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

function log(...msg) {
  if (VERBOSE || DRY_RUN) console.log(...msg);
}

function findProviderBlock(text, key) {
  const search = `"${key}": {`;
  const idx = text.indexOf(search);
  if (idx === -1) return null;
  let depth = 0;
  let i = idx + search.length - 1;
  do {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  } while (depth > 0 && i < text.length);
  if (depth !== 0) return null;
  return { start: idx, end: i, text: text.slice(idx, i) };
}

function extractModelsFromBlock(blockText) {
  const m = blockText.match(/models:\s*\[([\s\S]*?)\]\s*\}\s*$/);
  if (!m) return [];
  return parseModelsArray(m[1]);
}

function parseModelsArray(text) {
  const models = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '[') break;
    const start = i;
    let depth = 0;
    do {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') depth--;
      i++;
    } while (depth > 0);
    const item = text.slice(start + 1, i - 1);
    const parsed = parseModelEntry(item);
    if (parsed) models.push(parsed);
    while (i < text.length && (text[i] === ',' || /\s/.test(text[i]))) i++;
  }
  return models;
}

function parseModelEntry(text) {
  const fields = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString && (ch === "'" || ch === '"')) {
      inString = true;
      stringChar = ch;
    } else if (inString && ch === stringChar && text[i - 1] !== '\\') {
      inString = false;
    } else if (!inString && ch === ',') {
      fields.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) fields.push(current.trim());
  if (fields.length < 4) return null;
  return {
    modelId: stripQuotes(fields[0]),
    label: stripQuotes(fields[1]),
    tier: stripQuotes(fields[2]),
    sweScore: stripQuotes(fields[3]),
    ctx: fields.length >= 5 ? stripQuotes(fields[4]) : '128k',
  };
}

function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

function extractUpstreamProviderArrays(source) {
  const providers = {};
  const providerPattern = /export\s+const\s+(\w+)\s*=\s*\[/g;
  let match;
  while ((match = providerPattern.exec(source)) !== null) {
    const name = match[1];
    if (name === 'MODELS') continue;
    const start = match.index + match[0].length;
    let depth = 0;
    let end = start;
    do {
      if (source[end] === '[') depth++;
      else if (source[end] === ']') depth--;
      end++;
    } while (depth > 0 && end < source.length);
    const arrayText = source.slice(start, end - 1);
    providers[name] = parseModelsArray(arrayText);
  }
  return providers;
}

const PROVIDER_KEY_MAP = {
  nvidiaNim: 'nvidia',
  groq: 'groq',
  cerebras: 'cerebras',
  sambanova: 'sambanova',
  openrouter: 'openrouter',
  huggingface: 'huggingface',
  replicate: 'replicate',
  deepinfra: 'deepinfra',
  fireworks: 'fireworks',
  codestral: 'codestral',
  hyperbolic: 'hyperbolic',
  scaleway: 'scaleway',
  googleai: 'googleai',
  zai: 'zai',
  siliconflow: 'siliconflow',
  together: 'together',
  cloudflare: 'cloudflare',
  perplexity: 'perplexity',
  qwen: 'qwen',
  iflow: 'iflow',
  rovo: null,
  gemini: null,
  opencodeZen: 'opencode',
};

function main() {
  console.log('Syncing sources from free-coding-models...\n');

  let localSources;
  try {
    localSources = readFileSync(LOCAL_SOURCES, 'utf8');
  } catch (e) {
    console.error(`Error reading local sources.js: ${e.message}`);
    process.exit(1);
  }

  let upstreamSources;
  try {
    upstreamSources = readFileSync(UPSTREAM_SOURCES, 'utf8');
  } catch (e) {
    console.error(`Error reading upstream sources.js: ${e.message}`);
    console.error('Make sure free-coding-models-src is cloned as a sibling directory.');
    process.exit(1);
  }

  const upstreamProviders = extractUpstreamProviderArrays(upstreamSources);
  log('Upstream providers:', Object.keys(upstreamProviders));

  let result = localSources;
  const summary = [];
  let totalAdded = 0;
  let totalUpdated = 0;

  for (const [rawKey, upstreamModels] of Object.entries(upstreamProviders)) {
    const providerKey = PROVIDER_KEY_MAP[rawKey];
    if (!providerKey) {
      log(`Skipping non-API provider: ${rawKey}`);
      continue;
    }

    const block = findProviderBlock(result, providerKey);
    if (!block) {
      log(`Provider not found in local sources: ${providerKey}`);
      continue;
    }

    const existingModels = extractModelsFromBlock(block.text);
    const existingMap = new Map(existingModels.map(m => [m[0], m]));

    const added = [];
    const updated = [];

    for (const um of upstreamModels) {
      const modelId = um.modelId;
      const entry = [modelId, um.label, um.ctx];
      const existing = existingMap.get(modelId);

      if (!existing) {
        added.push(entry);
        log(`  + ${modelId} (${um.label})`);
      } else if (existing[1] !== um.label || existing[2] !== um.ctx) {
        updated.push({ from: existing, to: entry });
        log(`  ~ ${modelId}: "${existing[1]}" -> "${um.label}", ctx ${existing[2]} -> ${um.ctx}`);
      }
    }

    const unchanged = existingModels.filter(m => {
      return upstreamModels.some(um => um.modelId === m[0]);
    });
    const merged = [...unchanged, ...added, ...updated.map(u => u.to)];

    const mergedText = merged
      .map(m => `      ["${m[0]}", "${m[1]}", "${m[2]}"]`)
      .join(',\n');

    const newBlock = block.text.replace(
      /models:\s*\[[\s\S]*?\]\s*\}\s*$/,
      `models: [\n${mergedText}\n    ]\n  }`
    );

    result = result.slice(0, block.start) + newBlock + result.slice(block.end);

    if (added.length > 0 || updated.length > 0) {
      log(`\n${providerKey}: +${added.length} added, ~${updated.length} updated`);
      summary.push({ provider: providerKey, added: added.length, updated: updated.length });
      totalAdded += added.length;
      totalUpdated += updated.length;
    }
  }

  console.log('\n--- Summary ---');
  if (summary.length === 0) {
    console.log('No changes needed. Sources are up to date.');
  } else {
    for (const s of summary) {
      console.log(`  ${s.provider}: +${s.added} added, ~${s.updated} updated`);
    }
    console.log(`\nTotal: +${totalAdded} added, ~${totalUpdated} updated`);
  }

  if (DRY_RUN) {
    console.log('\n[Dry run] No changes written. Use `npm run sync:sources` to apply.');
  } else {
    writeFileSync(LOCAL_SOURCES, result);
    console.log(`\nUpdated ${LOCAL_SOURCES}`);
    console.log('Remember to run tests: npm test');
  }
}

main();
