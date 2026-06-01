'use strict';

/**
 * router.js — HTTP dispatcher.
 *
 * Each entry in ROUTES is:
 *   { method, path, handler }
 *
 * `path` may be a string (exact match) or a RegExp.
 * For RegExp paths with named groups, capture groups are passed as `params`.
 */

const { baseHeaders, preflightHeaders } = require('./cors');

const { health }                        = require('./controllers/health');
const { tgWebhook, maxWebhook }         = require('./controllers/webhooks');
const { getUserGroups }                 = require('./controllers/users');
const { createGroup, joinGroup, joinGroupById } = require('./controllers/groups');
const { analyzeAgent }                  = require('./controllers/agent');
const {
  listFamilyMembers, addFamilyMember, updateFamilyMember,
  deleteFamilyMember, setFamilyMemberGroup,
}                                       = require('./controllers/family');
const {
  statsOverview, statsGroups, statsActivity, statsTechnical,
}                                       = require('./controllers/admin');
const {
  startYandex, yandexCallback,
  startApple, appleCallback,
  register, devLogin, login, logout, me,
} = require('./controllers/auth');

// ── Route table ───────────────────────────────────────────────────────────────

const ROUTES = [
  { method: 'GET',  path: '/health',                  handler: health },

  { method: 'POST', path: '/tg-webhook',              handler: tgWebhook },
  { method: 'POST', path: '/max-webhook',             handler: maxWebhook },

  { method: 'GET',  path: /^\/users\/(?<userId>[^/]+)\/groups$/, handler: getUserGroups },

  { method: 'POST', path: '/groups',                  handler: createGroup },
  { method: 'POST', path: '/groups/join',             handler: joinGroup },
  { method: 'POST', path: '/groups/join-by-id',       handler: joinGroupById },

  { method: 'POST', path: '/agent/analyze',           handler: analyzeAgent },

  { method: 'GET',    path: '/family/members',                                               handler: listFamilyMembers },
  { method: 'POST',   path: '/family/members',                                               handler: addFamilyMember },
  { method: 'PUT',    path: /^\/family\/members\/(?<id>[^/]+)$/,                             handler: updateFamilyMember },
  { method: 'DELETE', path: /^\/family\/members\/(?<id>[^/]+)$/,                             handler: deleteFamilyMember },
  { method: 'POST',   path: /^\/family\/members\/(?<id>[^/]+)\/groups$/,                     handler: setFamilyMemberGroup },

  { method: 'GET',  path: '/auth/yandex',             handler: startYandex },
  { method: 'GET',  path: '/auth/yandex/callback',    handler: yandexCallback },
  { method: 'GET',  path: '/auth/apple',              handler: startApple },
  { method: 'POST', path: '/auth/apple/callback',     handler: appleCallback },
  { method: 'POST', path: '/auth/register',           handler: register },
  { method: 'POST', path: '/auth/dev-login',          handler: devLogin },
  { method: 'POST', path: '/auth/login',              handler: login },
  { method: 'POST', path: '/auth/logout',             handler: logout },
  { method: 'GET',  path: '/auth/me',                 handler: me },

  { method: 'GET',  path: '/admin/stats/overview',    handler: statsOverview },
  { method: 'GET',  path: '/admin/stats/groups',      handler: statsGroups },
  { method: 'GET',  path: '/admin/stats/activity',    handler: statsActivity },
  { method: 'GET',  path: '/admin/stats/technical',   handler: statsTechnical },
];

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 * @param {{ broadcast: Function, wss: import('ws').WebSocketServer }} ctx
 */
async function handleRequest(req, res, { broadcast, wss }) {
  const url = new URL(req.url, 'http://localhost');
  const H   = baseHeaders(req);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, preflightHeaders(req));
    res.end();
    return;
  }

  // Route matching
  for (const route of ROUTES) {
    if (route.method !== req.method) continue;

    let params = {};
    if (typeof route.path === 'string') {
      if (route.path !== url.pathname) continue;
    } else {
      // RegExp path
      const m = url.pathname.match(route.path);
      if (!m) continue;
      params = m.groups ?? {};
    }

    await route.handler(req, res, { H, url, params, broadcast, wss });
    return;
  }

  // 404
  res.writeHead(404, H);
  res.end(JSON.stringify({ error: 'not found' }));
}

module.exports = { handleRequest };
