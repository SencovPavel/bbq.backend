/**
 * http-body.js — чтение тела HTTP-запроса с лимитом размера.
 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

class BodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
    this.statusCode = 413;
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
function readRawBody(req, maxBytes = DEFAULT_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (typeof req.destroy === 'function') req.destroy();
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    req.on('error', reject);
  });
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJsonBody(req, maxBytes) {
  const raw = await readRawBody(req, maxBytes);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBytes]
 */
async function readFormBody(req, maxBytes) {
  const raw = await readRawBody(req, maxBytes);
  const obj = {};
  const p = new URLSearchParams(raw);
  for (const [k, v] of p) obj[k] = v;
  return obj;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  BodyTooLargeError,
  readRawBody,
  readJsonBody,
  readFormBody,
};
