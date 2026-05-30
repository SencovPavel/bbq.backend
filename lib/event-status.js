/**
 * Статус события: active vs completed.
 */

/** @param {string | null | undefined} status */
function isEventActive(status) {
  return status !== 'completed';
}

/**
 * Можно ли менять позиции списка (item:*).
 * @param {import('pg').Pool | { query: Function }} pool
 * @param {string} groupId
 * @param {string | null | undefined} eventId
 */
async function assertEventItemsEditable(pool, groupId, eventId) {
  if (!eventId) return true;
  const { rows } = await pool.query(
    'SELECT status FROM events WHERE id=$1 AND group_id=$2',
    [eventId, groupId],
  );
  if (!rows.length) return true;
  return isEventActive(rows[0].status);
}

/**
 * @param {import('pg').Pool | { query: Function }} pool
 * @param {string} groupId
 * @param {string} itemId
 */
async function assertEventItemsEditableByItemId(pool, groupId, itemId) {
  const { rows } = await pool.query(
    'SELECT event_id FROM items WHERE id=$1 AND group_id=$2',
    [itemId, groupId],
  );
  if (!rows.length) return false;
  return assertEventItemsEditable(pool, groupId, rows[0].event_id);
}

module.exports = {
  isEventActive,
  assertEventItemsEditable,
  assertEventItemsEditableByItemId,
};
