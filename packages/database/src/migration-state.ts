import { withCode } from '@marmeon/core/internal';
import { appTables, BOOKKEEPING_COLUMNS, MIGRATIONS_TABLE } from './bookkeeping.ts';
import { tableColumns, type CatalogQuery } from './introspection.ts';
import type { Driver } from './schema/blueprint.ts';

// Whether the database has the migrations the code knows. The schema itself comes from the migrations (the projection), so this is
// the one thing a process still asks the database about its schema: which migrations ran. See `docs/migrations.md#how-the-migrator-keeps-track`.

/** What stops a connection from answering queries: its migrations are not what the code expects. */
export class MigrationStateError extends Error {
  override name = 'MigrationStateError';
  /** The database connection it is about. */
  readonly connection: string;
  /**
   * `pending`: the database lacks migrations the code has (run `marmeon migrate`). `newer`: the record of migrations has a form this
   * release does not read. `unmigrated`: the database has tables and no record of migrations.
   */
  readonly reason: 'pending' | 'newer' | 'unmigrated';
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

/**
 * Refuses a record of migrations with other columns than this release reads — it was written by a newer Marmeon, and what its
 * columns mean is not known. Nothing happens for a database without one.
 */
export function assertRecordReadable(columns: ReadonlyMap<string, readonly string[]>, connection: string): void {
  const recorded = columns.get(MIGRATIONS_TABLE);
  if (recorded === undefined || sameColumns(recorded, BOOKKEEPING_COLUMNS[MIGRATIONS_TABLE]!)) return;
  throw new MigrationStateError(
    'newer',
    connection,
    withCode(
      'D1',
      `The record of migrations (${MIGRATIONS_TABLE}) of the database connection "${connection}" has the columns ${recorded.toSorted().join(', ')}, not the ones this release of Marmeon reads ` +
        `(${BOOKKEEPING_COLUMNS[MIGRATIONS_TABLE]!.join(', ')}): a newer Marmeon migrated this database. Update @marmeon/*. ${REFUSED}. See docs/migrations.md#how-the-migrator-keeps-track.`,
    ),
  );
}

/**
 * Compares the migrations of the code (`expected`, by name) with the ones the database recorded. Throws a {@link MigrationStateError}
 * when the database lacks one, when it has tables and no record, or when the record has columns this release does not know.
 * A database with more migrations than the code is fine: `unknown` names them.
 */
export async function checkMigrationState(run: CatalogQuery, driver: Driver, connection: string, expected: readonly string[]): Promise<MigrationState> {
  const { types, extension } = await tableColumns(run, driver);
  const columns = new Map([...types].map(([table, found]) => [table, [...found.keys()]]));
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
    assertRecordReadable(columns, connection);
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
