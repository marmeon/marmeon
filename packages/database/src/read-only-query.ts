import { err, type Result } from '@marmeon/core';
import type { ConnectionOptions } from './config.ts';
import type { Connections } from './connections.ts';
import { queryReadOnlyPgsql } from './read-only-pgsql.ts';
import { queryReadOnlySqlite } from './read-only-sqlite.ts';

/** How one read-only query is run and what of its result is kept. */
export interface ReadOnlyQueryOptions {
  /** Rows returned at most; one more is read to tell whether there were others. */
  readonly limit: number;
  /** Columns the query may never read, by table. */
  readonly secrets: ReadonlyMap<string, ReadonlySet<string>>;
  /** SQLite tables that cannot be read at all: their columns are not known (virtual tables, which may keep a copy of text a table holds). */
  readonly withheld?: ReadonlySet<string>;
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

/** What an answer may weigh in all (as JSON text) before the rest of its rows is left out: what a person or an agent can read, and a process can hold. */
export const MAX_RESULT_CHARS = 4 * 1024 * 1024;

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
  const invalid = limitProblem(options.limit);
  if (invalid) return err({ kind: 'failed', message: invalid });
  let connection: ConnectionOptions;
  let file: string | undefined;
  try {
    connection = connections.options(name);
    file = connections.sqliteFile(name);
  } catch (error) {
    return err({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
  }
  return connection.driver === 'sqlite' ? queryReadOnlySqlite(file, sql, options) : queryReadOnlyPgsql(connection.url, sql, options);
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

/** Why a row limit cannot be used (rows are read until it is reached, so it must be a whole number of at least one), if it cannot. */
export function limitProblem(limit: number): string | undefined {
  return Number.isSafeInteger(limit) && limit >= 1 ? undefined : `The row limit must be a whole number of at least 1, not ${String(limit)}.`;
}
