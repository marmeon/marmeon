import { sql, type Kysely } from 'kysely';
import type { Driver } from '../schema/blueprint.ts';
import { LOCK_TABLE } from './lock.ts';

/**
 * Drops every table of a connection — `migrate:fresh` — the record of migrations and the tables 0.3 left included. Foreign keys are no
 * obstacle. The migration lock of SQLite is a row in a table: the run that drops everything holds it, so that table stays.
 */
export async function dropAllTables(db: Kysely<any>, driver: Driver): Promise<void> {
  const present = (await db.introspection.getTables()).map((t) => ({ name: t.name, schema: t.schema }));
  const tables = present.filter((t) => t.name !== LOCK_TABLE);
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
