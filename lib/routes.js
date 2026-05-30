const { nanoid } = require('nanoid');
const { pool, DEFAULT_CATS, getFullState, readBody, readFormBody } = require('./db');
const { logActivity } = require('./activity');
const { analyzeDiff } = require('./agent');
const { handleUpdate }     = require('./bot');
const { handleUpdate: handleMaxUpdate } = require('./bot-max');
const { getSessionUser, createSession, deleteSession, hashPassword, verifyPassword } = require('./auth');
const { resolveRequestUser } = require('./identity');
const { isGroupMember } = require('./membership');
const { baseHeaders, preflightHeaders } = require('./cors');
const { checkRateLimit, getClientIp } = require('./rate-limit');
const {
  FRONTEND_URL,
  createState, consumeState, findOrCreateOAuthUser,
  yandexAuthUrl, yandexExchange, yandexUserInfo,
  appleAuthUrl, appleExchange,
} = require('./oauth');

async function requireUser(req, res, initDataExtra) {
  const H = baseHeaders(req);
  const user = await resolveRequestUser(req, { initData: initDataExtra });
  if (!user) {
    res.writeHead(401, H);
    res.end(JSON.stringify({ error: 'not authenticated' }));
    return null;
  }
  return { user, H };
}

/**
 * Main HTTP request handler — called by server.js inside async wrapper.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 * @param {{ broadcast: Function, wss: import('ws').WebSocketServer }} ctx
 */
async function handleRequest(req, res, { broadcast, wss }) {
  const url = new URL(req.url, 'http://localhost');
  const H = baseHeaders(req);

  // ── CORS preflight ─────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, preflightHeaders(req));
    res.end();
    return;
  }

  // ── GET /health ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    const payload = process.env.HEALTH_VERBOSE === 'true'
      ? { ok: true, clients: wss.clients.size, uptime: Math.round(process.uptime()) }
      : { ok: true };
    res.writeHead(200, H);
    res.end(JSON.stringify(payload));
    return;
  }

  // ── POST /tg-webhook (Telegram) ───────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/tg-webhook') {
    const secret = process.env.TG_WEBHOOK_SECRET;
    if (secret) {
      const header = req.headers['x-telegram-bot-api-secret-token'];
      if (header !== secret) {
        res.writeHead(403, H);
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
    }
    const body = await readBody(req);
    res.writeHead(200, H);
    res.end('{}');
    handleUpdate(body, pool, broadcast).catch(e => console.error('tg-bot:', e.message));
    return;
  }

  // ── POST /max-webhook (MAX Messenger) ─────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/max-webhook') {
    const body = await readBody(req);
    res.writeHead(200, H);
    res.end('{}');
    handleMaxUpdate(body).catch(e => console.error('max-bot:', e.message));
    return;
  }

  // ── GET /users/:userId/groups ──────────────────────────────────────────────
  const userGroupsMatch = url.pathname.match(/^\/users\/([^/]+)\/groups$/);
  if (req.method === 'GET' && userGroupsMatch) {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user, H: h } = auth;
    if (userGroupsMatch[1] !== user.userId) {
      res.writeHead(403, h);
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const result = await pool.query(`
      SELECT
        g.id,
        g.name,
        g.invite_code,
        COUNT(DISTINCT m2.user_id)::int AS member_count,
        COUNT(DISTINCT i.id)::int       AS item_count
      FROM picnic_groups g
      JOIN group_members m  ON m.group_id  = g.id AND m.user_id = $1
      LEFT JOIN group_members m2 ON m2.group_id = g.id
      LEFT JOIN items i ON i.group_id = g.id
      GROUP BY g.id, g.name, g.invite_code
      ORDER BY g.created_at DESC
    `, [user.userId]);
    res.writeHead(200, h);
    res.end(JSON.stringify(result.rows));
    return;
  }

  // ── POST /groups — создать группу ─────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/groups') {
    const body = await readBody(req);
    const auth = await requireUser(req, res, body.initData);
    if (!auth) return;
    const { user, H: h } = auth;
    const name = body.name?.trim();
    if (!name) {
      res.writeHead(400, h);
      res.end(JSON.stringify({ error: 'missing fields' }));
      return;
    }
    const id = nanoid(10);
    const inviteCode = nanoid(6).toUpperCase();
    await pool.query('INSERT INTO picnic_groups(id,invite_code,name) VALUES($1,$2,$3)', [id, inviteCode, name]);
    await pool.query(
      'INSERT INTO group_members(group_id,user_id,name,is_admin) VALUES($1,$2,$3,TRUE)',
      [id, user.userId, user.userName],
    );
    for (let i = 0; i < DEFAULT_CATS.length; i++) {
      const c = DEFAULT_CATS[i];
      await pool.query(
        'INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)',
        [c.id, id, c.title, c.icon, i],
      );
    }
    res.writeHead(200, h);
    res.end(JSON.stringify({ id, inviteCode }));
    return;
  }

  // ── POST /groups/join — вступить по invite-коду ────────────────────────────
  if (req.method === 'POST' && url.pathname === '/groups/join') {
    const ip = getClientIp(req);
    if (!checkRateLimit(`join:${ip}`, { limit: 30, windowMs: 15 * 60 * 1000 })) {
      res.writeHead(429, H);
      res.end(JSON.stringify({ error: 'too many requests' }));
      return;
    }
    const body = await readBody(req);
    const auth = await requireUser(req, res, body.initData);
    if (!auth) return;
    const { user, H: h } = auth;
    const inviteCode = body.inviteCode?.trim();
    if (!inviteCode) {
      res.writeHead(400, h);
      res.end(JSON.stringify({ error: 'missing fields' }));
      return;
    }
    const grp = await pool.query('SELECT * FROM picnic_groups WHERE invite_code=$1', [inviteCode.toUpperCase()]);
    if (!grp.rows.length) {
      res.writeHead(404, h);
      res.end(JSON.stringify({ error: 'Группа не найдена' }));
      return;
    }
    const group = grp.rows[0];
    await pool.query(
      `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
       ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
      [group.id, user.userId, user.userName],
    );
    await logActivity(pool, { groupId: group.id, type: 'member:joined', actorName: user.userName });
    const state = await getFullState(group.id);
    broadcast(group.id, { type: 'state', state });
    res.writeHead(200, h);
    res.end(JSON.stringify({ id: group.id, name: group.name, state }));
    return;
  }

  // ── POST /groups/join-by-id — вступить по id (deep-link) ──────────────────
  if (req.method === 'POST' && url.pathname === '/groups/join-by-id') {
    const body = await readBody(req);
    const auth = await requireUser(req, res, body.initData);
    if (!auth) return;
    const { user, H: h } = auth;
    const groupId = body.groupId;
    if (!groupId) {
      res.writeHead(400, h);
      res.end(JSON.stringify({ error: 'missing fields' }));
      return;
    }
    const grp = await pool.query('SELECT * FROM picnic_groups WHERE id=$1', [groupId]);
    if (!grp.rows.length) {
      res.writeHead(404, h);
      res.end(JSON.stringify({ error: 'Группа не найдена' }));
      return;
    }
    const group = grp.rows[0];
    await pool.query(
      `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
       ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
      [group.id, user.userId, user.userName],
    );
    await logActivity(pool, { groupId: group.id, type: 'member:joined', actorName: user.userName });
    const state = await getFullState(group.id);
    broadcast(group.id, { type: 'state', state });
    res.writeHead(200, h);
    res.end(JSON.stringify({ id: group.id, name: group.name, state }));
    return;
  }

  // ── POST /agent/analyze ────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/agent/analyze') {
    const body = await readBody(req);
    const auth = await requireUser(req, res, body.initData);
    if (!auth) return;
    const { user, H: h } = auth;
    const groupId = body.groupId;
    if (!groupId) {
      res.writeHead(400, h);
      res.end(JSON.stringify({ error: 'groupId required' }));
      return;
    }
    if (!checkRateLimit(`analyze:${user.userId}:${groupId}`, { limit: 10, windowMs: 60 * 60 * 1000 })) {
      res.writeHead(429, h);
      res.end(JSON.stringify({ error: 'too many requests' }));
      return;
    }
    if (!await isGroupMember(groupId, user.userId)) {
      res.writeHead(403, h);
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const [msgsRes, itemsRes] = await Promise.all([
      pool.query('SELECT user_name,text FROM chat_messages WHERE group_id=$1 ORDER BY created_at DESC LIMIT 100', [groupId]),
      pool.query('SELECT * FROM items WHERE group_id=$1', [groupId]),
    ]);
    if (!msgsRes.rows.length) {
      res.writeHead(200, h);
      res.end(JSON.stringify({
        summary: 'В чате пока нет сообщений. Привяжите бота командой /link КОД в вашей Telegram-группе.',
        missing: [], extra: [], changed: [],
      }));
      return;
    }
    const result = await analyzeDiff(msgsRes.rows.reverse(), itemsRes.rows);
    await pool.query('INSERT INTO agent_analyses(group_id,analysis) VALUES($1,$2)', [groupId, JSON.stringify(result)]);
    res.writeHead(200, h);
    res.end(JSON.stringify(result));
    return;
  }

  // ── GET /auth/yandex — start Yandex OAuth ────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/auth/yandex') {
    if (!process.env.YANDEX_CLIENT_ID) {
      res.writeHead(503, H); res.end(JSON.stringify({ error: 'Yandex OAuth не настроен' })); return;
    }
    const state = createState('yandex');
    res.writeHead(302, { Location: yandexAuthUrl(state) });
    res.end();
    return;
  }

  // ── GET /auth/yandex/callback ─────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/auth/yandex/callback') {
    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !consumeState(state, 'yandex')) {
      res.writeHead(302, { Location: `${FRONTEND_URL}?auth_error=1` }); res.end(); return;
    }
    try {
      const token    = await yandexExchange(code);
      const info     = await yandexUserInfo(token);
      const user     = await findOrCreateOAuthUser('yandex', info.id, info.default_email,
                          info.real_name || info.display_name || info.login);
      await createSession(res, user.id);
      res.writeHead(302, { Location: FRONTEND_URL });
      res.end();
    } catch (e) {
      console.error('yandex callback:', e.message);
      res.writeHead(302, { Location: `${FRONTEND_URL}?auth_error=1` }); res.end();
    }
    return;
  }

  // ── GET /auth/apple — start Apple Sign In ─────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/auth/apple') {
    if (!process.env.APPLE_CLIENT_ID) {
      res.writeHead(503, H); res.end(JSON.stringify({ error: 'Apple OAuth не настроен' })); return;
    }
    const state = createState('apple');
    res.writeHead(302, { Location: appleAuthUrl(state) });
    res.end();
    return;
  }

  // ── POST /auth/apple/callback (Apple uses form_post) ─────────────────────
  if (req.method === 'POST' && url.pathname === '/auth/apple/callback') {
    const body  = await readFormBody(req);
    const code  = body.code;
    const state = body.state;
    if (!code || !consumeState(state, 'apple')) {
      res.writeHead(302, { Location: `${FRONTEND_URL}?auth_error=1` }); res.end(); return;
    }
    try {
      const { sub, email } = await appleExchange(code);
      // Apple only sends user name on first auth
      let name = 'Пользователь';
      if (body.user) {
        try {
          const u = JSON.parse(body.user)?.name;
          if (u) name = [u.firstName, u.lastName].filter(Boolean).join(' ');
        } catch {}
      }
      const user = await findOrCreateOAuthUser('apple', sub, email, name);
      await createSession(res, user.id);
      res.writeHead(302, { Location: FRONTEND_URL });
      res.end();
    } catch (e) {
      console.error('apple callback:', e.message);
      res.writeHead(302, { Location: `${FRONTEND_URL}?auth_error=1` }); res.end();
    }
    return;
  }

  // ── POST /auth/register ───────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/auth/register') {
    const ip = getClientIp(req);
    if (!checkRateLimit(`register:${ip}`, { limit: 10, windowMs: 15 * 60 * 1000 })) {
      res.writeHead(429, H);
      res.end(JSON.stringify({ error: 'too many requests' }));
      return;
    }
    const { name, email, password } = await readBody(req);
    if (!name?.trim() || !email?.trim() || !password) {
      res.writeHead(400, H); res.end(JSON.stringify({ error: 'Заполни все поля' })); return;
    }
    if (password.length < 8) {
      res.writeHead(400, H); res.end(JSON.stringify({ error: 'Пароль минимум 8 символов' })); return;
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
    return;
  }

  // ── POST /auth/dev-login (только development) ───────────────────────────
  if (req.method === 'POST' && url.pathname === '/auth/dev-login') {
    if (process.env.NODE_ENV === 'production') {
      res.writeHead(404, H);
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const email = process.env.DEV_USER_EMAIL;
    const password = process.env.DEV_USER_PASSWORD;
    const name = process.env.DEV_USER_NAME || 'Dev User';
    if (!email || !password) {
      res.writeHead(503, H);
      res.end(JSON.stringify({ error: 'DEV_USER_* not configured' }));
      return;
    }
    let { rows } = await pool.query('SELECT id, name, email FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) {
      const id = nanoid(10);
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
    return;
  }

  // ── POST /auth/login ──────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/auth/login') {
    const ip = getClientIp(req);
    if (!checkRateLimit(`login:${ip}`, { limit: 20, windowMs: 15 * 60 * 1000 })) {
      res.writeHead(429, H);
      res.end(JSON.stringify({ error: 'too many requests' }));
      return;
    }
    const { email, password } = await readBody(req);
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
    return;
  }

  // ── POST /auth/logout ─────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    await deleteSession(req, res);
    res.writeHead(200, H);
    res.end('{}');
    return;
  }

  // ── GET /auth/me ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/auth/me') {
    const user = await getSessionUser(req);
    if (!user) { res.writeHead(401, H); res.end(JSON.stringify({ error: 'not authenticated' })); return; }
    res.writeHead(200, H);
    res.end(JSON.stringify(user));
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  res.writeHead(404, H);
  res.end(JSON.stringify({ error: 'not found' }));
}

module.exports = { handleRequest };
