/**
 * Тесты verifyWebhookSecret.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { verifyWebhookSecret } from '../lib/webhook-auth.js';

describe('verifyWebhookSecret', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it('в production без секрета возвращает 503', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.TG_WEBHOOK_SECRET;
    const req = { headers: {} };
    const r = verifyWebhookSecret(req, {
      envVar: 'TG_WEBHOOK_SECRET',
      header: 'x-telegram-bot-api-secret-token',
      label: 'TG',
    });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(503);
  });

  it('при неверном заголовке возвращает 403', () => {
    process.env.NODE_ENV = 'production';
    process.env.TG_WEBHOOK_SECRET = 'secret123';
    const req = { headers: { 'x-telegram-bot-api-secret-token': 'wrong' } };
    const r = verifyWebhookSecret(req, {
      envVar: 'TG_WEBHOOK_SECRET',
      header: 'x-telegram-bot-api-secret-token',
      label: 'TG',
    });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(403);
  });

  it('принимает верный секрет', () => {
    process.env.NODE_ENV = 'production';
    process.env.TG_WEBHOOK_SECRET = 'secret123';
    const req = { headers: { 'x-telegram-bot-api-secret-token': 'secret123' } };
    const r = verifyWebhookSecret(req, {
      envVar: 'TG_WEBHOOK_SECRET',
      header: 'x-telegram-bot-api-secret-token',
      label: 'TG',
    });
    expect(r.ok).toBe(true);
  });

  it('MAX не обязателен без MAX_TOKEN', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MAX_TOKEN;
    delete process.env.MAX_WEBHOOK_SECRET;
    const req = { headers: {} };
    const r = verifyWebhookSecret(req, {
      envVar: 'MAX_WEBHOOK_SECRET',
      header: 'x-max-bot-api-secret',
      label: 'MAX',
      requiredInProduction: false,
    });
    expect(r.ok).toBe(true);
  });
});
