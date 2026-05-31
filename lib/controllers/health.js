'use strict';

async function health(req, res, { H, wss }) {
  const payload = process.env.HEALTH_VERBOSE === 'true'
    ? { ok: true, clients: wss.clients.size, uptime: Math.round(process.uptime()) }
    : { ok: true };
  res.writeHead(200, H);
  res.end(JSON.stringify(payload));
}

module.exports = { health };
