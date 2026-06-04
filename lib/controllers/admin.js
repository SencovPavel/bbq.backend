'use strict';

const { pool } = require('../db');
const { requireAdmin } = require('../admin-auth');
const { withLabels, labelForEventType } = require('../admin-labels');
const { parseGroupsListParams } = require('../admin-query-helpers');

// ── GET /admin/stats/overview ─────────────────────────────────────────────────

async function statsOverview(req, res, { H }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const [
    groups, registeredUsers, groupParticipants, activeEvents, items,
    dau, wau, newGroupsWeek, joinsWeek, sparkline, platformBreakdown,
    inactiveGroups30,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM picnic_groups'),
    pool.query('SELECT COUNT(*)::int AS n FROM users'),
    pool.query('SELECT COUNT(DISTINCT user_id)::int AS n FROM group_members'),
    pool.query("SELECT COUNT(*)::int AS n FROM events WHERE status='active'"),
    pool.query('SELECT COUNT(*)::int AS n FROM items'),
    pool.query(`
      SELECT COUNT(DISTINCT user_id)::int AS n FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '1 day' AND user_id IS NOT NULL
    `),
    pool.query(`
      SELECT COUNT(DISTINCT user_id)::int AS n FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '7 days' AND user_id IS NOT NULL
    `),
    pool.query(`
      SELECT COUNT(*)::int AS n FROM picnic_groups
      WHERE created_at > NOW() - INTERVAL '7 days'
    `),
    pool.query(`
      SELECT COUNT(*)::int AS n FROM analytics_events
      WHERE type = 'group:joined' AND created_at > NOW() - INTERVAL '7 days'
    `),
    pool.query(`
      SELECT DATE_TRUNC('day', created_at)::date AS day, COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY day ORDER BY day
    `),
    pool.query(`
      SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY platform ORDER BY count DESC
    `),
    pool.query(`
      SELECT COUNT(*)::int AS n FROM picnic_groups g
      WHERE COALESCE(
        (SELECT MAX(created_at) FROM group_activity ga WHERE ga.group_id = g.id),
        (SELECT MAX(created_at) FROM analytics_events ae WHERE ae.group_id = g.id),
        g.created_at
      ) < NOW() - INTERVAL '30 days'
    `),
  ]);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    totalGroups: groups.rows[0].n,
    registeredUsers: registeredUsers.rows[0].n,
    groupParticipants: groupParticipants.rows[0].n,
    totalUsers: groupParticipants.rows[0].n,
    activeEvents: activeEvents.rows[0].n,
    totalItems: items.rows[0].n,
    dau: dau.rows[0].n,
    wau: wau.rows[0].n,
    activeToday: dau.rows[0].n,
    activeWeek: wau.rows[0].n,
    newGroupsWeek: newGroupsWeek.rows[0].n,
    joinsWeek: joinsWeek.rows[0].n,
    inactiveGroups30: inactiveGroups30.rows[0].n,
    sparkline: sparkline.rows,
    platforms: platformBreakdown.rows,
  }));
}

// ── GET /admin/stats/groups ───────────────────────────────────────────────────

async function statsGroups(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const { q, inactiveDays, hasBot, limit, offset } = parseGroupsListParams(url);

  const vals = [];
  let p = 1;
  const filters = [];

  if (q) {
    filters.push(`(
      gs.name ILIKE $${p} OR gs.id ILIKE $${p} OR gs.invite_code ILIKE $${p}
      OR gs.tg_chat_id::text ILIKE $${p} OR gs.max_chat_id::text ILIKE $${p}
    )`);
    vals.push(`%${q}%`);
    p += 1;
  }
  if (hasBot) {
    filters.push(`(gs.tg_chat_id IS NOT NULL OR gs.max_chat_id IS NOT NULL)`);
  }
  if (inactiveDays !== null) {
    filters.push(`(
      (gs.last_activity_at IS NULL AND gs.created_at < NOW() - ($${p} || ' days')::INTERVAL)
      OR gs.last_activity_at < NOW() - ($${p} || ' days')::INTERVAL
    )`);
    vals.push(String(inactiveDays));
    p += 1;
  }

  const outerWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const cte = `
    WITH gs AS (
      SELECT
        g.id, g.name, g.emoji, g.invite_code, g.tg_chat_id, g.max_chat_id, g.created_at,
        COUNT(DISTINCT gm.user_id)::int AS member_count,
        COUNT(DISTINCT ev.id)::int AS event_count,
        COUNT(DISTINCT it.id)::int AS item_count,
        GREATEST(
          (SELECT MAX(ga.created_at) FROM group_activity ga WHERE ga.group_id = g.id),
          (SELECT MAX(ae.created_at) FROM analytics_events ae WHERE ae.group_id = g.id)
        ) AS last_activity_at
      FROM picnic_groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      LEFT JOIN events ev ON ev.group_id = g.id
      LEFT JOIN items it ON it.group_id = g.id
      GROUP BY g.id
    )
  `;

  const listSql = `${cte}
    SELECT gs.*,
      CASE
        WHEN gs.last_activity_at IS NULL THEN (CURRENT_DATE - gs.created_at::date)
        ELSE (CURRENT_DATE - gs.last_activity_at::date)
      END::int AS days_since_activity
    FROM gs ${outerWhere}
    ORDER BY gs.last_activity_at DESC NULLS LAST, gs.created_at DESC
    LIMIT $${p} OFFSET $${p + 1}`;

  const countSql = `${cte} SELECT COUNT(*)::int AS n FROM gs ${outerWhere}`;

  vals.push(limit, offset);
  const [countRes, listRes] = await Promise.all([
    pool.query(countSql, vals.slice(0, -2)),
    pool.query(listSql, vals),
  ]);

  const rows = listRes.rows.map(row => ({
    ...row,
    last_activity: row.last_activity_at,
    bot_telegram: row.tg_chat_id != null,
    bot_max: row.max_chat_id != null,
  }));

  res.writeHead(200, h);
  res.end(JSON.stringify({
    rows,
    total: countRes.rows[0]?.n ?? rows.length,
    limit,
    offset,
  }));
}

// ── GET /admin/stats/activity?days=30 ────────────────────────────────────────

async function statsActivity(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));

  const [byDayType, topTypes, platforms] = await Promise.all([
    pool.query(`
      SELECT DATE_TRUNC('day', created_at)::date AS day,
             type,
             COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY day, type
      ORDER BY day, type
    `, [days]),
    pool.query(`
      SELECT type, COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY type
      ORDER BY count DESC
      LIMIT 15
    `, [days]),
    pool.query(`
      SELECT COALESCE(platform, 'unknown') AS platform,
             DATE_TRUNC('day', created_at)::date AS day,
             COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
      GROUP BY platform, day
      ORDER BY day
    `, [days]),
  ]);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    byDayType: byDayType.rows,
    topTypes: withLabels(topTypes.rows),
    platforms: platforms.rows,
    days,
  }));
}

// ── GET /admin/stats/technical ────────────────────────────────────────────────

async function statsTechnical(req, res, { H }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const [hourly, topTypes, errors, totalByDay] = await Promise.all([
    pool.query(`
      SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Europe/Moscow')::int AS hour,
             COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY hour ORDER BY hour
    `),
    pool.query(`
      SELECT type, COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY type ORDER BY count DESC
      LIMIT 20
    `),
    pool.query(`
      SELECT id, type, user_id, group_id, meta, created_at
      FROM analytics_events
      WHERE type LIKE 'error:%'
      ORDER BY created_at DESC
      LIMIT 50
    `),
    pool.query(`
      SELECT DATE_TRUNC('day', created_at AT TIME ZONE 'Europe/Moscow')::date AS day,
             COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day
    `),
  ]);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    hourly: hourly.rows,
    topTypes: withLabels(topTypes.rows),
    errors: withLabels(errors.rows),
    totalByDay: totalByDay.rows,
  }));
}

// ── GET /admin/stats/groups/:groupId ─────────────────────────────────────────

async function statsGroupDetail(req, res, { H, params }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const { groupId } = params;

  const [
    groupResult, membersResult, eventsResult, analyticsResult,
    productActivityResult, topItemsResult, eventStatusResult, familyCountResult,
  ] = await Promise.all([
    pool.query(`
      SELECT g.id, g.name, g.emoji, g.invite_code, g.tg_chat_id, g.max_chat_id, g.created_at, g.archived_at,
             COUNT(DISTINCT gm.user_id)::int AS member_count,
             COUNT(DISTINCT e.id)::int AS event_count,
             COUNT(DISTINCT i.id)::int AS item_count,
             COALESCE(SUM(i.price * i.qty), 0)::float AS items_total_sum
      FROM picnic_groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      LEFT JOIN events e ON e.group_id = g.id
      LEFT JOIN items i ON i.group_id = g.id AND i.enabled = true
      WHERE g.id = $1
      GROUP BY g.id
    `, [groupId]),
    pool.query(`
      SELECT user_id, name, joined_at, is_admin
      FROM group_members
      WHERE group_id = $1
      ORDER BY joined_at ASC
    `, [groupId]),
    pool.query(`
      SELECT id, name, event_date, status
      FROM events
      WHERE group_id = $1
      ORDER BY event_date DESC NULLS LAST, created_at DESC
      LIMIT 50
    `, [groupId]),
    pool.query(`
      SELECT type, user_id, platform, meta, created_at
      FROM analytics_events
      WHERE group_id = $1
      ORDER BY created_at DESC
      LIMIT 30
    `, [groupId]),
    pool.query(`
      SELECT type, actor_name, data, event_id, created_at
      FROM group_activity
      WHERE group_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [groupId]),
    pool.query(`
      SELECT i.name, i.qty, i.unit, i.source, i.price, e.name AS event_name
      FROM items i
      LEFT JOIN events e ON e.id = i.event_id
      WHERE i.group_id = $1 AND i.enabled = true
      ORDER BY i.qty * i.price DESC NULLS LAST
      LIMIT 10
    `, [groupId]),
    pool.query(`
      SELECT status, COUNT(*)::int AS count
      FROM events WHERE group_id = $1
      GROUP BY status
    `, [groupId]),
    pool.query(`
      SELECT COUNT(*)::int AS n FROM family_members fm
      WHERE fm.owner_id IN (SELECT user_id FROM group_members WHERE group_id = $1)
    `, [groupId]),
  ]);

  if (!groupResult.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const group = {
    ...groupResult.rows[0],
    bot_telegram: groupResult.rows[0].tg_chat_id != null,
    bot_max: groupResult.rows[0].max_chat_id != null,
    events_by_status: Object.fromEntries(
      eventStatusResult.rows.map(r => [r.status, r.count]),
    ),
    family_count: familyCountResult.rows[0]?.n ?? 0,
  };
  const members = membersResult.rows;
  const creator = members.find(m => m.is_admin) ?? members[0] ?? null;

  const productActivity = productActivityResult.rows.map(row => ({
    ...row,
    label: labelForEventType(row.type),
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
  }));

  res.writeHead(200, h);
  res.end(JSON.stringify({
    group,
    creator,
    members,
    events: eventsResult.rows,
    recentActivity: withLabels(analyticsResult.rows.map(r => ({
      ...r,
      meta: r.meta ?? {},
    }))),
    productActivity,
    topItems: topItemsResult.rows,
  }));
}

// ── POST /admin/groups/:groupId/archive ───────────────────────────────────────

async function archiveAdminGroup(req, res, { H, params }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { user: actor, H: h } = auth;

  const { groupId } = params;

  const { rows } = await pool.query(
    `UPDATE picnic_groups SET archived_at = NOW()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING id, name, archived_at`,
    [groupId],
  );

  if (!rows.length) {
    const exists = await pool.query('SELECT id, archived_at FROM picnic_groups WHERE id=$1', [groupId]);
    if (!exists.rows.length) {
      res.writeHead(404, h);
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    res.writeHead(200, h);
    res.end(JSON.stringify({ ok: true, group: exists.rows[0] }));
    return;
  }

  try {
    await pool.query(
      `INSERT INTO admin_audit_log(actor_id, action, target_type, target_id, payload)
       VALUES($1, 'group:archive', 'group', $2, '{}')`,
      [actor.userId, groupId],
    );
  } catch {
    // ignore if audit missing
  }

  res.writeHead(200, h);
  res.end(JSON.stringify({ ok: true, group: rows[0] }));
}

module.exports = {
  statsOverview,
  statsGroups,
  statsActivity,
  statsTechnical,
  statsGroupDetail,
  archiveAdminGroup,
};
