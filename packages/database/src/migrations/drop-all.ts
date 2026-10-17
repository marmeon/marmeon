import { sql, type Kysely } from 'kysely';
import { isBookkeepingName } from '../bookkeeping.ts';
import type { Driver } from '../schema/blueprint.ts';
import { LOCK_TABLE } from './lock.ts';

/**
 * Drops every table of a connection — `migrate:fresh`. Foreign keys are no obstacle. The migration lock of SQLite is a row in a
 * table: the run that drops everything holds it, so that table stays. The migrator's own tables stay too, unless `bookkeeping` is
 * set (the migrator drops everything), and then the entries about the migrated tables go before the tables do: left behind, they
 * would point at nothing.
 */
export async function dropAllTables(db: Kysely<any>, driver: Driver, bookkeeping: boolean): Promise<void> {
  const present = (await db.introspection.getTables()).map((t) => ({ name: t.name, schema: t.schema }));
  if (!bookkeeping) {
    const names = new Set(present.map((t) => t.name));
    for (const table of ['marmeon_migrations', 'marmeon_table_owners', 'marmeon_secret_columns', 'marmeon_schema_markers']) {
      if (names.has(table)) await sql`delete from ${sql.table(table)}`.execute(db);
    }
  }
  const tables = present.filter((t) => t.name !== LOCK_TABLE && (bookkeeping || !isBookkeepingName(t.name)));
  if (driver === 'pgsql') {
    for (const t of tables) await sql`drop table if exists ${sql.table(t.schema ? `${t.schema}.${t.name}` : t.name)} cascade`.execute(db);
    return;
  }
  await sql`pragma foreign_keys = off`.execute(db);
  try {
    for (const t of tables) await db.schema.dropTable(t.name).ifExists().execute();
  } finally {
    await sql`pragma foreign_keys = on`.execute(db);
  }
}
