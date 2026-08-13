'use strict';

const { nanoid } = require('nanoid');
const { getFullState, withTransaction } = require('./db');
const { logActivity } = require('./activity');
const { ensureAppUserRecord } = require('./identity');
const { escapeHtml } = require('./html');

/**
 * Имя стартового события по названию Telegram-чата.
 * @param {string} groupName
 * @returns {string}
 */
function defaultEventName(groupName) {
  const base = (groupName || 'Пикник').trim() || 'Пикник';
  return base.length > 80 ? `${base.slice(0, 77)}…` : base;
}

/**
 * @param {{ id: number, first_name?: string, last_name?: string, username?: string } | undefined} addedBy
 */
function telegramUserName(addedBy) {
  if (!addedBy?.id) return null;
  return [addedBy.first_name, addedBy.last_name].filter(Boolean).join(' ')
    || addedBy.username
    || 'Админ';
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} groupId
 * @param {{ id: number, first_name?: string, last_name?: string, username?: string }} addedBy
 */
async function upsertTelegramAdmin(pool, groupId, addedBy) {
  const userName = telegramUserName(addedBy);
  if (!userName) return;
  const userId = String(addedBy.id);
  await ensureAppUserRecord(pool, { userId, userName });
  await pool.query(
    `INSERT INTO group_members(group_id, user_id, name, is_admin)
     VALUES($1,$2,$3,TRUE)
     ON CONFLICT(group_id, user_id) DO UPDATE
       SET name = EXCLUDED.name, is_admin = TRUE`,
    [groupId, userId, userName],
  );
}

/**
 * Полная инициализация группы как в POST /groups: категории + админ из Telegram.
 * @param {import('pg').Pool} pool
 * @param {{ chatId: number, chatTitle: string, addedBy?: { id: number, first_name?: string, last_name?: string, username?: string } }} opts
 */
async function bootstrapTelegramGroup(pool, { chatId, chatTitle, addedBy }) {
  const groupId = nanoid(10);
  const inviteCode = nanoid(6).toUpperCase();
  const groupName = (chatTitle || 'Пикник').trim() || 'Пикник';

  await withTransaction(pool, async (client) => {
    await client.query(
      'INSERT INTO picnic_groups(id, invite_code, name, tg_chat_id) VALUES($1,$2,$3,$4)',
      [groupId, inviteCode, groupName, chatId],
    );
    await upsertTelegramAdmin(client, groupId, addedBy);
  });

  return { groupId, inviteCode, groupName };
}

/**
 * Создаёт активное событие (как event:add в WS) и пушит state подключённым клиентам.
 * @param {import('pg').Pool} pool
 * @param {string} groupId
 * @param {string} eventName
 * @param {(groupId: string, msg: object) => void} [broadcast]
 */
async function createStarterEvent(pool, groupId, eventName, broadcast) {
  await pool.query(
    `UPDATE events SET status='completed'
     WHERE group_id=$1 AND status IS DISTINCT FROM 'completed'`,
    [groupId],
  );

  const eventId = nanoid(8);
  const name = defaultEventName(eventName);

  await pool.query(
    `INSERT INTO events(id, group_id, name, event_date, event_time, location, description, status)
     VALUES($1,$2,$3,NULL,NULL,NULL,NULL,'active')`,
    [eventId, groupId, name],
  );

  await logActivity(pool, {
    groupId,
    eventId,
    type: 'event:created',
    actorName: 'Бот',
    data: { name, source: 'telegram_bootstrap' },
  });

  if (broadcast) {
    broadcast(groupId, { type: 'state', state: await getFullState(groupId) });
  }

  return { eventId, name };
}

/**
 * Группа в приложении для Telegram-чата: создать с нуля или дополнить событие/админа.
 * @param {import('pg').Pool} pool
 * @param {(groupId: string, msg: object) => void} broadcast
 * @param {{ chatId: number, chatTitle?: string, addedBy?: object }} opts
 */
async function ensureTelegramGroupReady(pool, broadcast, { chatId, chatTitle, addedBy }) {
  const existing = await pool.query(
    'SELECT id, name, invite_code FROM picnic_groups WHERE tg_chat_id=$1',
    [chatId],
  );

  if (existing.rows.length) {
    const row = existing.rows[0];
    const groupId = row.id;
    const groupName = row.name;
    const inviteCode = row.invite_code;

    await upsertTelegramAdmin(pool, groupId, addedBy);

    const active = await pool.query(
      `SELECT name FROM events
       WHERE group_id=$1 AND status='active'
       ORDER BY created_at DESC LIMIT 1`,
      [groupId],
    );

    let eventName = active.rows[0]?.name;
    let eventCreated = false;
    if (!active.rows.length) {
      const ev = await createStarterEvent(pool, groupId, groupName, broadcast);
      eventName = ev.name;
      eventCreated = true;
    }

    return {
      created: false,
      eventCreated,
      groupId,
      inviteCode,
      groupName,
      eventName: eventName ?? defaultEventName(groupName),
    };
  }

  const boot = await bootstrapTelegramGroup(pool, {
    chatId,
    chatTitle: chatTitle || 'Пикник',
    addedBy,
  });
  const ev = await createStarterEvent(pool, boot.groupId, boot.groupName, broadcast);

  return {
    created: true,
    eventCreated: true,
    groupId: boot.groupId,
    inviteCode: boot.inviteCode,
    groupName: boot.groupName,
    eventName: ev.name,
  };
}

/**
 * @param {{ groupName: string, inviteCode: string, eventName: string, created: boolean, eventCreated?: boolean }} p
 */
function formatGroupReadyMessage({ groupName, inviteCode, eventName, created, eventCreated }) {
  const safeGroup = escapeHtml(groupName);
  const safeEvent = escapeHtml(eventName);
  const intro = created
    ? `🔥 <b>Группа «${safeGroup}» готова в приложении!</b>`
    : `🔥 <b>Группа «${safeGroup}» уже подключена</b>`;

  const eventLine = (created || eventCreated)
    ? `📅 Создали событие <b>«${safeEvent}»</b> — укажите дату, место и список в приложении.\n\n`
    : `📅 Активное событие: <b>«${safeEvent}»</b>\n\n`;

  return (
    `${intro}\n\n` +
    `Код для участников: <b>${escapeHtml(inviteCode)}</b>\n\n` +
    eventLine +
    `Я буду слушать чат и добавлять продукты в список автоматически 🛒`
  );
}

module.exports = {
  defaultEventName,
  bootstrapTelegramGroup,
  createStarterEvent,
  ensureTelegramGroupReady,
  formatGroupReadyMessage,
};
