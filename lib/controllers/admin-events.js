'use strict';

const { pool } = require('../db');
const { requireAdmin } = require('../admin-auth');
const { withLabels, labelForEventType } = require('../admin-labels');
const { intParam } = require('../admin-query-helpers');

// ── GET /admin/events ─────────────────────────────────────────────────────────

async function listAdminEvents(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const status = url.searchParams.get('status');
  const groupId = url.searchParams.get('groupId');
  const limit = intParam(url, 'limit', 50, 1, 200);
  const offset = intParam(url, 'offset', 0, 0, 100_000);

  const vals = [];
  let p = 1;
  const filters = [];

  if (status) {
    filters.push(`e.status = $${p}`);
    vals.push(status);
    p += 1;
  }
  if (groupId) {
    filters.push(`e.group_id = $${p}`);
    vals.push(groupId);
    p += 1;
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const [countRes, listRes] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM events e ${where}`, vals),
    pool.query(`
      SELECT e.id, e.group_id, e.name, e.event_date, e.status, e.created_at,
             g.name AS group_name,
             COUNT(DISTINCT i.id)::int AS items_count,
             COUNT(DISTINCT r.user_id)::int AS rsvp_count
      FROM events e
      JOIN picnic_groups g ON g.id = e.group_id
      LEFT JOIN items i ON i.event_id = e.id AND i.enabled = true
      LEFT JOIN event_rsvp r ON r.event_id = e.id AND r.attending = true
      ${where}
      GROUP BY e.id, g.name
      ORDER BY e.event_date DESC NULLS LAST, e.created_at DESC
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

// ── GET /admin/stats/groups/:groupId/events/:eventId ────────────────────────

async function getAdminEventDetail(req, res, { H, params }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const { groupId, eventId } = params;

  const [eventRes, itemsRes, rsvpRes, familyRsvpRes, activityRes] = await Promise.all([
    pool.query(`
      SELECT e.*, g.name AS group_name
      FROM events e
      JOIN picnic_groups g ON g.id = e.group_id
      WHERE e.id = $1 AND e.group_id = $2
    `, [eventId, groupId]),
    pool.query(`
      SELECT id, name, qty, unit, price, source, bought
      FROM items WHERE event_id = $1 AND enabled = true
      ORDER BY name
    `, [eventId]),
    pool.query(`
      SELECT r.user_id, r.attending, gm.name
      FROM event_rsvp r
      LEFT JOIN group_members gm ON gm.group_id = $2 AND gm.user_id = r.user_id
      WHERE r.event_id = $1
    `, [eventId, groupId]),
    pool.query(`
      SELECT fmr.family_member_id, fmr.attending, fm.name
      FROM family_member_rsvp fmr
      JOIN family_members fm ON fm.id = fmr.family_member_id
      WHERE fmr.event_id = $1
    `, [eventId]),
    pool.query(`
      SELECT type, actor_name, data, created_at
      FROM group_activity
      WHERE event_id = $1
      ORDER BY created_at DESC
      LIMIT 40
    `, [eventId]),
  ]);

  if (!eventRes.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const items = itemsRes.rows;
  const bought = items.filter(i => i.bought).length;
  const totalSum = items.reduce((s, i) => s + Number(i.price) * Number(i.qty), 0);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    event: eventRes.rows[0],
    items,
    itemsTotalSum: totalSum,
    boughtPct: items.length ? Math.round((bought / items.length) * 100) : 0,
    rsvp: rsvpRes.rows,
    familyRsvp: familyRsvpRes.rows,
    activity: activityRes.rows.map(row => ({
      ...row,
      label: labelForEventType(row.type),
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    })),
  }));
}

// ── GET /admin/stats/funnel?days=30 ───────────────────────────────────────────

async function statsFunnel(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));

  const [created, joined, events, withItems, rsvp] = await Promise.all([
    pool.query(`
      SELECT COUNT(DISTINCT group_id)::int AS n FROM analytics_events
      WHERE type = 'group:created' AND created_at > NOW() - ($1 || ' days')::INTERVAL
    `, [days]),
    pool.query(`
      SELECT COUNT(*)::int AS n FROM analytics_events
      WHERE type = 'group:joined' AND created_at > NOW() - ($1 || ' days')::INTERVAL
    `, [days]),
    pool.query(`
      SELECT COUNT(*)::int AS n FROM analytics_events
      WHERE type = 'event:created' AND created_at > NOW() - ($1 || ' days')::INTERVAL
    `, [days]),
    pool.query(`
      SELECT COUNT(DISTINCT group_id)::int AS n FROM analytics_events
      WHERE type = 'item:added' AND created_at > NOW() - ($1 || ' days')::INTERVAL
    `, [days]),
    pool.query(`
      SELECT COUNT(*)::int AS n FROM analytics_events
      WHERE type = 'rsvp:set' AND created_at > NOW() - ($1 || ' days')::INTERVAL
    `, [days]),
  ]);

  const steps = [
    { key: 'group:created', label: 'Группы созданы', count: created.rows[0].n },
    { key: 'group:joined', label: 'Вступления', count: joined.rows[0].n },
    { key: 'event:created', label: 'Мероприятия', count: events.rows[0].n },
    { key: 'item:added', label: 'Группы с товарами', count: withItems.rows[0].n },
    { key: 'rsvp:set', label: 'RSVP', count: rsvp.rows[0].n },
  ];

  res.writeHead(200, h);
  res.end(JSON.stringify({ days, steps }));
}

// ── GET /admin/stats/retention?days=30 ────────────────────────────────────────

async function statsRetention(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const { rows } = await pool.query(`
    WITH cohort AS (
      SELECT id, created_at::date AS cohort_day
      FROM picnic_groups
      WHERE created_at > NOW() - INTERVAL '90 days'
    ),
    activity AS (
      SELECT g.id,
             MAX(COALESCE(ga.created_at, ae.created_at)) AS last_at
      FROM picnic_groups g
      LEFT JOIN group_activity ga ON ga.group_id = g.id
      LEFT JOIN analytics_events ae ON ae.group_id = g.id
      GROUP BY g.id
    )
    SELECT
      (SELECT COUNT(*)::int FROM cohort) AS cohort_size,
      (SELECT COUNT(*)::int FROM cohort c
        JOIN activity a ON a.id = c.id
        WHERE a.last_at >= c.cohort_day + INTERVAL '7 days') AS active_d7,
      (SELECT COUNT(*)::int FROM cohort c
        JOIN activity a ON a.id = c.id
        WHERE a.last_at >= c.cohort_day + INTERVAL '14 days') AS active_d14,
      (SELECT COUNT(*)::int FROM cohort c
        JOIN activity a ON a.id = c.id
        WHERE a.last_at >= c.cohort_day + INTERVAL '30 days') AS active_d30
  `);

  const r = rows[0];
  const size = r.cohort_size || 0;
  const pct = (n) => (size ? Math.round((n / size) * 100) : 0);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    cohortSize: size,
    d7: { count: r.active_d7, pct: pct(r.active_d7) },
    d14: { count: r.active_d14, pct: pct(r.active_d14) },
    d30: { count: r.active_d30, pct: pct(r.active_d30) },
  }));
}

module.exports = {
  listAdminEvents,
  getAdminEventDetail,
  statsFunnel,
  statsRetention,
};
