/**
 * webhook-auth.js — проверка секретов входящих вебхуков.
 */

const isProduction = () => process.env.NODE_ENV === 'production';

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
  if (received !== secret) {
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
