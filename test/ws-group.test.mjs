/**
 * Тесты бизнес-правил для group:* сообщений (ws.js → dispatchMessage).
 * Ключевое правило: и смена эмодзи, и удаление группы доступны только admin,
 * отказ по правам → error-фрейм forbidden.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

import { memberRowHandler, findSqlCall } from './pool-helpers.mjs';

const require = createRequire(import.meta.url);
const { dispatchMessage } = require('../lib/ws.js');

const getFullState = async () => ({});
const broadcast   = vi.fn();

function makeWs() {
  const frames = [];
  return { frames, send: vi.fn((raw) => frames.push(JSON.parse(raw))) };
}

function makePool(isAdminValue) {
  return {
    query: vi.fn().mockImplementation(memberRowHandler(async (sql) => {
      if (sql.includes('SELECT is_admin')) return { rows: [{ is_admin: isAdminValue }] };
      return { rows: [] };
    })),
  };
}

function ctx(pool, extra = {}) {
  return { groupId: 'g1', userId: 'u1', pool, getFullState, broadcast, ...extra };
}

beforeEach(() => broadcast.mockClear());

// ── group:set-emoji ───────────────────────────────────────────────────────────

describe('group:set-emoji', () => {
  it('admin: сохраняет эмодзи для своей группы', async () => {
    const pool = makePool(true);
    await dispatchMessage({ type: 'group:set-emoji', emoji: '🔥' }, ctx(pool));

    const upd = findSqlCall(pool, 'UPDATE picnic_groups SET emoji');
    expect(upd).toBeDefined();
    expect(upd[1]).toEqual(['🔥', 'g1']);
  });

  it('admin: обрезает пробелы вокруг эмодзи', async () => {
    const pool = makePool(true);
    await dispatchMessage({ type: 'group:set-emoji', emoji: '  🎉  ' }, ctx(pool));

    expect(findSqlCall(pool, 'UPDATE picnic_groups SET emoji')[1][0]).toBe('🎉');
  });

  it('admin: ограничивает длину 8 символами', async () => {
    const pool = makePool(true);
    await dispatchMessage({ type: 'group:set-emoji', emoji: 'abcdefghijkl' }, ctx(pool));

    expect(findSqlCall(pool, 'UPDATE picnic_groups SET emoji')[1][0]).toBe('abcdefgh');
  });

  it.each([
    ['пустая строка', ''],
    ['только пробелы', '   '],
    ['null', null],
    ['не строка', 42],
  ])('admin: %s → сброс в null', async (_label, emoji) => {
    const pool = makePool(true);
    await dispatchMessage({ type: 'group:set-emoji', emoji }, ctx(pool));

    expect(findSqlCall(pool, 'UPDATE picnic_groups SET emoji')[1][0]).toBeNull();
  });

  it('admin: после изменения вызывает broadcast со state', async () => {
    const pool = makePool(true);
    await dispatchMessage({ type: 'group:set-emoji', emoji: '🔥' }, ctx(pool));
    expect(broadcast).toHaveBeenCalledWith('g1', expect.objectContaining({ type: 'state' }));
  });

  it('не-admin: не меняет эмодзи и получает forbidden', async () => {
    const pool = makePool(false);
    const ws = makeWs();
    await dispatchMessage({ type: 'group:set-emoji', emoji: '🔥' }, ctx(pool, { senderWs: ws }));

    expect(findSqlCall(pool, 'UPDATE picnic_groups')).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.frames).toEqual([{ type: 'error', code: 'forbidden' }]);
  });
});

// ── group:delete ──────────────────────────────────────────────────────────────

describe('group:delete', () => {
  it('admin: сообщает комнате group:deleted до удаления', async () => {
    const order = [];
    const pool = {
      query: vi.fn().mockImplementation(memberRowHandler(async (sql) => {
        if (sql.includes('SELECT is_admin')) return { rows: [{ is_admin: true }] };
        if (sql.includes('DELETE FROM picnic_groups')) order.push('delete');
        return { rows: [] };
      })),
    };
    broadcast.mockImplementation(() => order.push('broadcast'));

    await dispatchMessage({ type: 'group:delete' }, ctx(pool));
    broadcast.mockImplementation(() => {});

    expect(broadcast).toHaveBeenCalledWith('g1', { type: 'group:deleted' });
    expect(order).toEqual(['broadcast', 'delete']);
  });

  it('admin: удаляет именно свою группу', async () => {
    const pool = makePool(true);
    await dispatchMessage({ type: 'group:delete' }, ctx(pool));

    const del = findSqlCall(pool, 'DELETE FROM picnic_groups');
    expect(del).toBeDefined();
    expect(del[1]).toEqual(['g1']);
  });

  it('не-admin: не удаляет группу и получает forbidden', async () => {
    const pool = makePool(false);
    const ws = makeWs();
    await dispatchMessage({ type: 'group:delete' }, ctx(pool, { senderWs: ws }));

    expect(findSqlCall(pool, 'DELETE FROM picnic_groups')).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.frames).toEqual([{ type: 'error', code: 'forbidden' }]);
  });
});
