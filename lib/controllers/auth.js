'use strict';

const { nanoid }               = require('nanoid');
const { pool }                 = require('../db');
const { validatePassword }     = require('../password-policy');
const { checkRateLimit, getClientIp } = require('../rate-limit');
const { readBodySafe, readFormBodySafe } = require('../request-helpers');
const {
  getSessionUser, createSession, deleteSession,
  hashPassword, verifyPassword,
} = require('../auth');
const {
  FRONTEND_URL,
  createState, consumeState, findOrCreateOAuthUser,
  yandexAuthUrl, yandexExchange, yandexUserInfo,
  appleAuthUrl, appleExchange,
} = require('../oauth');

// ── OAuth: Yandex ─────────────────────────────────────────────────────────────

async function startYandex(req, res, { H }) {
  if (!process.env.YANDEX_CLIENT_ID) {
    res.writeHead(503, H); res.end(JSON.stringify({ error: 'Yandex OAuth не настроен' })); return;
  }
  const state = createState('yandex');
  res.writeHead(302, { Location: yandexAuthUrl(state) });
  res.end();
}

async function yandexCallback(req, res, { H, url }) {
  const code  = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !consumeState(state, 'yandex')) {
    res.writeHead(302, { Location: `${FRONTEND_URL}?auth_error=1` }); res.end(); return;
  }
  try {
    const token = await yandexExchange(code);
    const info  = await yandexUserInfo(token);
    const user  = await findOrCreateOAuthUser('yandex', info.id, info.default_email,
                    info.real_name || info.display_name || info.login);
    await createSession(res, user.id);
    res.writeHead(302, { Location: FRONTEND_URL });
    res.end();
  } catch (e) {
    console.error('yandex callback:', e.message);
    res.writeHead(302, { Location: `${FRONTEND_URL}?auth_error=1` }); res.end();
  }
}

// ── OAuth: Apple ──────────────────────────────────────────────────────────────

async function startApple(req, res, { H }) {
  if (!process.env.APPLE_CLIENT_ID) {
    res.writeHead(503, H); res.end(JSON.stringify({ error: 'Apple OAuth не настроен' })); return;
  }
  const state = createState('apple');
  res.writeHead(302, { Location: appleAuthUrl(state) });
  res.end();
}

async function appleCallback(req, res, { H }) {
  const body  = await readFormBodySafe(req, res, H);
  if (body === null) return;
  const code  = body.code;
  const state = body.state;
  if (!code || !consumeState(state, 'apple')) {
    res.writeHead(302, { Location: `${FRONTEND_URL}?auth_error=1` }); res.end(); return;
  }
  try {
    const { sub, email } = await appleExchange(code);
    let name = 'Пользователь';
    if (body.user) {
      try {
        const u = JSON.parse(body.user)?.name;
        if (u) name = [u.firstName, u.lastName].filter(Boolean).join(' ');
      } catch { /* Apple sends invalid JSON occasionally */ }
    }
    const user = await findOrCreateOAuthUser('apple', sub, email, name);
    await createSession(res, user.id);
    res.writeHead(302, { Location: FRONTEND_URL });
    res.end();
  } catch (e) {
    console.error('apple callback:', e.message);
    res.writeHead(302, { Location: `${FRONTEND_URL}?auth_error=1` }); res.end();
  }
}

// ── Email/password auth ───────────────────────────────────────────────────────

async function register(req, res, { H }) {
  const ip = getClientIp(req);
  if (!await checkRateLimit(`register:${ip}`, { limit: 10, windowMs: 15 * 60 * 1000 })) {
    res.writeHead(429, H); res.end(JSON.stringify({ error: 'too many requests' })); return;
  }
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  const { name, email, password } = body;
  if (!name?.trim() || !email?.trim() || !password) {
    res.writeHead(400, H); res.end(JSON.stringify({ error: 'Заполни все поля' })); return;
  }
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) {
    res.writeHead(400, H); res.end(JSON.stringify({ error: pwCheck.error })); return;
  }
  const normalEmail = email.trim().toLowerCase();
  const { rows: ex } = await pool.query('SELECT id FROM users WHERE email=$1', [normalEmail]);
  if (ex.length) {
    res.writeHead(409, H); res.end(JSON.stringify({ error: 'Email уже занят' })); return;
  }
  const id   = nanoid(10);
  const hash = await hashPassword(password);
  await pool.query(
    'INSERT INTO users(id, email, password_hash, name) VALUES($1,$2,$3,$4)',
    [id, normalEmail, hash, name.trim()],
  );
  await createSession(res, id);
  res.writeHead(200, H);
  res.end(JSON.stringify({ id, name: name.trim(), email: normalEmail }));
}

async function devLogin(req, res, { H }) {
  if (process.env.NODE_ENV === 'production') {
    res.writeHead(404, H); res.end(JSON.stringify({ error: 'not found' })); return;
  }
  const email    = process.env.DEV_USER_EMAIL;
  const password = process.env.DEV_USER_PASSWORD;
  const name     = process.env.DEV_USER_NAME || 'Dev User';
  if (!email || !password) {
    res.writeHead(503, H); res.end(JSON.stringify({ error: 'DEV_USER_* not configured' })); return;
  }
  let { rows } = await pool.query('SELECT id, name, email FROM users WHERE email=$1', [email.toLowerCase()]);
  if (!rows.length) {
    const id   = nanoid(10);
    const hash = await hashPassword(password);
    await pool.query(
      'INSERT INTO users(id, email, password_hash, name) VALUES($1,$2,$3,$4)',
      [id, email.toLowerCase(), hash, name],
    );
    rows = [{ id, name, email: email.toLowerCase() }];
  }
  await createSession(res, rows[0].id);
  res.writeHead(200, H);
  res.end(JSON.stringify(rows[0]));
}

async function login(req, res, { H }) {
  const ip = getClientIp(req);
  if (!await checkRateLimit(`login:${ip}`, { limit: 20, windowMs: 15 * 60 * 1000 })) {
    res.writeHead(429, H); res.end(JSON.stringify({ error: 'too many requests' })); return;
  }
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  const { email, password } = body;
  if (!email?.trim() || !password) {
    res.writeHead(400, H); res.end(JSON.stringify({ error: 'Заполни все поля' })); return;
  }
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.trim().toLowerCase()]);
  if (!rows.length) {
    res.writeHead(401, H); res.end(JSON.stringify({ error: 'Неверный email или пароль' })); return;
  }
  const user = rows[0];
  const ok   = await verifyPassword(password, user.password_hash);
  if (!ok) {
    res.writeHead(401, H); res.end(JSON.stringify({ error: 'Неверный email или пароль' })); return;
  }
  await createSession(res, user.id);
  res.writeHead(200, H);
  res.end(JSON.stringify({ id: user.id, name: user.name, email: user.email }));
}

async function logout(req, res, { H }) {
  await deleteSession(req, res);
  res.writeHead(200, H);
  res.end('{}');
}

async function me(req, res, { H }) {
  const user = await getSessionUser(req);
  if (!user) {
    res.writeHead(401, H); res.end(JSON.stringify({ error: 'not authenticated' })); return;
  }
  res.writeHead(200, H);
  res.end(JSON.stringify(user));
}

module.exports = { startYandex, yandexCallback, startApple, appleCallback, register, devLogin, login, logout, me };
