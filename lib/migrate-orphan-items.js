/**
 * Датафикс миграции v4.1: привязка осиротевших позиций (items.event_id IS NULL) к событию.
 *
 * Для каждой группы, где такие позиции есть: берём первое существующее событие группы,
 * а если событий нет — создаём дефолтное с именем группы. Затем проставляем event_id всем
 * позициям группы без события.
 * Идемпотентно — повторный запуск не находит осиротевших позиций и ничего не делает.
 *
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{ fixed: Array<{ groupId: string; groupName: string; eventId: string; createdEvent: boolean; itemCount: number }> }>}
 */
const { randomBytes } = require('crypto');

async function attachOrphanItemsToEvents(client) {
  const { rows: groups } = await client.query(`
    SELECT DISTINCT g.id, g.name
    FROM picnic_groups g
    JOIN items i ON i.group_id = g.id
    WHERE i.event_id IS NULL
  `);

  const fixed = [];

  for (const group of groups) {
    // Проверяем, нет ли уже события у этой группы
    const { rows: existing } = await client.query(
      'SELECT id FROM events WHERE group_id = $1 LIMIT 1',
      [group.id],
    );

    let eventId;
    const createdEvent = !existing.length;
    if (existing.length) {
      // Событие уже есть — привяжем осиротевшие позиции к нему
      eventId = existing[0].id;
    } else {
      // Создаём дефолтное событие с именем группы
      eventId = randomBytes(4).toString('hex'); // 8 hex chars
      await client.query(
        `INSERT INTO events(id, group_id, name) VALUES($1, $2, $3)`,
        [eventId, group.id, group.name],
      );
    }

    // Привязываем все позиции без event_id к этому событию
    const { rowCount } = await client.query(
      'UPDATE items SET event_id = $1 WHERE group_id = $2 AND event_id IS NULL',
      [eventId, group.id],
    );

    fixed.push({
      groupId: group.id,
      groupName: group.name,
      eventId,
      createdEvent,
      itemCount: rowCount,
    });
  }

  return { fixed };
}

module.exports = { attachOrphanItemsToEvents };
