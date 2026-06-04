'use strict';

const { pool } = require('../db');
const { requireAdmin } = require('../admin-auth');

// ── GET /admin/integrations ───────────────────────────────────────────────────

async function adminIntegrations(req, res, { H }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const [withTg, withoutTg, withMax, chatStats] = await Promise.all([
    pool.query(`
      SELECT g.id, g.name, g.tg_chat_id, g.invite_code, g.created_at,
             (SELECT COUNT(*)::int FROM chat_messages cm WHERE cm.group_id = g.id
              AND cm.created_at > NOW() - INTERVAL '7 days') AS messages_7d
      FROM picnic_groups g
      WHERE g.tg_chat_id IS NOT NULL
      ORDER BY g.created_at DESC
      LIMIT 100
    `),
    pool.query(`
      SELECT g.id, g.name, g.invite_code, g.created_at,
             COUNT(DISTINCT gm.user_id)::int AS member_count
      FROM picnic_groups g
      LEFT JOIN group_members gm ON gm.group_id = g.id
      WHERE g.tg_chat_id IS NULL AND g.max_chat_id IS NULL
      GROUP BY g.id
      ORDER BY g.created_at DESC
      LIMIT 100
    `),
    pool.query(`
      SELECT g.id, g.name, g.max_chat_id, g.created_at
      FROM picnic_groups g
      WHERE g.max_chat_id IS NOT NULL
      ORDER BY g.created_at DESC
      LIMIT 100
    `),
    pool.query(`
      SELECT COUNT(*)::int AS total_7d
      FROM chat_messages
      WHERE created_at > NOW() - INTERVAL '7 days'
    `).catch(() => ({ rows: [{ total_7d: null }] })),
  ]);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    telegramLinked: withTg.rows,
    noBot: withoutTg.rows,
    maxLinked: withMax.rows,
    chatMessages7d: chatStats.rows[0]?.total_7d,
  }));
}

// ── GET /admin/health ─────────────────────────────────────────────────────────

async function adminHealth(req, res, { H }) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const { H: h } = auth;

  const [errors24h, errors7d, tableSizes] = await Promise.all([
    pool.query(`
      SELECT type, COUNT(*)::int AS count
      FROM analytics_events
      WHERE type LIKE 'error:%' AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY type ORDER BY count DESC
    `),
    pool.query(`
      SELECT type, COUNT(*)::int AS count
      FROM analytics_events
      WHERE type LIKE 'error:%' AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY type ORDER BY count DESC LIMIT 10
    `),
    pool.query(`
      SELECT relname AS table_name,
             pg_total_relation_size(relid)::bigint AS size_bytes
      FROM pg_catalog.pg_statio_user_tables
      WHERE schemaname = 'public'
      ORDER BY size_bytes DESC
      LIMIT 12
    `).catch(() => ({ rows: [] })),
  ]);

  res.writeHead(200, h);
  res.end(JSON.stringify({
    nodeEnv: process.env.NODE_ENV ?? 'development',
    uptimeSec: Math.floor(process.uptime()),
    botConfigured: Boolean(process.env.BOT_TOKEN),
    publicUrl: process.env.PUBLIC_URL ?? null,
    errors24h: errors24h.rows,
    errors7d: errors7d.rows,
    tableSizes: tableSizes.rows,
  }));
}

module.exports = { adminIntegrations, adminHealth };
