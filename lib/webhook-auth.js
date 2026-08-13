/**
 * webhook-auth.js — проверка секретов входящих вебхуков.
 */

const crypto = require('crypto');

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Постоянное по времени сравнение строк (защита от timing-атак).
 * Выравнивает длину, чтобы crypto.timingSafeEqual не бросал и не давал раннего выхода по длине.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Сравниваем буфер с самим собой, чтобы затратить сопоставимое время, и всё равно возвращаем false.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {{ envVar: string, header: string, label: string, requiredInProduction?: boolean }} opts
 * @returns {{ ok: true } | { ok: false, statusCode: number, reason: string }}
 */
function verifyWebhookSecret(req, { envVar, header, label, requiredInProduction = true }) {
  const secret = process.env[envVar];

  if (isProduction() && requiredInProduction && !secret) {
    return { ok: false, statusCode: 503, reason: `${label}: ${envVar} required in production` };
  }

  if (!secret) {
    return { ok: true };
  }

  const received = req.headers[header] ?? req.headers[header.toLowerCase()];
  if (!safeEqual(received, secret)) {
    return { ok: false, statusCode: 403, reason: 'forbidden' };
  }

  return { ok: true };
}

/**
 * Предупреждения при старте (fail-closed в runtime, не exit).
 */
function logWebhookConfigWarnings() {
  if (!isProduction()) return;

  if (!process.env.TG_WEBHOOK_SECRET) {
    console.error('❌ TG_WEBHOOK_SECRET не задан — /tg-webhook отклоняет запросы в production');
  }
  if (process.env.MAX_TOKEN && !process.env.MAX_WEBHOOK_SECRET) {
    console.error('❌ MAX_WEBHOOK_SECRET не задан при MAX_TOKEN — /max-webhook отклоняет запросы в production');
  }
}

module.exports = { verifyWebhookSecret, logWebhookConfigWarnings };
