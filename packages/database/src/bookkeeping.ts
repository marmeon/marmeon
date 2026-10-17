import { withCode } from '@marmeon/core/internal';
import type { CatalogQuery, SchemaMarker } from './introspection.ts';
import { LOCK_TABLE } from './migrations/lock.ts';

// The migrator's bookkeeping: which migrations ran, which module owns a table, which columns are secret and what the migrations
// marked. The secret guard and the soft deletes depend on it — so a connection whose bookkeeping cannot be read refuses every
// query instead of working without the list. See `docs/migrations.md#how-the-migrator-keeps-track`.

/** The migrations that ran (on `default` only). */
export const MIGRATIONS_TABLE = 'marmeon_migrations';
/** Table → the module whose migration created it. */
export const OWNERS_TABLE = 'marmeon_table_owners';
/** The columns migrations marked `.secret()`. */
export const SECRETS_TABLE = 'marmeon_secret_columns';
/**
 * What migrations declared beyond the columns — `timestamps()` and `softDeletes()` per table, `.inverse()` per foreign key.
 * See `docs/migrations.md#timestamps-and-soft-deletes`.
 */
export const MARKERS_TABLE = 'marmeon_schema_markers';
/** The version of the bookkeeping itself: one row, `('bookkeeping', 1)`. */
export const VERSIONS_TABLE = 'marmeon_versions';
export { LOCK_TABLE };

/** The version this release writes. */
export const BOOKKEEPING_VERSION = 1;

/** What a version of the bookkeeping holds, as this release understands it. */
export interface BookkeepingRows {
  readonly secrets: readonly { readonly table: string; readonly column: string }[];
  readonly markers: readonly SchemaMarker[];
}

/** Reads the bookkeeping of one version. */
export type BookkeepingReader = (run: CatalogQuery, columns: ReadonlyMap<string, readonly string[]>, connection: string) => Promise<BookkeepingRows>;

/**
 * Every version of the bookkeeping this release reads, by its number. A version that is not here is refused — never read
 * as "nothing secret".
 */
export const BOOKKEEPING_READERS = new Map<number, BookkeepingReader>([[1, readVersion1]]);

/** The columns of each table of version 1, sorted. */
export const BOOKKEEPING_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  [MIGRATIONS_TABLE]: ['batch', 'id', 'module', 'name'],
  [OWNERS_TABLE]: ['module', 'table_name'],
  [SECRETS_TABLE]: ['column_name', 'table_name'],
  [MARKERS_TABLE]: ['column_name', 'marker', 'table_name', 'value'],
  [VERSIONS_TABLE]: ['name', 'version'],
};

/** The names the bookkeeping of the previous release used, and what became of them. They stay taken until 1.0. */
export const LEGACY: Readonly<Record<string, { readonly to: string; readonly columns: readonly string[] }>> = {
  migrations: { to: MIGRATIONS_TABLE, columns: BOOKKEEPING_COLUMNS[MIGRATIONS_TABLE]! },
  table_owners: { to: OWNERS_TABLE, columns: BOOKKEEPING_COLUMNS[OWNERS_TABLE]! },
  secret_columns: { to: SECRETS_TABLE, columns: BOOKKEEPING_COLUMNS[SECRETS_TABLE]! },
  schema_markers: { to: MARKERS_TABLE, columns: BOOKKEEPING_COLUMNS[MARKERS_TABLE]! },
};

/** The columns of the placeholder left under each old name: one row, naming the table it moved to. */
export const TOMBSTONE_COLUMNS: readonly string[] = ['moved_to'];

const NAMES = new Set([...Object.keys(LEGACY), ...Object.keys(BOOKKEEPING_COLUMNS), LOCK_TABLE]);

/** Whether `name` belongs to the migrator: its tables, the lock, and the old names that now hold a placeholder. */
export function isBookkeepingName(name: string): boolean {
  return NAMES.has(name.toLowerCase());
}

/** The bookkeeping this release cannot read, or can only read after `marmeon migrate`. */
export class BookkeepingVersionError extends Error {
  override name = 'BookkeepingVersionError';
  /** The database connection whose bookkeeping it is. */
  readonly connection: string;
  /** `legacy`: the previous release's tables, to be moved by `migrate`. `newer`: a version this release does not read. `foreign`: an app table under a bookkeeping name. `incomplete`: tables missing or changed. */
  readonly reason: 'legacy' | 'newer' | 'foreign' | 'incomplete';

  constructor(reason: BookkeepingVersionError['reason'], connection: string, message: string) {
    super(message);
    this.reason = reason;
    this.connection = connection;
  }
}

const REFUSED = 'Every query on this connection is refused, because without its bookkeeping the secret columns and the soft-deleted rows cannot be told';

/** What the tables of a connection say about its bookkeeping. */
export type BookkeepingState =
  | { readonly state: 'none' }
  | { readonly state: 'versioned' }
  | { readonly state: 'legacy'; readonly tables: readonly string[] }
  | { readonly state: 'foreign'; readonly table: string }
  | { readonly state: 'incomplete'; readonly tables: readonly string[]; readonly unmigrated: boolean };

const sameColumns = (columns: readonly string[] | undefined, expected: readonly string[]) =>
  columns !== undefined && columns.length === expected.length && columns.toSorted().join('\0') === expected.join('\0');

/**
 * Looks at the tables, not at their rows. A connection has a versions table (read it), the previous release's tables
 * (`legacy`: all of them, `migrations` on `default` only), one of the app's next to those (`foreign`), parts of either without
 * the rest or tables of the app and no bookkeeping at all (`incomplete`), or no table (`none`: a database nothing ran on).
 * Tables of the app without bookkeeping are never "no secret columns": the connection is not one Marmeon migrated.
 */
export function classify(columns: ReadonlyMap<string, readonly string[]>, connection = 'default', ignore: ReadonlySet<string> = new Set()): BookkeepingState {
  if (columns.has(VERSIONS_TABLE)) return { state: 'versioned' };
  const legacy: string[] = [];
  const placeholders: string[] = [];
  const wrong: string[] = [];
  for (const [name, expected] of Object.entries(LEGACY)) {
    const found = columns.get(name);
    if (found === undefined) continue;
    if (sameColumns(found, expected.columns)) legacy.push(name);
    else if (sameColumns(found, TOMBSTONE_COLUMNS)) placeholders.push(name);
    else wrong.push(name);
  }
  // An app table under an old name only counts as one next to the old bookkeeping; alone it is a database Marmeon did not migrate.
  if (wrong.length > 0) return legacy.length > 0 ? { state: 'foreign', table: wrong[0]! } : { state: 'incomplete', tables: wrong, unmigrated: true };
  const parts = Object.keys(BOOKKEEPING_COLUMNS).filter((name) => columns.has(name));
  if (parts.length > 0 || placeholders.length > 0) return { state: 'incomplete', tables: [...parts, ...placeholders], unmigrated: false };
  const required = Object.keys(LEGACY).filter((name) => connection === 'default' || name !== 'migrations');
  if (legacy.length > 0) {
    return required.every((name) => legacy.includes(name)) ? { state: 'legacy', tables: legacy } : { state: 'incomplete', tables: legacy, unmigrated: false };
  }
  const app = appTables(columns, ignore);
  return app.length > 0 ? { state: 'incomplete', tables: app, unmigrated: true } : { state: 'none' };
}

/**
 * The tables of the app: not the migrator's, not SQLite's own (`sqlite_sequence`), and not the ones an extension owns (`ignore`:
 * PostGIS's `spatial_ref_sys`).
 */
export function appTables(columns: ReadonlyMap<string, readonly string[]>, ignore: ReadonlySet<string> = new Set()): string[] {
  return [...columns.keys()].filter((name) => !isMarmeonOwned(name) && !name.startsWith('sqlite_') && !ignore.has(name));
}

/** The migrator's own tables: the `marmeon_` bookkeeping, and the lock. */
function isMarmeonOwned(name: string): boolean {
  return Object.hasOwn(BOOKKEEPING_COLUMNS, name) || name === LOCK_TABLE;
}

/**
 * A connection with `managed: false` is read without bookkeeping — which is safe only when there is none to read. A table of the
 * migrator's on it means Marmeon migrates the database after all, and the option would hide its secret columns.
 */
export function assertNotMigrated(columns: ReadonlyMap<string, readonly string[]>, connection: string): void {
  const owned = [...columns.entries()].filter(([name, found]) => isMarmeonOwned(name) || (Object.hasOwn(LEGACY, name) && (sameColumns(found, TOMBSTONE_COLUMNS) || ((name === 'secret_columns' || name === 'schema_markers') && sameColumns(found, LEGACY[name]!.columns))))).map(([name]) => name);
  if (owned.length === 0) return;
  throw new BookkeepingVersionError(
    'incomplete',
    connection,
    withCode(
      'D1',
      `The database connection "${connection}" is set to \`managed: false\`, but it has tables of the migrator's (${owned.join(', ')}): Marmeon migrates this database. ` +
        `Remove \`managed: false\` (or DB_MANAGED=false); with it no secret column and no soft delete would be known. ${REFUSED}.`,
    ),
  );
}

/** The error for a state that is not readable (`none` and `versioned` are). */
export function unreadable(state: BookkeepingState, connection: string): BookkeepingVersionError | undefined {
  switch (state.state) {
    case 'legacy':
      return new BookkeepingVersionError(
        'legacy',
        connection,
        withCode(
          'D2',
          `The database connection "${connection}" still has the bookkeeping of an earlier release of Marmeon (${state.tables.join(', ')}). Stop every process of that release, then run "marmeon migrate": it moves the bookkeeping to the marmeon_ tables. ${REFUSED}.`,
        ),
      );
    case 'foreign':
      return new BookkeepingVersionError(
        'foreign',
        connection,
        withCode(
          'D3',
          `The database connection "${connection}" has a table "${state.table}" that is not the migrator's. The name is reserved for the framework: rename your table in the database (alter table ${state.table} rename to …) and in the code that uses it, then run "marmeon migrate". ${REFUSED}.`,
        ),
      );
    case 'incomplete':
      return new BookkeepingVersionError(
        'incomplete',
        connection,
        withCode(
          'D1',
          state.unmigrated
            ? `The database connection "${connection}" has tables (${state.tables.slice(0, 5).join(', ')}${state.tables.length > 5 ? ', …' : ''}) but none of the migrator's bookkeeping, so Marmeon cannot tell which columns are secret or which rows are deleted. ` +
                `If this is your own database and Marmeon is to migrate it from now on, run "marmeon migrate --adopt-existing" once: it writes an empty bookkeeping and names the tables it takes over unmarked. ` +
                `If a restore lost the bookkeeping, restore it. Only for a database that another tool manages, set \`managed: false\` on the connection. ${REFUSED}.`
            : `The bookkeeping of the database connection "${connection}" is incomplete: ${state.tables.join(', ')} exist without the rest of it (${VERSIONS_TABLE}, or the other tables). Restore the missing tables from a backup. ${REFUSED}.`,
        ),
      );
    default:
      return undefined;
  }
}

/** The bookkeeping has a version this release has no reader for. */
function newer(connection: string, version: unknown): BookkeepingVersionError {
  const readable = [...BOOKKEEPING_READERS.keys()].join(', ');
  return new BookkeepingVersionError(
    'newer',
    connection,
    withCode(
      'D1',
      `The bookkeeping of the database connection "${connection}" is version ${typeof version === 'number' ? version : JSON.stringify(version)}, and this release of Marmeon reads ${readable}: the database was migrated by a newer Marmeon. Update @marmeon/* — nothing of this database is read or changed meanwhile. ${REFUSED}.`,
    ),
  );
}

function unknownMarker(connection: string, marker: string): BookkeepingVersionError {
  return new BookkeepingVersionError(
    'newer',
    connection,
    withCode(
      'D1',
      `The bookkeeping of the database connection "${connection}" holds a marker "${marker}" that this release of Marmeon does not know: a newer Marmeon wrote it. Update @marmeon/*. ${REFUSED}.`,
    ),
  );
}

function incompleteTable(connection: string, table: string, problem: string): BookkeepingVersionError {
  return new BookkeepingVersionError('incomplete', connection, withCode('D1', `The bookkeeping of the database connection "${connection}" is incomplete: ${table} ${problem}. ${REFUSED}.`));
}

/**
 * The version of the bookkeeping on a connection that has a versions table — refused when this release has no reader for it.
 */
export async function bookkeepingVersion(run: CatalogQuery, columns: ReadonlyMap<string, readonly string[]>, connection: string): Promise<number> {
  if (!sameColumns(columns.get(VERSIONS_TABLE), BOOKKEEPING_COLUMNS[VERSIONS_TABLE]!)) throw incompleteTable(connection, VERSIONS_TABLE, 'does not have the columns name and version');
  const rows = await run<{ name: string; version: unknown }>(`select name, version from ${VERSIONS_TABLE}`);
  const row = rows.find((candidate) => candidate.name === 'bookkeeping');
  if (row === undefined) throw incompleteTable(connection, VERSIONS_TABLE, 'has no row for the bookkeeping');
  const version = typeof row.version === 'string' && /^\d+$/.test(row.version) ? Number(row.version) : row.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || !BOOKKEEPING_READERS.has(version)) throw newer(connection, row.version);
  return version;
}

/**
 * The secret columns and markers of a connection, from the bookkeeping of the version it has. Throws a
 * {@link BookkeepingVersionError} for everything it cannot read — only a database no migration ever ran on has nothing.
 */
export async function readBookkeeping(run: CatalogQuery, columns: ReadonlyMap<string, readonly string[]>, connection: string, ignore: ReadonlySet<string> = new Set()): Promise<BookkeepingRows> {
  const state = classify(columns, connection, ignore);
  const refused = unreadable(state, connection);
  if (refused) throw refused;
  if (state.state === 'none') return { secrets: [], markers: [] };
  const version = await bookkeepingVersion(run, columns, connection);
  return BOOKKEEPING_READERS.get(version)!(run, columns, connection);
}

/** Every marker version 1 knows. A new marker restricts or changes something: it comes with a new version, never silently. */
export const MARKER_KINDS = { inverse: true, soft_deletes: true, timestamps: true } satisfies Record<SchemaMarker['marker'], true>;

async function readVersion1(run: CatalogQuery, columns: ReadonlyMap<string, readonly string[]>, connection: string): Promise<BookkeepingRows> {
  // The record of migrations lives on `default` only; without it every migration would run again.
  for (const table of connection === 'default' ? [MIGRATIONS_TABLE, OWNERS_TABLE, SECRETS_TABLE, MARKERS_TABLE] : [OWNERS_TABLE, SECRETS_TABLE, MARKERS_TABLE]) {
    if (!columns.has(table)) throw incompleteTable(connection, table, 'is missing');
    if (!sameColumns(columns.get(table), BOOKKEEPING_COLUMNS[table]!)) throw incompleteTable(connection, table, 'does not have the columns version 1 stands for');
  }
  const secrets = (await run<{ table_name: string; column_name: string }>(`select table_name, column_name from ${SECRETS_TABLE}`)).map((row) => ({ table: row.table_name, column: row.column_name }));
  const markers: SchemaMarker[] = [];
  for (const row of await run<{ table_name: string; column_name: string; marker: string; value: string | null }>(`select table_name, column_name, marker, value from ${MARKERS_TABLE}`)) {
    if (!Object.hasOwn(MARKER_KINDS, row.marker)) throw unknownMarker(connection, row.marker);
    markers.push({ table: row.table_name, column: row.column_name, marker: row.marker as SchemaMarker['marker'], value: row.value });
  }
  const dangling = danglingEntries(columns, { secrets, markers });
  if (dangling.length > 0) throw danglingError(connection, dangling);
  return { secrets, markers };
}

/** The entries of the bookkeeping that point at a table or column that does not exist (any more). */
export function danglingEntries(columns: ReadonlyMap<string, readonly string[]>, { secrets, markers }: BookkeepingRows): string[] {
  const gone: string[] = [];
  for (const { table, column } of secrets) if (!columns.get(table)?.includes(column)) gone.push(`secret column ${table}.${column}`);
  for (const { table, column, marker } of markers) {
    if (!columns.has(table) || (column !== '' && !columns.get(table)!.includes(column))) gone.push(`${marker} marker on ${column === '' ? table : `${table}.${column}`}`);
  }
  return gone;
}

function danglingError(connection: string, dangling: readonly string[]): BookkeepingVersionError {
  return new BookkeepingVersionError(
    'incomplete',
    connection,
    withCode(
      'D1',
      `The bookkeeping of the database connection "${connection}" points at nothing: ${dangling.slice(0, 5).join(', ')}${dangling.length > 5 ? ', …' : ''}. A table or column was renamed or dropped outside the schema builder, so its mark came loose. ${REFUSED}.`,
    ),
  );
}
