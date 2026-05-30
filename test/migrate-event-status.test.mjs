import { describe, it, expect, vi } from 'vitest';

import { normalizeEventStatusPerGroup } from '../lib/migrate-event-status.js';

describe('normalizeEventStatusPerGroup', () => {
  it('помечает все completed, затем active только последнему по группе', async () => {
    const queries = [];

    const client = {
      query: vi.fn(async (sql) => {
        queries.push(sql.trim());

        if (sql.includes('UPDATE events SET status = \'completed\'')) {
          return { rowCount: 5, rows: [] };
        }

        if (sql.includes('DISTINCT ON (group_id)')) {
          return {
            rowCount: 2,
            rows: [
              { group_id: 'g1', id: 'e-new', name: 'Пикник 2025' },
              { group_id: 'g2', id: 'e3', name: 'Шашлыки' },
            ],
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      }),
    };

    const result = await normalizeEventStatusPerGroup(client);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("status = 'completed'");
    expect(queries[1]).toContain('DISTINCT ON (group_id)');
    expect(queries[1]).toContain('created_at DESC NULLS LAST');
    expect(result.activeEvents).toHaveLength(2);
  });
});
