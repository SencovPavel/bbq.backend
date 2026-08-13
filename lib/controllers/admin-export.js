'use strict';

const { pool } = require('../db');
const { requireAdmin } = require('../admin-auth');
const { parseGroupsListParams } = require('../admin-query-helpers');

function csvEscape(val) {
  let s = val === null || val === undefined ? '' : String(val);
  // CSV-injection: значения, начинающиеся с =, +, -, @ (или tab/CR), Excel/Sheets трактуют как формулу.
  // Нейтрализуем ведущим апострофом.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\n');
}

// ── GET /admin/export/groups.csv ──────────────────────────────────────────────

async function exportGroupsCsv(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const { q, inactiveDays, hasBot } = parseGroupsListParams(url);
  const vals = [];
  let p = 1;
  const filters = [];

  if (q) {
    filters.push(`(g.name ILIKE $${p} OR g.id ILIKE $${p} OR g.invite_code ILIKE $${p})`);
    vals.push(`%${q}%`);
    p += 1;
  }
  if (hasBot) filters.push(`(g.tg_chat_id IS NOT NULL OR g.max_chat_id IS NOT NULL)`);

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { rows } = await pool.query(`
    SELECT g.id, g.name, g.invite_code, g.emoji,
           g.tg_chat_id IS NOT NULL AS bot_telegram,
           g.max_chat_id IS NOT NULL AS bot_max,
           g.created_at,
           COUNT(DISTINCT gm.user_id)::int AS member_count,
           COUNT(DISTINCT e.id)::int AS event_count
    FROM picnic_groups g
    LEFT JOIN group_members gm ON gm.group_id = g.id
    LEFT JOIN events e ON e.group_id = g.id
    ${where}
    GROUP BY g.id
    ORDER BY g.created_at DESC
    LIMIT 5000
  `, vals);

  const headers = ['id', 'name', 'invite_code', 'emoji', 'bot_telegram', 'bot_max', 'created_at', 'member_count', 'event_count'];
  const csv = toCsv(headers, rows);

  res.writeHead(200, {
    ...h,
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="groups.csv"',
  });
  res.end(`\uFEFF${csv}`);
}

// ── GET /admin/export/analytics.csv?days=30 ───────────────────────────────────

async function exportAnalyticsCsv(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));

  const { rows } = await pool.query(`
    SELECT id, type, user_id, group_id, platform, created_at
    FROM analytics_events
    WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
    ORDER BY created_at DESC
    LIMIT 10000
  `, [days]);

  const headers = ['id', 'type', 'user_id', 'group_id', 'platform', 'created_at'];
  const csv = toCsv(headers, rows);

  res.writeHead(200, {
    ...h,
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="analytics-${days}d.csv"`,
  });
  res.end(`\uFEFF${csv}`);
}

// ── GET /admin/audit-log ──────────────────────────────────────────────────────

async function listAuditLog(req, res, { H, url }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  try {
    const { rows } = await pool.query(`
      SELECT id, actor_id, action, target_type, target_id, payload, created_at
      FROM admin_audit_log
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.writeHead(200, h);
    res.end(JSON.stringify(rows));
  } catch {
    res.writeHead(200, h);
    res.end(JSON.stringify([]));
  }
}

module.exports = { exportGroupsCsv, exportAnalyticsCsv, listAuditLog };
