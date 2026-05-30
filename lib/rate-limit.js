/**
 * rate-limit.js — простой in-memory rate limiter (IP / ключ).
 */
const buckets = new Map();

/**
 * @param {string} key
 * @param {{ limit: number, windowMs: number }} opts
 * @returns {boolean} true если запрос разрешён
 */
function checkRateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    buckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > limit) return false;
  return true;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

module.exports = { checkRateLimit, getClientIp };
