'use strict';

const { pool } = require('../db');
const { requireAdmin } = require('../admin-auth');
const { withLabels } = require('../admin-labels');
const { intParam } = require('../admin-query-helpers');
const { syncGroupMembersToUsers } = require('../admin-user-sync');

// ── GET /admin/users ──────────────────────────────────────────────────────────

async function listAdminUsers(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const q = (url.searchParams.get('q') || '').trim();
  const source = url.searchParams.get('source');
  const superadminOnly = url.searchParams.get('superadmin') === '1';
  const limit = intParam(url, 'limit', 50, 1, 200);
  const offset = intParam(url, 'offset', 0, 0, 100_000);

  const vals = [];
  let p = 1;
  const filters = [];

  if (q) {
    filters.push(`(u.id ILIKE $${p} OR u.name ILIKE $${p} OR u.email ILIKE $${p})`);
    vals.push(`%${q}%`);
    p += 1;
  }
  if (superadminOnly) {
    filters.push('u.is_superadmin = TRUE');
  }
  if (source === 'telegram') {
    filters.push(`u.email LIKE 'tg_%@telegram.internal'`);
  } else if (source === 'web') {
    filters.push(`u.email NOT LIKE 'tg_%@telegram.internal'`);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  await syncGroupMembersToUsers(pool);

  const [countRes, listRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM users u ${where}`, vals),
    pool.query(`
      SELECT u.id, u.name, u.email, u.created_at, u.is_superadmin,
             gc.groups_count, ls.last_seen_at,
             (u.email LIKE 'tg_%@telegram.internal') AS is_telegram_stub
      FROM users u
      LEFT JOIN LATERAL (
        SELECT MAX(ae.created_at) AS last_seen_at
        FROM analytics_events ae WHERE ae.user_id = u.id
      ) ls ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS groups_count
        FROM group_members gm WHERE gm.user_id = u.id
      ) gc ON TRUE
      ${where}
      ORDER BY ls.last_seen_at DESC NULLS LAST, u.created_at DESC
      LIMIT $${p} OFFSET $${p + 1}
    `, [...vals, limit, offset]),
  ]);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    rows: listRes.rows,
    total: countRes.rows[0].n,
    limit,
    offset,
  }));
}

// ── GET /admin/users/:id ──────────────────────────────────────────────────────

async function getAdminUser(req, res, { H, params }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const { id } = params;

  const [userRes, oauthRes, groupsRes, familyRes, activityRes] = await Promise.all([
    pool.query(`
      SELECT u.id, u.name, u.email, u.bio, u.created_at, u.is_superadmin,
             (u.email LIKE 'tg_%@telegram.internal') AS is_telegram_stub
      FROM users u WHERE u.id = $1
    `, [id]),
    pool.query(`
      SELECT provider, provider_id, email, created_at
      FROM oauth_accounts WHERE user_id = $1
    `, [id]),
    pool.query(`
      SELECT g.id, g.name, g.emoji, gm.is_admin, gm.joined_at
      FROM group_members gm
      JOIN picnic_groups g ON g.id = gm.group_id
      WHERE gm.user_id = $1
      ORDER BY gm.joined_at DESC
    `, [id]),
    pool.query(`
      SELECT id, name, label, created_at
      FROM family_members WHERE owner_id = $1
      ORDER BY created_at
    `, [id]),
    pool.query(`
      SELECT type, group_id, platform, meta, created_at
      FROM analytics_events WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 30
    `, [id]),
  ]);

  if (!userRes.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  res.writeHead(200, h);
  res.end(JSON.stringify({
    user: userRes.rows[0],
    oauth: oauthRes.rows,
    groups: groupsRes.rows,
    family: familyRes.rows,
    recentActivity: withLabels(activityRes.rows),
  }));
}

// ── PATCH /admin/users/:id ────────────────────────────────────────────────────

async function patchAdminUser(req, res, { H, params }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { user: actor, H: h } = auth;

  const { readBodySafe } = require('../request-helpers');
  const body = await readBodySafe(req, res, h);
  if (body === null) return;

  const { id } = params;

  if (typeof body.is_superadmin !== 'boolean') {
    res.writeHead(400, h);
    res.end(JSON.stringify({ error: 'is_superadmin boolean required' }));
    return;
  }

  const { rows } = await pool.query(
    'UPDATE users SET is_superadmin = $1 WHERE id = $2 RETURNING id, email, is_superadmin',
    [body.is_superadmin, id],
  );
  if (!rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  try {
    await pool.query(
      `INSERT INTO admin_audit_log(actor_id, action, target_type, target_id, payload)
       VALUES($1, $2, $3, $4, $5)`,
      [
        actor.userId,
        'user:set_superadmin',
        'user',
        id,
        JSON.stringify({ is_superadmin: body.is_superadmin }),
      ],
    );
  } catch {
    // audit table may be missing on old DB
  }

  res.writeHead(200, h);
  res.end(JSON.stringify({ ok: true, user: rows[0] }));
}

module.exports = { listAdminUsers, getAdminUser, patchAdminUser };
