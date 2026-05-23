require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const { nanoid } = require('nanoid');
const { handleUpdate, setWebhook } = require('./bot');
const { analyzeDiff } = require('./agent');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.PORT || 3001;

const rooms = new Map();
function roomBroadcast(groupId, msg, except = null) {
  const room = rooms.get(groupId);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.forEach(c => { if (c !== except && c.readyState === 1) c.send(data); });
}

async function getFullState(groupId) {
  const [grp, members, cats, items] = await Promise.all([
    pool.query('SELECT * FROM picnic_groups WHERE id=$1', [groupId]),
    pool.query('SELECT * FROM group_members WHERE group_id=$1 ORDER BY joined_at', [groupId]),
    pool.query('SELECT * FROM categories WHERE group_id=$1 ORDER BY position', [groupId]),
    pool.query('SELECT * FROM items WHERE group_id=$1', [groupId]),
  ]);
  if (!grp.rows.length) return null;
  return { group: grp.rows[0], members: members.rows, categories: cats.rows, items: items.rows };
}

const DEFAULT_CATS = [
  { id: 'rent',   title: 'Аренда',           icon: '🏡' },
  { id: 'meat',   title: 'Мясо',             icon: '🥩' },
  { id: 'grill',  title: 'Для мангала',      icon: '🔥' },
  { id: 'food',   title: 'Гарнир и закуски', icon: '🥗' },
  { id: 'drinks', title: 'Напитки',          icon: '🧃' },
  { id: 'extra',  title: 'Посуда и прочее',  icon: '🍽️' },
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const H = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const url = new URL(req.url, 'http://localhost');

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...H, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // ── Health ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, H);
    res.end(JSON.stringify({ ok: true, clients: wss.clients.size, uptime: Math.round(process.uptime()) }));
    return;
  }

  // ── Telegram webhook ────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/tg-webhook') {
    const body = await readBody(req);
    res.writeHead(200, H); res.end('{}');
    handleUpdate(body, pool, roomBroadcast).catch(e => console.error('bot:', e.message));
    return;
  }

  // ── GET /users/:userId/groups ───────────────────────────────────────────────
  // Returns list of groups the user belongs to with member_count and item_count
  const userGroupsMatch = url.pathname.match(/^\/users\/([^/]+)\/groups$/);
  if (req.method === 'GET' && userGroupsMatch) {
    const userId = userGroupsMatch[1];
    const result = await pool.query(`
      SELECT
        g.id,
        g.name,
        g.invite_code,
        COUNT(DISTINCT m2.user_id)::int  AS member_count,
        COUNT(DISTINCT i.id)::int        AS item_count
      FROM picnic_groups g
      JOIN group_members m ON m.group_id = g.id AND m.user_id = $1
      LEFT JOIN group_members m2 ON m2.group_id = g.id
      LEFT JOIN items i ON i.group_id = g.id
      GROUP BY g.id, g.name, g.invite_code
      ORDER BY g.created_at DESC
    `, [userId]);
    res.writeHead(200, H);
    res.end(JSON.stringify(result.rows));
    return;
  }

  // ── POST /groups ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/groups') {
    const { name, userId, userName } = await readBody(req);
    if (!name || !userId || !userName) {
      res.writeHead(400, H); res.end(JSON.stringify({ error: 'missing fields' })); return;
    }
    const id = nanoid(10);
    const inviteCode = nanoid(6).toUpperCase();
    await pool.query('INSERT INTO picnic_groups(id,invite_code,name) VALUES($1,$2,$3)', [id, inviteCode, name]);
    await pool.query('INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)', [id, userId, userName]);
    for (let i = 0; i < DEFAULT_CATS.length; i++) {
      const c = DEFAULT_CATS[i];
      await pool.query('INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)', [c.id, id, c.title, c.icon, i]);
    }
    res.writeHead(200, H); res.end(JSON.stringify({ id, inviteCode }));
    return;
  }

  // ── POST /groups/join — join by invite code ─────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/groups/join') {
    const { inviteCode, userId, userName } = await readBody(req);
    if (!inviteCode || !userId || !userName) {
      res.writeHead(400, H); res.end(JSON.stringify({ error: 'missing fields' })); return;
    }
    const grp = await pool.query('SELECT * FROM picnic_groups WHERE invite_code=$1', [inviteCode.toUpperCase()]);
    if (!grp.rows.length) {
      res.writeHead(404, H); res.end(JSON.stringify({ error: 'Группа не найдена' })); return;
    }
    const group = grp.rows[0];
    await pool.query(
      `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
       ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
      [group.id, userId, userName]
    );
    const state = await getFullState(group.id);
    roomBroadcast(group.id, { type: 'state', state });
    res.writeHead(200, H); res.end(JSON.stringify({ id: group.id, name: group.name, state }));
    return;
  }

  // ── POST /groups/join-by-id — join by group id (deep-link) ─────────────────
  if (req.method === 'POST' && url.pathname === '/groups/join-by-id') {
    const { groupId, userId, userName } = await readBody(req);
    if (!groupId || !userId || !userName) {
      res.writeHead(400, H); res.end(JSON.stringify({ error: 'missing fields' })); return;
    }
    const grp = await pool.query('SELECT * FROM picnic_groups WHERE id=$1', [groupId]);
    if (!grp.rows.length) {
      res.writeHead(404, H); res.end(JSON.stringify({ error: 'Группа не найдена' })); return;
    }
    const group = grp.rows[0];
    await pool.query(
      `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
       ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
      [group.id, userId, userName]
    );
    const state = await getFullState(group.id);
    roomBroadcast(group.id, { type: 'state', state });
    res.writeHead(200, H); res.end(JSON.stringify({ id: group.id, name: group.name, state }));
    return;
  }

  // ── POST /agent/analyze ─────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/agent/analyze') {
    const { groupId } = await readBody(req);
    if (!groupId) { res.writeHead(400, H); res.end(JSON.stringify({ error: 'groupId required' })); return; }
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
    try {
      const result = await analyzeDiff(msgsRes.rows.reverse(), itemsRes.rows);
      await pool.query('INSERT INTO agent_analyses(group_id,analysis) VALUES($1,$2)', [groupId, JSON.stringify(result)]);
      res.writeHead(200, H); res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, H); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, H); res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  let groupId = null;
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      groupId = msg.groupId;
      if (!rooms.has(groupId)) rooms.set(groupId, new Set());
      rooms.get(groupId).add(ws);
      const state = await getFullState(groupId);
      if (state) ws.send(JSON.stringify({ type: 'state', state }));
      return;
    }
    if (!groupId) return;

    if (msg.type === 'item:add') {
      const id = nanoid(8);
      await pool.query(
        'INSERT INTO items(id,group_id,cat_id,name,price,qty,unit,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, groupId, msg.catId, msg.name, msg.price || 0, msg.qty || 1, msg.unit || 'шт', 'manual']
      );
      roomBroadcast(groupId, { type: 'state', state: await getFullState(groupId) });
      return;
    }
    if (msg.type === 'item:update') {
      const allowed = ['name','price','qty','unit','enabled','buyer_id','buyer_name','bought','cat_id'];
      if (!allowed.includes(msg.field)) return;
      await pool.query(`UPDATE items SET ${msg.field}=$1 WHERE id=$2 AND group_id=$3`, [msg.value, msg.id, groupId]);
      roomBroadcast(groupId, { type: 'state', state: await getFullState(groupId) });
      return;
    }
    if (msg.type === 'item:delete') {
      await pool.query('DELETE FROM items WHERE id=$1 AND group_id=$2', [msg.id, groupId]);
      roomBroadcast(groupId, { type: 'state', state: await getFullState(groupId) });
      return;
    }
    if (msg.type === 'cat:add') {
      const id = nanoid(6);
      const pos = await pool.query('SELECT COALESCE(MAX(position),0)+1 AS p FROM categories WHERE group_id=$1', [groupId]);
      await pool.query(
        'INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)',
        [id, groupId, msg.title, msg.icon || '📦', pos.rows[0].p]
      );
      roomBroadcast(groupId, { type: 'state', state: await getFullState(groupId) });
      return;
    }
    if (msg.type === 'cat:delete') {
      await pool.query('DELETE FROM items WHERE cat_id=$1 AND group_id=$2', [msg.id, groupId]);
      await pool.query('DELETE FROM categories WHERE id=$1 AND group_id=$2', [msg.id, groupId]);
      roomBroadcast(groupId, { type: 'state', state: await getFullState(groupId) });
      return;
    }
    if (msg.type === 'member:remove') {
      await pool.query('UPDATE items SET buyer_id=NULL,buyer_name=NULL WHERE group_id=$1 AND buyer_id=$2', [groupId, msg.userId]);
      await pool.query('DELETE FROM group_members WHERE group_id=$1 AND user_id=$2', [groupId, msg.userId]);
      roomBroadcast(groupId, { type: 'state', state: await getFullState(groupId) });
      return;
    }
  });
  ws.on('close', () => {
    if (groupId && rooms.has(groupId)) {
      rooms.get(groupId).delete(ws);
      if (!rooms.get(groupId).size) rooms.delete(groupId);
    }
  });
  ws.on('error', () => {});
});

async function start() {
  try { await pool.query('SELECT 1'); console.log('✅ DB connected'); }
  catch (e) { console.error('❌ DB:', e.message); process.exit(1); }
  server.listen(PORT, async () => {
    console.log(`🔥 Picnic backend: http://localhost:${PORT}`);
    if (process.env.PUBLIC_URL && process.env.BOT_TOKEN) await setWebhook(process.env.PUBLIC_URL);
  });
}
process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT',  async () => { await pool.end(); process.exit(0); });
start();
