/**
 * identity.js — достоверная идентичность: web-сессия (cookie) и Telegram initData.
 */
const crypto = require('crypto');
const { pool } = require('./db');
const { getToken } = require('./auth');

const INIT_DATA_MAX_AGE_SEC = 86_400; // 24h
const TG_INIT_HEADER = 'x-telegram-init-data';

/** @returns {string | null} */
function getTelegramInitDataFromReq(req) {
  const h = req.headers[TG_INIT_HEADER] ?? req.headers[TG_INIT_HEADER.toUpperCase()];
  if (typeof h === 'string' && h.trim()) return h.trim();
  return null;
}

/**
 * Валидирует Telegram WebApp initData.
 * @param {string} initData — сырая строка из Telegram.WebApp.initData
 * @returns {{ userId: string, userName: string } | null}
 */
function validateTelegramInitData(initData) {
  const token = process.env.BOT_TOKEN;
  if (!token || !initData || typeof initData !== 'string') return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const authDate = parseInt(params.get('auth_date') ?? '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SEC) return null;

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key !== 'hash') pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(token)
    .digest();

  const calculated = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  try {
    const a = Buffer.from(calculated, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  const userRaw = params.get('user');
  if (!userRaw) return null;
  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return null;
  }
  if (!user?.id) return null;

  const userName = [user.first_name, user.last_name].filter(Boolean).join(' ')
    || user.username
    || 'Участник';

  return { userId: String(user.id), userName };
}

/**
 * Web-пользователь из cookie picnic_sid.
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ userId: string, userName: string } | null>}
 */
async function resolveWebUser(req) {
  const sessionToken = getToken(req);
  if (!sessionToken) return null;
  const { rows } = await pool.query(`
    SELECT u.id, u.name
    FROM users u
    JOIN user_sessions s ON s.user_id = u.id
    WHERE s.id = $1 AND s.expires_at > NOW()
  `, [sessionToken]);
  if (!rows.length) return null;
  return { userId: rows[0].id, userName: rows[0].name };
}

/**
 * Telegram из заголовка или поля initData.
 * @param {import('http').IncomingMessage} req
 * @param {string} [initDataFromBody]
 */
function resolveTelegramUser(req, initDataFromBody) {
  const raw = initDataFromBody || getTelegramInitDataFromReq(req);
  if (!raw) return null;
  return validateTelegramInitData(raw);
}

/**
 * Web cookie или Telegram initData (TG приоритетнее при обоих).
 * @param {import('http').IncomingMessage} req
 * @param {{ initData?: string }} [opts]
 */
async function resolveRequestUser(req, opts = {}) {
  const tg = resolveTelegramUser(req, opts.initData);
  if (tg) return { ...tg, source: 'telegram' };
  const web = await resolveWebUser(req);
  if (web) return { ...web, source: 'web' };
  return null;
}

/**
 * Создаёт строку в users для Telegram-id (group_members уже используют tg id без users).
 * family_members.owner_id ссылается на users — без этого INSERT падает по FK.
 */
async function ensureAppUserRecord(pool, { userId, userName }) {
  const { rows } = await pool.query('SELECT id FROM users WHERE id=$1', [userId]);
  if (rows.length) return;
  const email = `tg_${userId}@telegram.internal`;
  await pool.query(
    `INSERT INTO users(id, email, name) VALUES($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [userId, email, userName || 'Участник'],
  );
}

/**
 * WS join: initData в сообщении или cookie на upgrade.
 */
async function resolveWsJoinIdentity(cookieHeader, initData) {
  if (initData) {
    const tg = validateTelegramInitData(initData);
    if (tg) return { ...tg, source: 'telegram' };
  }
  if (cookieHeader) {
    const fakeReq = { headers: { cookie: cookieHeader } };
    const web = await resolveWebUser(fakeReq);
    if (web) return { ...web, source: 'web' };
  }
  return null;
}

module.exports = {
  TG_INIT_HEADER,
  getTelegramInitDataFromReq,
  validateTelegramInitData,
  resolveWebUser,
  resolveTelegramUser,
  resolveRequestUser,
  resolveWsJoinIdentity,
  ensureAppUserRecord,
};
