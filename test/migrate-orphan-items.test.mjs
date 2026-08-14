/**
 * Тесты датафикса миграции v4.1 — привязка осиротевших позиций (items.event_id IS NULL).
 */
import { describe, it, expect, vi } from 'vitest';

import { attachOrphanItemsToEvents } from '../lib/migrate-orphan-items.js';

/**
 * Мок client: `orphanGroups` — что вернёт поиск групп с осиротевшими позициями,
 * `eventsByGroup` — существующие события по группам, `updated` — rowCount у UPDATE items.
 */
function makeClient({ orphanGroups = [], eventsByGroup = {}, updated = 3 } = {}) {
  const queries = [];
  const client = {
    queries,
    query: vi.fn(async (sql, params) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

      if (sql.includes('FROM picnic_groups g')) return { rows: orphanGroups };
      if (sql.includes('SELECT id FROM events')) {
        const existing = eventsByGroup[params[0]];
        return { rows: existing ? [{ id: existing }] : [] };
      }
      if (sql.includes('INSERT INTO events')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE items SET event_id')) return { rows: [], rowCount: updated };

      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
  return client;
}

describe('attachOrphanItemsToEvents', () => {
  it('осиротевших позиций нет — только один SELECT, ничего не меняется', async () => {
    const client = makeClient();
    const { fixed } = await attachOrphanItemsToEvents(client);

    expect(fixed).toEqual([]);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('у группы уже есть событие — переиспользует его, новое не создаёт', async () => {
    const client = makeClient({
      orphanGroups: [{ id: 'g1', name: 'Шашлыки' }],
      eventsByGroup: { g1: 'evt-old' },
      updated: 4,
    });

    const { fixed } = await attachOrphanItemsToEvents(client);

    expect(client.queries.some(q => q.sql.includes('INSERT INTO events'))).toBe(false);
    const upd = client.queries.find(q => q.sql.includes('UPDATE items SET event_id'));
    expect(upd.params).toEqual(['evt-old', 'g1']);
    expect(fixed).toEqual([{
      groupId: 'g1', groupName: 'Шашлыки', eventId: 'evt-old',
      createdEvent: false, itemCount: 4,
    }]);
  });

  it('событий нет — создаёт дефолтное с именем группы и 8-символьным hex-id', async () => {
    const client = makeClient({ orphanGroups: [{ id: 'g2', name: 'Дача' }] });

    const { fixed } = await attachOrphanItemsToEvents(client);

    const ins = client.queries.find(q => q.sql.includes('INSERT INTO events'));
    expect(ins).toBeDefined();
    const [eventId, groupId, name] = ins.params;
    expect(eventId).toMatch(/^[0-9a-f]{8}$/);
    expect(groupId).toBe('g2');
    expect(name).toBe('Дача');

    expect(fixed[0]).toMatchObject({ groupId: 'g2', createdEvent: true, itemCount: 3 });
    expect(fixed[0].eventId).toBe(eventId);

    // Позиции привязываются именно к созданному событию
    const upd = client.queries.find(q => q.sql.includes('UPDATE items SET event_id'));
    expect(upd.params).toEqual([eventId, 'g2']);
  });

  it('обрабатывает несколько групп независимо', async () => {
    const client = makeClient({
      orphanGroups: [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }],
      eventsByGroup: { g1: 'evt-a' },
    });

    const { fixed } = await attachOrphanItemsToEvents(client);

    expect(fixed).toHaveLength(2);
    expect(fixed[0]).toMatchObject({ groupId: 'g1', eventId: 'evt-a', createdEvent: false });
    expect(fixed[1]).toMatchObject({ groupId: 'g2', createdEvent: true });
    expect(client.queries.filter(q => q.sql.includes('INSERT INTO events'))).toHaveLength(1);
    expect(client.queries.filter(q => q.sql.includes('UPDATE items SET event_id'))).toHaveLength(2);
  });

  it('UPDATE ограничен группой и только позициями без события', async () => {
    const client = makeClient({
      orphanGroups: [{ id: 'g1', name: 'A' }],
      eventsByGroup: { g1: 'evt-a' },
    });

    await attachOrphanItemsToEvents(client);

    const upd = client.queries.find(q => q.sql.includes('UPDATE items SET event_id'));
    expect(upd.sql).toContain('group_id = $2');
    expect(upd.sql).toContain('event_id IS NULL');
  });
});
