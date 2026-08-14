/**
 * Тесты бизнес-правил для cat:* сообщений (ws.js → dispatchMessage).
 * Ключевое правило: менять категории может только admin, отказ → error-фрейм forbidden.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

import { memberRowHandler, findSqlCall } from './pool-helpers.mjs';

const require = createRequire(import.meta.url);
const { dispatchMessage } = require('../lib/ws.js');

const getFullState = async () => ({});
const broadcast   = vi.fn();

/** Мок-сокет: собирает распарсенные фреймы, отправленные клиенту */
function makeWs() {
  const frames = [];
  return { frames, send: vi.fn((raw) => frames.push(JSON.parse(raw))) };
}

function makePool(handler) {
  return { query: vi.fn().mockImplementation(memberRowHandler(handler)) };
}

function adminPool(handler) {
  return makePool(async (sql, params) => {
    if (sql.includes('SELECT is_admin')) return { rows: [{ is_admin: true }] };
    if (sql.includes('COALESCE(MAX(position)')) return { rows: [{ p: 7 }] };
    return handler ? handler(sql, params) : { rows: [] };
  });
}

function nonAdminPool() {
  return makePool(async (sql) => {
    if (sql.includes('SELECT is_admin')) return { rows: [{ is_admin: false }] };
    return { rows: [] };
  });
}

function ctx(pool, extra = {}) {
  return { groupId: 'g1', userId: 'u1', pool, getFullState, broadcast, ...extra };
}

beforeEach(() => broadcast.mockClear());

// ── cat:add ───────────────────────────────────────────────────────────────────

describe('cat:add', () => {
  it('admin: вставляет категорию с позицией из MAX(position)+1', async () => {
    const pool = adminPool();
    await dispatchMessage({ type: 'cat:add', title: 'Десерты', icon: '🍰' }, ctx(pool));

    const ins = findSqlCall(pool, 'INSERT INTO categories');
    expect(ins).toBeDefined();
    const [, params] = ins;
    expect(params[1]).toBe('g1');
    expect(params[2]).toBe('Десерты');
    expect(params[3]).toBe('🍰');
    expect(params[4]).toBe(7);
  });

  it('admin: иконка по умолчанию — 📦', async () => {
    const pool = adminPool();
    await dispatchMessage({ type: 'cat:add', title: 'Разное' }, ctx(pool));

    const [, params] = findSqlCall(pool, 'INSERT INTO categories');
    expect(params[3]).toBe('📦');
  });

  it('admin: после создания вызывает broadcast со state', async () => {
    const pool = adminPool();
    await dispatchMessage({ type: 'cat:add', title: 'X' }, ctx(pool));
    expect(broadcast).toHaveBeenCalledWith('g1', expect.objectContaining({ type: 'state' }));
  });

  it('не-admin: не создаёт категорию и получает forbidden', async () => {
    const pool = nonAdminPool();
    const ws = makeWs();
    await dispatchMessage({ type: 'cat:add', title: 'X' }, ctx(pool, { senderWs: ws }));

    expect(findSqlCall(pool, 'INSERT INTO categories')).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.frames).toEqual([{ type: 'error', code: 'forbidden' }]);
  });

  it('не-admin без senderWs: просто ничего не делает', async () => {
    const pool = nonAdminPool();
    await dispatchMessage({ type: 'cat:add', title: 'X' }, ctx(pool));
    expect(findSqlCall(pool, 'INSERT INTO categories')).toBeUndefined();
  });
});

// ── cat:delete ────────────────────────────────────────────────────────────────

describe('cat:delete', () => {
  it('admin: удаляет позиции категории до самой категории', async () => {
    const calls = [];
    const pool = adminPool((sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: [] };
    });

    await dispatchMessage({ type: 'cat:delete', id: 'c9' }, ctx(pool));

    const itemsIdx = calls.findIndex(c => c.sql.includes('DELETE FROM items'));
    const catsIdx  = calls.findIndex(c => c.sql.includes('DELETE FROM categories'));
    expect(itemsIdx).toBeGreaterThanOrEqual(0);
    expect(catsIdx).toBeGreaterThan(itemsIdx);
    expect(calls[itemsIdx].params).toEqual(['c9', 'g1']);
    expect(calls[catsIdx].params).toEqual(['c9', 'g1']);
  });

  it('admin: после удаления вызывает broadcast со state', async () => {
    const pool = adminPool();
    await dispatchMessage({ type: 'cat:delete', id: 'c9' }, ctx(pool));
    expect(broadcast).toHaveBeenCalledWith('g1', expect.objectContaining({ type: 'state' }));
  });

  it('не-admin: не удаляет ничего и получает forbidden', async () => {
    const pool = nonAdminPool();
    const ws = makeWs();
    await dispatchMessage({ type: 'cat:delete', id: 'c9' }, ctx(pool, { senderWs: ws }));

    expect(findSqlCall(pool, 'DELETE FROM')).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
    expect(ws.frames).toEqual([{ type: 'error', code: 'forbidden' }]);
  });
});
