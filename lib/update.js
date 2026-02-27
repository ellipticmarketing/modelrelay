import { spawnSync } from 'node:child_process'
import { getAutostartStatus, startAutostart, stopAutostart } from './autostart.js'

const NPM_LATEST_URL = 'https://registry.npmjs.org/modelrelay/latest'

function parseVersionParts(version) {
  if (typeof version !== 'string' || !version.trim()) return null
  const core = version.trim().split('-')[0]
  const parts = core.split('.').map(part => Number(part))
  if (parts.some(Number.isNaN)) return null
  while (parts.length < 3) parts.push(0)
  return parts
}

export function isVersionNewer(latest, current) {
  const latestParts = parseVersionParts(latest)
  const currentParts = parseVersionParts(current)
  if (!latestParts || !currentParts) return false

  const len = Math.max(latestParts.length, currentParts.length)
  for (let i = 0; i < len; i++) {
    const a = latestParts[i] ?? 0
    const b = currentParts[i] ?? 0
    if (a > b) return true
    if (a < b) return false
  }
  return false
}

export async function fetchLatestNpmVersion() {
  try {
    const resp = await fetch(NPM_LATEST_URL, { method: 'GET' })
    if (!resp.ok) return null
    const payload = await resp.json()
    if (!payload || typeof payload.version !== 'string' || !payload.version.trim()) return null
    return payload.version.trim()
  } catch {
    return null
  }
}

function runNpmUpdate(target = 'latest') {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npmCommand, ['install', '-g', `modelrelay@${target}`], { stdio: 'pipe', encoding: 'utf8' })

  if (result.error) {
    return {
      ok: false,
      message: `Failed to run npm update: ${result.error.message}`,
    }
  }

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || 'npm update failed').trim()
    return {
      ok: false,
      message: `npm global update failed: ${details}`,
    }
  }

  return {
    ok: true,
    message: `Updated modelrelay to ${target === 'latest' ? 'latest npm version' : `v${target}`}.`,
  }
}

export function runUpdateCommand(target = 'latest') {
  const status = getAutostartStatus()
  const shouldManageBackground = status.supported && status.configured
  const messages = []

  if (shouldManageBackground) {
    const stopResult = stopAutostart()
    if (!stopResult.ok) return stopResult
    messages.push(stopResult.message)
  } else {
    messages.push('Autostart is not configured; skipping background stop/start.')
  }

  const updateResult = runNpmUpdate(target)
  if (!updateResult.ok) return updateResult
  messages.push(updateResult.message)

  if (shouldManageBackground) {
    const startResult = startAutostart()
    if (!startResult.ok) {
      return {
        ok: false,
        message: `${messages.join('\n')}\nUpdate succeeded, but failed to restart autostart target: ${startResult.message}`,
      }
    }
    messages.push(startResult.message)
  }

  return {
    ok: true,
    message: messages.join('\n'),
  }
}
