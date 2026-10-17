import { sql, type Kysely } from 'kysely';
import {
  appTables,
  BOOKKEEPING_VERSION,
  bookkeepingVersion,
  classify,
  LEGACY,
  MARKERS_TABLE,
  MIGRATIONS_TABLE,
  OWNERS_TABLE,
  SECRETS_TABLE,
  unreadable,
  VERSIONS_TABLE,
  type BookkeepingState,
} from './bookkeeping.ts';
import { bookkeepingAccess, bookkeepingConnection } from './books.ts';
import type { Connections } from './connections.ts';
import { tableColumns, type CatalogQuery } from './introspection.ts';
import { Schema } from './schema/schema.ts';
import type { Driver } from './schema/blueprint.ts';

// Creating and moving the migrator's bookkeeping. The migrator calls it before it migrates; tests call it to give a database an empty,
// versioned bookkeeping the way a first `migrate` would.

export interface PrepareOptions {
  /** `migrate` moves the previous release's tables; every other command refuses until it ran. */
  readonly adopt?: boolean;
  /** `migrate --adopt-existing`: tables of the app and no bookkeeping at all become an empty, versioned bookkeeping. Called with the tables. */
  readonly adoptExisting?: ((connection: string, tables: readonly string[]) => void) | undefined;
}

/** A connection with `managed: false` is another tool's: nothing of the migrator touches it. */
export function assertManaged(connections: Connections, connection: string): void {
  if (connections.options(connection).managed === false) {
    throw new Error(
      `The database connection "${connection}" is not migrated by Marmeon (\`managed: false\`): the migrations cannot run on it, nor can the bookkeeping be kept there. ` +
        'Run them on a connection Marmeon manages, or remove the option. See docs/database.md#a-database-another-tool-manages.',
    );
  }
}

export function runner(db: Kysely<any>): CatalogQuery {
  return async (query) => (await sql.raw<any>(query).execute(db)).rows;
}

/** Table → columns, and the tables an extension owns (Postgres: PostGIS's `spatial_ref_sys`), which are no tables of the app. */
export async function loadColumns(db: Kysely<any>, driver: Driver): Promise<{ columns: Map<string, string[]>; extension: Set<string> }> {
  const { types, extension } = await tableColumns(runner(db), driver);
  return { columns: new Map([...types].map(([table, columns]) => [table, [...columns.keys()]])), extension };
}

/** Whether the connection has a versioned bookkeeping this release reads (throws for one it does not). */
export async function isReadable(db: Kysely<any>, driver: Driver, connection: string): Promise<boolean> {
  const { columns, extension } = await loadColumns(db, driver);
  if (classify(columns, connection, extension).state !== 'versioned') return false;
  await bookkeepingVersion(runner(db), columns, connection);
  return true;
}

/**
 * Makes sure a connection has readable bookkeeping: a database nothing ran on gets an empty, versioned one; one that has the previous
 * release's tables gets them moved (with `adopt`); one with a newer version, or with tables it cannot make sense of, is refused. Runs
 * on the bookkeeping connection: the app's own refuses such a database.
 */
export async function prepareBookkeeping(connections: Connections, connection = 'default', options: PrepareOptions = {}): Promise<void> {
  assertManaged(connections, connection);
  const books = bookkeepingConnection(connections, connection);
  const driver = connections.options(connection).driver;
  if (await isReadable(books, driver, connection)) return;
  let adopted: readonly string[] | undefined;
  await books.transaction().execute(async (trx) => {
    // Looked at again inside: another process may have moved the tables since.
    if (await isReadable(trx, driver, connection)) return;
    const { columns, extension } = await loadColumns(trx, driver);
    const state = classify(columns, connection, extension);
    const existing = state.state === 'incomplete' && state.unmigrated && options.adoptExisting !== undefined && options.adopt === true;
    // Anything else this release cannot make sense of is refused, and so is every other command until `migrate` ran.
    if (!existing && (state.state === 'foreign' || state.state === 'incomplete' || (state.state === 'legacy' && options.adopt !== true))) throw unreadable(state, connection)!;
    if (existing) adopted = appTables(columns, extension);
    await create(trx, driver, connection, state);
  });
  if (adopted !== undefined) options.adoptExisting?.(connection, adopted);
}

/** Moves the tables of the previous release to their `marmeon_` names (indexes and constraints with them), creates what is missing, writes the version, and leaves a placeholder under each old name. */
async function create(trx: Kysely<any>, driver: Driver, connection: string, state: BookkeepingState): Promise<void> {
  const sqlite = driver === 'sqlite';
  const moved = state.state === 'legacy' ? state.tables : [];
  const schema = new Schema(trx, driver);
  bookkeepingAccess.add(schema);
  for (const old of moved) await schema.rename(old, LEGACY[old]!.to, { indexes: true });
  const has = (table: string) => moved.some((old) => LEGACY[old]!.to === table);
  if (connection === 'default' && !has(MIGRATIONS_TABLE)) {
    await trx.schema
      .createTable(MIGRATIONS_TABLE)
      .addColumn('id', sqlite ? 'integer' : 'bigint', (c) => (sqlite ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity()))
      .addColumn('name', 'varchar(255)', (c) => c.notNull().unique())
      .addColumn('module', 'varchar(255)', (c) => c.notNull())
      .addColumn('batch', 'integer', (c) => c.notNull())
      .execute();
  }
  if (!has(OWNERS_TABLE)) {
    await trx.schema
      .createTable(OWNERS_TABLE)
      .addColumn('table_name', 'varchar(255)', (c) => c.primaryKey())
      .addColumn('module', 'varchar(255)', (c) => c.notNull())
      .execute();
  }
  if (!has(SECRETS_TABLE)) {
    await trx.schema
      .createTable(SECRETS_TABLE)
      .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
      .addColumn('column_name', 'varchar(255)', (c) => c.notNull())
      .addPrimaryKeyConstraint(`${SECRETS_TABLE}_pkey`, ['table_name', 'column_name'])
      .execute();
  }
  if (!has(MARKERS_TABLE)) {
    await trx.schema
      .createTable(MARKERS_TABLE)
      .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
      .addColumn('column_name', 'varchar(255)', (c) => c.notNull().defaultTo(''))
      .addColumn('marker', 'varchar(32)', (c) => c.notNull())
      .addColumn('value', 'varchar(255)')
      .addPrimaryKeyConstraint(`${MARKERS_TABLE}_pkey`, ['table_name', 'column_name', 'marker'])
      .execute();
  }
  await trx.schema
    .createTable(VERSIONS_TABLE)
    .addColumn('name', 'varchar(64)', (c) => c.primaryKey())
    .addColumn('version', 'integer', (c) => c.notNull())
    .execute();
  await trx.insertInto(VERSIONS_TABLE).values({ name: 'bookkeeping', version: BOOKKEEPING_VERSION }).execute();
  // A placeholder under every old name: a process of the previous release that is still running finds no secret columns, no
  // markers and no record of migrations — and no table to ask. Its queries fail instead of being served without the list.
  for (const old of moved) {
    await trx.schema.createTable(old).addColumn('moved_to', 'varchar(64)', (c) => c.notNull()).execute();
    await trx.insertInto(old).values({ moved_to: LEGACY[old]!.to }).execute();
  }
}
