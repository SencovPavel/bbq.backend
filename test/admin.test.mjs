import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { labelForEventType, withLabels } = require('../lib/admin-labels.js');

describe('admin-labels', () => {
  it('возвращает русскую подпись для известного типа', () => {
    expect(labelForEventType('group:created')).toBe('Создана группа');
  });

  it('добавляет label в массив', () => {
    const rows = withLabels([{ type: 'item:added', count: 1 }]);
    expect(rows[0].label).toBe('Добавлен товар');
  });
});

describe('parseGroupsListParams', () => {
  it('парсит limit и offset', async () => {
    const { parseGroupsListParams } = await import('../lib/admin-query-helpers.js');
    const url = new URL('http://localhost/admin/stats/groups?limit=25&offset=10&q=test');
    const p = parseGroupsListParams(url);
    expect(p.limit).toBe(25);
    expect(p.offset).toBe(10);
    expect(p.q).toBe('test');
  });
});
