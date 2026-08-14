'use strict';

const { nanoid }                   = require('nanoid');
const { pool, getFullState } = require('../db');
const { logActivity }              = require('../activity');
const { trackEvent, detectPlatform } = require('../analytics');
const { checkRateLimit, getClientIp } = require('../rate-limit');
const { requireUser, readBodySafe } = require('../request-helpers');
const { ensureAppUserRecord } = require('../identity');

async function createGroup(req, res, { H, broadcast }) {
  const ip = getClientIp(req);
  if (!await checkRateLimit(`create-group:${ip}`, { limit: 20, windowMs: 15 * 60 * 1000 })) {
    res.writeHead(429, H);
    res.end(JSON.stringify({ error: 'too many requests' }));
    return;
  }
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  const auth = await requireUser(req, res, body.initData);
  if (!auth) return;
  const { user, H: h } = auth;
  const name = body.name?.trim();
  if (!name) {
    res.writeHead(400, h);
    res.end(JSON.stringify({ error: 'missing fields' }));
    return;
  }
  const id         = nanoid(10);
  const inviteCode = nanoid(6).toUpperCase();
  await pool.query('INSERT INTO picnic_groups(id,invite_code,name) VALUES($1,$2,$3)', [id, inviteCode, name]);
  await ensureAppUserRecord(pool, { userId: user.userId, userName: user.userName });
  await pool.query(
    'INSERT INTO group_members(group_id,user_id,name,is_admin) VALUES($1,$2,$3,TRUE)',
    [id, user.userId, user.userName],
  );
  trackEvent(pool, { type: 'group:created', userId: user.userId, groupId: id, platform: detectPlatform(req) });
  res.writeHead(200, h);
  res.end(JSON.stringify({ id, inviteCode }));
}

/**
 * Общая часть вступления в группу: rate-limit → тело → auth → извлечение ключа →
 * поиск группы → вступление → broadcast → ответ.
 * Различаются только rate-limit-бакет, способ достать ключ из тела и SQL поиска группы.
 *
 * @param {object} deps
 * @param {string} deps.bucket            — префикс ключа rate-limit
 * @param {(body: object) => string|undefined} deps.pickKey — достаёт ключ группы из тела (уже нормализованный)
 * @param {string} deps.lookupSql         — SELECT-запрос с одним параметром-ключом
 */
async function joinResolvedGroup(req, res, { H, broadcast }, { bucket, pickKey, lookupSql }) {
  const ip = getClientIp(req);
  if (!await checkRateLimit(`${bucket}:${ip}`, { limit: 30, windowMs: 15 * 60 * 1000 })) {
    res.writeHead(429, H);
    res.end(JSON.stringify({ error: 'too many requests' }));
    return;
  }
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  const auth = await requireUser(req, res, body.initData);
  if (!auth) return;
  const { user, H: h } = auth;
  const key = pickKey(body);
  if (!key) {
    res.writeHead(400, h);
    res.end(JSON.stringify({ error: 'missing fields' }));
    return;
  }
  const grp = await pool.query(lookupSql, [key]);
  if (!grp.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'Группа не найдена' }));
    return;
  }
  const group = grp.rows[0];
  await ensureAppUserRecord(pool, { userId: user.userId, userName: user.userName });
  await pool.query(
    `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
     ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
    [group.id, user.userId, user.userName],
  );
  await logActivity(pool, { groupId: group.id, type: 'member:joined', actorName: user.userName });
  trackEvent(pool, { type: 'group:joined', userId: user.userId, groupId: group.id, platform: detectPlatform(req) });
  const state = await getFullState(group.id);
  broadcast(group.id, { type: 'state', state });
  res.writeHead(200, h);
  res.end(JSON.stringify({ id: group.id, name: group.name, state }));
}

async function joinGroup(req, res, ctx) {
  return joinResolvedGroup(req, res, ctx, {
    bucket: 'join',
    pickKey: (body) => body.inviteCode?.trim().toUpperCase(),
    lookupSql: 'SELECT * FROM picnic_groups WHERE invite_code=$1',
  });
}

async function joinGroupById(req, res, ctx) {
  return joinResolvedGroup(req, res, ctx, {
    bucket: 'join-by-id',
    pickKey: (body) => body.groupId,
    lookupSql: 'SELECT * FROM picnic_groups WHERE id=$1',
  });
}

module.exports = { createGroup, joinGroup, joinGroupById };
