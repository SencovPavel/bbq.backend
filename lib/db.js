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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

module.exports = { pool, DEFAULT_CATS, getFullState, readBody };
