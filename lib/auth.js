/**
 * Web Auth: bcrypt password hashing + HttpOnly cookie sessions
 */
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const { pool } = require('./db')

const COOKIE = 'picnic_sid'
const DAYS   = 30

// ── Cookie helpers ────────────────────────────────────────────────────────────

function setCookie(res, token) {
  const exp = new Date(Date.now() + DAYS * 86_400_000).toUTCString()
  const sec = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Expires=${exp}${sec}`)
}

function clearCookie(res) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`)
}

function getToken(req) {
  const h = req.headers.cookie ?? ''
  const m = h.match(/(?:^|;\s*)picnic_sid=([^;]+)/)
  return m?.[1] ?? null
}

// ── Session ───────────────────────────────────────────────────────────────────

async function getSessionUser(req) {
  const token = getToken(req)
  if (!token) return null
  const { rows } = await pool.query(`
    SELECT u.id, u.email, u.name, u.bio, u.is_superadmin,
           EXISTS(
             SELECT 1 FROM group_members gm
             WHERE gm.user_id = u.id AND gm.is_admin = TRUE
           ) AS is_admin
    FROM users u
    JOIN user_sessions s ON s.user_id = u.id
    WHERE s.id = $1 AND s.expires_at > NOW()
  `, [token])
  if (!rows[0]) return null
  const user = rows[0]
  // username — часть email до @, например "anya_k" из "anya_k@gmail.com"
  user.username = user.email ? user.email.split('@')[0] : null
  return user
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex')
  const exp   = new Date(Date.now() + DAYS * 86_400_000)
  await pool.query(
    'INSERT INTO user_sessions(id, user_id, expires_at) VALUES($1,$2,$3)',
    [token, userId, exp],
  )
  setCookie(res, token)
}

async function deleteSession(req, res) {
  const token = getToken(req)
  if (token) await pool.query('DELETE FROM user_sessions WHERE id=$1', [token])
  clearCookie(res)
}

// ── Password ──────────────────────────────────────────────────────────────────

/**
 * bcrypt молча обрезает пароли длиннее 72 байт — делаем это явно,
 * чтобы "password" + 100 посторонних байт не совпадал с "password".
 * Обрезаем по байтам (UTF-8), а не символам.
 */
function truncate72(pw) {
  const buf = Buffer.from(pw, 'utf8')
  return buf.length > 72 ? buf.subarray(0, 72).toString('utf8') : pw
}

const hashPassword   = (pw)       => bcrypt.hash(truncate72(pw), 12)
const verifyPassword = (pw, hash) => bcrypt.compare(truncate72(pw), hash)

module.exports = { setCookie, clearCookie, getToken, getSessionUser, createSession, deleteSession, hashPassword, verifyPassword }
