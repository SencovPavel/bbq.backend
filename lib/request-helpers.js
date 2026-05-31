'use strict';

const { readJsonBody: readBody, readFormBody, BodyTooLargeError } = require('./http-body');
const { resolveRequestUser } = require('./identity');
const { baseHeaders } = require('./cors');

/**
 * Resolves the authenticated user from a request.
 * Sends 401 and returns null if not authenticated.
 */
async function requireUser(req, res, initDataExtra) {
  const H = baseHeaders(req);
  const user = await resolveRequestUser(req, { initData: initDataExtra });
  if (!user) {
    res.writeHead(401, H);
    res.end(JSON.stringify({ error: 'not authenticated' }));
    return null;
  }
  return { user, H };
}

/**
 * Reads and parses JSON body. Sends 413 on size limit and returns null.
 */
async function readBodySafe(req, res, H) {
  try {
    return await readBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      res.writeHead(413, H);
      res.end(JSON.stringify({ error: 'payload too large' }));
      return null;
    }
    throw e;
  }
}

/**
 * Reads and parses form body. Sends 413 on size limit and returns null.
 */
async function readFormBodySafe(req, res, H) {
  try {
    return await readFormBody(req);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      res.writeHead(413, H);
      res.end(JSON.stringify({ error: 'payload too large' }));
      return null;
    }
    throw e;
  }
}

module.exports = { requireUser, readBodySafe, readFormBodySafe };
