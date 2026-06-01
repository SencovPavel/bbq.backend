'use strict';

/**
 * detectPlatform — определяет платформу по заголовкам запроса.
 * @param {import('http').IncomingMessage} req
 * @returns {'telegram' | 'max' | 'web'}
 */
function detectPlatform(req) {
  if (req?.headers?.['x-telegram-init-data']) return 'telegram';
  const ua = req?.headers?.['user-agent'] ?? '';
  if (/\bMAX\b/i.test(ua)) return 'max';
  return 'web';
}

/**
 * Записывает аналитическое событие. Никогда не бросает исключений
 * и не блокирует основной поток запроса.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   type: string,
 *   userId?: string | null,
 *   groupId?: string | null,
 *   platform?: string | null,
 *   meta?: Record<string, unknown>
 * }} opts
 */
async function trackEvent(pool, { type, userId = null, groupId = null, platform = null, meta = {} }) {
  try {
    await pool.query(
      `INSERT INTO analytics_events(type, user_id, group_id, platform, meta)
       VALUES($1,$2,$3,$4,$5)`,
      [type, userId || null, groupId || null, platform || null, meta],
    );
  } catch (e) {
    // Аналитика не должна ломать основную логику
    console.error('[analytics] track error:', type, e.message);
  }
}

module.exports = { trackEvent, detectPlatform };
