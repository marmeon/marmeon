import { sql, type Kysely } from 'kysely';
import type { Driver } from '../schema/blueprint.ts';
import { LOCK_TABLE } from './lock.ts';

/**
 * Empties a connection — `migrate:fresh`: its views, tables (the record of migrations and the tables 0.3 left included), and on Postgres
 * the functions, standalone types and free-standing sequences of the app's schemas. Foreign keys are no obstacle. The migration lock of
 * SQLite is a row in a table: the run that drops everything holds it, so that table stays.
 */
export async function dropAllTables(db: Kysely<any>, driver: Driver): Promise<void> {
  const present = await db.introspection.getTables();
  const tables = present.filter((t) => t.name !== LOCK_TABLE);
  if (driver === 'pgsql') {
    await dropPostgres(db, present.map((t) => t.schema).filter((schema): schema is string => !!schema), tables);
    return;
  }
  await sql`pragma foreign_keys = off`.execute(db);
  try {
    // `getTables()` lists views too, and `drop table` on a view is an error.
    for (const t of tables.filter((t) => t.isView)) await db.schema.dropView(t.name).ifExists().execute();
    for (const t of tables.filter((t) => !t.isView)) await db.schema.dropTable(t.name).ifExists().execute();
  } finally {
    await sql`pragma foreign_keys = on`.execute(db);
  }
}

const SYSTEM_SCHEMA = /^(pg_catalog|information_schema|pg_toast.*|pg_temp.*)$/;

type Row = { name: string; kind?: string };

/**
 * Only what the connection's role owns and no extension brought: a function of `pg_trgm` or an object of another role is not the app's to
 * drop, and `drop` would fail on it. Only the schemas of the app's tables and `current_schema()` are looked at.
 */
async function dropPostgres(db: Kysely<any>, tableSchemas: string[], tables: { name: string; schema?: string; isView: boolean; isForeign?: boolean }[]): Promise<void> {
  const current = (await sql<{ schema: string | null }>`select current_schema() as schema`.execute(db)).rows[0]?.schema;
  const schemas = [...new Set([...tableSchemas, ...(current ? [current] : [])])].filter((schema) => !SYSTEM_SCHEMA.test(schema));
  // `sql.id` keeps a dot in a name; `sql.table` would read it as a schema separator.
  const qualified = (t: { name: string; schema?: string }) => (t.schema ? sql.id(t.schema, t.name) : sql.id(t.name));
  const owned = (classId: string, oid: string, owner: string) =>
    sql`${sql.ref(owner)} = (select oid from pg_roles where rolname = current_user)
      and not exists (select 1 from pg_depend d where d.classid = ${sql.lit(classId)}::regclass and d.objid = ${sql.ref(oid)} and d.deptype = 'e')`;
  const run = async (statement: string, rows: Row[]) => {
    for (const row of rows) await sql`${sql.raw(statement)} ${sql.raw(row.name)} cascade`.execute(db);
  };

  // Views first: a view can stand on a table, and `drop table` on a view fails.
  const views = await sql<Row>`
    select c.oid::regclass::text as name, c.relkind as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm') and n.nspname = any(${schemas}::text[]) and ${owned('pg_class', 'c.oid', 'c.relowner')}`.execute(db);
  for (const view of views.rows) await sql`${sql.raw(view.kind === 'm' ? 'drop materialized view if exists' : 'drop view if exists')} ${sql.raw(view.name)} cascade`.execute(db);

  // `getTables()` lists foreign tables with the tables; `drop table` refuses them. These drops are not limited to the role's own
  // objects: a table of another role stops the command, which is better than a database that is not empty.
  for (const t of tables.filter((t) => !t.isView)) {
    await (t.isForeign ? sql`drop foreign table if exists ${qualified(t)} cascade` : sql`drop table if exists ${qualified(t)} cascade`).execute(db);
  }

  // Constructors of a range or multirange type depend on it internally and go with it.
  const routines = await sql<Row>`
    select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = any(${schemas}::text[]) and ${owned('pg_proc', 'p.oid', 'p.proowner')}
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'i')`.execute(db);
  await run('drop routine if exists', routines.rows);

  // Enum, domain, range and a composite no table stands behind. Array and multirange types go with their element or range.
  const types = await sql<Row>`
    select t.oid::regtype::text as name from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where (t.typtype in ('e', 'd', 'r') or (t.typtype = 'c' and exists (select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c')))
    and n.nspname = any(${schemas}::text[]) and ${owned('pg_type', 't.oid', 't.typowner')}`.execute(db);
  await run('drop type if exists', types.rows);

  // A sequence a column owns (serial, identity) went with its table.
  const sequences = await sql<Row>`
    select c.oid::regclass::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'S' and n.nspname = any(${schemas}::text[]) and ${owned('pg_class', 'c.oid', 'c.relowner')}
    and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i'))`.execute(db);
  await run('drop sequence if exists', sequences.rows);
}
