'use strict';

const { pool }        = require('../db');
const { requireUser } = require('../request-helpers');

async function getUserGroups(req, res, { H, params }) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, H: h } = auth;
  if (params.userId !== user.userId) {
    res.writeHead(403, h);
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }
  const result = await pool.query(`
    SELECT
      g.id,
      g.name,
      g.invite_code,
      g.emoji,
      COUNT(DISTINCT m2.user_id)::int AS member_count,
      COUNT(DISTINCT i.id)::int       AS item_count
    FROM picnic_groups g
    JOIN group_members m  ON m.group_id  = g.id AND m.user_id = $1
    LEFT JOIN group_members m2 ON m2.group_id = g.id
    LEFT JOIN items i ON i.group_id = g.id
    GROUP BY g.id, g.name, g.invite_code, g.emoji
    ORDER BY g.created_at DESC
  `, [user.userId]);
  res.writeHead(200, h);
  res.end(JSON.stringify(result.rows));
}

module.exports = { getUserGroups };
