import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createHash, randomBytes } from 'crypto'

const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/device/code'
const QWEN_OAUTH_TOKEN_ENDPOINT = 'https://chat.qwen.ai/api/v1/oauth2/token'
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion'
const QWEN_OAUTH_DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const EXPIRY_BUFFER_MS = 30_000

export function getQwenOauthCredsPath() {
  return join(homedir(), '.qwen', 'oauth_creds.json')
}

export function hasQwenOauthCredentials(credentialsPath = getQwenOauthCredsPath()) {
  return existsSync(credentialsPath)
}

export function isQwenOauthAccessTokenValid(credentials, now = Date.now()) {
  const token = typeof credentials?.access_token === 'string' ? credentials.access_token.trim() : ''
  const expiryDate = Number(credentials?.expiry_date)
  if (!token) return false
  if (!Number.isFinite(expiryDate) || expiryDate <= 0) return false
  return now < (expiryDate - EXPIRY_BUFFER_MS)
}

function readQwenOauthCredentials(credentialsPath = getQwenOauthCredsPath()) {
  const credsPath = credentialsPath
  if (!existsSync(credsPath)) return null
  try {
    const raw = readFileSync(credsPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function saveQwenOauthCredentials(credentials, credentialsPath = getQwenOauthCredsPath()) {
  const credsPath = credentialsPath
  try {
    mkdirSync(dirname(credsPath), { recursive: true })
    writeFileSync(credsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // Best effort: continue with in-memory token even if persisting fails.
  }
}

function createCodeVerifier() {
  return randomBytes(32).toString('base64url')
}

function createCodeChallenge(codeVerifier) {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

export async function startQwenOauthDeviceLogin() {
  const codeVerifier = createCodeVerifier()
  const codeChallenge = createCodeChallenge(codeVerifier)

  const body = new URLSearchParams({
    client_id: QWEN_OAUTH_CLIENT_ID,
    scope: QWEN_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString()

  const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw new Error(`Qwen OAuth device authorization failed (${response.status}). ${raw}`)
  }

  const payload = await response.json()
  if (!payload || typeof payload !== 'object' || !payload.device_code || !payload.verification_uri_complete) {
    throw new Error('Qwen OAuth device authorization returned an invalid response.')
  }

  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code || '',
    verificationUri: payload.verification_uri || '',
    verificationUriComplete: payload.verification_uri_complete,
    expiresIn: Number(payload.expires_in) || 600,
    codeVerifier,
  }
}

export async function pollQwenOauthDeviceToken({ deviceCode, codeVerifier, credentialsPath = getQwenOauthCredsPath() }) {
  const body = new URLSearchParams({
    grant_type: QWEN_OAUTH_DEVICE_GRANT_TYPE,
    client_id: QWEN_OAUTH_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: codeVerifier,
  }).toString()

  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok) {
    const err = payload && typeof payload === 'object' ? payload.error : null
    if (response.status === 400 && err === 'authorization_pending') {
      return { status: 'pending', slowDown: false }
    }
    if (response.status === 429 && err === 'slow_down') {
      return { status: 'pending', slowDown: true }
    }
    if (response.status === 400 && err === 'expired_token') {
      return { status: 'expired' }
    }
    const raw = payload && typeof payload === 'object' && payload.error_description ? payload.error_description : 'Unknown error'
    return { status: 'error', message: raw }
  }

  if (!payload || typeof payload !== 'object' || typeof payload.access_token !== 'string' || !payload.access_token.trim()) {
    return { status: 'error', message: 'Qwen OAuth token response missing access_token.' }
  }

  const expiresIn = Number(payload.expires_in)
  const nextCredentials = {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    resource_url: typeof payload.resource_url === 'string' ? payload.resource_url : undefined,
    expiry_date: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + (expiresIn * 1000) : Date.now() + 3600_000,
  }

  saveQwenOauthCredentials(nextCredentials, credentialsPath)
  return { status: 'authorized', credentials: nextCredentials }
}

export async function resolveQwenCodeOauthAccessToken(options = {}) {
  const session = await resolveQwenCodeOauthSession(options)
  return session ? session.accessToken : null
}

export async function resolveQwenCodeOauthSession(options = {}) {
  const forceRefresh = !!options.forceRefresh
  const credentialsPath = options.credentialsPath || getQwenOauthCredsPath()
  const credentials = readQwenOauthCredentials(credentialsPath)
  if (!credentials) return null

  if (!forceRefresh && isQwenOauthAccessTokenValid(credentials)) {
    return {
      accessToken: credentials.access_token,
      resourceUrl: typeof credentials.resource_url === 'string' ? credentials.resource_url : null,
    }
  }

  const refreshToken = typeof credentials.refresh_token === 'string' ? credentials.refresh_token.trim() : ''
  if (!refreshToken) return null

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: QWEN_OAUTH_CLIENT_ID,
    }).toString()

    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    })

    if (!response.ok) return null

    const payload = await response.json()
    if (!payload || typeof payload !== 'object') return null
    if (typeof payload.access_token !== 'string' || !payload.access_token.trim()) return null

    const expiresIn = Number(payload.expires_in)
    const expiryDate = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + (expiresIn * 1000) : credentials.expiry_date
    const nextCredentials = {
      ...credentials,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === 'string' && payload.refresh_token.trim() ? payload.refresh_token : refreshToken,
      token_type: typeof payload.token_type === 'string' ? payload.token_type : credentials.token_type,
      resource_url: typeof payload.resource_url === 'string' ? payload.resource_url : credentials.resource_url,
      expiry_date: expiryDate,
    }

    saveQwenOauthCredentials(nextCredentials, credentialsPath)
    return {
      accessToken: nextCredentials.access_token,
      resourceUrl: typeof nextCredentials.resource_url === 'string' ? nextCredentials.resource_url : null,
    }
  } catch {
    return null
  }
}
