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

/**
 * The table a statement could not find — SQLite (`no such table: users`) or Postgres (SQLSTATE 42P01, `relation "users"
 * does not exist`) — or undefined for any other error. Mostly a migration that has not run (the error page says which).
 */
export function missingTable(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof message !== 'string') return undefined;
  if (code === '42P01') return /relation "([^"]+)" does not exist/.exec(message)?.[1] ?? 'unknown';
  return /no such table: ([\w.]+)/.exec(message)?.[1];
}
