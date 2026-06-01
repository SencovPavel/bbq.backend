'use strict';

const { pool }         = require('../db');
const { requireAdmin } = require('../admin-auth');

// ── GET /admin/stats/overview ─────────────────────────────────────────────────

async function statsOverview(req, res, { H }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const [
    groups, users, activeEvents, items,
    activeToday, activeWeek,
    newGroupsWeek, sparkline,
    platformBreakdown,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM picnic_groups'),
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
  ]);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    totalGroups:    groups.rows[0].n,
    totalUsers:     users.rows[0].n,
    activeEvents:   activeEvents.rows[0].n,
    totalItems:     items.rows[0].n,
    activeToday:    activeToday.rows[0].n,
    activeWeek:     activeWeek.rows[0].n,
    newGroupsWeek:  newGroupsWeek.rows[0].n,
    sparkline:      sparkline.rows,
    platforms:      platformBreakdown.rows,
  }));
}

// ── GET /admin/stats/groups ───────────────────────────────────────────────────

async function statsGroups(req, res, { H }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const { rows } = await pool.query(`
    SELECT
      g.id,
      g.name,
      g.created_at,
      COUNT(DISTINCT gm.user_id)::int AS member_count,
      COUNT(DISTINCT e.id)::int        AS event_count,
      COUNT(DISTINCT i.id)::int        AS item_count,
      MAX(ae.created_at)               AS last_activity
    FROM picnic_groups g
    LEFT JOIN group_members       gm ON gm.group_id = g.id
    LEFT JOIN events               e ON e.group_id  = g.id
    LEFT JOIN items                i ON i.group_id  = g.id
    LEFT JOIN analytics_events    ae ON ae.group_id = g.id
    GROUP BY g.id
    ORDER BY last_activity DESC NULLS LAST, g.created_at DESC
    LIMIT 500
  `);

  res.writeHead(200, h);
  res.end(JSON.stringify(rows));
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
    topTypes:  topTypes.rows,
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
    // Распределение по часам суток (UTC) за 7 дней
    pool.query(`
      SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
             COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY hour ORDER BY hour
    `),
    // Топ типов событий за 30 дней
    pool.query(`
      SELECT type, COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY type ORDER BY count DESC
      LIMIT 20
    `),
    // Последние события типа error:*
    pool.query(`
      SELECT id, type, user_id, group_id, meta, created_at
      FROM analytics_events
      WHERE type LIKE 'error:%'
      ORDER BY created_at DESC
      LIMIT 50
    `),
    // Общий объём событий по дням за 30 дней
    pool.query(`
      SELECT DATE_TRUNC('day', created_at)::date AS day,
             COUNT(*)::int AS count
      FROM analytics_events
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day
    `),
  ]);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    hourly:    hourly.rows,
    topTypes:  topTypes.rows,
    errors:    errors.rows,
    totalByDay: totalByDay.rows,
  }));
}

// ── GET /admin/stats/groups/:groupId ─────────────────────────────────────────

async function statsGroupDetail(req, res, { H, params }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const { groupId } = params;

  const [groupResult, membersResult, eventsResult, activityResult] = await Promise.all([
    pool.query(`
      SELECT g.id, g.name, g.invite_code, g.tg_chat_id, g.created_at,
             COUNT(DISTINCT gm.user_id)::int AS member_count,
             COUNT(DISTINCT e.id)::int        AS event_count,
             COUNT(DISTINCT i.id)::int        AS item_count
      FROM picnic_groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      LEFT JOIN events e         ON e.group_id  = g.id
      LEFT JOIN items  i         ON i.group_id  = g.id
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
      ORDER BY event_date DESC
      LIMIT 20
    `, [groupId]),
    pool.query(`
      SELECT type, user_id, platform, created_at
      FROM analytics_events
      WHERE group_id = $1
      ORDER BY created_at DESC
      LIMIT 30
    `, [groupId]),
  ]);

  if (!groupResult.rows.length) {
    res.writeHead(404, h); res.end(JSON.stringify({ error: 'not found' })); return;
  }

  const group   = groupResult.rows[0];
  const members = membersResult.rows;
  const creator = members.find(m => m.is_admin) ?? members[0] ?? null;

  res.writeHead(200, h);
  res.end(JSON.stringify({
    group,
    creator,
    members,
    events:         eventsResult.rows,
    recentActivity: activityResult.rows,
  }));
}

module.exports = { statsOverview, statsGroups, statsActivity, statsTechnical, statsGroupDetail };
