const { nanoid } = require('nanoid');
const { pool, getFullState } = require('./db');

/** groupId → Set<WebSocket> */
const rooms = new Map();

function broadcast(groupId, msg, except = null) {
  const room = rooms.get(groupId);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.forEach(ws => { if (ws !== except && ws.readyState === 1) ws.send(data); });
}

function createWsHandler(wss) {
  wss.on('connection', (ws) => {
    let groupId = null;

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // ── join ──────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        groupId = msg.groupId;
        if (!rooms.has(groupId)) rooms.set(groupId, new Set());
        rooms.get(groupId).add(ws);
        const state = await getFullState(groupId);
        if (state) ws.send(JSON.stringify({ type: 'state', state }));
        return;
      }

      if (!groupId) return;

      // ── items ─────────────────────────────────────────────────────────────
      if (msg.type === 'item:add') {
        const id = nanoid(8);
        await pool.query(
          'INSERT INTO items(id,group_id,cat_id,name,price,qty,unit,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, groupId, msg.catId, msg.name, msg.price || 0, msg.qty || 1, msg.unit || 'шт', 'manual'],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      if (msg.type === 'item:update') {
        const allowed = ['name', 'price', 'qty', 'unit', 'enabled', 'buyer_id', 'buyer_name', 'bought', 'cat_id'];
        if (!allowed.includes(msg.field)) return;
        await pool.query(
          `UPDATE items SET ${msg.field}=$1 WHERE id=$2 AND group_id=$3`,
          [msg.value, msg.id, groupId],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      if (msg.type === 'item:delete') {
        await pool.query('DELETE FROM items WHERE id=$1 AND group_id=$2', [msg.id, groupId]);
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      // ── categories ────────────────────────────────────────────────────────
      if (msg.type === 'cat:add') {
        const id = nanoid(6);
        const pos = await pool.query(
          'SELECT COALESCE(MAX(position),0)+1 AS p FROM categories WHERE group_id=$1',
          [groupId],
        );
        await pool.query(
          'INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)',
          [id, groupId, msg.title, msg.icon || '📦', pos.rows[0].p],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      if (msg.type === 'cat:delete') {
        await pool.query('DELETE FROM items WHERE cat_id=$1 AND group_id=$2', [msg.id, groupId]);
        await pool.query('DELETE FROM categories WHERE id=$1 AND group_id=$2', [msg.id, groupId]);
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      // ── members ───────────────────────────────────────────────────────────
      if (msg.type === 'member:remove') {
        await pool.query(
          'UPDATE items SET buyer_id=NULL,buyer_name=NULL WHERE group_id=$1 AND buyer_id=$2',
          [groupId, msg.userId],
        );
        await pool.query(
          'DELETE FROM group_members WHERE group_id=$1 AND user_id=$2',
          [groupId, msg.userId],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
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
}

module.exports = { broadcast, createWsHandler };
