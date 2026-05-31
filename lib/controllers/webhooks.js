'use strict';

const { pool }               = require('../db');
const { verifyWebhookSecret } = require('../webhook-auth');
const { handleUpdate }       = require('../bot');
const { handleUpdate: handleMaxUpdate } = require('../bot-max');
const { readBodySafe }       = require('../request-helpers');

async function tgWebhook(req, res, { H, broadcast }) {
  const check = verifyWebhookSecret(req, {
    envVar: 'TG_WEBHOOK_SECRET',
    header: 'x-telegram-bot-api-secret-token',
    label: 'Telegram webhook',
  });
  if (!check.ok) {
    res.writeHead(check.statusCode, H);
    res.end(JSON.stringify({ error: check.reason }));
    return;
  }
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  res.writeHead(200, H);
  res.end('{}');
  handleUpdate(body, pool, broadcast).catch(e => console.error('tg-bot:', e.message));
}

async function maxWebhook(req, res, { H }) {
  const check = verifyWebhookSecret(req, {
    envVar: 'MAX_WEBHOOK_SECRET',
    header: 'x-max-bot-api-secret',
    label: 'MAX webhook',
    requiredInProduction: !!process.env.MAX_TOKEN,
  });
  if (!check.ok) {
    res.writeHead(check.statusCode, H);
    res.end(JSON.stringify({ error: check.reason }));
    return;
  }
  const body = await readBodySafe(req, res, H);
  if (body === null) return;
  res.writeHead(200, H);
  res.end('{}');
  handleMaxUpdate(body).catch(e => console.error('max-bot:', e.message));
}

module.exports = { tgWebhook, maxWebhook };
