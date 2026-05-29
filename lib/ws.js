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

function broadcastAll(groupId, msg) {
  const room = rooms.get(groupId);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
}

/** Проверяет, является ли userId администратором группы */
async function isAdmin(groupId, userId) {
  if (!userId) return false;
  const { rows } = await pool.query(
    'SELECT is_admin FROM group_members WHERE group_id=$1 AND user_id=$2',
    [groupId, userId],
  );
  return rows[0]?.is_admin === true;
}

function createWsHandler(wss) {
  wss.on('connection', (ws) => {
    let groupId = null;
    let userId  = null;

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // ── join ──────────────────────────────────────────────────────────────
      if (msg.type === 'join') {
        groupId = msg.groupId;
        userId  = msg.userId || null;
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
          'INSERT INTO items(id,group_id,cat_id,name,price,qty,unit,source,event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id, groupId, msg.catId, msg.name, msg.price || 0, msg.qty || 1, msg.unit || 'шт', 'manual', msg.eventId || null],
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
        const id  = nanoid(6);
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

      // ── events ────────────────────────────────────────────────────────────
      if (msg.type === 'event:add') {
        await pool.query(
          `UPDATE events SET status='completed' WHERE group_id=$1 AND status='active'`,
          [groupId],
        );
        const id = nanoid(8);
        await pool.query(
          `INSERT INTO events(id,group_id,name,event_date,event_time,location,description,status)
           VALUES($1,$2,$3,$4,$5,$6,$7,'active')`,
          [id, groupId, msg.name, msg.date || null, msg.time || null, msg.location || null, msg.description || null],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      if (msg.type === 'event:complete') {
        await pool.query(
          `UPDATE events SET status='completed' WHERE id=$1 AND group_id=$2`,
          [msg.id, groupId],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      if (msg.type === 'event:update') {
        const allowed = ['name', 'event_date', 'event_time', 'location', 'description'];
        if (!allowed.includes(msg.field)) return;
        await pool.query(
          `UPDATE events SET ${msg.field}=$1 WHERE id=$2 AND group_id=$3`,
          [msg.value, msg.id, groupId],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      if (msg.type === 'event:delete') {
        await pool.query('DELETE FROM events WHERE id=$1 AND group_id=$2', [msg.id, groupId]);
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      // ── members ───────────────────────────────────────────────────────────

      /** Кикнуть другого участника (только для администраторов) */
      if (msg.type === 'member:remove') {
        if (!await isAdmin(groupId, userId)) return;
        if (msg.userId === userId) return; // нельзя кикнуть самого себя этим методом
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

      /** Покинуть группу самостоятельно */
      if (msg.type === 'member:leave') {
        if (!userId) return;
        await pool.query(
          'UPDATE items SET buyer_id=NULL,buyer_name=NULL WHERE group_id=$1 AND buyer_id=$2',
          [groupId, userId],
        );
        await pool.query(
          'DELETE FROM group_members WHERE group_id=$1 AND user_id=$2',
          [groupId, userId],
        );
        // Оповещаем остальных (не того, кто уходит)
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) }, ws);
        return;
      }

      /** Назначить администратором (только для администраторов) */
      if (msg.type === 'member:promote') {
        if (!await isAdmin(groupId, userId)) return;
        await pool.query(
          'UPDATE group_members SET is_admin=TRUE WHERE group_id=$1 AND user_id=$2',
          [groupId, msg.userId],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      /** Снять права администратора (только для администраторов, нельзя снять последнего) */
      if (msg.type === 'member:demote') {
        if (!await isAdmin(groupId, userId)) return;
        const { rows } = await pool.query(
          'SELECT COUNT(*) AS cnt FROM group_members WHERE group_id=$1 AND is_admin=TRUE',
          [groupId],
        );
        if (parseInt(rows[0].cnt) <= 1) return; // нельзя оставить группу без администратора
        await pool.query(
          'UPDATE group_members SET is_admin=FALSE WHERE group_id=$1 AND user_id=$2',
          [groupId, msg.userId],
        );
        broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
        return;
      }

      /** Удалить группу полностью (только для администраторов) */
      if (msg.type === 'group:delete') {
        if (!await isAdmin(groupId, userId)) return;
        // Сначала уведомляем всех участников
        broadcastAll(groupId, { type: 'group:deleted' });
        // Затем удаляем данные (каскадно по FK)
        await pool.query('DELETE FROM picnic_groups WHERE id=$1', [groupId]);
        rooms.delete(groupId);
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
