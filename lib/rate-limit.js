/**
 * rate-limit.js — rate limiter (in-memory или Redis при REDIS_URL).
 */
const buckets = new Map();

/** @type {import('ioredis').Redis | null} */
let redis = null;

const initRateLimitStore = () => {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    const Redis = require('ioredis');
    redis = new Redis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    redis.on('error', (e) => {
      console.warn('[rate-limit] Redis error:', e.message);
    });
    redis.on('connect', () => {
      console.log('✅ Redis rate-limit connected');
    });
  } catch {
    console.warn('[rate-limit] REDIS_URL задан, но ioredis не установлен — in-memory');
  }
};

initRateLimitStore();

/**
 * @param {string} key
 * @param {{ limit: number, windowMs: number }} opts
 * @returns {Promise<boolean>} true если запрос разрешён
 */
const checkRateLimitMemory = (key, { limit, windowMs }) => {
  const now = Date.now();
  let entry = buckets.get(key);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 0 };
    buckets.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= limit;
};

/**
 * @param {string} key
 * @param {{ limit: number, windowMs: number }} opts
 * @returns {Promise<boolean>}
 */
const checkRateLimitRedis = async (key, { limit, windowMs }) => {
  const fullKey = `rl:${key}`;
  const count = await redis.incr(fullKey);
  if (count === 1) {
    await redis.pexpire(fullKey, windowMs);
  }
  return count <= limit;
};

/**
 * @param {string} key
 * @param {{ limit: number, windowMs: number }} opts
 * @returns {Promise<boolean>}
 */
async function checkRateLimit(key, opts) {
  if (redis) {
    try {
      return await checkRateLimitRedis(key, opts);
    } catch (e) {
      console.warn('[rate-limit] fallback in-memory:', e.message);
    }
  }
  return checkRateLimitMemory(key, opts);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function getClientIp(req) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

module.exports = { checkRateLimit, getClientIp, initRateLimitStore };
