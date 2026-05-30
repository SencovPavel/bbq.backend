const { Pool } = require('pg');

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
  const activity = await fetchGroupActivity(groupId);
  return {
    group: grp.rows[0],
    members: members.rows,
    categories: cats.rows,
    items: items.rows,
    events: events.rows,
    activity,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

/** Reads URL-encoded form body (used by Apple OAuth form_post callback) */
function readFormBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => {
      const p = new URLSearchParams(d);
      const obj = {};
      for (const [k, v] of p) obj[k] = v;
      resolve(obj);
    });
    req.on('error', reject);
  });
}

module.exports = { pool, DEFAULT_CATS, getFullState, readBody, readFormBody };
