/**
 * Тесты бизнес-правил для member:* сообщений.
 * Ключевые правила: только admin может кикать/повышать/понижать,
 * нельзя кикнуть себя, нельзя понизить последнего admin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { dispatchMessage } = require('../lib/ws.js');

const getFullState = async () => ({});
const broadcast   = vi.fn();

function ctx(pool, userId = 'admin1', extra = {}) {
  return { groupId: 'g1', userId, pool, getFullState, broadcast, ...extra };
}

/** Мок-сокет: собирает распарсенные фреймы, отправленные клиенту */
function makeWs() {
  const frames = [];
  return { frames, send: vi.fn((raw) => frames.push(JSON.parse(raw))) };
}

beforeEach(() => broadcast.mockClear());

// ── helpers ───────────────────────────────────────────────────────────────────

/** Возвращает pool, в котором текущий пользователь — администратор */
function adminPool(adminCount = 2) {
  return {
    query: vi.fn().mockImplementation(async (sql) => {
      if (sql.includes('FROM group_members') && sql.includes('SELECT 1')) {
        return { rows: [{ ok: 1 }] };
      }
      if (sql.includes('SELECT is_admin')) return { rows: [{ is_admin: true }] };
      if (sql.includes('COUNT(*)'))        return { rows: [{ cnt: String(adminCount) }] };
      return { rows: [] };
    }),
  };
}

/** Возвращает pool, в котором userId — НЕ администратор */
function nonAdminPool() {
  return {
    query: vi.fn().mockImplementation(async (sql) => {
      if (sql.includes('FROM group_members') && sql.includes('SELECT 1')) {
        return { rows: [{ ok: 1 }] };
      }
      if (sql.includes('SELECT is_admin')) return { rows: [{ is_admin: false }] };
      return { rows: [] };
    }),
  };
}

// ── member:remove ─────────────────────────────────────────────────────────────

describe('member:remove', () => {
  it('admin может удалить другого участника', async () => {
    const pool = adminPool();
    await dispatchMessage({ type: 'member:remove', userId: 'user2' }, ctx(pool, 'admin1'));

    const delCall = pool.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM group_members'));
    expect(delCall).toBeDefined();
    expect(delCall[1]).toEqual(['g1', 'user2']);
  });

  it('не-admin не может удалить участника и получает forbidden', async () => {
    const pool = nonAdminPool();
    const ws = makeWs();
    await dispatchMessage({ type: 'member:remove', userId: 'user2' }, ctx(pool, 'user3', { senderWs: ws }));

    const delCall = pool.query.mock.calls.find(([sql]) => sql.includes('DELETE'));
    expect(delCall).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.frames).toEqual([{ type: 'error', code: 'forbidden' }]);
  });

  it('нельзя удалить самого себя через member:remove', async () => {
    const pool = adminPool();
    await dispatchMessage({ type: 'member:remove', userId: 'admin1' }, ctx(pool, 'admin1'));

    const delCall = pool.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM group_members'));
    expect(delCall).toBeUndefined();
  });
});

// ── member:leave ──────────────────────────────────────────────────────────────

describe('member:leave', () => {
  it('пользователь может покинуть группу сам', async () => {
    const pool = {
      query: vi.fn().mockImplementation(async (sql) => {
        if (typeof sql === 'string' && sql.includes('FROM group_members') && sql.includes('SELECT 1')) {
          return { rows: [{ ok: 1 }] };
        }
        return { rows: [] };
      }),
    };
    await dispatchMessage({ type: 'member:leave' }, ctx(pool, 'user5'));

    const delCall = pool.query.mock.calls.find(([sql]) => sql.includes('DELETE FROM group_members'));
    expect(delCall).toBeDefined();
    expect(delCall[1]).toEqual(['g1', 'user5']);
  });

  it('не выполняется если userId не задан', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await dispatchMessage({ type: 'member:leave' }, ctx(pool, null));

    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ── member:promote ────────────────────────────────────────────────────────────

describe('member:promote', () => {
  it('admin может повысить другого участника', async () => {
    const pool = adminPool();
    await dispatchMessage({ type: 'member:promote', userId: 'user2' }, ctx(pool, 'admin1'));

    const upd = pool.query.mock.calls.find(([sql]) => sql.includes('SET is_admin=TRUE'));
    expect(upd).toBeDefined();
    expect(upd[1]).toEqual(['g1', 'user2']);
  });

  it('не-admin не может повысить участника и получает forbidden', async () => {
    const pool = nonAdminPool();
    const ws = makeWs();
    await dispatchMessage({ type: 'member:promote', userId: 'user2' }, ctx(pool, 'user3', { senderWs: ws }));

    const upd = pool.query.mock.calls.find(([sql]) => sql.includes('SET is_admin'));
    expect(upd).toBeUndefined();
    expect(ws.frames).toEqual([{ type: 'error', code: 'forbidden' }]);
  });
});

// ── member:demote ─────────────────────────────────────────────────────────────

describe('member:demote', () => {
  it('admin может понизить другого admin если их несколько', async () => {
    const pool = adminPool(2); // 2 admin'а
    await dispatchMessage({ type: 'member:demote', userId: 'admin2' }, ctx(pool, 'admin1'));

    const upd = pool.query.mock.calls.find(([sql]) => sql.includes('SET is_admin=FALSE'));
    expect(upd).toBeDefined();
    expect(upd[1]).toEqual(['g1', 'admin2']);
  });

  it('нельзя понизить последнего admin (cnt=1)', async () => {
    const pool = adminPool(1); // только 1 admin
    await dispatchMessage({ type: 'member:demote', userId: 'admin1' }, ctx(pool, 'admin1'));

    const upd = pool.query.mock.calls.find(([sql]) => sql.includes('SET is_admin=FALSE'));
    expect(upd).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('не-admin не может понизить кого-либо и получает forbidden', async () => {
    const pool = nonAdminPool();
    const ws = makeWs();
    await dispatchMessage({ type: 'member:demote', userId: 'admin1' }, ctx(pool, 'user9', { senderWs: ws }));

    const upd = pool.query.mock.calls.find(([sql]) => sql.includes('SET is_admin'));
    expect(upd).toBeUndefined();
    expect(ws.frames).toEqual([{ type: 'error', code: 'forbidden' }]);
  });
});
