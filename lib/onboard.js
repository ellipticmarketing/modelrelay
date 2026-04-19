import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { sources } from '../sources.js'
import { API_KEY_SIGNUP_URLS } from './providerLinks.js'
import { loadConfig, saveConfig, getApiKeyPool, getMaxTurns } from './config.js'
import { installAutostart } from './autostart.js'

const PROVIDER_ORDER = [
  'nvidia',
  'groq',
  'cerebras',
  'opencode',
  'openrouter',
  'openai-compatible',
  'ollama',
  'codestral',
  'scaleway',
  'kilocode',
  'googleai',
]

function isKiloCodeBearerEnabled(config) {
  const providerConfig = config?.providers?.kilocode
  if (!providerConfig || providerConfig.useBearerAuth == null) return true
  return providerConfig.useBearerAuth !== false
}

function maskKey(key) {
  if (!key) return '(none)'
  if (key.length <= 8) return `${key.slice(0, 2)}***`
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

function parseYesNo(answer, defaultValue = true) {
  const cleaned = (answer || '').trim().toLowerCase()
  if (!cleaned) return defaultValue
  if (['y', 'yes'].includes(cleaned)) return true
  if (['n', 'no'].includes(cleaned)) return false
  return defaultValue
}

function toJsonString(value) {
  return JSON.stringify(value, null, 2)
}

export function buildOpenClawProviderConfig(port) {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: 'openai-completions',
    apiKey: 'no-key',
    models: [
      {
        id: 'auto-fastest',
        name: 'Auto Fastest',
      },
    ],
  }
}

function buildOpenCodeConfigPatch(port) {
  return {
    provider: {
      router: {
        npm: '@ai-sdk/openai-compatible',
        name: 'modelrelay',
        options: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: 'dummy-key',
        },
        models: {
          'auto-fastest': {
            name: 'Auto Fastest',
          },
        },
      },
    },
    model: 'router/auto-fastest',
  }
}

function buildPicoclawConfigPatch(port) {
  return {
    model_name: 'modelrelay',
    model: 'openai/auto-fastest',
    api_base: `http://127.0.0.1:${port}/v1`
  }
}

function mergeShallowObject(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {}
      }
      mergeShallowObject(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}

function configureOpenCode(port) {
  const configPath = join(homedir(), '.config', 'opencode', 'opencode.json')
  const configDir = dirname(configPath)
  let config = {}

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return {
        ok: false,
        reason: `Could not parse ${configPath}.`,
      }
    }
  }

  mergeShallowObject(config, buildOpenCodeConfigPatch(port))
  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, `${toJsonString(config)}\n`)

  return {
    ok: true,
    path: configPath,
  }
}

function configureOpenClaw(port) {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json')
  const configDir = dirname(configPath)
  let config = {}

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return {
        ok: false,
        reason: `Could not parse ${configPath}. It may be JSON5; use the copy-paste commands below.`,
      }
    }
  }

  if (!config.models) config.models = {}
  if (!config.models.providers) config.models.providers = {}
  config.models.providers.modelrelay = buildOpenClawProviderConfig(port)

  if (!config.agents) config.agents = {}
  if (!config.agents.defaults) config.agents.defaults = {}
  if (!config.agents.defaults.model) config.agents.defaults.model = {}
  config.agents.defaults.model.primary = 'modelrelay/auto-fastest'

  if (!config.agents.defaults.models) config.agents.defaults.models = {}
  if (!config.agents.defaults.models['modelrelay/auto-fastest']) {
    config.agents.defaults.models['modelrelay/auto-fastest'] = {}
  }

  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, `${toJsonString(config)}\n`)

  return {
    ok: true,
    path: configPath,
  }
}

// At the top with other configure functions
async function configurePicoClaw(port) {
  const configPath = join(homedir(), '.picoclaw', 'config.json');
  const configDir = dirname(configPath)
  let config = {}

  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return {
        ok: false,
        reason: `Could not parse ${configPath}. It may be JSON5; use the copy-paste commands below.`,
      }
    }
  }

  // Add to model_list (avoid duplicates by model_name)
  if (!config.model_list) config.model_list = [];
  const existing = config.model_list.some(m => m.model_name === 'modelrelay');
  if (!existing) {
    config.model_list.push(buildPicoclawConfigPatch(port));
  }

  // Set as default if nothing was set before
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.model_name || config.agents.defaults.model_name === '') config.agents.defaults.model_name = 'modelrelay';

  writeFileSync(configPath, toJsonString(config), 'utf8');
  console.log(`✅ PicoClaw configured at ${configPath}`);
  return { ok: true, path: configPath };

  mkdirSync(configDir, { recursive: true })
  writeFileSync(configPath, `${toJsonString(config)}\n`)

  return {
    ok: true,
    path: configPath,
  }

}

function printIntegrationSnippets(port) {
  const opencodeSnippet = [
    '{',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "provider": {',
    '    "router": {',
    '      "npm": "@ai-sdk/openai-compatible",',
    '      "name": "modelrelay",',
    '      "options": {',
    `        "baseURL": "http://127.0.0.1:${port}/v1",`,
    '        "apiKey": "dummy-key"',
    '      },',
    '      "models": {',
    '        "auto-fastest": { "name": "Auto Fastest" }',
    '      }',
    '    }',
    '  },',
    '  "model": "router/auto-fastest"',
    '}',
  ].join('\n')

  const openclawSnippet = [
    '{',
    '  "models": {',
    '    "providers": {',
    '      "modelrelay": {',
    `        "baseUrl": "http://127.0.0.1:${port}/v1",`,
    '        "api": "openai-completions",',
    '        "apiKey": "no-key",',
    '        "models": [',
    '          { "id": "auto-fastest", "name": "Auto Fastest" }',
    '        ]',
    '      }',
    '    }',
    '  },',
    '  "agents": {',
    '    "defaults": {',
    '      "model": { "primary": "modelrelay/auto-fastest" },',
    '      "models": { "modelrelay/auto-fastest": {} }',
    '    }',
    '  }',
    '}',
  ].join('\n')

  const picoclawSnippet = [
    '{',
    '  "model_name": "modelrelay",',
    '  "model": "openai/auto-fastest",',
    `  "api_base": "http://127.0.0.1:${port}/v1",`,
    '}',
  ].join('\n')

  console.log('\nOpenCode quick config (paste into ~/.config/opencode/opencode.json):\n')
  console.log(opencodeSnippet)
  console.log('\nOpenClaw quick config (merge into ~/.openclaw/openclaw.json):\n')
  console.log(openclawSnippet)
  console.log('\nPicoClaw quick config (merge into ~/.picoclaw/config.json):\n')
  console.log(picoclawSnippet)
}

export async function runOnboard(port = 7352) {
  if (!process.stdin.isTTY) {
    console.log('onboard requires an interactive terminal.')
    printIntegrationSnippets(port)
    return false
  }

  const rl = readline.createInterface({ input, output })
  const config = loadConfig()

  if (!config.apiKeys) config.apiKeys = {}
  if (!config.providers) config.providers = {}

  console.log('\nmodelrelay onboarding')
  console.log('Enter an API key, press Enter to keep existing, or type - to clear.\n')

  for (const providerKey of PROVIDER_ORDER) {
    if (!sources[providerKey]) continue
    const providerName = sources[providerKey].name
    const existing = config.apiKeys[providerKey] || ''
    const signup = API_KEY_SIGNUP_URLS[providerKey] || '(see provider docs)'

    console.log(`- ${providerName} (${providerKey})`)
    console.log(`  signup: ${signup}`)
    if (providerKey === 'kilocode') {
      console.log('  note: API Key is optional for this provider (attaches as Bearer if provided)')
    }
    if (providerKey === 'openai-compatible' || providerKey === 'ollama') {
      console.log('  note: configure your upstream base URL and model ID after the API key prompt')
    }
    if (providerKey === 'ollama') {
      console.log('  note: Ollama cloud uses OLLAMA_API_KEY; leave base URL blank to use https://ollama.com/v1')
    }
    console.log(`  current: ${maskKey(existing)}`)
    const answer = await rl.question('  key: ')
    const value = answer.trim()

    if (value === '-') {
      delete config.apiKeys[providerKey]
      if (!config.providers[providerKey]) config.providers[providerKey] = {}
      config.providers[providerKey].enabled = false

      console.log('  cleared\n')
      continue
    }

    if (value) {
      config.apiKeys[providerKey] = value
      if (!config.providers[providerKey]) config.providers[providerKey] = {}
      config.providers[providerKey].enabled = true

      console.log('  updated')
    } else {
      console.log('  unchanged')
    }

    if (providerKey === 'openai-compatible' || providerKey === 'ollama') {
      if (!config.providers[providerKey]) config.providers[providerKey] = {}
      const currentBaseUrl = config.providers[providerKey].baseUrl || ''
      const currentModelId = config.providers[providerKey].modelId || ''
      console.log(`  current base URL: ${currentBaseUrl || '(none)'}`)
      const baseUrlAnswer = await rl.question('  base URL: ')
      const baseUrlValue = baseUrlAnswer.trim()
      if (baseUrlValue === '-') delete config.providers[providerKey].baseUrl
      else if (baseUrlValue) config.providers[providerKey].baseUrl = baseUrlValue

      console.log(`  current model ID: ${currentModelId || '(none)'}`)
      const modelIdAnswer = await rl.question('  model ID: ')
      const modelIdValue = modelIdAnswer.trim()
      if (modelIdValue === '-') delete config.providers[providerKey].modelId
      else if (modelIdValue) config.providers[providerKey].modelId = modelIdValue

      if (config.providers[providerKey].baseUrl && config.providers[providerKey].modelId) {
        config.providers[providerKey].enabled = true
      }
    }

    console.log('')
  }

  saveConfig(config)
  console.log('Saved API keys to ~/.modelrelay.json')

  const multiAccountProviders = []
  for (const providerKey of PROVIDER_ORDER) {
    if (!sources[providerKey]) continue
    const pool = getApiKeyPool(config, providerKey)
    if (pool.length > 1) {
      multiAccountProviders.push({ key: providerKey, name: sources[providerKey].name, count: pool.length })
    }
  }

  if (multiAccountProviders.length > 0) {
    console.log('\n--- Multi-Account Round-Robin ---')
    for (const { name, key, count } of multiAccountProviders) {
      console.log(`${name}: ${count} accounts configured. Requests will rotate across accounts.`)
    }
    console.log('Round-robin switches accounts to avoid hitting per-account rate limits.')
    const maxTurnsAnswer = await rl.question(`\nSet max-turns threshold (per-account)? Press Enter for unlimited (0), or enter a number (e.g. 20): `)
    const maxTurnsVal = maxTurnsAnswer.trim() || '0'
    const maxTurnsNum = Math.floor(Number(maxTurnsVal))
    for (const { key } of multiAccountProviders) {
      if (!config.providers[key]) config.providers[key] = {}
      if (isNaN(maxTurnsNum) || maxTurnsNum <= 0) {
        delete config.providers[key].maxTurns
      } else {
        config.providers[key].maxTurns = maxTurnsNum
      }
    }
    if (!isNaN(maxTurnsNum) && maxTurnsNum > 0) {
      console.log(`max-turns set to ${maxTurnsNum} for multi-account providers.`)
    } else {
      console.log('max-turns disabled (unlimited).')
    }
    saveConfig(config)
  } else {
    const hasSingleKeys = Object.keys(config.apiKeys || {}).some(k => getApiKeyPool(config, k).length === 1)
    if (hasSingleKeys) {
      console.log('\nTip: Add multiple API keys for automatic round-robin to avoid rate limits:')
      console.log('  modelrelay config add-key <provider> <key2>')
      console.log('  modelrelay config set-maxturns <provider> 20')
    }
  }

  const openCodeAnswer = await rl.question('\nAuto-configure OpenCode now? [Y/n]: ')
  const doOpenCode = parseYesNo(openCodeAnswer, true)
  if (doOpenCode) {
    const result = configureOpenCode(port)
    if (result.ok) console.log(`OpenCode configured: ${result.path}`)
    else console.log(`OpenCode auto-config skipped: ${result.reason}`)
  }

  const openClawAnswer = await rl.question('Auto-configure OpenClaw now? [Y/n]: ')
  const doOpenClaw = parseYesNo(openClawAnswer, true)
  if (doOpenClaw) {
    const result = configureOpenClaw(port)
    if (result.ok) console.log(`OpenClaw configured: ${result.path}`)
    else console.log(`OpenClaw auto-config skipped: ${result.reason}`)
  }

  const picoclawAnswer = await rl.question('Auto-configure PicoClaw now? [Y/n]: ');
  const doPicoclaw = parseYesNo(picoclawAnswer, true);
  if (doPicoclaw) {
    const result = await configurePicoClaw(port);
    if (result.ok) console.log(`PicoClaw configured: ${result.path}`)
    else console.log(`PicoClaw auto-config skipped: ${result.reason}`)
  }

  printIntegrationSnippets(port)

  const autostartAnswer = await rl.question('\nEnable auto-start at login now? [Y/n]: ')
  const doAutostart = parseYesNo(autostartAnswer, true)
  if (doAutostart) {
    const result = installAutostart()
    if (result.ok) console.log(result.message)
    else console.log(`Autostart setup skipped: ${result.message}`)
  }

  const startNowAnswer = await rl.question('\nStart router now? [Y/n]: ')
  const shouldStartRouter = parseYesNo(startNowAnswer, true)
  rl.close()
  return shouldStartRouter
}
