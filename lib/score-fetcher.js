import { MODELS, canonicalizeModelId } from '../sources.js';
import { fetchKiloCodeFreeModels, fetchOllamaModels, fetchOpenCodeModels, fetchOpenRouterFreeModels } from './server.js';
import { isProviderEnabled } from './config.js';

export function normalizeMissingScoreId(modelId) {
  return canonicalizeModelId(modelId).base;
}

/**
 * Identifies models that are currently using the default/estimated score.
 * It performs real-time discovery of models from providers.
 */
export async function getModelsNeedingScores(config) {
  // Use dynamic import for scores to avoid caching issues during a session
  const { scores } = await import(`../scores.js?t=${Date.now()}`);

  function hasScore(modelId) {
    const { base, unprefixed } = canonicalizeModelId(modelId);
    return (scores[base] != null) || (scores[unprefixed] != null);
  }

  const needing = new Set();

  function addMissing(modelId) {
    needing.add(normalizeMissingScoreId(modelId));
  }

  // 1. Check hardcoded models
  for (const [modelId] of MODELS) {
    if (!hasScore(modelId)) {
      addMissing(modelId);
    }
  }

  // 2. Perform live discovery from providers (just like the server does)
  
  // KiloCode
  if (isProviderEnabled(config, 'kilocode')) {
    try {
      const models = await fetchKiloCodeFreeModels(config);
      for (const m of models) {
        // Recalculate isEstimatedScore using the fresh scores map
        const scoreExists = hasScore(m.modelId);
        if (!scoreExists) {
          addMissing(m.modelId);
        }
      }
    } catch (e) {
      // Ignore discovery errors in fetcher
    }
  }

  // OpenRouter
  if (isProviderEnabled(config, 'openrouter')) {
    try {
      const models = await fetchOpenRouterFreeModels(config);
      for (const m of models) {
        const scoreExists = hasScore(m.modelId);
        if (!scoreExists) {
          addMissing(m.modelId);
        }
      }
    } catch (e) {
      // Ignore discovery errors in fetcher
    }
  }

  // OpenCode Zen
  if (isProviderEnabled(config, 'opencode')) {
    try {
      const models = await fetchOpenCodeModels(config);
      for (const m of models) {
        const scoreExists = hasScore(m.modelId);
        if (!scoreExists) {
          addMissing(m.modelId);
        }
      }
    } catch (e) {
      // Ignore discovery errors in fetcher
    }
  }

  // Ollama
  if (isProviderEnabled(config, 'ollama')) {
    try {
      const models = await fetchOllamaModels(config);
      for (const m of models) {
        const scoreExists = hasScore(m.modelId);
        if (!scoreExists) {
          addMissing(m.modelId);
        }
      }
    } catch (e) {
      // Ignore discovery errors in fetcher
    }
  }

  return Array.from(needing).sort();
}
