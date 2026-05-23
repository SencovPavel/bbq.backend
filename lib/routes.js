const { nanoid } = require('nanoid');
const { pool, DEFAULT_CATS, getFullState, readBody } = require('./db');
const { analyzeDiff } = require('./agent');
const { handleUpdate } = require('./bot');

const H = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

/**
 * Main HTTP request handler — called by server.js inside async wrapper.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 * @param {{ broadcast: Function, wss: import('ws').WebSocketServer }} ctx
 */
async function handleRequest(req, res, { broadcast, wss }) {
  const url = new URL(req.url, 'http://localhost');

  // ── CORS preflight ─────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...H, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // ── GET /health ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, H);
    res.end(JSON.stringify({ ok: true, clients: wss.clients.size, uptime: Math.round(process.uptime()) }));
    return;
  }

  // ── POST /tg-webhook ───────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/tg-webhook') {
    const body = await readBody(req);
    res.writeHead(200, H);
    res.end('{}');
    // fire-and-forget: ответ Telegram уже отправлен
    handleUpdate(body, pool, broadcast).catch(e => console.error('bot:', e.message));
    return;
  }

  // ── GET /users/:userId/groups ──────────────────────────────────────────────
  const userGroupsMatch = url.pathname.match(/^\/users\/([^/]+)\/groups$/);
  if (req.method === 'GET' && userGroupsMatch) {
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
    `, [userGroupsMatch[1]]);
    res.writeHead(200, H);
    res.end(JSON.stringify(result.rows));
    return;
  }

  // ── POST /groups — создать группу ─────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/groups') {
    const { name, userId, userName } = await readBody(req);
    if (!name || !userId || !userName) {
      res.writeHead(400, H);
      res.end(JSON.stringify({ error: 'missing fields' }));
      return;
    }
    const id = nanoid(10);
    const inviteCode = nanoid(6).toUpperCase();
    await pool.query('INSERT INTO picnic_groups(id,invite_code,name) VALUES($1,$2,$3)', [id, inviteCode, name]);
    await pool.query('INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)', [id, userId, userName]);
    for (let i = 0; i < DEFAULT_CATS.length; i++) {
      const c = DEFAULT_CATS[i];
      await pool.query(
        'INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)',
        [c.id, id, c.title, c.icon, i],
      );
    }
    res.writeHead(200, H);
    res.end(JSON.stringify({ id, inviteCode }));
    return;
  }

  // ── POST /groups/join — вступить по invite-коду ────────────────────────────
  if (req.method === 'POST' && url.pathname === '/groups/join') {
    const { inviteCode, userId, userName } = await readBody(req);
    if (!inviteCode || !userId || !userName) {
      res.writeHead(400, H);
      res.end(JSON.stringify({ error: 'missing fields' }));
      return;
    }
    const grp = await pool.query('SELECT * FROM picnic_groups WHERE invite_code=$1', [inviteCode.toUpperCase()]);
    if (!grp.rows.length) {
      res.writeHead(404, H);
      res.end(JSON.stringify({ error: 'Группа не найдена' }));
      return;
    }
    const group = grp.rows[0];
    await pool.query(
      `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
       ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
      [group.id, userId, userName],
    );
    const state = await getFullState(group.id);
    broadcast(group.id, { type: 'state', state });
    res.writeHead(200, H);
    res.end(JSON.stringify({ id: group.id, name: group.name, state }));
    return;
  }

  // ── POST /groups/join-by-id — вступить по id (deep-link) ──────────────────
  if (req.method === 'POST' && url.pathname === '/groups/join-by-id') {
    const { groupId, userId, userName } = await readBody(req);
    if (!groupId || !userId || !userName) {
      res.writeHead(400, H);
      res.end(JSON.stringify({ error: 'missing fields' }));
      return;
    }
    const grp = await pool.query('SELECT * FROM picnic_groups WHERE id=$1', [groupId]);
    if (!grp.rows.length) {
      res.writeHead(404, H);
      res.end(JSON.stringify({ error: 'Группа не найдена' }));
      return;
    }
    const group = grp.rows[0];
    await pool.query(
      `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
       ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
      [group.id, userId, userName],
    );
    const state = await getFullState(group.id);
    broadcast(group.id, { type: 'state', state });
    res.writeHead(200, H);
    res.end(JSON.stringify({ id: group.id, name: group.name, state }));
    return;
  }

  // ── POST /agent/analyze ────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/agent/analyze') {
    const { groupId } = await readBody(req);
    if (!groupId) {
      res.writeHead(400, H);
      res.end(JSON.stringify({ error: 'groupId required' }));
      return;
    }
    const [msgsRes, itemsRes] = await Promise.all([
      pool.query('SELECT user_name,text FROM chat_messages WHERE group_id=$1 ORDER BY created_at DESC LIMIT 100', [groupId]),
      pool.query('SELECT * FROM items WHERE group_id=$1', [groupId]),
    ]);
    if (!msgsRes.rows.length) {
      res.writeHead(200, H);
      res.end(JSON.stringify({
        summary: 'В чате пока нет сообщений. Привяжите бота командой /link КОД в вашей Telegram-группе.',
        missing: [], extra: [], changed: [],
      }));
      return;
    }
    const result = await analyzeDiff(msgsRes.rows.reverse(), itemsRes.rows);
    await pool.query('INSERT INTO agent_analyses(group_id,analysis) VALUES($1,$2)', [groupId, JSON.stringify(result)]);
    res.writeHead(200, H);
    res.end(JSON.stringify(result));
    return;
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  res.writeHead(404, H);
  res.end(JSON.stringify({ error: 'not found' }));
}

module.exports = { handleRequest };
