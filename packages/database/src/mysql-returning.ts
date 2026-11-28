import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { withCode } from '@marmeon/core/internal';
import type { Connection } from './builder.ts';
import type { SchemaMetadata } from './metadata.ts';
import { mysqlDuplicateKey } from './mysql-duplicates.ts';
import { UnsupportedDriverError } from './supported-driver.ts';

// MySQL has no RETURNING. A write returns its row by reading it back by the primary key, in the transaction (or savepoint) the write ran
// in, so the row read is the row written: the key comes from the insert's own answer, from the row itself, or is drawn here.

const PLAIN = 'a key value must be null, a string, a number, a bigint, a boolean, a Date or bytes';

function refuse(message: string): never {
  throw new UnsupportedDriverError(withCode('D29', `${message} See docs/queries.md#writing-on-mysql.`));
}

/** @internal A UUIDv7 in the layout of the column default `useUuidv7()` makes on MySQL: the time in milliseconds, version `7`, variant `8`..`b`, lower case. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let milliseconds = BigInt(now);
  for (let at = 5; at >= 0; at--) {
    bytes[at] = Number(milliseconds & 0xffn);
    milliseconds >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** @internal The primary key a write is read back by, and which of its columns the database or this module can fill. */
export interface ReadBackKey {
  readonly table: string;
  readonly columns: readonly string[];
  /** The auto-incrementing key column, when the key has one. */
  readonly identity: string | undefined;
  /** The key columns whose default is a UUIDv7. */
  readonly uuidv7: ReadonlySet<string>;
  /** Every column of the table, as the connection knows them. */
  readonly known: ReadonlySet<string>;
}

/** @internal The key of `table`, refusing (D29) a table without a primary key Marmeon knows. Nothing is sent before this. */
export function readBackKey(metadata: SchemaMetadata, table: string, method: string): ReadBackKey {
  const columns = metadata.primaryKeys.get(table);
  if (columns === undefined || columns.length === 0) {
    return refuse(`${method}() on MySQL reads the row back by its primary key, and ${table} has none that Marmeon knows: give the table a primary key in its migration, or write with the query builder and read the row yourself.`);
  }
  const known = metadata.projection?.tables.get(table)?.columns.filter((column) => columns.includes(column.name)) ?? [];
  return {
    table,
    columns: [...columns],
    identity: known.find((column) => column.identity)?.name,
    uuidv7: new Set(known.filter((column) => column.default === 'uuidv7').map((column) => column.name)),
    known: new Set(metadata.kinds.get(table)?.keys()),
  };
}

/** @internal Whether `value` is one whose value Marmeon knows: an expression's is not, so it cannot be read back by. */
function isPlainKeyValue(value: unknown): boolean {
  return value === null || ['string', 'number', 'bigint', 'boolean'].includes(typeof value) || value instanceof Date || value instanceof Uint8Array;
}

/**
 * @internal Refuses (D29) a property name that MySQL could take for a key column of another spelling. MySQL names columns without
 * regard to case, and its folding is not JavaScript's (`İd` is `id` to it), so the rule is not to imitate it: an ASCII name is compared
 * without case, and a name with any other character must be exactly a column of the table.
 */
export function checkNames(key: ReadBackKey, names: readonly string[], method: string): void {
  for (const name of names) {
    if ([...name].some((character) => character.charCodeAt(0) > 0x7f)) {
      if (!key.known.has(name)) refuse(`${method}() on MySQL reads the row back by its primary key, and ${key.table} has no column named ${JSON.stringify(name)}: MySQL may take it for another spelling of a key column.`);
      continue;
    }
    const column = key.columns.find((candidate) => candidate !== name && candidate.toLowerCase() === name.toLowerCase());
    if (column !== undefined) refuse(`${method}() on MySQL reads the row back by ${key.table}.${column}, and the values name it as ${name}: write the column's name as the table has it.`);
  }
}

/** @internal Refuses (D29) a key set to something that is no plain value. */
export function checkPlainKeyValue(key: Pick<ReadBackKey, 'table'>, column: string, value: unknown, method: string): void {
  if (!isPlainKeyValue(value)) refuse(`${method}() on MySQL reads the row back by ${key.table}.${column}, which was given an expression or object: ${PLAIN}.`);
}

/**
 * @internal A copy of `row` that is ready to insert: an absent key column is left to the database (the identity) or filled with a
 * UUIDv7 (its default's column); any other absent key column, or one set to a non-plain value, is refused (D29) before a statement.
 */
export function keyedRow(key: ReadBackKey, row: Record<string, unknown>, method: string): Record<string, unknown> {
  const copy = { ...row };
  checkNames(key, Object.keys(copy), method);
  for (const column of key.columns) {
    if (column === key.identity) checkIdentityValue(key, copy[column], method);
    if (copy[column] === undefined) {
      if (column === key.identity) continue;
      if (key.uuidv7.has(column)) {
        copy[column] = uuidv7();
        continue;
      }
      refuse(`${method}() on MySQL reads the row back by its primary key, and ${key.table} has no value for its key column ${column}, which nothing generates that Marmeon can read back: give it a value.`);
    }
    checkPlainKeyValue(key, column, copy[column], method);
  }
  return copy;
}

/**
 * An identity column is left to MySQL (absent, `null` or `0`) or is a canonical positive integer. Anything else is read as a number by
 * MySQL and by `insertId` differently (`'0600'` is 600, `-600` and `600.4` are not ids of their own), so the id written could not be
 * checked against the one the insert answered.
 */
function checkIdentityValue(key: ReadBackKey, value: unknown, method: string): void {
  if (value === undefined || value === null || value === 0 || value === 0n || positive(value) !== undefined) return;
  refuse(`${method}() on MySQL reads the row back by ${key.table}.${key.identity}, which was given a value that is neither empty, 0 nor a positive whole number in its plain form: pass the id as a number.`);
}

/** The positive integer `value` stands for, when it is one. */
function positive(value: unknown): bigint | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : undefined;
  if (typeof value === 'bigint') return value > 0n ? value : undefined;
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? BigInt(value) : undefined;
}

/**
 * @internal Inserts `row` and answers the values of its primary key. The key is the insert's `insertId` for the identity column (MySQL
 * answers with the stored value, also for an explicit `0` or `null`), the row's own value for any other. The caller holds a transaction or
 * a savepoint: a failure after this insert has to undo it.
 */
export async function insertKeyed(db: Connection<any>, key: ReadBackKey, row: Record<string, unknown>, method: string): Promise<Record<string, unknown>> {
  const result = await db.insertInto(key.table).values(row).executeTakeFirst();
  const values: Record<string, unknown> = {};
  for (const column of key.columns) {
    if (column !== key.identity) {
      values[column] = row[column];
      continue;
    }
    if (result.insertId === undefined) throw new Error(`${method}() on MySQL got no id from the insert into ${key.table}, so it cannot read the row back.`);
    const given = positive(row[column]);
    // An expression elsewhere in the statement called `last_insert_id(…)`: the answer is not this row's key.
    if (given !== undefined && given !== result.insertId) {
      throw new Error(`${method}() on MySQL got an id from the insert into ${key.table} that is not the one it was given, so it cannot read the row back.`);
    }
    values[column] = result.insertId;
  }
  return values;
}

/** @internal {@link insertKeyed}, then the row read back by that key: every column, or the `select` ones. */
export async function insertAndRead(
  db: Connection<any>,
  key: ReadBackKey,
  row: Record<string, unknown>,
  select: readonly string[] | 'all',
  method: string,
): Promise<Record<string, unknown>> {
  return readByKey(db, key, await insertKeyed(db, key, row, method), select, method);
}

/**
 * @internal The names of the unique indexes of `table` over exactly `columns`: `PRIMARY` for the primary key, and every index a migration
 * describes that is unique, not partial and has those columns (two equal indexes are both named: MySQL may report either).
 */
export function uniqueIndexNames(metadata: SchemaMetadata, table: string, columns: readonly string[]): ReadonlySet<string> {
  const wanted = new Set(columns);
  const same = (candidate: readonly string[]) => new Set(candidate).size === wanted.size && candidate.every((column) => wanted.has(column));
  const names = new Set<string>();
  const primary = metadata.primaryKeys.get(table);
  if (primary !== undefined && primary.length > 0 && same(primary)) names.add('PRIMARY');
  for (const index of metadata.projection?.tables.get(table)?.indexes ?? []) {
    if (index.unique && index.where === undefined && same(index.columns)) names.add(index.name);
  }
  return names;
}

/** @internal Refuses (D29) an `on` no known unique index backs, on a connection that reads no migrations and so knows only the primary key's index. */
export function refuseUnmanagedOn(table: string, method: string): never {
  return refuse(`${method}() on MySQL matches on columns that are no unique index Marmeon knows: on a connection with managed: false it knows only the primary key's index of ${table}, so it cannot tell a row that is there from another duplicate. Match on the primary key.`);
}

/**
 * @internal Whether `error` is MySQL's duplicate-key error of `table` on one of the indexes `names`. Only the index named at the end of
 * the message counts, by exact equality: a duplicate on any other index is a different fault that must not be skipped.
 */
export function isDuplicateOn(error: unknown, table: string, names: ReadonlySet<string>): boolean {
  const key = mysqlDuplicateKey(error);
  return key !== undefined && key.table === table && names.has(key.index);
}

/**
 * The text a primitive `on` value is compared by: text as it is, a bigint or a whole number within 2^53 as its integer text (`5` is `'5'`,
 * never `'05'`), `true` and `false` as `'1'` and `'0'`. A `Date`, bytes, an object and a number that is not a whole number within 2^53 have none:
 * they are never skipped.
 */
function exactText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? '1' : '0';
  return undefined;
}

/**
 * @internal Whether a duplicate `error` of `table` is one `insertMissing()` may skip. MySQL names only the first index a row violates (the
 * primary key, then the unique indexes in key order), so a row that is there already can also clash on an index before the one over `on`.
 * The duplicate is then skipped only when the table holds a row whose `on` values equal this row's exactly: read in the same transaction,
 * no soft-delete filter, bound as their exact text (an exact lookup on the unique index, which returns at most one row, so no limit can cut it off)
 * and compared here again, since MySQL treats `5` and `'05'` alike. A value without an exact text (see `exactText`) or an error that is not a
 * duplicate of this table means no skip. A failing read throws, with the duplicate as its `cause` when the error has none: a deadlock must reach the caller.
 */
export async function skipsDuplicate(
  db: Connection<any>,
  error: unknown,
  table: string,
  names: ReadonlySet<string>,
  on: readonly string[],
  row: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (isDuplicateOn(error, table, names)) return true;
  if (mysqlDuplicateKey(error)?.table !== table) return false;
  const wanted = on.map((column) => exactText(row[column]));
  if (wanted.includes(undefined)) return false;
  try {
    let query = db.selectFrom(table).select(on as string[]);
    on.forEach((column, at) => (query = query.where(column, '=', wanted[at])));
    const found = (await query.forShare().execute()) as Record<string, unknown>[];
    return found.some((candidate) => on.every((column, at) => exactText(candidate[column]) === wanted[at]));
  } catch (readError) {
    if (typeof readError === 'object' && readError !== null && !('cause' in readError)) (readError as { cause?: unknown }).cause = error;
    throw readError;
  }
}

/**
 * @internal Refuses (a `TypeError`, like a null) an `on` value MySQL would replace by a generated id, so the row would be written on every run: `0`,
 * `'0'`, `0.4`, `false` or non-numeric text in an auto-increment column. On a connection with `managed: false` every primary key column counts, as Marmeon cannot tell a key
 * column from an auto-increment one there (a column's kind does not: MySQL's text and float columns read as `other`).
 */
export function checkOnIdentity(metadata: SchemaMetadata, table: string, on: readonly string[], rows: readonly Record<string, unknown>[], method: string): void {
  const generated = metadata.managed
    ? (metadata.projection?.tables.get(table)?.columns.filter((column) => column.identity).map((column) => column.name) ?? [])
    : (metadata.primaryKeys.get(table) ?? []);
  for (const column of on.filter((candidate) => generated.includes(candidate))) {
    rows.forEach((row, index) => {
      if (positive(row[column]) !== undefined) return;
      throw new TypeError(
        metadata.managed
          ? `${method}() matches on ${column}, an auto-increment column on MySQL, but row ${index} has a value for it that is not a positive whole number: MySQL would replace it with a new id, so the row would be written again on every run.`
          : `${method}() matches on ${column}, which is a primary key column that Marmeon cannot tell from an auto-increment one on a connection with managed: false, and row ${index} has a value for it that is not a positive whole number: pass a positive whole number, or match on a migration-managed connection.`,
      );
    });
  }
}

/**
 * @internal The row of `key.table` with these key values — no soft-delete filter, the row is the one written — exactly one, else an
 * error that the caller's transaction rolls back. MySQL compares a number with text loosely (`5` equals `'05'`), so more than one row is possible.
 */
export async function readByKey(
  db: Connection<any>,
  key: ReadBackKey,
  values: Readonly<Record<string, unknown>>,
  select: readonly string[] | 'all',
  method: string,
): Promise<Record<string, unknown>> {
  let query = select === 'all' ? db.selectFrom(key.table).selectAll() : db.selectFrom(key.table).select(select as string[]);
  for (const column of key.columns) query = query.where(column, '=', values[column]);
  const rows = (await query.execute()) as Record<string, unknown>[];
  if (rows.length === 0) {
    throw new Error(`${method}() on MySQL found no row of ${key.table} by the key it wrote, so the write was rolled back: the row's key is no longer the one it was written with (a trigger changed it, or MySQL stored the value in another form, such as a rounded datetime or decimal).`);
  }
  if (rows.length !== 1) {
    throw new Error(
      `${method}() on MySQL found ${rows.length} rows of ${key.table} by its primary key, so the write was rolled back: a key compared with a value of another type matches more than one row on MySQL (a number against text); pass the key in the column's type.`,
    );
  }
  return rows[0]!;
}

let savepoints = 0;

/**
 * @internal Runs `work` all or nothing for a caller that has no repository (a factory): a savepoint on a connection that is a
 * transaction, else a transaction of its own — which the driver turns into a savepoint inside an ambient transaction or `isolate()`.
 */
export async function atomically<R>(db: Connection<any>, work: (db: Connection<any>) => Promise<R>): Promise<R> {
  if (!db.isTransaction) return db.transaction().execute(work as never) as Promise<R>;
  const name = sql.raw(`mysql_write_savepoint_${++savepoints}`);
  await sql`savepoint ${name}`.execute(db);
  try {
    const result = await work(db);
    await sql`release savepoint ${name}`.execute(db);
    return result;
  } catch (error) {
    await sql`rollback to savepoint ${name}`.execute(db);
    throw error;
  }
}
