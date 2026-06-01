'use strict';

const { nanoid }                    = require('nanoid');
const { pool }                      = require('../db');
const { requireUser, readBodySafe } = require('../request-helpers');

// ── GET /family/members ───────────────────────────────────────────────────────

async function listFamilyMembers(req, res, { H }) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, H: h } = auth;

  const { rows } = await pool.query(
    `SELECT
       fm.id, fm.owner_id, fm.name, fm.label, fm.created_at,
       COALESCE(
         json_agg(
           json_build_object(
             'group_id',        fgs.group_id,
             'group_name',      pg.name,
             'include_in_calc', fgs.include_in_calc,
             'cost_pct',        fgs.cost_pct
           ) ORDER BY pg.name
         ) FILTER (WHERE fgs.group_id IS NOT NULL),
         '[]'
       ) AS groups
     FROM family_members fm
     LEFT JOIN family_group_settings fgs ON fgs.family_member_id = fm.id
     LEFT JOIN picnic_groups pg ON pg.id = fgs.group_id
     WHERE fm.owner_id = $1
     GROUP BY fm.id
     ORDER BY fm.created_at`,
    [user.userId],
  );

  res.writeHead(200, h);
  res.end(JSON.stringify(rows));
}

// ── POST /family/members ──────────────────────────────────────────────────────

async function addFamilyMember(req, res, { H }) {
  const body = await readBodySafe(req, res, H);
  if (body === null) return;

  const auth = await requireUser(req, res, body.initData);
  if (!auth) return;
  const { user, H: h } = auth;

  const name  = body.name?.trim();
  const label = body.label?.trim() || null;

  if (!name) {
    res.writeHead(400, h);
    res.end(JSON.stringify({ error: 'name required' }));
    return;
  }

  const id = nanoid(10);
  await pool.query(
    'INSERT INTO family_members(id, owner_id, name, label) VALUES($1,$2,$3,$4)',
    [id, user.userId, name, label],
  );

  res.writeHead(200, h);
  res.end(JSON.stringify({ id, owner_id: user.userId, name, label, groups: [] }));
}

// ── PUT /family/members/:id ───────────────────────────────────────────────────

async function updateFamilyMember(req, res, { H, params }) {
  const body = await readBodySafe(req, res, H);
  if (body === null) return;

  const auth = await requireUser(req, res, body.initData);
  if (!auth) return;
  const { user, H: h } = auth;

  const { id } = params;

  // Проверяем владение
  const check = await pool.query(
    'SELECT id FROM family_members WHERE id=$1 AND owner_id=$2',
    [id, user.userId],
  );
  if (!check.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const fields = [];
  const vals   = [];
  if (typeof body.name === 'string') { fields.push('name'); vals.push(body.name.trim()); }
  if ('label' in body)               { fields.push('label'); vals.push(body.label?.trim() || null); }

  if (fields.length) {
    const set = fields.map((f, i) => `${f}=$${i + 1}`).join(', ');
    vals.push(id);
    await pool.query(
      `UPDATE family_members SET ${set} WHERE id=$${vals.length}`,
      vals,
    );
  }

  res.writeHead(200, h);
  res.end(JSON.stringify({ ok: true }));
}

// ── DELETE /family/members/:id ────────────────────────────────────────────────

async function deleteFamilyMember(req, res, { H, params }) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, H: h } = auth;

  const { id } = params;

  const check = await pool.query(
    'SELECT id FROM family_members WHERE id=$1 AND owner_id=$2',
    [id, user.userId],
  );
  if (!check.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  await pool.query('DELETE FROM family_members WHERE id=$1', [id]);

  res.writeHead(200, h);
  res.end(JSON.stringify({ ok: true }));
}

// ── POST /family/members/:id/groups ──────────────────────────────────────────
// body: { groupId, enabled, includeInCalc?, costPct? }

async function setFamilyMemberGroup(req, res, { H, params }) {
  const body = await readBodySafe(req, res, H);
  if (body === null) return;

  const auth = await requireUser(req, res, body.initData);
  if (!auth) return;
  const { user, H: h } = auth;

  const { id } = params;
  const groupId = body.groupId;

  if (!groupId) {
    res.writeHead(400, h);
    res.end(JSON.stringify({ error: 'groupId required' }));
    return;
  }

  // Проверяем владение family member
  const check = await pool.query(
    'SELECT id FROM family_members WHERE id=$1 AND owner_id=$2',
    [id, user.userId],
  );
  if (!check.rows.length) {
    res.writeHead(404, h);
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // Проверяем, что пользователь состоит в этой группе
  const memberCheck = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',
    [groupId, user.userId],
  );
  if (!memberCheck.rows.length) {
    res.writeHead(403, h);
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  if (body.enabled === false) {
    await pool.query(
      'DELETE FROM family_group_settings WHERE family_member_id=$1 AND group_id=$2',
      [id, groupId],
    );
  } else {
    const includeInCalc = body.includeInCalc !== false;
    const costPct       = typeof body.costPct === 'number'
      ? Math.max(0, Math.min(200, body.costPct))
      : 100;
    await pool.query(
      `INSERT INTO family_group_settings(family_member_id, group_id, include_in_calc, cost_pct)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (family_member_id, group_id)
       DO UPDATE SET include_in_calc=$3, cost_pct=$4`,
      [id, groupId, includeInCalc, costPct],
    );
  }

  res.writeHead(200, h);
  res.end(JSON.stringify({ ok: true }));
}

module.exports = {
  listFamilyMembers,
  addFamilyMember,
  updateFamilyMember,
  deleteFamilyMember,
  setFamilyMemberGroup,
};
