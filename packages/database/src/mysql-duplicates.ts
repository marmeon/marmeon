import type { SchemaMetadata } from './metadata.ts';

// MySQL's duplicate-key error names the index (`Duplicate entry '<value>' for key '<table>.<index>'`), never its columns. The columns are
// found by the index's exact name in what the migrations describe, and only for an error that passed the app's connection.

/** @internal MySQL's `ER_DUP_ENTRY`. */
export const ERRNO_DUP_ENTRY = 1062;
/** @internal MySQL's `ER_DUP_ENTRY_WITH_KEY_NAME`. */
export const ERRNO_DUP_ENTRY_WITH_KEY_NAME = 1586;

/** @internal Whether `error` is MySQL's duplicate-key error: errno 1062 or 1586 with SQLSTATE 23000. */
export function isMysqlDuplicate(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { errno, sqlState } = error as { errno?: unknown; sqlState?: unknown };
  return (errno === ERRNO_DUP_ENTRY || errno === ERRNO_DUP_ENTRY_WITH_KEY_NAME) && sqlState === '23000';
}

/**
 * @internal The table and index a MySQL duplicate-key error names, or undefined when the text does not end in exactly `for key
 * '<table>.<index>'`. The value before it is caller data and can hold `' for key '…` itself, so only the end of the text counts.
 */
export function mysqlDuplicateKey(error: unknown): { readonly table: string; readonly index: string } | undefined {
  if (!isMysqlDuplicate(error)) return undefined;
  const { sqlMessage, message } = error as { sqlMessage?: unknown; message?: unknown };
  const text = typeof sqlMessage === 'string' ? sqlMessage : message;
  if (typeof text !== 'string') return undefined;
  const key = / for key '([^']*)'$/.exec(text)?.[1];
  if (key === undefined) return undefined;
  const parts = key.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return undefined;
  return { table: parts[0]!, index: parts[1]! };
}

/**
 * @internal The columns of the primary key (`PRIMARY`) or of the unique index of exactly that name a migration describes; undefined otherwise.
 * A partial index is skipped: it identifies no row of the table. The arrays are the metadata's own, shared by every request: copy before handing them out.
 */
export function uniqueIndexColumns(metadata: SchemaMetadata, table: string, index: string): readonly string[] | undefined {
  if (index === 'PRIMARY') return metadata.primaryKeys.get(table);
  const found = metadata.projection?.tables.get(table)?.indexes.find((candidate) => candidate.unique && candidate.where === undefined && candidate.name === index);
  return found?.columns;
}

const noted = new WeakMap<object, readonly string[]>();

/** @internal Remembers the columns of a MySQL duplicate-key error whose index is known, for {@link notedColumns}. Nothing is written onto the error. */
export function noteMysqlDuplicate(error: unknown, metadata: SchemaMetadata): void {
  const key = mysqlDuplicateKey(error);
  if (!key) return;
  const columns = uniqueIndexColumns(metadata, key.table, key.index);
  if (columns) noted.set(error as object, columns);
}

/**
 * @internal The columns {@link noteMysqlDuplicate} remembered for `error` — the metadata's own array, so copy it before handing it out. The table is not compared: as with Postgres's `detail`, a
 * field of `failOnDuplicate` is matched against the columns the error names, whichever table's index it was (a repository does compare).
 */
export function notedColumns(error: unknown): readonly string[] | undefined {
  return typeof error === 'object' && error !== null ? noted.get(error) : undefined;
}
