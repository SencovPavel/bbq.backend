'use strict';

const { nanoid }                   = require('nanoid');
const { pool, DEFAULT_CATS, getFullState } = require('../db');
const { logActivity }              = require('../activity');
const { checkRateLimit, getClientIp } = require('../rate-limit');
const { requireUser, readBodySafe } = require('../request-helpers');

async function createGroup(req, res, { H, broadcast }) {
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
  await pool.query(
    'INSERT INTO group_members(group_id,user_id,name,is_admin) VALUES($1,$2,$3,TRUE)',
    [id, user.userId, user.userName],
  );
  for (let i = 0; i < DEFAULT_CATS.length; i++) {
    const c = DEFAULT_CATS[i];
    await pool.query(
      'INSERT INTO categories(id,group_id,title,icon,position) VALUES($1,$2,$3,$4,$5)',
      [c.id, id, c.title, c.icon, i],
    );
  }
  res.writeHead(200, h);
  res.end(JSON.stringify({ id, inviteCode }));
}

async function joinGroup(req, res, { H, broadcast }) {
  const ip = getClientIp(req);
  if (!await checkRateLimit(`join:${ip}`, { limit: 30, windowMs: 15 * 60 * 1000 })) {
    res.writeHead(429, H);
    res.end(JSON.stringify({ error: 'too many requests' }));
    return;
  }
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  const auth = await requireUser(req, res, body.initData);
  if (!auth) return;
  const { user, H: h } = auth;
  const inviteCode = body.inviteCode?.trim();
  if (!inviteCode) {
    res.writeHead(400, h);
    res.end(JSON.stringify({ error: 'missing fields' }));
    return;
  }
  const grp = await pool.query('SELECT * FROM picnic_groups WHERE invite_code=$1', [inviteCode.toUpperCase()]);
  if (!grp.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'Группа не найдена' }));
    return;
  }
  const group = grp.rows[0];
  await pool.query(
    `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
     ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
    [group.id, user.userId, user.userName],
  );
  await logActivity(pool, { groupId: group.id, type: 'member:joined', actorName: user.userName });
  const state = await getFullState(group.id);
  broadcast(group.id, { type: 'state', state });
  res.writeHead(200, h);
  res.end(JSON.stringify({ id: group.id, name: group.name, state }));
}

async function joinGroupById(req, res, { H, broadcast }) {
  const ip = getClientIp(req);
  if (!await checkRateLimit(`join-by-id:${ip}`, { limit: 30, windowMs: 15 * 60 * 1000 })) {
    res.writeHead(429, H);
    res.end(JSON.stringify({ error: 'too many requests' }));
    return;
  }
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  const auth = await requireUser(req, res, body.initData);
  if (!auth) return;
  const { user, H: h } = auth;
  const groupId = body.groupId;
  if (!groupId) {
    res.writeHead(400, h);
    res.end(JSON.stringify({ error: 'missing fields' }));
    return;
  }
  const grp = await pool.query('SELECT * FROM picnic_groups WHERE id=$1', [groupId]);
  if (!grp.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'Группа не найдена' }));
    return;
  }
  const group = grp.rows[0];
  await pool.query(
    `INSERT INTO group_members(group_id,user_id,name) VALUES($1,$2,$3)
     ON CONFLICT(group_id,user_id) DO UPDATE SET name=EXCLUDED.name`,
    [group.id, user.userId, user.userName],
  );
  await logActivity(pool, { groupId: group.id, type: 'member:joined', actorName: user.userName });
  const state = await getFullState(group.id);
  broadcast(group.id, { type: 'state', state });
  res.writeHead(200, h);
  res.end(JSON.stringify({ id: group.id, name: group.name, state }));
}

module.exports = { createGroup, joinGroup, joinGroupById };
