import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const WINDOWS_STARTUP_RELATIVE = ['Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup']
const WINDOWS_STARTUP_FILE = 'modelrelay-autostart.cmd'
const LINUX_SERVICE_FILE = 'modelrelay.service'
const MACOS_AGENT_FILE = 'io.modelrelay.autostart.plist'
const MACOS_AGENT_LABEL = 'io.modelrelay.autostart'

function run(command, args) {
  return spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8' })
}

function toErrorMessage(result) {
  const stderr = (result?.stderr || '').trim()
  const stdout = (result?.stdout || '').trim()
  const fallback = result?.error?.message || 'command failed'
  return stderr || stdout || fallback
}

function getPaths(platform = process.platform) {
  if (platform === 'win32') {
    const appData = process.env.APPDATA
    if (!appData) return null
    return {
      platform,
      filePath: join(appData, ...WINDOWS_STARTUP_RELATIVE, WINDOWS_STARTUP_FILE),
    }
  }

  if (platform === 'linux') {
    return {
      platform,
      filePath: join(homedir(), '.config', 'systemd', 'user', LINUX_SERVICE_FILE),
      unitName: LINUX_SERVICE_FILE,
    }
  }

  if (platform === 'darwin') {
    return {
      platform,
      filePath: join(homedir(), 'Library', 'LaunchAgents', MACOS_AGENT_FILE),
      label: MACOS_AGENT_LABEL,
    }
  }

  return null
}

export function resolveAutostartExecPath(argvPath = process.argv[1]) {
  if (typeof argvPath === 'string' && argvPath.trim()) {
    const candidate = isAbsolute(argvPath) ? argvPath : resolve(argvPath)
    if (existsSync(candidate)) return candidate
  }
  return 'modelrelay'
}

export function resolveAutostartNodePath(nodePath = process.execPath) {
  if (typeof nodePath === 'string' && nodePath.trim()) {
    const candidate = isAbsolute(nodePath) ? nodePath : resolve(nodePath)
    if (existsSync(candidate)) return candidate
  }
  return 'node'
}

function linuxUnitFile(execPath, nodePath) {
  const pathEntries = [
    '/usr/local/sbin',
    '/usr/local/bin',
    '/usr/sbin',
    '/usr/bin',
    '/sbin',
    '/bin',
    dirname(nodePath),
    dirname(execPath),
  ]
  const servicePath = [...new Set(pathEntries.filter(Boolean))].join(':')

  return [
    '[Unit]',
    'Description=modelrelay autostart',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=PATH=${servicePath}`,
    `ExecStart=${nodePath} ${execPath}`,
    'Restart=always',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

function macosPlist() {
  const logPath = join(homedir(), '.modelrelay-autostart.log')
  const errorPath = join(homedir(), '.modelrelay-autostart.err.log')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${MACOS_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-lc</string>',
    '    <string>modelrelay</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${logPath}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${errorPath}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

function windowsStartupScript() {
  return ['@echo off', 'start "" /min modelrelay', ''].join('\r\n')
}

export function getAutostartStatus(platform = process.platform) {
  const paths = getPaths(platform)
  if (!paths) {
    return {
      ok: false,
      supported: false,
      message: `Autostart is not supported on platform: ${platform}`,
    }
  }

  if (platform === 'win32') {
    return {
      ok: true,
      supported: true,
      configured: existsSync(paths.filePath),
      message: existsSync(paths.filePath)
        ? `Autostart is enabled via ${paths.filePath}`
        : 'Autostart is not enabled.',
    }
  }

  if (platform === 'linux') {
    const configured = existsSync(paths.filePath)
    const enabledResult = run('systemctl', ['--user', 'is-enabled', paths.unitName])
    const activeResult = run('systemctl', ['--user', 'is-active', paths.unitName])
    const systemctlMissing = enabledResult.error?.code === 'ENOENT' || activeResult.error?.code === 'ENOENT'

    if (systemctlMissing) {
      return {
        ok: false,
        supported: true,
        configured,
        message: 'Autostart file exists, but systemctl was not found in PATH.',
      }
    }

    const enabled = enabledResult.status === 0
    const active = activeResult.status === 0
    return {
      ok: true,
      supported: true,
      configured,
      enabled,
      active,
      message: configured
        ? `Autostart file is present (${enabled ? 'enabled' : 'disabled'}, ${active ? 'active' : 'inactive'}).`
        : 'Autostart is not enabled.',
    }
  }

  const configured = existsSync(paths.filePath)
  const loadedResult = run('launchctl', ['list', paths.label])
  const loaded = loadedResult.status === 0
  const launchctlMissing = loadedResult.error?.code === 'ENOENT'

  if (launchctlMissing) {
    return {
      ok: false,
      supported: true,
      configured,
      message: 'Autostart file exists, but launchctl was not found in PATH.',
    }
  }

  return {
    ok: true,
    supported: true,
    configured,
    loaded,
    message: configured
      ? `Autostart file is present (${loaded ? 'loaded' : 'not loaded'}).`
      : 'Autostart is not enabled.',
  }
}

export function installAutostart(platform = process.platform) {
  const paths = getPaths(platform)
  if (!paths) {
    return {
      ok: false,
      supported: false,
      message: `Autostart is not supported on platform: ${platform}`,
    }
  }

  mkdirSync(dirname(paths.filePath), { recursive: true })

  if (platform === 'win32') {
    writeFileSync(paths.filePath, windowsStartupScript(), 'utf8')
    return {
      ok: true,
      supported: true,
      path: paths.filePath,
      message: `Autostart enabled via Startup shortcut script: ${paths.filePath}`,
    }
  }

  if (platform === 'linux') {
    const execPath = resolveAutostartExecPath()
    const nodePath = resolveAutostartNodePath()
    writeFileSync(paths.filePath, linuxUnitFile(execPath, nodePath), 'utf8')

    const reloadResult = run('systemctl', ['--user', 'daemon-reload'])
    if (reloadResult.error?.code === 'ENOENT') {
      return {
        ok: false,
        supported: true,
        path: paths.filePath,
        message: 'Created service file, but systemctl is not available in PATH.',
      }
    }
    if (reloadResult.status !== 0) {
      return {
        ok: false,
        supported: true,
        path: paths.filePath,
        message: `Service file created, but daemon-reload failed: ${toErrorMessage(reloadResult)}`,
      }
    }

    const enableResult = run('systemctl', ['--user', 'enable', '--now', paths.unitName])
    if (enableResult.status !== 0) {
      return {
        ok: false,
        supported: true,
        path: paths.filePath,
        message: `Service file created, but enable/start failed: ${toErrorMessage(enableResult)}`,
      }
    }

    return {
      ok: true,
      supported: true,
      path: paths.filePath,
      message: `Autostart enabled with systemd user service: ${paths.unitName}\nRun: systemctl --user status ${paths.unitName}`,
    }
  }

  writeFileSync(paths.filePath, macosPlist(), 'utf8')
  run('launchctl', ['unload', paths.filePath])
  const loadResult = run('launchctl', ['load', paths.filePath])

  if (loadResult.error?.code === 'ENOENT') {
    return {
      ok: false,
      supported: true,
      path: paths.filePath,
      message: 'Created launch agent file, but launchctl is not available in PATH.',
    }
  }
  if (loadResult.status !== 0) {
    return {
      ok: false,
      supported: true,
      path: paths.filePath,
      message: `Launch agent file created, but load failed: ${toErrorMessage(loadResult)}`,
    }
  }

  return {
    ok: true,
    supported: true,
    path: paths.filePath,
    message: `Autostart enabled with launch agent: ${MACOS_AGENT_LABEL}`,
  }
}

export function uninstallAutostart(platform = process.platform) {
  const paths = getPaths(platform)
  if (!paths) {
    return {
      ok: false,
      supported: false,
      message: `Autostart is not supported on platform: ${platform}`,
    }
  }

  if (platform === 'win32') {
    if (existsSync(paths.filePath)) rmSync(paths.filePath)
    return {
      ok: true,
      supported: true,
      message: 'Autostart disabled.',
    }
  }

  if (platform === 'linux') {
    const disableResult = run('systemctl', ['--user', 'disable', '--now', paths.unitName])
    if (disableResult.error?.code !== 'ENOENT' && disableResult.status !== 0) {
      return {
        ok: false,
        supported: true,
        message: `Unable to disable service cleanly: ${toErrorMessage(disableResult)}`,
      }
    }
    if (existsSync(paths.filePath)) rmSync(paths.filePath)

    const reloadResult = run('systemctl', ['--user', 'daemon-reload'])
    if (reloadResult.error?.code !== 'ENOENT' && reloadResult.status !== 0) {
      return {
        ok: false,
        supported: true,
        message: `Service removed, but daemon-reload failed: ${toErrorMessage(reloadResult)}`,
      }
    }

    return {
      ok: true,
      supported: true,
      message: 'Autostart disabled.',
    }
  }

  run('launchctl', ['unload', paths.filePath])
  if (existsSync(paths.filePath)) rmSync(paths.filePath)
  return {
    ok: true,
    supported: true,
    message: 'Autostart disabled.',
  }
}
