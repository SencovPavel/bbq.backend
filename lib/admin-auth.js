'use strict';

const { pool }        = require('./db');
const { requireUser } = require('./request-helpers');

/**
 * Проверяет, что запрос выполнен аутентифицированным суперадмином.
 * Отправляет 401/403 и возвращает null при провале.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse}  res
 * @returns {Promise<{ user: { userId: string; userName: string }, H: Record<string, string> } | null>}
 */
async function requireAdmin(req, res) {
  const auth = await requireUser(req, res);
  if (!auth) return null;

  const { user, H } = auth;
  const { rows } = await pool.query(
    'SELECT is_superadmin FROM users WHERE id=$1',
    [user.userId],
  );

  if (!rows[0]?.is_superadmin) {
    res.writeHead(403, H);
    res.end(JSON.stringify({ error: 'forbidden' }));
    return null;
  }

  return auth;
}

module.exports = { requireAdmin };
