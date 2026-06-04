'use strict';

/** Паттерн email для Telegram-stub в users. */
const TG_EMAIL_SQL = `u.email LIKE 'tg_%@telegram.internal'`;

/**
 * Создаёт записи users для участников group_members без аккаунта (Telegram-id).
 * @param {import('pg').Pool} pool
 * @returns {Promise<number>} число вставленных строк
 */
async function syncGroupMembersToUsers(pool) {
  const { rowCount } = await pool.query(`
    INSERT INTO users(id, email, name)
    SELECT DISTINCT ON (gm.user_id)
      gm.user_id,
      'tg_' || gm.user_id || '@telegram.internal',
      gm.name
    FROM group_members gm
    LEFT JOIN users u ON u.id = gm.user_id
    WHERE u.id IS NULL
    ORDER BY gm.user_id, gm.joined_at ASC
    ON CONFLICT (id) DO NOTHING
  `);
  return rowCount ?? 0;
}

module.exports = {
  TG_EMAIL_SQL,
  syncGroupMembersToUsers,
};
