/**
 * activity.js — логирование истории изменений группы.
 * Все операции silent: ошибки пишутся в stderr, но не бросают исключений,
 * чтобы сбой лога не ронял основной поток.
 */

/**
 * @param {object} pool — pg Pool (или mock в тестах)
 * @param {{ groupId: string, eventId?: string|null, type: string, actorName?: string|null, data?: object }} opts
 */
async function logActivity(pool, { groupId, eventId = null, type, actorName = null, data = {} }) {
  try {
    await pool.query(
      `INSERT INTO group_activity(group_id, event_id, type, actor_name, data)
       VALUES($1, $2, $3, $4, $5)`,
      [groupId, eventId ?? null, type, actorName ?? null, JSON.stringify(data)],
    );
  } catch (e) {
    console.error('logActivity error:', e.message);
  }
}

module.exports = { logActivity };
