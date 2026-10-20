import { withCode } from '@marmeon/core/internal';
import type { Kysely } from 'kysely';
import { tableColumns, type CatalogQuery } from './introspection.ts';
import type { Driver } from './schema/blueprint.ts';

// Whether the database has the migrations the code knows. The schema itself comes from the migrations (the projection), so this is
// the one thing a process still asks the database about its schema: which migrations ran. See `docs/migrations.md#how-the-migrator-keeps-track`.

/** The table of the migrations that ran (on `default` only). Its columns are its format: there is no version beside them. */
export const MIGRATIONS_TABLE = 'migrations';
/**
 * The columns of {@link MIGRATIONS_TABLE} per format, sorted. 1 is the form Marmeon 0.3 wrote; 2 adds the checksum of the file that ran.
 * A table with any other columns was written by a Marmeon this release does not know.
 */
export const RECORD_COLUMNS: Readonly<Record<1 | 2, readonly string[]>> = {
  1: ['batch', 'id', 'module', 'name'],
  2: ['batch', 'checksum', 'id', 'module', 'name'],
};
/** The columns of {@link MIGRATIONS_TABLE} in the format this release writes. */
export const MIGRATIONS_COLUMNS: readonly string[] = RECORD_COLUMNS[2];
/** SQLite: the table whose one row is the migration lock. Postgres needs none — it holds an advisory lock on a connection. */
export const LOCK_TABLE = 'migration_lock';
/** The columns of {@link LOCK_TABLE}, sorted. */
export const LOCK_COLUMNS: readonly string[] = ['acquired_at', 'heartbeat_at', 'name', 'owner'];

/**
 * The tables Marmeon 0.3 kept beside the record of migrations, and their columns. This release neither reads nor writes them and
 * `migrate` leaves them where they are: a process of 0.3 that still runs reads them, and a missing table means "no secret columns" to it.
 */
export const LEGACY_TABLES: Readonly<Record<string, readonly string[]>> = {
  table_owners: ['module', 'table_name'],
  secret_columns: ['column_name', 'table_name'],
  schema_markers: ['column_name', 'marker', 'table_name', 'value'],
};

/** The table a build of Marmeon that was never released kept its record of migrations in. There is no way from it to this release. */
const UNRELEASED_TABLE = 'marmeon_migrations';

/** Whether `name` belongs to the migrator: the record of migrations and the lock. No migration may create, change or drop them. */
export function isMigratorTable(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === MIGRATIONS_TABLE || lower === LOCK_TABLE;
}

/** What stops a connection from answering queries: its migrations are not what the code expects. */
export class MigrationStateError extends Error {
  override name = 'MigrationStateError';
  /** The database connection it is about. */
  readonly connection: string;
  /**
   * `pending`: the database lacks migrations the code has (run `marmeon migrate`). `newer`: the record of migrations has a form this
   * release does not read. `unmigrated`: the database has tables and no record of migrations. `unmanaged`: the connection is set to
   * `managed: false` and Marmeon migrates the database after all.
   */
  readonly reason: 'pending' | 'newer' | 'unmigrated' | 'unmanaged';
  /** `pending`: the migrations the database lacks, in the order they run. */
  readonly missing: readonly string[];

  constructor(reason: MigrationStateError['reason'], connection: string, message: string, missing: readonly string[] = []) {
    super(message);
    this.reason = reason;
    this.connection = connection;
    this.missing = missing;
  }
}

/** What a database that answers queries says about its migrations. */
export interface MigrationState {
  /** The migrations the database has and the code does not: a process of an older release during a deploy. Nothing is refused. */
  readonly unknown: readonly string[];
}

/** How many migrations a message names. */
const LISTED = 5;

const REFUSED = 'Every query on this connection is refused until that is so';

const sameColumns = (found: readonly string[] | undefined, expected: readonly string[]) =>
  found !== undefined && found.length === expected.length && found.toSorted().join('\0') === expected.join('\0');

/** The tables of 0.3 that are still there, with the columns 0.3 gave them. */
export function legacyTables(columns: ReadonlyMap<string, readonly string[]>): string[] {
  return Object.entries(LEGACY_TABLES).filter(([name, expected]) => sameColumns(columns.get(name), expected)).map(([name]) => name);
}

/**
 * The tables of the app: not the migrator's, not 0.3's leftovers, not SQLite's own (`sqlite_sequence`), and not the ones an extension
 * owns (`ignore`: PostGIS's `spatial_ref_sys`).
 */
export function appTables(columns: ReadonlyMap<string, readonly string[]>, ignore: ReadonlySet<string> = new Set()): string[] {
  const left = new Set(legacyTables(columns));
  return [...columns.keys()].filter((name) => !isMigratorTable(name) && !left.has(name) && !name.startsWith('sqlite_') && !ignore.has(name));
}

/**
 * A connection with `managed: false` is read from its catalog, without the migrations — which is right only for a database Marmeon
 * does not migrate. A record of migrations in the form Marmeon writes means it does, and the option would hide what the migrations say
 * (secret columns, soft deletes). A table `migrations` of any other form belongs to another tool and is left alone.
 */
export function assertNotMigrated(columns: ReadonlyMap<string, readonly string[]>, connection: string): void {
  const recorded = columns.get(MIGRATIONS_TABLE);
  if (!sameColumns(recorded, RECORD_COLUMNS[1]) && !sameColumns(recorded, RECORD_COLUMNS[2])) return;
  throw new MigrationStateError(
    'unmanaged',
    connection,
    withCode(
      'D1',
      `The database connection "${connection}" is set to \`managed: false\`, but it has the record of migrations Marmeon writes (${MIGRATIONS_TABLE}): Marmeon migrates this database. ` +
        `Remove \`managed: false\` (or DB_MANAGED=false); with it no secret column and no soft delete would be known. ${REFUSED}. See docs/migrations.md#how-the-migrator-keeps-track.`,
    ),
  );
}

/**
 * Whether the database was migrated by a build of Marmeon that was never released (its record is `marmeon_migrations`) and has no
 * record of this release, or a placeholder where it was: there is no way from it to this one, only `migrate:fresh`.
 */
export function isUnreleased(columns: ReadonlyMap<string, readonly string[]>): boolean {
  if (!columns.has(UNRELEASED_TABLE)) return false;
  // The build took a 0.3 database over and left a placeholder under the old name.
  const old = columns.get(MIGRATIONS_TABLE);
  return old === undefined || sameColumns(old, ['moved_to']);
}

export function assertNotUnreleased(columns: ReadonlyMap<string, readonly string[]>, connection: string): void {
  if (!isUnreleased(columns)) return;
  throw new MigrationStateError(
    'unmigrated',
    connection,
    withCode(
      'D1',
      `The database connection "${connection}" has ${UNRELEASED_TABLE}: it was migrated by a build of Marmeon that was never released, and nothing moves its record to ${MIGRATIONS_TABLE}. ` +
        'In development, "marmeon migrate:fresh" drops every table and starts over; anywhere else, migrate a new database. See docs/migrations.md#how-the-migrator-keeps-track.',
    ),
  );
}

/** Refuses a lock table with other columns than this release writes. */
export function assertLockReadable(columns: ReadonlyMap<string, readonly string[]>, connection: string): void {
  const found = columns.get(LOCK_TABLE);
  if (found === undefined || sameColumns(found, LOCK_COLUMNS)) return;
  throw new MigrationStateError(
    'newer',
    connection,
    withCode(
      'D1',
      `The migration lock (${LOCK_TABLE}) of the database connection "${connection}" has the columns ${found.toSorted().join(', ')}, not the ones this release of Marmeon writes ` +
        `(${LOCK_COLUMNS.join(', ')}): a newer Marmeon migrated this database. Update @marmeon/*. See docs/migrations.md#one-migration-at-a-time.`,
    ),
  );
}

/** Creates the record of migrations — what the first `migrate` on a database does. */
export async function createMigrationsTable(db: Kysely<any>, driver: Driver): Promise<void> {
  const sqlite = driver === 'sqlite';
  await db.schema
    .createTable(MIGRATIONS_TABLE)
    .addColumn('id', sqlite ? 'integer' : 'bigint', (c) => (sqlite ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity()))
    .addColumn('name', 'varchar(255)', (c) => c.notNull().unique())
    .addColumn('module', 'varchar(255)', (c) => c.notNull())
    .addColumn('batch', 'integer', (c) => c.notNull())
    .addColumn('checksum', 'varchar(80)')
    .execute();
}

/**
 * The format of the record of migrations (see {@link RECORD_COLUMNS}), or undefined for a database without one. Refuses a record with
 * other columns than this release reads — it was written by a newer Marmeon, and what its columns mean is not known.
 */
export function recordVersion(columns: ReadonlyMap<string, readonly string[]>, connection: string): 1 | 2 | undefined {
  const recorded = columns.get(MIGRATIONS_TABLE);
  if (recorded === undefined) return undefined;
  if (sameColumns(recorded, RECORD_COLUMNS[2])) return 2;
  if (sameColumns(recorded, RECORD_COLUMNS[1])) return 1;
  throw new MigrationStateError(
    'newer',
    connection,
    withCode(
      'D1',
      `The record of migrations (${MIGRATIONS_TABLE}) of the database connection "${connection}" has the columns ${recorded.toSorted().join(', ')}, not the ones this release of Marmeon reads ` +
        `(${RECORD_COLUMNS[2].join(', ')}, or ${RECORD_COLUMNS[1].join(', ')} as Marmeon 0.3 wrote them): a newer Marmeon migrated this database, or another tool keeps a table of that name. Update @marmeon/*. ${REFUSED}. See docs/migrations.md#how-the-migrator-keeps-track.`,
    ),
  );
}

/** Refuses a record of migrations with other columns than this release reads. Nothing happens for a database without one. */
export function assertRecordReadable(columns: ReadonlyMap<string, readonly string[]>, connection: string): void {
  recordVersion(columns, connection);
}

/**
 * Compares the migrations of the code (`expected`, by name) with the ones the database recorded. Throws a {@link MigrationStateError}
 * when the database lacks one, when it has tables and no record, or when the record has columns this release does not know.
 * A database with more migrations than the code is fine: `unknown` names them.
 */
export async function checkMigrationState(run: CatalogQuery, driver: Driver, connection: string, expected: readonly string[]): Promise<MigrationState> {
  const { types, extension } = await tableColumns(run, driver);
  const columns = new Map([...types].map(([table, found]) => [table, [...found.keys()]]));
  assertNotUnreleased(columns, connection);
  const recorded = columns.get(MIGRATIONS_TABLE);
  let ran: Set<string>;
  if (recorded === undefined) {
    const tables = appTables(columns, extension);
    if (tables.length > 0) {
      throw new MigrationStateError(
        'unmigrated',
        connection,
        withCode(
          'D1',
          `The database connection "${connection}" has tables (${tables.slice(0, LISTED).join(', ')}${tables.length > LISTED ? ', …' : ''}) and no record of migrations (${MIGRATIONS_TABLE}), ` +
            'so Marmeon cannot tell which migrations ran. Run "marmeon migrate" if Marmeon migrates this database; for a database that another tool manages, set `managed: false` on the connection. ' +
            `${REFUSED}. See docs/migrations.md#how-the-migrator-keeps-track.`,
        ),
      );
    }
    ran = new Set();
  } else {
    // The form of 0.3 has no checksum per migration: `migrate` carries it over, and until it did the process treats it like a migration that is missing.
    if (recordVersion(columns, connection) === 1) {
      throw new MigrationStateError(
        'pending',
        connection,
        withCode(
          'D2',
          `The record of migrations (${MIGRATIONS_TABLE}) of the database connection "${connection}" is in the form Marmeon 0.3 wrote, without a checksum per migration. ` +
            `Run "marmeon migrate": it carries the record over. ${REFUSED}. See docs/migrations.md#how-the-migrator-keeps-track.`,
        ),
        [],
      );
    }
    ran = new Set((await run<{ name: string }>(`select name from ${MIGRATIONS_TABLE}`)).map((row) => row.name));
  }
  const missing = expected.filter((name) => !ran.has(name));
  if (missing.length > 0) {
    throw new MigrationStateError(
      'pending',
      connection,
      withCode(
        'D2',
        `The database connection "${connection}" lacks ${missing.length} migration${missing.length === 1 ? '' : 's'} this code has (${missing.slice(0, LISTED).join(', ')}${missing.length > LISTED ? `, and ${missing.length - LISTED} more` : ''}), ` +
          `so the schema the code expects is not there. Run "marmeon migrate"; the app answers again within a second of it, without a restart. ${REFUSED}. See docs/migrations.md#migrating-a-running-app.`,
      ),
      missing,
    );
  }
  const known = new Set(expected);
  return { unknown: [...ran].filter((name) => !known.has(name)).toSorted() };
}
