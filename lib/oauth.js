/**
 * OAuth 2.0 helpers: Yandex + Apple Sign In
 *
 * Env vars needed:
 *   Yandex: YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET
 *   Apple:  APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY
 *
 * CALLBACK_BASE  — base URL the OAuth providers redirect back to (PUBLIC_URL)
 * FRONTEND_URL   — where to send users after successful auth (defaults to CALLBACK_BASE)
 */
const crypto  = require('crypto')
const jwt     = require('jsonwebtoken')
const jwksClient = require('jwks-rsa')
const { nanoid } = require('nanoid')
const { pool } = require('./db')

const appleJwks = jwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
  cache: true,
  cacheMaxAge: 86_400_000,
})

const CALLBACK_BASE = process.env.PUBLIC_URL   || 'http://localhost:3001'
const FRONTEND_URL  = process.env.FRONTEND_URL || CALLBACK_BASE

// ── CSRF state store (in-memory, 10-min TTL) ──────────────────────────────────

const _states = new Map()

function createState(provider) {
  const s = crypto.randomBytes(16).toString('hex')
  _states.set(s, { provider, at: Date.now() })
  setTimeout(() => _states.delete(s), 10 * 60 * 1000)
  return s
}

function consumeState(state, provider) {
  const e = _states.get(state)
  if (!e) return false
  _states.delete(state)
  return e.provider === provider && Date.now() - e.at < 10 * 60 * 1000
}

// ── DB: find or create user by OAuth account ──────────────────────────────────

async function findOrCreateOAuthUser(provider, providerId, email, name) {
  const pid = String(providerId)

  // 1. Look up existing OAuth link
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email
     FROM users u
     JOIN oauth_accounts oa ON oa.user_id = u.id
     WHERE oa.provider = $1 AND oa.provider_id = $2`,
    [provider, pid],
  )
  if (rows.length) return rows[0]

  // 2. Link to existing email account
  if (email) {
    const { rows: byEmail } = await pool.query(
      'SELECT id, name, email FROM users WHERE email = $1',
      [email.toLowerCase()],
    )
    if (byEmail.length) {
      await pool.query(
        `INSERT INTO oauth_accounts(user_id, provider, provider_id, email)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [byEmail[0].id, provider, pid, email.toLowerCase()],
      )
      return byEmail[0]
    }
  }

  // 3. Create new user (no password_hash for OAuth-only)
  const id           = nanoid(10)
  const displayName  = name?.trim() || 'Пользователь'
  const displayEmail = email?.toLowerCase() ?? `${provider}.${pid}@noreply.local`

  await pool.query(
    'INSERT INTO users(id, email, name) VALUES($1,$2,$3)',
    [id, displayEmail, displayName],
  )
  await pool.query(
    `INSERT INTO oauth_accounts(user_id, provider, provider_id, email)
     VALUES($1,$2,$3,$4)`,
    [id, provider, pid, email?.toLowerCase() ?? null],
  )
  return { id, name: displayName, email: displayEmail }
}

// ── Yandex ────────────────────────────────────────────────────────────────────

function yandexAuthUrl(state) {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.YANDEX_CLIENT_ID,
    redirect_uri:  `${CALLBACK_BASE}/auth/yandex/callback`,
    scope:         'login:email login:info',
    state,
  })
  return `https://oauth.yandex.ru/authorize?${p}`
}

async function yandexExchange(code) {
  const r = await fetch('https://oauth.yandex.ru/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      client_id:     process.env.YANDEX_CLIENT_ID,
      client_secret: process.env.YANDEX_CLIENT_SECRET,
      redirect_uri:  `${CALLBACK_BASE}/auth/yandex/callback`,
    }),
  })
  const data = await r.json()
  if (!data.access_token) throw new Error('Yandex token exchange failed')
  return data.access_token
}

async function yandexUserInfo(accessToken) {
  const r = await fetch('https://login.yandex.ru/info?format=json', {
    headers: { Authorization: `OAuth ${accessToken}` },
  })
  return r.json()
}

// ── Apple ─────────────────────────────────────────────────────────────────────

function appleClientSecret() {
  const key = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  return jwt.sign({}, key, {
    algorithm: 'ES256',
    expiresIn: '5m',
    issuer:    process.env.APPLE_TEAM_ID,
    audience:  'https://appleid.apple.com',
    subject:   process.env.APPLE_CLIENT_ID,
    keyid:     process.env.APPLE_KEY_ID,
  })
}

function appleAuthUrl(state) {
  const p = new URLSearchParams({
    client_id:     process.env.APPLE_CLIENT_ID,
    redirect_uri:  `${CALLBACK_BASE}/auth/apple/callback`,
    response_type: 'code',
    scope:         'name email',
    state,
    response_mode: 'form_post',
  })
  return `https://appleid.apple.com/auth/authorize?${p}`
}

/**
 * @param {string} idToken
 * @returns {Promise<{ sub: string, email?: string }>}
 */
function verifyAppleIdToken(idToken) {
  const clientId = process.env.APPLE_CLIENT_ID
  if (!clientId) throw new Error('APPLE_CLIENT_ID not configured')

  return new Promise((resolve, reject) => {
    jwt.verify(
      idToken,
      (header, callback) => {
        appleJwks.getSigningKey(header.kid, (err, key) => {
          if (err) {
            callback(err)
            return
          }
          callback(null, key.getPublicKey())
        })
      },
      {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: clientId,
      },
      (err, decoded) => {
        if (err) {
          reject(err)
          return
        }
        if (!decoded || typeof decoded.sub !== 'string') {
          reject(new Error('Invalid Apple id_token payload'))
          return
        }
        resolve({
          sub: decoded.sub,
          email: typeof decoded.email === 'string' ? decoded.email : undefined,
        })
      },
    )
  })
}

async function appleExchange(code) {
  const r = await fetch('https://appleid.apple.com/auth/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.APPLE_CLIENT_ID,
      client_secret: appleClientSecret(),
      code,
      grant_type:    'authorization_code',
      redirect_uri:  `${CALLBACK_BASE}/auth/apple/callback`,
    }),
  })
  const data = await r.json()
  if (!data.id_token) throw new Error('Apple token exchange failed')
  return verifyAppleIdToken(data.id_token)
}

module.exports = {
  FRONTEND_URL,
  createState,
  consumeState,
  findOrCreateOAuthUser,
  yandexAuthUrl,
  yandexExchange,
  yandexUserInfo,
  appleAuthUrl,
  appleExchange,
}
