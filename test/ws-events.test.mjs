/**
 * Тесты бизнес-правил для event:* сообщений (ws.js → dispatchMessage).
 * Используют mock-pool — без реальной БД.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { dispatchMessage } = require('../lib/ws.js');

// ── helpers ───────────────────────────────────────────────────────────────────

function makePool(queryImpl) {
  return { query: vi.fn().mockImplementation(queryImpl) };
}

const getFullState = async () => ({});
const broadcast   = vi.fn();

function ctx(pool, extra = {}) {
  return { groupId: 'g1', userId: 'u1', pool, getFullState, broadcast, ...extra };
}

/** Пул где текущий пользователь — администратор */
function makeAdminPool(extraHandler) {
  return makePool(async (sql, params) => {
    if (sql.includes('SELECT is_admin')) return { rows: [{ is_admin: true }] };
    return extraHandler ? extraHandler(sql, params) : { rows: [] };
  });
}

/** Пул где текущий пользователь — НЕ администратор */
function makeNonAdminPool() {
  return makePool(async (sql) => {
    if (sql.includes('SELECT is_admin')) return { rows: [{ is_admin: false }] };
    return { rows: [] };
  });
}

beforeEach(() => broadcast.mockClear());

// ── event:add ─────────────────────────────────────────────────────────────────

describe('event:add', () => {
  it('admin: сначала завершает все активные события группы', async () => {
    const calls = [];
    const pool = makeAdminPool((sql) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
    });

    await dispatchMessage({ type: 'event:add', name: 'BBQ' }, ctx(pool));

    const updateCall = calls.find(s => /UPDATE events SET status='completed'/.test(s));
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain("status='active'");
  });

  it('admin: INSERT нового события идёт после UPDATE, статус active', async () => {
    const calls = [];
    const pool = makeAdminPool((sql) => { calls.push(sql.replace(/\s+/g, ' ').trim()); });

    await dispatchMessage({ type: 'event:add', name: 'BBQ', date: '2026-07-01' }, ctx(pool));

    const insertCall = calls.find(s => s.startsWith('INSERT INTO events'));
    expect(insertCall).toBeDefined();
    expect(insertCall).toContain("'active'");
    const updateIdx = calls.findIndex(s => /UPDATE events/.test(s));
    expect(calls.indexOf(insertCall)).toBeGreaterThan(updateIdx);
  });

  it('admin: передаёт name, date, time, location в INSERT', async () => {
    const params = [];
    const pool = makeAdminPool((sql, p) => { if (sql.includes('INSERT INTO events')) params.push(...p); });

    await dispatchMessage(
      { type: 'event:add', name: 'Пикник', date: '2026-08-15', time: '12:00', location: 'Парк' },
      ctx(pool),
    );

    expect(params).toContain('Пикник');
    expect(params).toContain('2026-08-15');
    expect(params).toContain('12:00');
    expect(params).toContain('Парк');
  });

  it('admin: после создания вызывает broadcast со state', async () => {
    const pool = makeAdminPool();
    await dispatchMessage({ type: 'event:add', name: 'X' }, ctx(pool));
    expect(broadcast).toHaveBeenCalledWith('g1', expect.objectContaining({ type: 'state' }));
  });

  it('не-admin: не может создать событие', async () => {
    const pool = makeNonAdminPool();
    await dispatchMessage({ type: 'event:add', name: 'X' }, ctx(pool));

    const insert = pool.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO events'));
    expect(insert).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

// ── event:complete ────────────────────────────────────────────────────────────

describe('event:complete', () => {
  it('admin: делает UPDATE status=completed для нужного события и группы', async () => {
    const queries = [];
    const pool = makeAdminPool((sql, params) => {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    });

    await dispatchMessage({ type: 'event:complete', id: 'evt1' }, ctx(pool));

    const upd = queries.find(q => q.sql.includes('UPDATE events'));
    expect(upd).toBeDefined();
    expect(upd.sql).toContain("status='completed'");
    expect(upd.params).toContain('evt1');
    expect(upd.params).toContain('g1');
  });

  it('admin: не трогает события другой группы', async () => {
    const queries = [];
    const pool = makeAdminPool((sql, params) => { queries.push({ sql, params }); });

    await dispatchMessage({ type: 'event:complete', id: 'evt1' }, ctx(pool));

    const upd = queries.find(q => q.sql.includes('UPDATE events'));
    expect(upd.params).toEqual(['evt1', 'g1']);
  });

  it('не-admin: не может завершить событие', async () => {
    const pool = makeNonAdminPool();
    await dispatchMessage({ type: 'event:complete', id: 'evt1' }, ctx(pool));

    const upd = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE events'));
    expect(upd).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('без userId: не может завершить событие', async () => {
    const pool = makeNonAdminPool();
    await dispatchMessage({ type: 'event:complete', id: 'evt1' }, ctx(pool, { userId: null }));

    const upd = pool.query.mock.calls.find(([sql]) => sql.includes('UPDATE events'));
    expect(upd).toBeUndefined();
  });
});

// ── event:update ──────────────────────────────────────────────────────────────

describe('event:update', () => {
  const ALLOWED = ['name', 'event_date', 'event_time', 'location', 'description'];
  const FORBIDDEN = ['status', 'id', 'group_id', 'created_at', '__proto__'];

  it.each(ALLOWED)('разрешает поле "%s"', async (field) => {
    const pool = makePool(async () => ({ rows: [] }));
    await dispatchMessage({ type: 'event:update', id: 'e1', field, value: 'v' }, ctx(pool));
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(`SET ${field}=`),
      expect.arrayContaining(['v', 'e1', 'g1']),
    );
  });

  it.each(FORBIDDEN)('блокирует поле "%s"', async (field) => {
    const pool = makePool(async () => ({ rows: [] }));
    await dispatchMessage({ type: 'event:update', id: 'e1', field, value: 'v' }, ctx(pool));
    // query не должен быть вызван ни разу
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── event:delete ──────────────────────────────────────────────────────────────

describe('event:delete', () => {
  it('удаляет событие только своей группы', async () => {
    const queries = [];
    const pool = makePool(async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    });

    await dispatchMessage({ type: 'event:delete', id: 'evt9' }, ctx(pool));

    const del = queries.find(q => q.sql.includes('DELETE FROM events'));
    expect(del.params).toEqual(['evt9', 'g1']);
  });
});
