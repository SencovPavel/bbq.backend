'use strict';

/**
 * @param {URL} url
 * @param {string} key
 * @param {number} def
 * @param {number} min
 * @param {number} max
 */
function intParam(url, key, def, min, max) {
  const raw = url.searchParams.get(key);
  const v = raw === null || raw === '' ? def : parseInt(raw, 10);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

/**
 * @param {URL} url
 */
function parseGroupsListParams(url) {
  const q = (url.searchParams.get('q') || '').trim();
  const inactiveDays = url.searchParams.get('inactiveDays');
  const hasBot = url.searchParams.get('hasBot');
  return {
    q,
    inactiveDays: inactiveDays === null || inactiveDays === ''
      ? null
      : Math.max(0, parseInt(inactiveDays, 10) || 0),
    hasBot: hasBot === '1' || hasBot === 'true',
    limit: intParam(url, 'limit', 50, 1, 200),
    offset: intParam(url, 'offset', 0, 0, 100_000),
  };
}

module.exports = { intParam, parseGroupsListParams };
