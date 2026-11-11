import type { Client, FieldDef } from 'pg';
import { err, ok, type Result } from '@marmeon/core';
import { fold } from './secret-guard.ts';
import { calledNames, checkPlan, readPlan, type FunctionFact, type PlanFacts } from './pg-plan-guard.ts';
import { importPg, postgresConnection } from './postgres.ts';
import { cellOf, limitProblem, MAX_CELL_LENGTH, type ReadOnlyQueryOptions, type ReadOnlyQueryRefusal, type ReadOnlyQueryResult } from './read-only-query.ts';

const APPLICATION_NAME = 'marmeon-db-query';
const SHAPE = 'Only one SELECT, WITH … SELECT, VALUES or TABLE query can run here.';

// Text-like columns are cut in the database: `repeat('x', 500000000)` would otherwise be sent whole to a process that cuts it afterwards.
const TEXT_TYPES = new Set([25, 1042, 1043, 114, 142, 3802]);
const BYTEA = 17;
const DATE = 1082;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;
const JSON_TYPE = 114;
const JSONB = 3802;

/**
 * Runs `sql` on a connection of its own to the Postgres database at `url`. Postgres keeps it read-only (a read-only transaction, rolled back),
 * the wrapper `SELECT * FROM (…) LIMIT $1` makes it one query (the extended protocol takes one statement, and a statement that starts
 * so can only be a query), and the plan Postgres deparsed is checked for functions that have effects and for secret columns before the
 * query itself runs.
 */
export async function queryReadOnlyPgsql(url: string, sql: string, options: ReadOnlyQueryOptions): Promise<Result<ReadOnlyQueryResult, ReadOnlyQueryRefusal>> {
  const invalid = limitProblem(options.limit);
  if (invalid) return err({ kind: 'failed', message: invalid });
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) return err({ kind: 'failed', message: 'The time limit must be a whole number of milliseconds of at least 1.' });

  let pg;
  try {
    pg = await importPg();
  } catch (error) {
    return err({ kind: 'failed', message: messageOf(error) });
  }
  const connection = postgresConnection(url);
  const client = new pg.Client({
    ...connection,
    connectionString: withoutApplicationName(connection.connectionString),
    application_name: APPLICATION_NAME,
    // Also asked of the transaction below, which is what holds: these only cover the statements before it.
    options: `${connection.options} -c default_transaction_read_only=on -c statement_timeout=${options.timeoutMs} -c standard_conforming_strings=on`,
    types: {
      getTypeParser: (oid: number, format?: 'text' | 'binary') => {
        // Text as the database writes it: dates and JSON are not parsed (a date would shift with the time zone, and JSON text goes through the redaction like any other).
        if (oid === DATE || oid === TIMESTAMP || oid === TIMESTAMPTZ || oid === JSON_TYPE || oid === JSONB) return (value: string) => value;
        return pg.types.getTypeParser(oid, format);
      },
    },
  });
  // A connection that the server ends while idle emits 'error'; without a listener that ends the process.
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    // Not the driver's message: it names the host and the account.
    return err({ kind: 'failed', message: `Could not connect to the database${typeof code === 'string' ? ` (${code})` : ''}.` });
  }
  try {
    return await run(client, sql, options);
  } catch (error) {
    return err(refusalOf(error, options));
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is gone or the transaction never began: closing it ends whatever is left, advisory locks and all.
    }
    try {
      await client.end();
    } catch {
      // Already closed.
    }
  }
}

async function run(client: Client, sql: string, options: ReadOnlyQueryOptions): Promise<Result<ReadOnlyQueryResult, ReadOnlyQueryRefusal>> {
  // One snapshot for the inspection and the query. The limits are settings of this transaction, over whatever the URL asked for.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
  // `timeoutMs` is for the query as a whole, not for each statement: every statement gets what is left of it.
  const deadline = Date.now() + options.timeoutMs;
  const remaining = async () => {
    const left = Math.floor(deadline - Date.now());
    if (left < 1) throw Object.assign(new Error('the time limit is used up'), { code: '57014' });
    await client.query(`SET LOCAL statement_timeout = ${left}`);
  };

  // A trailing `;` is the one thing a caller may add. Own line, so that a `--` comment at the end cannot take the `)` with it.
  const query = `SELECT * FROM (\n${sql.replace(/;\s*$/, '')}\n) AS marmeon_query LIMIT $1`;
  await remaining();
  const plan = await client.query({ text: `EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) ${query}`, values: [options.limit + 1] });
  // JSON comes back as text (see the type parsers).
  const found = parsedPlan((plan.rows[0] as Record<string, unknown> | undefined)?.['QUERY PLAN']);
  const reading = readPlan(found);
  if (!reading) return err({ kind: 'refused', message: 'Could not read the query plan, so the query cannot be checked.' });
  const problem = checkPlan(found, await factsOf(client, reading, options));
  if (problem) return err({ kind: 'refused', message: problem });

  // The plan is allowed, so the query may run: first to learn the columns, without a row.
  await remaining();
  const head = await client.query({ text: query, values: [0], rowMode: 'array' });
  const fields = head.fields;
  const types = await typeNames(client, fields);
  const projected = projection(fields);
  const text = projected ? `SELECT ${projected.sql} FROM (${query}) AS marmeon_cut(${fields.map((_, index) => `c${index}`).join(', ')})` : query;
  // Fetched in batches from a cursor, so that what the client holds is bounded by what it keeps, not by what the query could return.
  await remaining();
  await client.query({ text: `DECLARE marmeon_rows NO SCROLL CURSOR FOR ${text}`, values: [options.limit + 1] });
  const rows: unknown[][] = [];
  let cut = 0;
  let bytes = 0;
  let truncated = false;
  let batch = 1;
  fetching: while (rows.length <= options.limit) {
    await remaining();
    const page = await client.query({ text: `FETCH FORWARD ${Math.min(batch, options.limit + 1 - rows.length)} FROM marmeon_rows`, rowMode: 'array' });
    if (page.rows.length === 0) break;
    let pageBytes = 0;
    for (const row of page.rows as unknown[][]) {
      if (rows.length === options.limit) {
        truncated = true;
        break fetching;
      }
      let cutHere = 0;
      const cells = row.slice(0, fields.length).map((cell) => deep(cell, options.redact, () => cutHere++));
      // A value replaced for its size counts as cut, like a text that was.
      for (const [position, index] of (projected?.flags ?? []).entries()) {
        if (row[fields.length + position] !== true) continue;
        cells[index] = null;
        cutHere++;
      }
      const size = JSON.stringify(cells).length;
      if (rows.length > 0 && bytes + size > MAX_RESULT_CHARS) {
        truncated = true;
        break fetching;
      }
      rows.push(cells);
      bytes += size;
      pageBytes += size;
      cut += cutHere;
    }
    // Rows of this size, as many as an eighth of the cap: big rows one by one, small ones a hundred at a time.
    batch = Math.max(1, Math.min(100, Math.floor(MAX_RESULT_CHARS / 8 / Math.max(1, pageBytes / page.rows.length))));
  }
  return ok({
    columns: fields.map((field) => ({ name: field.name, type: types.get(field.dataTypeID) ?? null })),
    rows,
    truncated,
    cut,
  });
}

// Types whose values are as small as their type: everything else can hold what a query builds (`array[repeat('x', 100000000)]`).
const FIXED_WIDTH = new Set([16, 18, 19, 20, 21, 23, 26, 700, 701, 1082, 1083, 1114, 1184, 1186, 1266, 2950]);
// What an answer may weigh in all (as JSON text) before the rest of its rows is left out: what a person or an agent can read, and a process can hold.
const MAX_RESULT_CHARS = 4 * 1024 * 1024;
// What a value of another type may weigh in the database before it is replaced: no string in it survives the client's cut of 4096
// characters, so a bigger one only costs transfer and memory.
const MAX_VALUE_BYTES = 64 * 1024;

/**
 * The select list that bounds what a cell can hold, or `undefined` when no column needs it. Text is cut and bytes counted; any other
 * type beyond a fixed width is replaced by NULL above {@link MAX_VALUE_BYTES}, with a flag column after the cells that says so (`flags`
 * holds the column of each). Only plain column references and `left()`, `octet_length()`, `pg_column_size()` of them: nothing the
 * plan check has not seen is called.
 */
function projection(fields: readonly FieldDef[]): { sql: string; flags: number[] } | undefined {
  let changed = false;
  const flags: number[] = [];
  const list = fields.map((field, index) => {
    if (TEXT_TYPES.has(field.dataTypeID)) {
      changed = true;
      return `left(c${index}::text, ${MAX_CELL_LENGTH + 1})`;
    }
    if (field.dataTypeID === BYTEA) {
      changed = true;
      return `'[binary ' || octet_length(c${index}) || ' bytes]'`;
    }
    if (FIXED_WIDTH.has(field.dataTypeID)) return `c${index}`;
    changed = true;
    flags.push(index);
    return `CASE WHEN pg_column_size(c${index}) > ${MAX_VALUE_BYTES} THEN NULL ELSE c${index} END`;
  });
  if (!changed) return undefined;
  return { sql: [...list, ...flags.map((index) => `pg_column_size(c${index}) > ${MAX_VALUE_BYTES}`)].join(', '), flags };
}

function parsedPlan(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function factsOf(client: Client, reading: NonNullable<ReturnType<typeof readPlan>>, options: ReadOnlyQueryOptions): Promise<PlanFacts> {
  const functions = await client.query({
    text: 'SELECT p.proname AS name, n.nspname AS schema, p.provolatile AS volatility FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = ANY($1::text[])',
    values: [calledNames(reading)],
  });
  const scanned = [...new Set(reading.relations.map((relation) => relation.name))];
  const ancestors = await ancestorsOf(client, scanned);
  // A generated column computes from other columns, so it hands out a secret under another name: it is secret as well.
  const secrets = new Map([...options.secrets].map(([table, columns]) => [table, new Set(columns)]));
  const derived = new Map<string, string[]>();
  if (scanned.length > 0) {
    const related = new Set(scanned.flatMap((name) => [name, ...(ancestors.get(fold(name)) ?? [])]));
    const generated = await client.query({
      text: `SELECT c.relname AS relation, a.attname AS column FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        WHERE c.relname = ANY($1::text[]) AND a.attgenerated <> '' AND NOT a.attisdropped`,
      values: [[...related]],
    });
    for (const row of generated.rows as { relation: string; column: string }[]) {
      const name = fold(row.relation);
      for (const table of [name, ...(ancestors.get(name) ?? []).map(fold)]) {
        for (const [key, columns] of secrets) if (fold(key.slice(key.lastIndexOf('.') + 1)) === table) columns.add(row.column);
      }
    }
    // A materialized view keeps a copy of what it reads: found through the definition it depends on, views in between included.
    const copies = await client.query({
      text: `WITH RECURSIVE reach(mv, rel) AS (
        SELECT c.oid, c.oid FROM pg_catalog.pg_class c WHERE c.relkind = 'm' AND c.relname = ANY($1::text[])
        UNION
        SELECT reach.mv, d.refobjid FROM reach
          JOIN pg_catalog.pg_rewrite r ON r.ev_class = reach.rel
          JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass AND d.objid = r.oid AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid <> reach.rel
      )
      SELECT m.relname AS matview, t.relname AS origin FROM reach JOIN pg_catalog.pg_class m ON m.oid = reach.mv JOIN pg_catalog.pg_class t ON t.oid = reach.rel WHERE reach.mv <> reach.rel`,
      values: [scanned],
    });
    const found = copies.rows as { matview: string; origin: string }[];
    // What a matview was built from may be a child table or a partition of a table with secrets.
    const above = await ancestorsOf(client, [...new Set(found.map((row) => row.origin))]);
    for (const row of found) {
      const key = fold(row.matview);
      derived.set(key, [...(derived.get(key) ?? []), row.origin, ...(above.get(fold(row.origin)) ?? [])]);
    }
  }
  return { functions: functions.rows as FunctionFact[], ancestors, derived, secrets };
}

/** Relation name (folded) → the relations it inherits from or is a partition of, transitively, itself included. */
async function ancestorsOf(client: Client, names: readonly string[]): Promise<Map<string, string[]>> {
  const ancestors = new Map<string, string[]>();
  if (names.length === 0) return ancestors;
  const found = await client.query({
    text: `WITH RECURSIVE up(rel, ancestor) AS (
      SELECT c.oid, c.oid FROM pg_catalog.pg_class c WHERE c.relname = ANY($1::text[])
      UNION
      SELECT up.rel, i.inhparent FROM pg_catalog.pg_inherits i JOIN up ON i.inhrelid = up.ancestor
    )
    SELECT r.relname AS relation, a.relname AS ancestor FROM up JOIN pg_catalog.pg_class r ON r.oid = up.rel JOIN pg_catalog.pg_class a ON a.oid = up.ancestor`,
    values: [names],
  });
  for (const row of found.rows as { relation: string; ancestor: string }[]) {
    const key = fold(row.relation);
    ancestors.set(key, [...(ancestors.get(key) ?? []), row.ancestor]);
  }
  return ancestors;
}

async function typeNames(client: Client, fields: readonly FieldDef[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (fields.length === 0) return names;
  const found = await client.query({
    text: 'SELECT oid::int AS oid, pg_catalog.format_type(oid, NULL) AS name FROM pg_catalog.pg_type WHERE oid = ANY($1::oid[])',
    values: [[...new Set(fields.map((field) => field.dataTypeID))]],
  });
  for (const row of found.rows as { oid: number; name: string }[]) names.set(row.oid, row.name);
  return names;
}

/** A cell with every string in it masked and cut, arrays and objects (an interval, a point) included. */
function deep(value: unknown, redact: (text: string) => string, onCut: () => void): unknown {
  if (Array.isArray(value)) return value.map((item) => deep(item, redact, onCut));
  if (value !== null && typeof value === 'object' && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item, redact, onCut)]));
  }
  return cellOf(value, redact, onCut);
}

/** Postgres's own errors, by what they say about the statement: the read-only transaction, the wrapper and a limit reached. */
function refusalOf(error: unknown, options: ReadOnlyQueryOptions): ReadOnlyQueryRefusal {
  const { code } = (error ?? {}) as { code?: unknown };
  const message = options.redact(messageOf(error));
  // Read-only transaction; a statement that is not a query where a query goes (syntax, `WITH` with a write below the top).
  if (code === '25006' || code === '42601' || code === '0A000') return { kind: 'refused', message: `${message}. ${SHAPE}` };
  if (code === '57014') return { kind: 'failed', message: `The query took longer than ${options.timeoutMs} ms and was stopped (${message}).` };
  return { kind: 'failed', message };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The URL without a `application_name` of its own, so that the marker the connection carries is not replaced. */
function withoutApplicationName(connectionString: string): string {
  const parsed = URL.parse(connectionString);
  if (parsed === null || !parsed.searchParams.has('application_name')) return connectionString;
  parsed.searchParams.delete('application_name');
  return parsed.href;
}
