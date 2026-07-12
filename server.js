require('dotenv').config();
const http = require('http');
const { WebSocketServer } = require('ws');

const { pool }          = require('./lib/db');
const { broadcast, createWsHandler } = require('./lib/ws');
const { handleRequest } = require('./lib/router');
const { setWebhook }              = require('./lib/bot');
const { setWebhook: setMaxWebhook } = require('./lib/bot-max');
const { logWebhookConfigWarnings } = require('./lib/webhook-auth');
const { checkEventReminders }     = require('./lib/reminders');

const REMINDER_INTERVAL_MS = 30 * 60 * 1000;

const PORT = process.env.PORT || 3001;

// wss объявляется до server, чтобы handleRequest мог прочитать wss.clients.size.
// К моменту первого HTTP-запроса wss уже присвоен (listen ещё не вызван).
let wss;

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res, { broadcast, wss });
  } catch (e) {
    console.error('Unhandled request error:', e.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal server error' }));
    }
  }
});

wss = new WebSocketServer({ server });
createWsHandler(wss);

async function start() {
  logWebhookConfigWarnings();

  try {
    await pool.query('SELECT 1');
    console.log('✅ DB connected');
  } catch (e) {
    console.error('❌ DB:', e.message);
    process.exit(1);
  }

  server.listen(PORT, async () => {
    console.log(`🔥 Picnic backend: http://localhost:${PORT}`);
    if (process.env.PUBLIC_URL && process.env.BOT_TOKEN) {
      await setWebhook(process.env.PUBLIC_URL);
    }
    if (process.env.PUBLIC_URL && process.env.MAX_TOKEN) {
      await setMaxWebhook();
    }
    checkEventReminders(pool).catch(e => console.error('[reminders]', e.message));
    setInterval(() => checkEventReminders(pool).catch(e => console.error('[reminders]', e.message)), REMINDER_INTERVAL_MS);
  });
}

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT',  async () => { await pool.end(); process.exit(0); });

start();
