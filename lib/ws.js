const { nanoid } = require('nanoid');
const { pool: dbPool, getFullState: dbGetFullState } = require('./db');
const { logActivity } = require('./activity');
const { trackEvent } = require('./analytics');
const { resolveWsJoinIdentity } = require('./identity');
const { assertGroupMember } = require('./membership');
const { assertEventItemsEditable, assertEventItemsEditableByItemId } = require('./event-status');
const { EVENT_TYPES_BY_ID } = require('./event-types');
const { sendMessage } = require('./bot');

/** Шлёт сообщение в привязанный Telegram-чат группы, если он есть. Ошибки/отсутствие чата — тихо игнорируем. */
async function notifyGroupChat(pool, groupId, text) {
  try {
    const { rows } = await pool.query('SELECT tg_chat_id FROM picnic_groups WHERE id=$1', [groupId]);
    const chatId = rows[0]?.tg_chat_id;
    if (!chatId) return;
    await sendMessage(chatId, text);
  } catch (e) {
    console.error('[notifyGroupChat]', e.message);
  }
}

/** Досеивает в группу категории из шаблона типа события — только те, которых там ещё нет по title. */
async function seedEventTypeCategories(pool, groupId, eventType) {
  const template = EVENT_TYPES_BY_ID[eventType];
  if (!template || !template.categories.length) return;
  const existing = await pool.query('SELECT title, position FROM categories WHERE group_id=$1', [groupId]);
  const existingTitles = new Set(existing.rows.map(r => r.title.trim().toLowerCase()));
  let nextPos = existing.rows.reduce((max, r) => Math.max(max, r.position || 0), 0) + 1;
  for (const cat of template.categories) {
    if (existingTitles.has(cat.title.trim().toLowerCase())) continue;
    await pool.query(
      'INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)',
      [nanoid(6), groupId, cat.title, cat.icon, nextPos++],
    );
  }
}

/** groupId → Set<WebSocket> */
const rooms = new Map();

function broadcast(groupId, msg, except = null) {
  const room = rooms.get(groupId);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.forEach(ws => { if (ws !== except && ws.readyState === 1) ws.send(data); });
}

/** Проверяет, является ли userId администратором группы */
async function isAdmin(groupId, userId, pool) {
  if (!userId) return false;
  const { rows } = await pool.query(
    'SELECT is_admin FROM group_members WHERE group_id=$1 AND user_id=$2',
    [groupId, userId],
  );
  return rows[0]?.is_admin === true;
}

/**
 * Обрабатывает одно WS-сообщение. Весь доступ к БД идёт через инжектированный pool.
 * @param {object} msg — распарсенный JSON
 * @param {{ groupId, userId, userName?, pool, getFullState, broadcast, senderWs? }} ctx
 */
async function dispatchMessage(msg, { groupId, userId, userName = null, platform = null, pool, getFullState, broadcast: bcast, senderWs = null }) {
  if (!userId || !groupId) return;
  if (!await assertGroupMember(groupId, userId, pool)) return;

  // ── items ──────────────────────────────────────────────────────────────────

  if (msg.type === 'item:add') {
    if (!await assertEventItemsEditable(pool, groupId, msg.eventId || null)) return;
    const id = nanoid(8);
    const kind = msg.kind === 'task' ? 'task' : 'bring';
    await pool.query(
      'INSERT INTO items(id,group_id,cat_id,name,price,qty,unit,source,event_id,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, groupId, msg.catId, msg.name, msg.price || 0, msg.qty || 1, msg.unit || 'шт', 'manual', msg.eventId || null, kind],
    );
    await logActivity(pool, {
      groupId, eventId: msg.eventId || null, type: 'item:added',
      actorName: userName, data: { name: msg.name },
    });
    trackEvent(pool, { type: 'item:added', userId, groupId, platform });
    notifyGroupChat(pool, groupId, `➕ ${userName || 'Кто-то'} добавил «${msg.name}»`);
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'item:update') {
    const allowed = ['name', 'price', 'qty', 'unit', 'enabled', 'buyer_id', 'buyer_name', 'bought', 'cat_id', 'kind'];
    if (!allowed.includes(msg.field)) return;
    if (!await assertEventItemsEditableByItemId(pool, groupId, msg.id)) return;
    await pool.query(
      `UPDATE items SET ${msg.field}=$1 WHERE id=$2 AND group_id=$3`,
      [msg.value, msg.id, groupId],
    );
    if (msg.field === 'bought' && msg.value === true) {
      const boughtRes = await pool.query(
        'SELECT name, event_id FROM items WHERE id=$1 AND group_id=$2',
        [msg.id, groupId],
      );
      const boughtRow = boughtRes?.rows?.[0];
      if (boughtRow) {
        await logActivity(pool, {
          groupId, eventId: boughtRow.event_id, type: 'item:bought',
          actorName: userName, data: { name: boughtRow.name },
        });
        trackEvent(pool, { type: 'item:bought', userId, groupId, platform });
        notifyGroupChat(pool, groupId, `✅ ${userName || 'Кто-то'} купил «${boughtRow.name}»`);
      }
    } else {
      trackEvent(pool, {
        type: 'item:updated',
        userId,
        groupId,
        platform,
        meta: { field: msg.field },
      });
    }
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'item:delete') {
    if (!await assertEventItemsEditableByItemId(pool, groupId, msg.id)) return;
    const delRes = await pool.query(
      'SELECT name, buyer_id, buyer_name, event_id FROM items WHERE id=$1 AND group_id=$2',
      [msg.id, groupId],
    );
    const delRow = delRes?.rows?.[0];
    await pool.query('DELETE FROM items WHERE id=$1 AND group_id=$2', [msg.id, groupId]);
    if (delRow?.buyer_id) {
      await logActivity(pool, {
        groupId, eventId: delRow.event_id, type: 'item:deleted',
        actorName: userName, data: { name: delRow.name, buyerName: delRow.buyer_name },
      });
    }
    trackEvent(pool, { type: 'item:deleted', userId, groupId, platform });
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  // ── categories ─────────────────────────────────────────────────────────────

  if (msg.type === 'cat:add') {
    if (!await isAdmin(groupId, userId, pool)) return;
    const id  = nanoid(6);
    const pos = await pool.query(
      'SELECT COALESCE(MAX(position),0)+1 AS p FROM categories WHERE group_id=$1',
      [groupId],
    );
    await pool.query(
      'INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)',
      [id, groupId, msg.title, msg.icon || '📦', pos.rows[0].p],
    );
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'cat:delete') {
    if (!await isAdmin(groupId, userId, pool)) return;
    await pool.query('DELETE FROM items WHERE cat_id=$1 AND group_id=$2', [msg.id, groupId]);
    await pool.query('DELETE FROM categories WHERE id=$1 AND group_id=$2', [msg.id, groupId]);
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  // ── events ─────────────────────────────────────────────────────────────────

  if (msg.type === 'event:add') {
    if (!await isAdmin(groupId, userId, pool)) {
      if (senderWs) sendWsError(senderWs, 'forbidden');
      return;
    }
    await pool.query(
      `UPDATE events SET status='completed' WHERE group_id=$1 AND status IS DISTINCT FROM 'completed'`,
      [groupId],
    );
    const id = nanoid(8);
    const eventType = EVENT_TYPES_BY_ID[msg.eventType] ? msg.eventType : null;
    const hasBudget = msg.hasBudget !== false;
    await pool.query(
      `INSERT INTO events(id,group_id,name,event_date,event_time,location,description,status,type,has_budget)
       VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
      [id, groupId, msg.name, msg.date || null, msg.time || null, msg.location || null, msg.description || null, eventType, hasBudget],
    );
    if (eventType) await seedEventTypeCategories(pool, groupId, eventType);
    await logActivity(pool, {
      groupId, eventId: id, type: 'event:created',
      actorName: userName, data: { name: msg.name },
    });
    trackEvent(pool, { type: 'event:created', userId, groupId, platform });
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'event:complete') {
    if (!await isAdmin(groupId, userId, pool)) return;
    const evtRes = await pool.query('SELECT name FROM events WHERE id=$1', [msg.id]);
    const evtName = evtRes?.rows?.[0]?.name ?? '';
    await pool.query(
      `UPDATE events SET status='completed' WHERE id=$1 AND group_id=$2`,
      [msg.id, groupId],
    );
    await logActivity(pool, {
      groupId, eventId: msg.id, type: 'event:completed',
      actorName: userName, data: { name: evtName },
    });
    trackEvent(pool, { type: 'event:completed', userId, groupId, platform });
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'event:update') {
    if (!await isAdmin(groupId, userId, pool)) return;
    const allowed = ['name', 'event_date', 'event_time', 'location', 'description', 'type', 'has_budget'];
    if (!allowed.includes(msg.field)) return;
    if (msg.field === 'event_date') {
      await pool.query(
        'UPDATE events SET event_date=$1, reminder_4d_sent=false, reminder_1d_sent=false WHERE id=$2 AND group_id=$3',
        [msg.value, msg.id, groupId],
      );
    } else {
      await pool.query(
        `UPDATE events SET ${msg.field}=$1 WHERE id=$2 AND group_id=$3`,
        [msg.value, msg.id, groupId],
      );
    }
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'event:delete') {
    if (!await isAdmin(groupId, userId, pool)) return;
    await pool.query('DELETE FROM events WHERE id=$1 AND group_id=$2', [msg.id, groupId]);
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'event:rsvp') {
    // Проверяем, что событие принадлежит группе
    const evtCheck = await pool.query(
      'SELECT id FROM events WHERE id=$1 AND group_id=$2',
      [msg.eventId, groupId],
    );
    if (!evtCheck.rows.length) return;

    const attending = msg.attending !== false; // по умолчанию true

    if (attending) {
      // Явно подтверждает: убираем запись «не иду»
      await pool.query(
        'DELETE FROM event_rsvp WHERE event_id=$1 AND user_id=$2',
        [msg.eventId, userId],
      );
    } else {
      // Помечает «не иду»: upsert
      await pool.query(
        `INSERT INTO event_rsvp(event_id, user_id, attending, updated_at)
         VALUES($1, $2, FALSE, NOW())
         ON CONFLICT (event_id, user_id) DO UPDATE SET attending=FALSE, updated_at=NOW()`,
        [msg.eventId, userId],
      );
    }
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  // ── family RSVP ───────────────────────────────────────────────────────────

  if (msg.type === 'family:rsvp') {
    // Проверяем, что family_member принадлежит userId
    const ownerCheck = await pool.query(
      'SELECT id FROM family_members WHERE id=$1 AND owner_id=$2',
      [msg.familyMemberId, userId],
    );
    if (!ownerCheck.rows.length) return;

    // Проверяем, что событие принадлежит группе
    const evtCheck = await pool.query(
      'SELECT id FROM events WHERE id=$1 AND group_id=$2',
      [msg.eventId, groupId],
    );
    if (!evtCheck.rows.length) return;

    const attending = msg.attending !== false;
    await pool.query(
      `INSERT INTO family_member_rsvp(family_member_id, event_id, attending, updated_at)
       VALUES($1, $2, $3, NOW())
       ON CONFLICT (family_member_id, event_id)
       DO UPDATE SET attending=$3, updated_at=NOW()`,
      [msg.familyMemberId, msg.eventId, attending],
    );
    trackEvent(pool, { type: 'rsvp:set', userId, groupId, platform, meta: { attending: msg.attending } });
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'family:group_settings') {
    // Проверяем владение
    const ownerCheck = await pool.query(
      'SELECT id FROM family_members WHERE id=$1 AND owner_id=$2',
      [msg.familyMemberId, userId],
    );
    if (!ownerCheck.rows.length) return;

    const includeInCalc = msg.includeInCalc !== false;
    const costPct       = typeof msg.costPct === 'number'
      ? Math.max(0, Math.min(200, msg.costPct))
      : 100;

    if (msg.enabled === false) {
      // Исключить члена семьи из группы
      await pool.query(
        'DELETE FROM family_group_settings WHERE family_member_id=$1 AND group_id=$2',
        [msg.familyMemberId, groupId],
      );
    } else {
      await pool.query(
        `INSERT INTO family_group_settings(family_member_id, group_id, include_in_calc, cost_pct)
         VALUES($1, $2, $3, $4)
         ON CONFLICT (family_member_id, group_id)
         DO UPDATE SET include_in_calc=$3, cost_pct=$4`,
        [msg.familyMemberId, groupId, includeInCalc, costPct],
      );
    }
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  // ── members ────────────────────────────────────────────────────────────────

  if (msg.type === 'member:remove') {
    if (!await isAdmin(groupId, userId, pool)) return;
    if (msg.userId === userId) return; // нельзя кикнуть самого себя
    await pool.query(
      'UPDATE items SET buyer_id=NULL,buyer_name=NULL WHERE group_id=$1 AND buyer_id=$2',
      [groupId, msg.userId],
    );
    await pool.query(
      'DELETE FROM group_members WHERE group_id=$1 AND user_id=$2',
      [groupId, msg.userId],
    );
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

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
    bcast(groupId, { type: 'state', state: await getFullState(groupId) }, senderWs);
    return;
  }

  if (msg.type === 'member:promote') {
    if (!await isAdmin(groupId, userId, pool)) return;
    await pool.query(
      'UPDATE group_members SET is_admin=TRUE WHERE group_id=$1 AND user_id=$2',
      [groupId, msg.userId],
    );
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'member:demote') {
    if (!await isAdmin(groupId, userId, pool)) return;
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM group_members WHERE group_id=$1 AND is_admin=TRUE',
      [groupId],
    );
    if (parseInt(rows[0].cnt) <= 1) return; // нельзя оставить группу без администратора
    await pool.query(
      'UPDATE group_members SET is_admin=FALSE WHERE group_id=$1 AND user_id=$2',
      [groupId, msg.userId],
    );
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'group:set-emoji') {
    if (!await isAdmin(groupId, userId, pool)) return;
    // Принимаем строку-эмодзи или null (сброс к дефолту)
    const emoji = typeof msg.emoji === 'string' && msg.emoji.trim()
      ? msg.emoji.trim().slice(0, 8)   // ограничиваем длину на случай многобайтных
      : null;
    await pool.query('UPDATE picnic_groups SET emoji=$1 WHERE id=$2', [emoji, groupId]);
    bcast(groupId, { type: 'state', state: await getFullState(groupId) });
    return;
  }

  if (msg.type === 'group:delete') {
    if (!await isAdmin(groupId, userId, pool)) return;
    bcast(groupId, { type: 'group:deleted' });
    await pool.query('DELETE FROM picnic_groups WHERE id=$1', [groupId]);
    rooms.delete(groupId);
    return;
  }
}

function sendWsError(ws, code) {
  ws.send(JSON.stringify({ type: 'error', code }));
}

function createWsHandler(wss) {
  wss.on('connection', (ws, req) => {
    let groupId  = null;
    let userId   = null;
    let userName = null;
    let platform = null;
    const cookieHeader = req?.headers?.cookie ?? '';

    ws.on('message', async (raw) => {
      if (raw.length > 64_000) return; // ~64 KB — никакое реальное сообщение не требует больше
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'join') {
        const joinGroupId = msg.groupId;
        if (!joinGroupId) {
          sendWsError(ws, 'group_not_found');
          return;
        }

        const identity = await resolveWsJoinIdentity(cookieHeader, msg.initData);
        if (!identity) {
          sendWsError(ws, 'auth_required');
          ws.close();
          return;
        }

        const grp = await dbPool.query('SELECT id FROM picnic_groups WHERE id=$1', [joinGroupId]);
        if (!grp.rows.length) {
          sendWsError(ws, 'group_not_found');
          return;
        }

        if (!await assertGroupMember(joinGroupId, identity.userId, dbPool)) {
          sendWsError(ws, 'not_member');
          return;
        }

        groupId  = joinGroupId;
        userId   = identity.userId;
        userName = identity.userName;
        platform = identity.source === 'telegram' ? 'telegram' : 'web';

        if (!rooms.has(groupId)) rooms.set(groupId, new Set());
        rooms.get(groupId).add(ws);
        try {
          const state = await dbGetFullState(groupId);
          if (state) {
            ws.send(JSON.stringify({ type: 'state', state }));
          } else {
            sendWsError(ws, 'group_not_found');
          }
        } catch (e) {
          console.error('WS join getFullState:', e.message);
          sendWsError(ws, 'state_failed');
        }
        return;
      }

      if (!groupId) return;

      await dispatchMessage(msg, {
        groupId,
        userId,
        userName,
        platform,
        pool: dbPool,
        getFullState: dbGetFullState,
        broadcast,
        senderWs: ws,
      });
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

module.exports = { broadcast, createWsHandler, dispatchMessage, isAdmin };
