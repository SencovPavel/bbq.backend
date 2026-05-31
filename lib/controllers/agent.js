'use strict';

const { pool }                   = require('../db');
const { analyzeDiff }            = require('../agent');
const { isGroupMember }          = require('../membership');
const { checkRateLimit }         = require('../rate-limit');
const { requireUser, readBodySafe } = require('../request-helpers');

async function analyzeAgent(req, res, { H }) {
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  const auth = await requireUser(req, res, body.initData);
  if (!auth) return;
  const { user, H: h } = auth;
  const { groupId } = body;
  if (!groupId) {
    res.writeHead(400, h);
    res.end(JSON.stringify({ error: 'groupId required' }));
    return;
  }
  if (!await checkRateLimit(`analyze:${user.userId}:${groupId}`, { limit: 10, windowMs: 60 * 60 * 1000 })) {
    res.writeHead(429, h);
    res.end(JSON.stringify({ error: 'too many requests' }));
    return;
  }
  if (!await isGroupMember(groupId, user.userId)) {
    res.writeHead(403, h);
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }
  const [msgsRes, itemsRes] = await Promise.all([
    pool.query('SELECT user_name,text FROM chat_messages WHERE group_id=$1 ORDER BY created_at DESC LIMIT 100', [groupId]),
    pool.query('SELECT * FROM items WHERE group_id=$1', [groupId]),
  ]);
  if (!msgsRes.rows.length) {
    res.writeHead(200, h);
    res.end(JSON.stringify({
      summary: 'В чате пока нет сообщений. Привяжите бота командой /link КОД в вашей Telegram-группе.',
      missing: [], extra: [], changed: [],
    }));
    return;
  }
  const result = await analyzeDiff(msgsRes.rows.reverse(), itemsRes.rows);
  await pool.query('INSERT INTO agent_analyses(group_id,analysis) VALUES($1,$2)', [groupId, JSON.stringify(result)]);
  res.writeHead(200, h);
  res.end(JSON.stringify(result));
}

module.exports = { analyzeAgent };
