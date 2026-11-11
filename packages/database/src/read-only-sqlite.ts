import { constants, DatabaseSync } from 'node:sqlite';
import { err, ok, type Result } from '@marmeon/core';
import { cellOf, limitProblem, MAX_RESULT_CHARS, type ReadOnlyQueryOptions, type ReadOnlyQueryRefusal, type ReadOnlyQueryResult } from './read-only-query.ts';
import { fold } from './secret-guard.ts';

// What SQLite lets a query do, by allow-list: whatever the authorizer does not name is denied, so an action a later SQLite adds is
// refused until someone decides about it. `VACUUM` can pass `prepare` without the
// authorizer being asked — the check after `prepare` closes it.
const ALLOWED = new Set<number>([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);
// A string or blob this long is the most a value can be (`zeroblob(900000000)` would fill the memory); the answer of a tool is cut far below it.
const MAX_VALUE_BYTES = 1024 * 1024;
// A row is bounded by SQLite's default of 2000 columns and the caller's process limit; the column limit is not lowered, because
// SQLite applies it while reading the schema and a table with more columns would make the whole database unreadable.
// What a text index keeps its text in (FTS3/4 and FTS5): a secret column of the table is a column of these as well.
const FTS_SHADOWS = ['content', 'data', 'idx', 'docsize', 'config', 'segments', 'segdir', 'stat'];
// Functions that load code or reach into the engine; `enableLoadExtension` stays off as well.
const DENIED_FUNCTIONS = new Set(['load_extension', 'fts3_tokenizer']);

/** Runs `sql` on a read-only connection of its own to the file; `undefined` is an in-memory database, which has no file to open. */
export function queryReadOnlySqlite(
  file: string | undefined,
  sql: string,
  options: ReadOnlyQueryOptions,
): Result<ReadOnlyQueryResult, ReadOnlyQueryRefusal> {
  if (file === undefined) return err({ kind: 'refused', message: 'An in-memory database belongs to the process that opened it: there is nothing to open read-only.' });
  const invalid = limitProblem(options.limit);
  if (invalid) return err({ kind: 'failed', message: invalid });
  const secrets = new Map<string, Set<string>>();
  for (const [table, columns] of options.secrets) secrets.set(fold(table), new Set([...columns].map(fold)));

  const withheld = new Set([...(options.withheld ?? [])].map(fold));

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  } catch (error) {
    return err({ kind: 'failed', message: `Could not open ${file} read-only: ${messageOf(error)}` });
  }
  try {
    db.enableDefensive(true);
    db.limits.length = MAX_VALUE_BYTES;
    let shadows: Set<string>;
    try {
      // One snapshot for the inspection and the query: a migration committed in between cannot leave the checks with an old picture. Before
      // the authorizer, which would refuse it; the statement of a caller that begins is refused by the authorizer all the same.
      db.exec('begin');
      shadows = withheldBeyondTheMigrations(db, secrets);
    } catch (error) {
      // Not read rather than read unchecked: a file that is no database, or one another process holds.
      return err({ kind: 'failed', message: `Could not inspect ${file}: ${messageOf(error)}` });
    }
    let selected = false;
    let reason: string | undefined;
    db.setAuthorizer((action, first, second) => {
      // FTS5 asks for the data version of the database whenever it is read.
      if (action === constants.SQLITE_PRAGMA && first === 'data_version' && second === null) return constants.SQLITE_OK;
      if (!ALLOWED.has(action)) {
        reason ??= 'Only a plain SELECT can run here: this statement changes or configures the database.';
        return constants.SQLITE_DENY;
      }
      if (action === constants.SQLITE_SELECT) selected = true;
      if (action === constants.SQLITE_READ) {
        const table = fold(first ?? '');
        if (table.startsWith('sqlite_stat')) {
          reason ??= `${first} holds samples of the data and cannot be read.`;
          return constants.SQLITE_DENY;
        }
        if (withheld.has(table)) {
          reason ??= `${first} is not described by the migrations and cannot be read.`;
          return constants.SQLITE_DENY;
        }
        if (shadows.has(table)) {
          reason ??= `${first} keeps the text of a secret column and cannot be read.`;
          return constants.SQLITE_DENY;
        }
        if (second !== null && secrets.get(table)?.has(fold(second))) {
          reason ??= `${first}.${second} is a secret column: name the columns you need instead of *.`;
          return constants.SQLITE_DENY;
        }
      }
      if (action === constants.SQLITE_FUNCTION && DENIED_FUNCTIONS.has(fold(second ?? ''))) {
        reason ??= `${second}() is not available here.`;
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });

    let statement;
    try {
      statement = db.prepare(sql);
    } catch (error) {
      return err({ kind: reason === undefined ? 'failed' : 'refused', message: reason ?? messageOf(error) });
    }
    const columns = statement.columns();
    // `VACUUM INTO` writes a file although the connection is read-only, and the authorizer may not be asked about it at prepare time: no SELECT, no columns.
    if (!selected || columns.length === 0) return err({ kind: 'refused', message: 'Only a single SELECT that returns columns can run here.' });
    // A comment after the statement belongs to it (`select 1 -- x` runs); one after a `;` is a statement of its own and is refused.
    // `prepare` compiles the first statement and drops the rest without a word.
    if (!sql.startsWith(statement.sourceSQL) || !/^[\s;]*$/.test(sql.slice(statement.sourceSQL.length))) {
      return err({ kind: 'refused', message: 'Only one statement can run at a time.' });
    }

    // Integers beyond 2^53 would throw as numbers: read as bigint, give back a number where it is exact and text where it is not.
    statement.setReturnArrays(true);
    statement.setReadBigInts(true);
    const rows: unknown[][] = [];
    let cut = 0;
    let bytes = 0;
    let truncated = false;
    try {
      for (const row of statement.iterate() as Iterable<unknown[]>) {
        if (rows.length === options.limit) {
          truncated = true;
          break;
        }
        let cutHere = 0;
        const cells = row.map((cell) => cellOf(integer(cell), options.redact, () => cutHere++));
        // The first row always stays; after it the answer stops where the cap is reached, so a wide result is never held whole.
        const size = JSON.stringify(cells).length;
        if (rows.length > 0 && bytes + size > MAX_RESULT_CHARS) {
          truncated = true;
          break;
        }
        rows.push(cells);
        bytes += size;
        cut += cutHere;
      }
    } catch (error) {
      return err({ kind: reason === undefined ? 'failed' : 'refused', message: reason ?? messageOf(error) });
    }
    return ok({ columns: columns.map((column) => ({ name: column.name, type: column.type })), rows, truncated, cut });
  } finally {
    try {
      db.exec('rollback');
    } catch {
      // No transaction open (the begin failed): nothing to end; closing the connection ends whatever is left.
    }
    db.close();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integer(cell: unknown): unknown {
  return typeof cell === 'bigint' && cell >= BigInt(Number.MIN_SAFE_INTEGER) && cell <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cell) : cell;
}

/**
 * A generated column computes from other columns, so `g as (upper(password))` hands out the secret under another name: every
 * generated column of a table with a secret column counts as secret (added to `secrets`). Returns the shadow tables of the FTS
 * tables with a secret column, which hold its text. Fail closed: a table that cannot be inspected is not read.
 */
function withheldBeyondTheMigrations(db: DatabaseSync, secrets: Map<string, Set<string>>): Set<string> {
  const shadows = new Set<string>();
  const virtual = db.prepare("select name, sql from sqlite_master where type = 'table' and sql like 'create virtual table%'").all() as { name: string; sql: string }[];
  // Text indexes, with the table they index when it is not their own storage (`content='users'`): a MATCH on one asks whether
  // a word is in the text, so an index over a secret column is withheld whole, shadow tables and all.
  const fts = new Map<string, (string | null)[]>();
  // The only `content=` taken as safe names one of these: an ordinary table. A view (even over harmless columns: its dependencies are not
  // followed), a missing name or another virtual table is withheld.
  const ordinary = new Set(
    (db.prepare("select name from sqlite_master where type = 'table' and sql not like 'create virtual table%'").all() as { name: string }[]).map((row) => fold(row.name)),
  );
  // The tables an FTS table keeps its text in are ordinary tables to SQLite, but never a safe `content=`: they hold what an index over a
  // secret column holds.
  for (const row of virtual) {
    const using = /\busing\s+fts[345]\s*\(/i.exec(row.sql);
    if (!using) continue;
    fts.set(fold(row.name), contentOf(row.sql.slice(using.index + using[0].length)));
    for (const suffix of FTS_SHADOWS) ordinary.delete(`${fold(row.name)}_${suffix}`);
  }
  const withhold = (table: string) => {
    for (const suffix of FTS_SHADOWS) shadows.add(`${table}_${suffix}`);
  };
  for (const [table, columns] of secrets) {
    for (const column of db.prepare('select name, hidden from pragma_table_xinfo(?)').all(table) as { name: string; hidden: number }[]) {
      if (column.hidden === 2 || column.hidden === 3) columns.add(fold(column.name));
    }
  }
  for (const [table, content] of fts) {
    if (secrets.has(table)) withhold(table);
    // Its own columns are the secret ones of another table, under names the migrations do not know: all of it is withheld.
    // `null`: a `content=` that could not be read, or one that names no ordinary table: withheld, since it may reach a secret column.
    else if (content.some((name) => name === null || secrets.has(name) || !ordinary.has(name))) {
      shadows.add(table);
      withhold(table);
    }
  }
  return shadows;
}

/**
 * The tables an FTS table indexes, from its arguments (`content=users`, quoted with `'…'`, `"…"`, backticks or `[…]`, folded): every
 * `content=` counts, and `null` stands for one that cannot be read. Empty when it has none of its own to name (it keeps its text
 * itself, or is contentless). A query on FTS4 with `content=<table>` is refused anyway on a read-only connection.
 */
function contentOf(args: string): (string | null)[] {
  const names: (string | null)[] = [];
  for (const start of args.matchAll(/\bcontent\s*=\s*/gi)) {
    const value = /^(?:'((?:[^']|'')*)'|"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|([^\s,)'"`[\]]+))/.exec(args.slice(start.index + start[0].length));
    if (!value) {
      names.push(null);
      continue;
    }
    const [, single, double, tick, bracket, bare] = value;
    const name = single?.replaceAll("''", "'") ?? double?.replaceAll('""', '"') ?? tick?.replaceAll('``', '`') ?? bracket ?? bare ?? '';
    if (name !== '') names.push(fold(name));
  }
  return names;
}
