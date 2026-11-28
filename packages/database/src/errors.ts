import { translatable, ValidationError } from '@marmeon/router';
import { isMysqlDuplicate, notedColumns } from './mysql-duplicates.ts';

/**
 * Whether `error` is a unique-constraint violation — SQLite (`SQLITE_CONSTRAINT_UNIQUE`, 2067),
 * Postgres (SQLSTATE 23505) or MySQL (errno 1062 or 1586, SQLSTATE 23000). Repositories have `tryInsert()` for the common case. Inside a
 * transaction, catch it outside a nested `transaction()`, never inside it: on Postgres the failed statement
 * aborts that transaction, which then rolls back and throws `TransactionError` (D24). See
 * `docs/transactions.md#nested-transactions`.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errcode } = error as { code?: unknown; errcode?: unknown };
  return isMysqlDuplicate(error) || code === '23505' || errcode === 2067 || (code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(String((error as Error).message)));
}

/**
 * The table a statement could not find — SQLite (`no such table: users`), Postgres (SQLSTATE 42P01, `relation "users"
 * does not exist`) or MySQL (errno 1146, `Table 'app.users' doesn't exist`) — or undefined for any other error. Mostly a migration
 * that has not run (the error page says which).
 */
export function missingTable(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message, errno, sqlMessage } = error as { code?: unknown; message?: unknown; errno?: unknown; sqlMessage?: unknown };
  if (errno === 1146 && typeof sqlMessage === 'string') return /^Table '(.+)' doesn't exist$/.exec(sqlMessage)?.[1]?.split('.').slice(1).join('.') || 'unknown';
  if (typeof message !== 'string') return undefined;
  if (code === '42P01') return /relation "([^"]+)" does not exist/.exec(message)?.[1] ?? 'unknown';
  // Only node:sqlite's own error: another driver's message can carry a caller's value, such as a MySQL duplicate's.
  if (code !== 'ERR_SQLITE_ERROR') return undefined;
  return /no such table: ([\w.]+)/.exec(message)?.[1];
}

/**
 * The columns of a unique violation, as far as the driver tells: Postgres's `detail` (`Key (email)=(…) already exists.`, an
 * expression index names its columns inside: `Key (lower(email::text))`) or its constraint's name, SQLite's message
 * (`UNIQUE constraint failed: users.team_id, users.email`, or the index: `index 'users_email_unique'`). Words, not a parser:
 * `failOnDuplicate` matches its fields against them. MySQL names only the index: its columns when the error passed the app's connection
 * and the index is the primary key or one a migration describes, else empty. Empty for anything else.
 */
export function uniqueViolationColumns(error: unknown): string[] {
  if (!isUniqueViolation(error)) return [];
  // No table check, as with Postgres's `detail`: a field matches the columns an error names, and a trigger's index of another table is the caller's to know.
  if (isMysqlDuplicate(error)) return [...(notedColumns(error) ?? [])];
  const { detail, constraint, message } = error as { detail?: unknown; constraint?: unknown; message?: unknown };
  const words = (text: string) => text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const key = typeof detail === 'string' ? /^Key \((.+?)\)=\(/.exec(detail)?.[1] : undefined;
  if (key !== undefined) return words(key);
  const failed = typeof message === 'string' ? /UNIQUE constraint failed: (.+)$/m.exec(message)?.[1] : undefined;
  if (failed !== undefined) {
    const index = /^index '(.+)'$/.exec(failed.trim())?.[1];
    return index !== undefined ? index.split('_') : failed.split(',').map((column) => column.trim().split('.').pop()!);
  }
  return typeof constraint === 'string' ? constraint.split('_') : [];
}

/** The `unique` rule's message of @marmeon/validation — English without a translator. */
const DUPLICATE = 'The {attribute} has already been taken.';

/**
 * Runs `work` — an insert or an update — and turns a violation of a unique index on one of `fields` into a **422 at that field**,
 * with the message of the `unique` rule of @marmeon/validation (`marmeon.validation.unique`, in the request's language): the rule
 * gives the friendly message before the insert, the index is the truth when two requests race past it. A violation of another
 * index stays what it is (a 500 — a bug, not the user's input). `fields` maps columns to form fields when their names differ;
 * `input` goes back to the form for `old()`. See `docs/validation.md#the-unique-index-is-the-truth`.
 */
export async function failOnDuplicate<T>(fields: string | readonly string[] | Readonly<Record<string, string>>, work: () => Promise<T>, input: Record<string, unknown> = {}): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const byColumn: Readonly<Record<string, string>> =
      typeof fields === 'string' ? { [fields]: fields } : Array.isArray(fields) ? Object.fromEntries(fields.map((field: string) => [field, field])) : (fields as Readonly<Record<string, string>>);
    const columns = uniqueViolationColumns(error);
    const column = Object.keys(byColumn).find((name) => columns.includes(name));
    if (column === undefined) throw error;
    throw duplicate(byColumn[column]!, input);
  }
}

function duplicate(field: string, input: Record<string, unknown>): ValidationError {
  const issue = { message: '', path: [field] };
  issue.message = translatable('marmeon.validation.unique', {}, DUPLICATE)(issue);
  return ValidationError.fromIssues([issue], input);
}
