#!/usr/bin/env node

/**
 * Model Validation Script
 *
 * Validates integrity between sources.js and scores.js:
 *  - Every model in sources has a corresponding score in scores
 *  - Scores are in [0, 1] range
 *  - Context windows are non-empty strings or positive numbers
 *  - Warns on duplicate modelIds across providers (routing ambiguity)
 *  - Warns on orphaned scores (scores without models)
 *
 * Exit codes: 0 = pass, 1 = failures found
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const sourcesModule = await import('../sources.js');
  const scoresModule = await import('../scores.js');

  const sources = sourcesModule.sources || sourcesModule.default || sourcesModule;
  const scores = scoresModule.scores || scoresModule.default || scoresModule;

  let errors = [];
  let warnings = [];

  // Build flat list of all models: { modelId, providerKey, ctx, canonicalId }
  const allModels = [];
  for (const [providerKey, provider] of Object.entries(sources)) {
    if (!provider.models || !Array.isArray(provider.models)) {
      console.warn(`Provider ${providerKey} has no models array`);
      continue;
    }
    for (const modelTuple of provider.models) {
      const [modelId, label, ctx] = modelTuple;
      // Strip :free suffix for score lookup
      const canonicalId = modelId.replace(/:free$/, '');
      allModels.push({ modelId, label, ctx, providerKey, canonicalId });
    }
  }

  console.log(`Validating ${allModels.length} models across ${Object.keys(sources).length} providers...`);

  // 1. Check every model has a score
  const missingScores = [];
  for (const m of allModels) {
    if (!(m.canonicalId in scores)) {
      missingScores.push({ modelId: m.modelId, provider: m.providerKey, canonical: m.canonicalId });
    }
  }
  if (missingScores.length > 0) {
    errors.push(`Missing scores for ${missingScores.length} model(s):`);
    for (const miss of missingScores.slice(0, 10)) {
      errors.push(`  - ${miss.modelId} (${miss.provider}) → canonical: ${miss.canonicalId}`);
    }
    if (missingScores.length > 10) {
      errors.push(`  ... and ${missingScores.length - 10} more`);
    }
  } else {
    console.log('✓ All models have scores');
  }

  // 2. Check score range [0, 1]
  const outOfRange = [];
  for (const [mid, score] of Object.entries(scores)) {
    const s = Number(score);
    if (isNaN(s) || s < 0 || s > 1) {
      outOfRange.push({ modelId: mid, score });
    }
  }
  if (outOfRange.length > 0) {
    errors.push(`Scores out of [0,1] range: ${outOfRange.map(o => `${o.modelId}=${o.score}`).join(', ')}`);
  } else {
    console.log('✓ All scores in [0, 1]');
  }

  // 3. Check for duplicate modelIds across providers (warn, not error)
  const seen = new Map();
  const duplicates = new Map();
  for (const m of allModels) {
    if (seen.has(m.modelId)) {
      if (!duplicates.has(m.modelId)) {
        duplicates.set(m.modelId, [seen.get(m.modelId)]);
      }
      duplicates.get(m.modelId).push(m.providerKey);
    } else {
      seen.set(m.modelId, m.providerKey);
    }
  }
  if (duplicates.size > 0) {
    warnings.push(`Duplicate model IDs across providers (routing may be ambiguous):`);
    for (const [mid, providers] of duplicates) {
      warnings.push(`  - '${mid}' in: ${providers.join(', ')}`);
    }
  } else {
    console.log('✓ No duplicate model IDs across providers');
  }

  // 4. Check context windows are non-empty (string or positive number)
  const badCtx = allModels.filter(m => {
    if (m.ctx === null || m.ctx === undefined || m.ctx === '') return true;
    if (typeof m.ctx === 'number' && m.ctx <= 0) return true;
    return false;
  });
  if (badCtx.length > 0) {
    errors.push(`Invalid context windows (empty or non-positive): ${badCtx.slice(0, 5).map(b => `${b.modelId}=${b.ctx}`).join(', ')}`);
  } else {
    console.log('✓ All context windows are set (strings allowed, e.g. "128k")');
  }

  // 5. Orphaned scores (scores without models) — info/warn
  const canonicalIds = new Set(allModels.map(m => m.canonicalId));
  const orphanedScores = Object.keys(scores).filter(k => !canonicalIds.has(k));
  if (orphanedScores.length > 0) {
    warnings.push(`Scores without matching models (orphaned): ${orphanedScores.length} — acceptable (scores.js is a superset)`);
  }

  // Summary
  console.log('\n--- Summary ---');
  console.log(`Models: ${allModels.length}, Providers: ${Object.keys(sources).length}, Scores: ${Object.keys(scores).length}`);
  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  if (errors.length > 0) {
    console.error(`\n✗ Validation FAILED (${errors.length} error(s)):`);
    for (const e of errors) console.error(`  ✖ ${e}`);
    process.exit(1);
  } else {
    console.log('\n✓ All checks passed.');
    process.exit(0);
  }
}

await main();
