/**
 * Whether `error` is a unique-constraint violation — SQLite (`SQLITE_CONSTRAINT_UNIQUE`, 2067) or
 * Postgres (SQLSTATE 23505). Repositories have `tryInsert()` for the common case. Inside a
 * transaction, catch it only around a savepoint: on Postgres the failed statement aborts the
 * transaction ("current transaction is aborted, commands ignored").
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  return code === '23505' || errcode === 2067 || (code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(String((error as Error).message)));
}
