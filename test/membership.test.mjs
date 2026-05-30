/**
 * Тесты assertGroupMember / isGroupMember.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isGroupMember, assertGroupMember } = require('../lib/membership.js');

const queryMock = vi.fn();
const fakePool = { query: (...args) => queryMock(...args) };

describe('membership', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('isGroupMember возвращает true при наличии строки', async () => {
    queryMock.mockResolvedValue({ rows: [{ ok: 1 }] });
    await expect(isGroupMember('g1', 'u1', fakePool)).resolves.toBe(true);
  });

  it('isGroupMember возвращает false без строки', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(isGroupMember('g1', 'u1', fakePool)).resolves.toBe(false);
  });

  it('assertGroupMember возвращает false при отсутствии членства', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(assertGroupMember('g1', 'u1', fakePool)).resolves.toBe(false);
  });
});
