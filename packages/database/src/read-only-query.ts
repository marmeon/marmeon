import { err, type Result } from '@marmeon/core';
import type { Connections } from './connections.ts';
import { queryReadOnlySqlite } from './read-only-sqlite.ts';

/** How one read-only query is run and what of its result is kept. */
export interface ReadOnlyQueryOptions {
  /** Rows returned at most; one more is read to tell whether there were others. */
  readonly limit: number;
  /** Columns the query may never read, by table. */
  readonly secrets: ReadonlyMap<string, ReadonlySet<string>>;
  /** Masks what a string cell holds that the app's redaction knows (tokens, secrets in text). */
  readonly redact: (text: string) => string;
  /** How long Postgres may work on the query before it gives up. SQLite has no interrupt: there the caller's process limit is the bound. */
  readonly timeoutMs: number;
}

export interface ReadOnlyQueryResult {
  readonly columns: { readonly name: string; readonly type: string | null }[];
  readonly rows: unknown[][];
  /** There were more rows than `limit`. */
  readonly truncated: boolean;
  /** Cells whose text was cut at {@link MAX_CELL_LENGTH}. */
  readonly cut: number;
}

/** `refused`: the statement is not a plain read or reads what is withheld; `failed`: the database could not run it. */
export interface ReadOnlyQueryRefusal {
  readonly kind: 'refused' | 'failed';
  readonly message: string;
}

/** Longest text a cell keeps. */
export const MAX_CELL_LENGTH = 4096;

/**
 * Answers one query on a connection of its own (never the app's pool), and the database itself keeps it read-only.
 * @internal
 */
export async function readOnlyQuery(
  connections: Connections,
  name: string,
  sql: string,
  options: ReadOnlyQueryOptions,
): Promise<Result<ReadOnlyQueryResult, ReadOnlyQueryRefusal>> {
  let driver: string;
  let file: string | undefined;
  try {
    driver = connections.options(name).driver;
    file = connections.sqliteFile(name);
  } catch (error) {
    return err({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
  }
  if (driver === 'sqlite') return queryReadOnlySqlite(file, sql, options);
  return err({ kind: 'failed', message: `Read-only queries on ${driver} are not supported yet.` });
}

/** A cell as JSON can carry it: text masked and cut, bytes by their size, big integers and dates as text. */
export function cellOf(value: unknown, redact: (text: string) => string, onCut: () => void): unknown {
  if (typeof value === 'string') {
    const text = redact(value);
    if (text.length <= MAX_CELL_LENGTH) return text;
    onCut();
    return text.slice(0, MAX_CELL_LENGTH);
  }
  if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  return value;
}
