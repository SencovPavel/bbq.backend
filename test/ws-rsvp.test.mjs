/**
 * Тесты бизнес-правил для event:rsvp и family:rsvp (ws.js → dispatchMessage).
 * Права admin здесь не нужны — любой участник отмечает себя и своих домочадцев.
 * Ключевые правила: событие должно принадлежать группе, family_member — вызывающему.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

import { memberRowHandler, findSqlCall } from './pool-helpers.mjs';

const require = createRequire(import.meta.url);
const { dispatchMessage } = require('../lib/ws.js');

const getFullState = async () => ({});
const broadcast   = vi.fn();

function makePool(handler) {
  return { query: vi.fn().mockImplementation(memberRowHandler(handler)) };
}

function ctx(pool, extra = {}) {
  return { groupId: 'g1', userId: 'u1', pool, getFullState, broadcast, ...extra };
}

/** Пул, где событие принадлежит группе, а family_member — пользователю */
function okPool({ eventFound = true, familyFound = true } = {}) {
  return makePool(async (sql, params) => {
    if (sql.includes('FROM events')) {
      return { rows: eventFound ? [{ id: params[0] }] : [] };
    }
    if (sql.includes('FROM family_members')) {
      return { rows: familyFound ? [{ id: params[0] }] : [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => broadcast.mockClear());

// ── event:rsvp ────────────────────────────────────────────────────────────────

describe('event:rsvp', () => {
  it('attending=true — удаляет отметку «не иду»', async () => {
    const pool = okPool();
    await dispatchMessage({ type: 'event:rsvp', eventId: 'e1', attending: true }, ctx(pool));

    const del = findSqlCall(pool, 'DELETE FROM event_rsvp');
    expect(del).toBeDefined();
    expect(del[1]).toEqual(['e1', 'u1']);
    expect(findSqlCall(pool, 'INSERT INTO event_rsvp')).toBeUndefined();
  });

  it('attending не задан — трактуется как true', async () => {
    const pool = okPool();
    await dispatchMessage({ type: 'event:rsvp', eventId: 'e1' }, ctx(pool));
    expect(findSqlCall(pool, 'DELETE FROM event_rsvp')).toBeDefined();
  });

  it('attending=false — upsert записи «не иду»', async () => {
    const pool = okPool();
    await dispatchMessage({ type: 'event:rsvp', eventId: 'e1', attending: false }, ctx(pool));

    const ins = findSqlCall(pool, 'INSERT INTO event_rsvp');
    expect(ins).toBeDefined();
    expect(ins[0]).toContain('ON CONFLICT');
    expect(ins[1]).toEqual(['e1', 'u1']);
    expect(findSqlCall(pool, 'DELETE FROM event_rsvp')).toBeUndefined();
  });

  it('событие чужой группы — ничего не пишет и не броадкастит', async () => {
    const pool = okPool({ eventFound: false });
    await dispatchMessage({ type: 'event:rsvp', eventId: 'alien', attending: false }, ctx(pool));

    expect(findSqlCall(pool, 'event_rsvp')).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('после изменения вызывает broadcast со state', async () => {
    const pool = okPool();
    await dispatchMessage({ type: 'event:rsvp', eventId: 'e1' }, ctx(pool));
    expect(broadcast).toHaveBeenCalledWith('g1', expect.objectContaining({ type: 'state' }));
  });
});

// ── family:rsvp ───────────────────────────────────────────────────────────────

describe('family:rsvp', () => {
  it('upsert с attending=true для своего члена семьи', async () => {
    const pool = okPool();
    await dispatchMessage(
      { type: 'family:rsvp', familyMemberId: 'fm1', eventId: 'e1', attending: true },
      ctx(pool),
    );

    const ins = findSqlCall(pool, 'INSERT INTO family_member_rsvp');
    expect(ins).toBeDefined();
    expect(ins[0]).toContain('ON CONFLICT');
    expect(ins[1]).toEqual(['fm1', 'e1', true]);
  });

  it('attending не задан — трактуется как true', async () => {
    const pool = okPool();
    await dispatchMessage({ type: 'family:rsvp', familyMemberId: 'fm1', eventId: 'e1' }, ctx(pool));

    const ins = findSqlCall(pool, 'INSERT INTO family_member_rsvp');
    expect(ins[1]).toEqual(['fm1', 'e1', true]);
  });

  it('attending=false пишется как есть', async () => {
    const pool = okPool();
    await dispatchMessage(
      { type: 'family:rsvp', familyMemberId: 'fm1', eventId: 'e1', attending: false },
      ctx(pool),
    );

    const ins = findSqlCall(pool, 'INSERT INTO family_member_rsvp');
    expect(ins[1]).toEqual(['fm1', 'e1', false]);
  });

  it('чужой член семьи — отказ, событие даже не проверяется', async () => {
    const pool = okPool({ familyFound: false });
    await dispatchMessage(
      { type: 'family:rsvp', familyMemberId: 'alien', eventId: 'e1' },
      ctx(pool),
    );

    expect(findSqlCall(pool, 'INSERT INTO family_member_rsvp')).toBeUndefined();
    expect(findSqlCall(pool, 'FROM events')).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('событие чужой группы — отказ', async () => {
    const pool = okPool({ eventFound: false });
    await dispatchMessage(
      { type: 'family:rsvp', familyMemberId: 'fm1', eventId: 'alien' },
      ctx(pool),
    );

    expect(findSqlCall(pool, 'INSERT INTO family_member_rsvp')).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
