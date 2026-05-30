/**
 * Нормализует status событий: одно active на группу (последнее по created_at).
 * Идемпотентно — безопасно запускать повторно.
 *
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ activeEvents: Array<{ group_id: string; id: string; name: string }> }>}
 */
async function normalizeEventStatusPerGroup(client) {
  await client.query(`UPDATE events SET status = 'completed'`);

  const { rows: activeEvents } = await client.query(`
    UPDATE events e
    SET status = 'active'
    FROM (
      SELECT DISTINCT ON (group_id) id
      FROM events
      ORDER BY group_id, created_at DESC NULLS LAST, id DESC
    ) latest
    WHERE e.id = latest.id
    RETURNING e.group_id, e.id, e.name
  `);

  return { activeEvents };
}

module.exports = { normalizeEventStatusPerGroup };
