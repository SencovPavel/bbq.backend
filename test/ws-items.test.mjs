/**
 * Тесты бизнес-правил для item:* сообщений.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { dispatchMessage } = require('../lib/ws.js');

function wrapPool(handler) {
  return async (sql, params) => {
    if (typeof sql === 'string' && sql.includes('FROM group_members') && sql.includes('SELECT 1')) {
      return { rows: [{ ok: 1 }] };
    }
    if (typeof sql === 'string' && sql.includes('SELECT event_id FROM items')) {
      return { rows: [{ event_id: 'evt1' }] };
    }
    if (typeof sql === 'string' && sql.includes('SELECT status FROM events')) {
      return { rows: [{ status: 'active' }] };
    }
    if (handler) return handler(sql, params);
    return { rows: [] };
  };
}

function wrapLockedPool(handler) {
  return async (sql, params) => {
    if (typeof sql === 'string' && sql.includes('FROM group_members') && sql.includes('SELECT 1')) {
      return { rows: [{ ok: 1 }] };
    }
    if (typeof sql === 'string' && sql.includes('SELECT status FROM events')) {
      return { rows: [{ status: 'completed' }] };
    }
    if (typeof sql === 'string' && sql.includes('SELECT event_id FROM items')) {
      return { rows: [{ event_id: 'evt1' }] };
    }
    if (handler) return handler(sql, params);
    return { rows: [] };
  };
}

function makeLockedPool() {
  return { query: vi.fn().mockImplementation(wrapLockedPool()) };
}

function makePool() {
  return { query: vi.fn().mockImplementation(wrapPool()) };
}

const getFullState = async () => ({});
const broadcast   = vi.fn();

function ctx(pool, extra = {}) {
  return { groupId: 'g1', userId: 'u1', pool, getFullState, broadcast, ...extra };
}

beforeEach(() => broadcast.mockClear());

// ── item:add ──────────────────────────────────────────────────────────────────

describe('item:add', () => {
  it('использует price=0 по умолчанию', async () => {
    const pool = makePool();
    await dispatchMessage({ type: 'item:add', catId: 'food', name: 'Хлеб' }, ctx(pool));

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO items'));
    const [, params] = insertCall;
    const priceIdx = 4; // позиция price в INSERT
    expect(params[priceIdx]).toBe(0);
  });

  it('использует qty=1 по умолчанию', async () => {
    const pool = makePool();
    await dispatchMessage({ type: 'item:add', catId: 'food', name: 'Хлеб' }, ctx(pool));

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO items'));
    const [, params] = insertCall;
    expect(params[5]).toBe(1); // qty
  });

  it('использует unit="шт" по умолчанию', async () => {
    const pool = makePool();
    await dispatchMessage({ type: 'item:add', catId: 'food', name: 'Хлеб' }, ctx(pool));

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO items'));
    const [, params] = insertCall;
    expect(params[6]).toBe('шт'); // unit
  });

  it('сохраняет source="manual"', async () => {
    const pool = makePool();
    await dispatchMessage({ type: 'item:add', catId: 'food', name: 'Хлеб' }, ctx(pool));

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO items'));
    const [, params] = insertCall;
    expect(params[7]).toBe('manual');
  });

  it('принимает пользовательские price, qty, unit', async () => {
    const pool = makePool();
    await dispatchMessage(
      { type: 'item:add', catId: 'meat', name: 'Шашлык', price: 500, qty: 2, unit: 'кг' },
      ctx(pool),
    );

    const insertCall = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO items'));
    const [, params] = insertCall;
    expect(params[4]).toBe(500); // price
    expect(params[5]).toBe(2);   // qty
    expect(params[6]).toBe('кг'); // unit
  });
});

// ── item:update ───────────────────────────────────────────────────────────────

describe('item:update', () => {
  const ALLOWED   = ['name', 'price', 'qty', 'unit', 'enabled', 'buyer_id', 'buyer_name', 'bought', 'cat_id'];
  const FORBIDDEN = ['source', 'group_id', 'id', 'chat_hint', 'event_id', 'created_at'];

  it.each(ALLOWED)('разрешает поле "%s"', async (field) => {
    const pool = makePool();
    await dispatchMessage({ type: 'item:update', id: 'i1', field, value: 'v' }, ctx(pool));
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(`SET ${field}=`),
      expect.arrayContaining(['v', 'i1', 'g1']),
    );
  });

  it.each(FORBIDDEN)('блокирует поле "%s"', async (field) => {
    const pool = makePool();
    await dispatchMessage({ type: 'item:update', id: 'i1', field, value: 'evil' }, ctx(pool));
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('SET '))).toBe(false);
  });
});

// ── item:delete ───────────────────────────────────────────────────────────────

describe('item:delete', () => {
  it('удаляет позицию только своей группы', async () => {
    const pool = makePool();
    await dispatchMessage({ type: 'item:delete', id: 'item42' }, ctx(pool));

    const delCall = pool.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM items'));
    const [, params] = delCall;
    expect(params).toEqual(['item42', 'g1']);
  });
});

describe('завершённое событие', () => {
  it('item:add — не создаёт позицию', async () => {
    const pool = makeLockedPool();
    await dispatchMessage(
      { type: 'item:add', catId: 'food', name: 'Хлеб', eventId: 'evt1' },
      ctx(pool),
    );
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO items'))).toBe(false);
  });

  it('item:update — не меняет позицию', async () => {
    const pool = makeLockedPool();
    await dispatchMessage({ type: 'item:update', id: 'i1', field: 'price', value: 100 }, ctx(pool));
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('UPDATE items SET'))).toBe(false);
  });

  it('item:delete — не удаляет позицию', async () => {
    const pool = makeLockedPool();
    await dispatchMessage({ type: 'item:delete', id: 'i1' }, ctx(pool));
    expect(pool.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM items'))).toBe(false);
  });
});
