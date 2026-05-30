/**
 * cors.js — CORS-заголовки для REST.
 */
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.PUBLIC_URL || 'http://localhost:5173';

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return FRONTEND_URL;
  const allowed = [FRONTEND_URL, process.env.PUBLIC_URL].filter(Boolean);
  if (allowed.includes(origin)) return origin;
  if (process.env.NODE_ENV !== 'production' && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    return origin;
  }
  return FRONTEND_URL;
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

function baseHeaders(req) {
  return {
    ...securityHeaders(),
    'Access-Control-Allow-Origin': getAllowedOrigin(req),
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json',
  };
}

function preflightHeaders(req) {
  return {
    ...baseHeaders(req),
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, X-Telegram-Init-Data`,
  };
}

module.exports = { baseHeaders, preflightHeaders, securityHeaders, FRONTEND_URL };
