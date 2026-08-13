const { Pool, types } = require('pg');

// По умолчанию pg разбирает DATE (OID 1082) через postgres-date, возвращая JS Date object.
// JSON.stringify сериализует его как "2025-06-02T00:00:00.000Z", и фронт получает
// ISO-строку с временной зоной вместо простого "YYYY-MM-DD".
// Возвращаем DATE как plain-строку — это то, что ожидает весь frontend-код.
types.setTypeParser(1082, (val) => val); // DATE → "YYYY-MM-DD"

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Выполняет fn внутри транзакции (BEGIN/COMMIT, ROLLBACK при ошибке).
 * fn получает клиента, на котором нужно делать все запросы транзакции.
 * Для пулов без connect() (мок-пулы в тестах) — прозрачный fallback без реальной транзакции.
 * @template T
 * @param {{ connect?: Function, query: Function }} p
 * @param {(client: { query: Function }) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(p, fn) {
  if (typeof p.connect !== 'function') return fn(p);
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* соединение уже разорвано */ }
    throw e;
  } finally {
    client.release();
  }
}

async function fetchGroupActivity(groupId) {
  try {
    const res = await pool.query(
      'SELECT * FROM group_activity WHERE group_id=$1 ORDER BY created_at DESC LIMIT 100',
      [groupId],
    );
    return res.rows;
  } catch (e) {
    if (e.code === '42P01') {
      console.warn('[db] Таблица group_activity отсутствует — выполните npm run migrate');
      return [];
    }
    throw e;
  }
}

async function getFullState(groupId) {
  const [grp, members, cats, items, events] = await Promise.all([
    // tg_chat_id / max_chat_id намеренно не отдаём рядовым участникам — только флаг «бот привязан».
    pool.query(
      `SELECT id, invite_code, name, emoji, created_at, archived_at,
              (tg_chat_id IS NOT NULL) AS bot_telegram,
              (max_chat_id IS NOT NULL) AS bot_max
       FROM picnic_groups WHERE id=$1`,
      [groupId],
    ),
    pool.query(
      'SELECT id, group_id, user_id, name, joined_at, is_admin FROM group_members WHERE group_id=$1 ORDER BY joined_at',
      [groupId],
    ),
    pool.query(
      'SELECT id, group_id, title, icon, position FROM categories WHERE group_id=$1 ORDER BY position',
      [groupId],
    ),
    pool.query(
      `SELECT id, group_id, cat_id, name, price, qty, unit, enabled,
              buyer_id, buyer_name, bought, source, chat_hint, event_id, kind
       FROM items WHERE group_id=$1`,
      [groupId],
    ),
    pool.query(
      `SELECT id, group_id, name, event_date, event_time, location, description,
              created_at, status, type, has_budget, reminder_4d_sent, reminder_1d_sent
       FROM events WHERE group_id=$1 ORDER BY event_date ASC NULLS LAST, created_at ASC`,
      [groupId],
    ),
  ]);
  if (!grp.rows.length) return null;
  const [activity, rsvp, familyMembers, familyRsvp] = await Promise.all([
    fetchGroupActivity(groupId),
    pool.query(
      `SELECT r.event_id, r.user_id, r.attending
       FROM event_rsvp r
       JOIN events e ON e.id = r.event_id
       WHERE e.group_id = $1`,
      [groupId],
    ).then(r => r.rows).catch(() => []),
    // Члены семьи участников группы с настройками для этой группы
    pool.query(
      `SELECT fm.id, fm.owner_id, fm.name, fm.label,
              fgs.include_in_calc, fgs.cost_pct
       FROM family_members fm
       JOIN group_members gm ON gm.user_id = fm.owner_id AND gm.group_id = $1
       LEFT JOIN family_group_settings fgs
         ON fgs.family_member_id = fm.id AND fgs.group_id = $1
       ORDER BY fm.created_at`,
      [groupId],
    ).then(r => r.rows).catch(() => []),
    // RSVP членов семьи на события этой группы
    pool.query(
      `SELECT fmr.family_member_id, fmr.event_id, fmr.attending
       FROM family_member_rsvp fmr
       JOIN family_members fm ON fm.id = fmr.family_member_id
       JOIN group_members gm ON gm.user_id = fm.owner_id AND gm.group_id = $1`,
      [groupId],
    ).then(r => r.rows).catch(() => []),
  ]);
  return {
    group: grp.rows[0],
    members: members.rows,
    categories: cats.rows,
    items: items.rows,
    events: events.rows,
    activity,
    rsvp,
    familyMembers,
    familyRsvp,
  };
}

const { readJsonBody, readFormBody, BodyTooLargeError } = require('./http-body');

const readBody = readJsonBody;

module.exports = {
  pool,
  withTransaction,
  getFullState,
  readBody,
  readFormBody,
  BodyTooLargeError,
};
