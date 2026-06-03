const { Pool, types } = require('pg');

// По умолчанию pg разбирает DATE (OID 1082) через postgres-date, возвращая JS Date object.
// JSON.stringify сериализует его как "2025-06-02T00:00:00.000Z", и фронт получает
// ISO-строку с временной зоной вместо простого "YYYY-MM-DD".
// Возвращаем DATE как plain-строку — это то, что ожидает весь frontend-код.
types.setTypeParser(1082, (val) => val); // DATE → "YYYY-MM-DD"

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEFAULT_CATS = [
  { id: 'rent',   title: 'Аренда',           icon: '🏡' },
  { id: 'meat',   title: 'Мясо',             icon: '🥩' },
  { id: 'grill',  title: 'Для мангала',      icon: '🔥' },
  { id: 'food',   title: 'Гарнир и закуски', icon: '🥗' },
  { id: 'drinks', title: 'Напитки',          icon: '🧃' },
  { id: 'extra',  title: 'Посуда и прочее',  icon: '🍽️' },
];

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
    pool.query('SELECT * FROM picnic_groups WHERE id=$1', [groupId]),
    pool.query('SELECT * FROM group_members WHERE group_id=$1 ORDER BY joined_at', [groupId]),
    pool.query('SELECT * FROM categories WHERE group_id=$1 ORDER BY position', [groupId]),
    pool.query('SELECT * FROM items WHERE group_id=$1', [groupId]),
    pool.query('SELECT * FROM events WHERE group_id=$1 ORDER BY event_date ASC NULLS LAST, created_at ASC', [groupId]),
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
  DEFAULT_CATS,
  getFullState,
  readBody,
  readFormBody,
  BodyTooLargeError,
};
