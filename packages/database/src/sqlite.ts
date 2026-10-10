import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { SqliteDialect, type SqliteDatabase, type SqliteStatement } from 'kysely';

type Bindable = null | number | bigint | string | Uint8Array;
type Row = Record<string, unknown>;

/**
 * Kysely's `SqliteDialect` on Node's built-in `node:sqlite` — no native addon.
 *
 * Opened lazily on the first query. File databases use WAL (the dev server and a CLI command
 * can work at the same time) and wait up to 5 s for a lock instead of failing at once.
 */
export function createSqliteDialect(path: string): SqliteDialect {
  return new SqliteDialect({
    database: async () => {
      const db = new DatabaseSync(path, { timeout: 5000 });
      if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
      return adaptNodeSqlite(db);
    },
  });
}

/**
 * Adapts `DatabaseSync` to the shape Kysely's `SqliteDialect` expects (better-sqlite3's), and makes values honest both ways.
 * In: node:sqlite reads an object as *named* parameters, so a `Date` would silently store NULL — dates become ISO-8601 UTC,
 * booleans 0/1, and anything else SQLite cannot store throws. Out: columns *declared* `boolean`, `json`/`jsonb` or
 * `numeric(p, s)` come back as `true`/`false`, parsed JSON and `'12.50'`, like on Postgres; unnamed expressions that return
 * a JSON array or object (the subqueries of `jsonArrayFrom`) are parsed too, a declared text column never.
 */
export function adaptNodeSqlite(db: DatabaseSync): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const statement = db.prepare(sql);
      const convert = converters(statement);
      const read = convert ? (row: unknown) => convert(row as Row) : (row: unknown) => row;
      return {
        // better-sqlite3's meaning: the statement returns rows (SELECT, RETURNING, some PRAGMAs).
        reader: statement.columns().length > 0,
        all: (parameters) => statement.all(...bind(parameters)).map(read),
        run: (parameters) => statement.run(...bind(parameters)),
        iterate: (parameters) => statement.iterate(...bind(parameters)).map(read),
      };
    },
  };
}

function bind(parameters: ReadonlyArray<unknown>): Bindable[] {
  return parameters.map((value, index) => {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
    if (value instanceof Uint8Array) return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError(`SQLite cannot bind parameter ${index + 1}: Invalid Date.`);
      return value.toISOString();
    }
    const type = value === undefined ? 'undefined' : ((value as object).constructor?.name ?? typeof value);
    throw new TypeError(
      `SQLite cannot bind parameter ${index + 1} of type ${type}. ` +
        'Pass a string, number, bigint, boolean, Date, Uint8Array or null (JSON: JSON.stringify it).',
    );
  });
}

/** Per statement, once: which result columns need converting — or undefined when none do. */
function converters(statement: StatementSync): ((row: Row) => Row) | undefined {
  const conversions: [string, (value: unknown) => unknown][] = [];
  for (const column of statement.columns()) {
    const declared = column.type?.toLowerCase();
    const decimal = declared && /^(?:numeric|decimal)\(\s*\d+\s*,\s*(\d+)\s*\)$/.exec(declared);
    if (declared === 'boolean' || declared === 'bool') conversions.push([column.name, toBoolean]);
    else if (decimal) conversions.push([column.name, toDecimal(Number(decimal[1]))]);
    else if (declared === 'json' || declared === 'jsonb') conversions.push([column.name, parseJson]);
    else if (declared === undefined || declared === null) conversions.push([column.name, parseJsonExpression]);
  }
  if (conversions.length === 0) return undefined;
  return (row) => {
    for (const [name, convert] of conversions) row[name] = convert(row[name]);
    return row;
  };
}

/** SQLite stores `numeric(p, s)` as a number (so it sorts numerically); read it back like Postgres does: `'12.50'`. */
const toDecimal = (scale: number) => (value: unknown) => (typeof value === 'number' ? value.toFixed(scale) : typeof value === 'bigint' ? `${value}${scale ? `.${'0'.repeat(scale)}` : ''}` : value);
const toBoolean = (value: unknown) => (typeof value === 'number' || typeof value === 'bigint' ? value !== 0 && value !== 0n : value);
const parseJson = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value);
function parseJsonExpression(value: unknown): unknown {
  if (typeof value !== 'string' || (value[0] !== '[' && value[0] !== '{')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
