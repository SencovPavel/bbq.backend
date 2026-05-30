/**
 * Тесты validateTelegramInitData и resolveWsJoinIdentity.
 */
import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const BOT_TOKEN = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

const buildInitData = (user, authDate) => {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(authDate));
  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
};

describe('validateTelegramInitData', () => {
  let identity;

  beforeEach(() => {
    process.env.BOT_TOKEN = BOT_TOKEN;
    vi.resetModules();
    identity = require('../lib/identity.js');
  });

  afterEach(() => {
    delete process.env.BOT_TOKEN;
  });

  it('принимает валидный initData', () => {
    const initData = buildInitData(
      { id: 42, first_name: 'Иван', username: 'ivan' },
      Math.floor(Date.now() / 1000),
    );
    const user = identity.validateTelegramInitData(initData);
    expect(user).toEqual({ userId: '42', userName: 'Иван' });
  });

  it('отклоняет подделанный hash', () => {
    const initData = buildInitData({ id: 1, first_name: 'A' }, Math.floor(Date.now() / 1000));
    const tampered = initData.replace(/hash=[^&]+/, 'hash=deadbeef');
    expect(identity.validateTelegramInitData(tampered)).toBeNull();
  });

  it('отклоняет устаревший auth_date', () => {
    const old = Math.floor(Date.now() / 1000) - 86_401;
    const initData = buildInitData({ id: 1, first_name: 'A' }, old);
    expect(identity.validateTelegramInitData(initData)).toBeNull();
  });

  it('отклоняет initData без BOT_TOKEN', () => {
    delete process.env.BOT_TOKEN;
    vi.resetModules();
    identity = require('../lib/identity.js');
    const initData = buildInitData({ id: 1, first_name: 'A' }, Math.floor(Date.now() / 1000));
    expect(identity.validateTelegramInitData(initData)).toBeNull();
  });
});

describe('resolveWsJoinIdentity', () => {
  let identity;

  beforeEach(() => {
    process.env.BOT_TOKEN = BOT_TOKEN;
    vi.resetModules();
    identity = require('../lib/identity.js');
  });

  afterEach(() => {
    delete process.env.BOT_TOKEN;
  });

  it('возвращает TG-пользователя из initData', async () => {
    const initData = buildInitData({ id: 99, first_name: 'TG' }, Math.floor(Date.now() / 1000));
    const user = await identity.resolveWsJoinIdentity(null, initData);
    expect(user?.userId).toBe('99');
    expect(user?.source).toBe('telegram');
  });
});
