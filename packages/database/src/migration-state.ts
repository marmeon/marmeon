import { printable, withCode } from '@marmeon/core/internal';
import { sql, type ColumnDefinitionBuilder, type Kysely } from 'kysely';
import { tableColumns, type CatalogQuery } from './introspection.ts';
import type { Driver } from './schema/blueprint.ts';
import { unknownDriver } from './supported-driver.ts';

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
 * MySQL only: the table whose row says a migration started and has not finished. Other drivers keep no such table; a table of that
 * name there is the app's. See `docs/migrations.md#a-migration-that-stopped-halfway`.
 */
export const INTERRUPTION_TABLE = 'migration_interruption';
/** The columns of {@link INTERRUPTION_TABLE}, sorted. */
export const INTERRUPTION_COLUMNS: readonly string[] = ['batch', 'connection_name', 'direction', 'module', 'name', 'owner', 'started_at'];

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

/**
 * Whether `name` belongs to the migrator: the record of migrations and the lock. No migration may create, change or drop them.
 * `driver` `undefined` asks for the names reserved on every driver (what a plan is checked against); `'mysql'` adds
 * {@link INTERRUPTION_TABLE}, which is the app's own name on SQLite and Postgres.
 */
export function isMigratorTable(name: string, driver: Driver | undefined): boolean {
  const lower = name.toLowerCase();
  return lower === MIGRATIONS_TABLE || lower === LOCK_TABLE || (driver === 'mysql' && lower === INTERRUPTION_TABLE);
}

/** What stops a connection from answering queries: its migrations are not what the code expects. */
export class MigrationStateError extends Error {
  override name = 'MigrationStateError';
  /** The database connection it is about. */
  readonly connection: string;
  /**
   * `pending`: the database lacks migrations the code has (run `marmeon migrate`). `newer`: the record of migrations has a form this
   * release does not read. `unmigrated`: the database has tables and no record of migrations. `unmanaged`: the connection is set to
   * `managed: false` and Marmeon migrates the database after all. `interrupted` (MySQL): a migration started and has not finished, or the
   * table that says so cannot be read; see `docs/migrations.md#a-migration-that-stopped-halfway`.
   */
  readonly reason: 'pending' | 'newer' | 'unmigrated' | 'unmanaged' | 'interrupted';
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
export function appTables(columns: ReadonlyMap<string, readonly string[]>, driver: Driver, ignore: ReadonlySet<string> = new Set()): string[] {
  const left = new Set(legacyTables(columns));
  return [...columns.keys()].filter((name) => !isMigratorTable(name, driver) && !left.has(name) && !name.startsWith('sqlite_') && !ignore.has(name));
}

/**
 * A connection with `managed: false` is read from its catalog, without the migrations — which is right only for a database Marmeon
 * does not migrate. A record of migrations in the form Marmeon writes means it does, and the option would hide what the migrations say
 * (secret columns, soft deletes). A table `migrations` of any other form belongs to another tool and is left alone. On MySQL a role without
 * privileges on `migrations` does not see it, and nothing refuses: see docs/database.md#the-catalog-of-mysql.
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
      `The migration lock (${LOCK_TABLE}) of the database connection "${connection}" has the columns ${printable(found.toSorted().join(', '))}, not the ones this release of Marmeon writes ` +
        `(${LOCK_COLUMNS.join(', ')}): a newer Marmeon migrated this database. Update @marmeon/*. See docs/migrations.md#one-migration-at-a-time.`,
    ),
  );
}

/** A migration that started and has not finished, as its row says. */
export interface Interruption {
  readonly name: string;
  readonly module: string;
  /** The database connection the migration runs on, which may be another MySQL connection than `default`. */
  readonly connection: string;
  /** `up` or `down`; a newer Marmeon may have written another value, which refuses all the same. */
  readonly direction: string;
  /** The batch of the run the migration belongs to. */
  readonly batch: number;
  /** ISO-8601 UTC text. */
  readonly startedAt: string;
  /** Who ran it. */
  readonly owner: string;
}

/** Refuses a table of interruptions with other columns than this release writes. */
export function assertInterruptionReadable(columns: ReadonlyMap<string, readonly string[]>, connection: string): void {
  const found = columns.get(INTERRUPTION_TABLE);
  if (found === undefined || sameColumns(found, INTERRUPTION_COLUMNS)) return;
  throw new MigrationStateError(
    'newer',
    connection,
    withCode(
      'D1',
      `The table of interrupted migrations (${INTERRUPTION_TABLE}) of the database connection "${connection}" has the columns ${printable(found.toSorted().join(', '))}, not the ones this release of Marmeon writes ` +
        `(${INTERRUPTION_COLUMNS.join(', ')}): a newer Marmeon migrated this database, or another tool keeps a table of that name. Update @marmeon/*. ${REFUSED}. See docs/migrations.md#how-the-migrator-keeps-track.`,
    ),
  );
}

/**
 * The migration of a MySQL database that started and has not finished, or undefined. Callers ask on MySQL only. Refuses a table with
 * other columns, and a database that has the record of migrations and no table of interruptions: this release makes both together, so
 * the role does not see the table (MySQL hides what it holds no privilege on), or it was dropped by hand, and whether a migration
 * stopped halfway cannot be told. A `select` the server refuses throws and is not caught.
 */
export async function readInterruption(run: CatalogQuery, columns: ReadonlyMap<string, readonly string[]>, connection: string): Promise<Interruption | undefined> {
  assertInterruptionReadable(columns, connection);
  if (!columns.has(INTERRUPTION_TABLE)) {
    if (!columns.has(MIGRATIONS_TABLE)) return undefined;
    throw new MigrationStateError(
      'interrupted',
      connection,
      withCode(
        'D32',
        `The database connection "${connection}" has the record of migrations (${MIGRATIONS_TABLE}) but this role does not see ${INTERRUPTION_TABLE}, the table that says whether a migration has not finished, so Marmeon cannot tell. ` +
          `Grant the role \`select\` on ${INTERRUPTION_TABLE}; if the table was dropped by hand, restore it with the columns ${INTERRUPTION_COLUMNS.join(', ')}. ${REFUSED}. See docs/migrations.md#a-migration-that-stopped-halfway.`,
      ),
    );
  }
  const rows = await run<{ batch: number | string; connection_name: string; direction: string; module: string; name: string; owner: string; started_at: string }>(
    `select "batch", "connection_name", "direction", "module", "name", "owner", "started_at" from "${INTERRUPTION_TABLE}" order by "started_at", "name"`,
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return { name: row.name, module: row.module, connection: row.connection_name, direction: row.direction, batch: Number(row.batch), startedAt: row.started_at, owner: row.owner };
}

/**
 * The refusal while a migration has not finished. `refused` says what is refused: every query of the connection, or the command that
 * would run a migration on top of the half done one.
 */
export function interruptedError(found: Interruption, connection: string, refused: 'queries' | 'migrate' | 'rollback'): MigrationStateError {
  const after =
    refused === 'queries'
      ? `Every query on the connection "${printable(connection)}" is refused until that is resolved.`
      : `${refused === 'migrate' ? 'marmeon migrate' : 'marmeon migrate:rollback (migrate:reset)'} does not start until that is resolved.`;
  return new MigrationStateError(
    'interrupted',
    connection,
    withCode(
      'D32',
      `Migration ${printable(found.name)} (module "${printable(found.module)}") started its ${printable(found.direction)}() on the database connection "${printable(found.connection)}" at ${printable(found.startedAt)} (${printable(found.owner)}) and has not finished (${INTERRUPTION_TABLE} holds its row). ${after} ` +
        'How to resolve it: docs/migrations.md#a-migration-that-stopped-halfway.',
    ),
  );
}

/** Creates the record of migrations — what the first `migrate` on a database does. On MySQL the table of interruptions comes first, beside it. */
export async function createMigrationsTable(db: Kysely<any>, driver: Driver): Promise<void> {
  let id: ['integer' | 'bigint', (c: ColumnDefinitionBuilder) => ColumnDefinitionBuilder];
  switch (driver) {
    case 'sqlite':
      id = ['integer', (c) => c.primaryKey().autoIncrement()];
      break;
    case 'pgsql':
      id = ['bigint', (c) => c.primaryKey().generatedByDefaultAsIdentity()];
      break;
    case 'mysql':
      id = ['bigint', (c) => c.primaryKey().autoIncrement()];
      break;
    default:
      return unknownDriver(driver);
  }
  // First, so that a record without this table is never this release's: one that is (a role without privilege, a table dropped by hand) cannot say whether a migration stopped halfway.
  if (driver === 'mysql') {
    await db.schema
      .createTable(INTERRUPTION_TABLE)
      .ifNotExists()
      .addColumn('name', 'varchar(255)', (c) => c.primaryKey())
      .addColumn('module', 'varchar(255)', (c) => c.notNull())
      .addColumn('connection_name', 'varchar(255)', (c) => c.notNull())
      .addColumn('direction', 'varchar(4)', (c) => c.notNull())
      .addColumn('batch', 'integer', (c) => c.notNull())
      .addColumn('started_at', 'varchar(32)', (c) => c.notNull())
      .addColumn('owner', 'varchar(255)', (c) => c.notNull())
      .modifyEnd(sql`default character set utf8mb4 collate utf8mb4_0900_bin`)
      .execute();
  }
  const table = db.schema
    .createTable(MIGRATIONS_TABLE)
    .addColumn('id', ...id)
    .addColumn('name', 'varchar(255)', (c) => c.notNull().unique())
    .addColumn('module', 'varchar(255)', (c) => c.notNull())
    .addColumn('batch', 'integer', (c) => c.notNull())
    .addColumn('checksum', 'varchar(80)');
  // The table's own collation, binary like the session's: a name is the same name in any case it was written in.
  await (driver === 'mysql' ? table.modifyEnd(sql`default character set utf8mb4 collate utf8mb4_0900_bin`) : table).execute();
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
      `The record of migrations (${MIGRATIONS_TABLE}) of the database connection "${connection}" has the columns ${printable(recorded.toSorted().join(', '))}, not the ones this release of Marmeon reads ` +
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
  // A record this release cannot read is said so first: the table of interruptions is judged against a record that is this release's.
  if (driver === 'mysql') assertRecordReadable(columns, connection);
  const recorded = columns.get(MIGRATIONS_TABLE);
  let ran: Set<string>;
  if (recorded === undefined) {
    const tables = appTables(columns, driver, extension);
    if (tables.length > 0) {
      throw new MigrationStateError(
        'unmigrated',
        connection,
        withCode(
          'D1',
          `The database connection "${connection}" has tables (${printable(tables.slice(0, LISTED).join(', '))}${tables.length > LISTED ? ', …' : ''}) and no record of migrations (${MIGRATIONS_TABLE}), ` +
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
  // Read after the record, so that a row written between the two reads is seen and not skipped.
  // Before the pending migrations: a row in the table is the reason, and "run marmeon migrate" would be wrong advice.
  if (driver === 'mysql') {
    const found = await readInterruption(run, columns, connection);
    if (found) throw interruptedError(found, connection, 'queries');
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
