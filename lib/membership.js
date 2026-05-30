/**
 * membership.js — проверка членства в группе.
 */
const { pool } = require('./db');

/**
 * @param {string} groupId
 * @param {string} userId
 * @param {object} [dbPool]
 * @returns {Promise<boolean>}
 */
async function isGroupMember(groupId, userId, dbPool = pool) {
  if (!groupId || !userId) return false;
  const { rows } = await dbPool.query(
    'SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',
    [groupId, userId],
  );
  return rows.length > 0;
}

/**
 * @throws не бросает — возвращает false
 */
async function assertGroupMember(groupId, userId, dbPool = pool) {
  return isGroupMember(groupId, userId, dbPool);
}

module.exports = { isGroupMember, assertGroupMember };
