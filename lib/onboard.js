import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { sources } from '../sources.js'
import { API_KEY_SIGNUP_URLS } from './providerLinks.js'
import { loadConfig, saveConfig } from './config.js'
import { installAutostart } from './autostart.js'

const PROVIDER_ORDER = [
  'nvidia',
  'groq',
  'cerebras',
  'openrouter',
  'codestral',
  'scaleway',
  'googleai',
]

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
    api: 'openai',
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
    '        "api": "openai",',
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

  console.log('\nOpenCode quick config (paste into ~/.config/opencode/opencode.json):\n')
  console.log(opencodeSnippet)
  console.log('\nOpenClaw quick config (merge into ~/.openclaw/openclaw.json):\n')
  console.log(openclawSnippet)
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
      console.log('  updated\n')
      continue
    }

    console.log('  unchanged\n')
  }

  saveConfig(config)
  console.log('Saved API keys to ~/.modelrelay.json')

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
