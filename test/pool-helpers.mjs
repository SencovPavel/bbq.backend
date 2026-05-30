/**
 * Общие моки pool для ws-тестов (членство в группе).
 */
export function memberRowHandler(baseHandler) {
  return async (sql, params) => {
    if (typeof sql === 'string' && sql.includes('FROM group_members') && sql.includes('SELECT 1')) {
      return { rows: [{ ok: 1 }] };
    }
    if (baseHandler) return baseHandler(sql, params);
    return { rows: [] };
  };
}

/** Первый mock-вызов, SQL которого содержит подстроку. */
export const findSqlCall = (pool, fragment) =>
  pool.query.mock.calls.find(([sql]) => typeof sql === 'string' && sql.includes(fragment));
