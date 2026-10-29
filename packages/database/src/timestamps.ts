import { sql, type Kysely } from 'kysely';
import { metadataOf, nowOf } from './schema-resolver.ts';

/**
 * The rows with `created_at` and `updated_at` set to the app's time, on a table whose migration called `timestamps()` — each only
 * where the row does not name it (`undefined` is not naming it). The database's own default would be the wall clock, which
 * `app.travel()` does not move. Every row of one call gets the same time. A connection without Marmeon's plugins does not know the
 * table's marks: its rows stay as they are.
 */
export async function stampTimestamps(db: Kysely<any>, table: string, rows: readonly Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const metadata = metadataOf(db);
  if (!metadata) return [...rows];
  if (!metadata.fresh) await sql`select 1`.execute(db);
  if (!metadata.timestamps.has(table)) return [...rows];
  const now = new Date(nowOf(db));
  return rows.map((row) => ({
    ...row,
    ...(row.created_at === undefined ? { created_at: now } : {}),
    ...(row.updated_at === undefined ? { updated_at: now } : {}),
  }));
}
