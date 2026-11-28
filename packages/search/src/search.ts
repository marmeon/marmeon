import { afterCommit, err, ok, type Resolver, type Result } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { Connections, Database, sql, type PageMeta, type Paginated } from '@marmeon/database';
import type { DriverQuery, SearchDriver, SearchFailure, SearchKey, StoredDocument } from './driver.ts';
import { DocumentsTooLongError, SearchSetupError } from './errors.ts';
import { WEIGHTS, type IndexInfo, type SearchIndexes } from './registry.ts';
import type { FiltersOf, IndexRowOf, KeyOf, SearchIndex, SearchIndexClass } from './search-index.ts';
import { cleanText, searchText, tokens, type ExcerptSegment, type FilterScalar } from './terms.ts';

/** The most keys one batch reads, writes or queues. */
export const BATCH_SIZE = 500;
/** The most hits a search reaches: `page * perPage` may not pass it, and `total` is capped at it. */
export const MAX_REACHABLE_HITS = 1000;
/** The page size of a search that names none. */
export const DEFAULT_PER_PAGE = 20;
/** The largest page size. */
export const MAX_PER_PAGE = 100;
/** The most characters of field text one document keeps; the rest is cut in the order of the weights. */
export const MAX_DOCUMENT_LENGTH = 200_000;
/** The most characters of a string filter value. */
export const MAX_FILTER_VALUE_LENGTH = 255;
/** The most characters of a string key. */
export const MAX_KEY_LENGTH = 253;
/** The most characters of a locale in its canonical form. */
export const MAX_LOCALE_LENGTH = 35;

const REQUEST_OPTIONS: readonly string[] = ['in', 'term', 'filters', 'locale', 'prefix', 'excerpts', 'page', 'perPage'];
const FAILURE_KINDS: readonly unknown[] = ['unavailable', 'missing-index'];
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/**
 * One search: the index or indexes to look in, the words the user typed, the filters that decide what this user may see, the locale
 * and the page. `filters` takes only names every index declares. See `docs/full-text-search.md#searching`.
 */
export interface SearchRequest<I extends SearchIndexClass> {
  readonly in: I | readonly I[];
  readonly term: string;
  readonly filters?: FiltersOf<I> | undefined;
  /** Narrows to documents of this locale and to documents without one. */
  readonly locale?: string | undefined;
  /** Whether the last word matches as the start of a word (search as you type). Default `false`. */
  readonly prefix?: boolean | undefined;
  /** Whether each hit carries an excerpt of its text with the matches marked. Default `false`. */
  readonly excerpts?: boolean | undefined;
  /** The page, from 1. Default 1. */
  readonly page?: number | undefined;
  /** Hits per page, 1 to 100. Default 20. `page * perPage` is at most 1000. */
  readonly perPage?: number | undefined;
}

/**
 * One hit of a search over the indexes `I`, a union by index: its name, the key of its row, its score (higher is better) and, when
 * asked for, the excerpt as segments of plain text, never HTML.
 */
export type SearchHit<I extends SearchIndexClass> = I extends SearchIndexClass
  ? { readonly index: I['index']; readonly key: KeyOf<I>; readonly score: number; readonly excerpt?: readonly ExcerptSegment[] }
  : never;

/** What `Search.index()` takes for the index `I`: one row or key, or a list of only rows or only keys. */
export type IndexInput<I extends SearchIndexClass> = IndexRowOf<I> | KeyOf<I> | readonly IndexRowOf<I>[] | readonly KeyOf<I>[];

/** The payload of the job `marmeon.search.sync`: the index by name and the keys of the rows to bring over. */
export interface SyncPayload {
  index: string;
  keys: SearchKey[];
}

function setup(message: string): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message));
}

/** A class's name for a message. */
function nameOf(Index: SearchIndexClass): string {
  const { name } = Index as { readonly name?: unknown };
  return typeof name === 'string' && name !== '' ? name : '(unnamed class)';
}

/** What a value is, for a message: never its content beyond a short string. */
function shown(value: unknown): string {
  if (typeof value === 'string') return value.length <= 80 ? JSON.stringify(value) : `${JSON.stringify(value.slice(0, 80))}…`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined || value === null) return String(value);
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a driver can store the string: well-formed Unicode (no lone surrogate) without NUL, which Postgres cannot keep. */
const storable = (text: string): boolean => text.isWellFormed() && !text.includes('\u0000');

/** A key as it is compared and stored: `42` and `"42"` are two keys. */
export const keyId = (key: SearchKey): string => JSON.stringify(key);

/** Checks one key: a string of 1 to 253 characters or a safe integer. */
export function checkKey(value: unknown, where: string): SearchKey {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.length >= 1 && value.length <= MAX_KEY_LENGTH && storable(value)) return value;
  throw new TypeError(`${where} is ${shown(value)}, but a search key is a string of 1 to ${MAX_KEY_LENGTH} characters (well-formed, without NUL) or a safe integer.`);
}

/**
 * A locale in its canonical form (`pt-br` → `pt-BR`); a tag that is no language tag, or whose canonical form is longer than 35
 * characters (the width of the stored locale), is a `TypeError`.
 */
export function canonicalLocale(value: unknown, where: string): string {
  if (typeof value === 'string' && LOCALE.test(value)) {
    try {
      const [canonical] = Intl.getCanonicalLocales(value);
      if (canonical !== undefined && canonical.length <= MAX_LOCALE_LENGTH) return canonical;
    } catch {
      // falls through to the refusal below
    }
  }
  throw new TypeError(`${where} is ${shown(value)}, but a locale is a language tag such as "en" or "pt-BR", at most ${MAX_LOCALE_LENGTH} characters in its canonical form.`);
}

/** Checks one filter value: a string of at most 255 characters, a finite number or a boolean. */
function checkFilterScalar(value: unknown, where: string): FilterScalar {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= MAX_FILTER_VALUE_LENGTH && storable(value)) return value;
  throw new TypeError(`${where} is ${shown(value)}, but a filter value is a string of at most ${MAX_FILTER_VALUE_LENGTH} characters (well-formed, without NUL), a finite number or a boolean.`);
}

/** The first `max` code points of `text`, and how many code points that is. */
function cutText(text: string, max: number): { readonly text: string; readonly length: number } {
  let end = 0;
  let count = 0;
  for (const char of text) {
    if (count === max) return { text: text.slice(0, end), length: count };
    end += char.length;
    count += 1;
  }
  return { text, length: count };
}

/**
 * Checks what `toDocument()` returned and turns it into what a driver stores: only declared fields and filters, texts cleaned and
 * cut to 200 000 characters in all in the order of the weights, the locale canonical.
 */
export function storedDocument(info: IndexInfo, label: string, key: SearchKey, document: unknown): StoredDocument {
  const where = `${label}.toDocument() for the key ${keyId(key)}`;
  if (!isRecord(document)) throw new TypeError(`${where} returned ${shown(document)}, but a document is an object with fields.`);
  for (const name of Object.keys(document)) {
    if (name !== 'locale' && name !== 'fields' && name !== 'filters') throw new TypeError(`${where} returned the property ${shown(name)}; a document has only locale, fields and filters.`);
  }
  const locale = document['locale'] === undefined || document['locale'] === null ? null : canonicalLocale(document['locale'], `${where}: locale`);

  const fields = document['fields'];
  if (!isRecord(fields)) throw new TypeError(`${where} returned fields = ${shown(fields)}, but fields are an object of texts by field name.`);
  const declared = new Map(info.fields.map((field) => [field.name, field.weight]));
  for (const [name, value] of Object.entries(fields)) {
    if (!declared.has(name)) throw new TypeError(`${where} returned the field ${shown(name)}, which ${label} does not declare in static fields.`);
    if (value !== undefined && value !== null && typeof value !== 'string') throw new TypeError(`${where} returned ${shown(value)} for the field "${name}", but a field holds a string or null.`);
  }
  const texts: Record<string, string> = {};
  let budget = MAX_DOCUMENT_LENGTH;
  for (const weight of WEIGHTS) {
    for (const field of info.fields) {
      if (field.weight !== weight) continue;
      const value = fields[field.name];
      if (typeof value !== 'string') continue;
      const cut = cutText(cleanText(value), budget);
      budget -= cut.length;
      if (cut.text !== '') texts[field.name] = cut.text;
    }
  }

  const given = document['filters'];
  const filters: Record<string, FilterScalar> = {};
  if (given !== undefined) {
    if (!isRecord(given)) throw new TypeError(`${where} returned filters = ${shown(given)}, but filters are an object of values by filter name.`);
    for (const [name, value] of Object.entries(given)) {
      if (!info.filters.includes(name)) throw new TypeError(`${where} returned the filter ${shown(name)}, which ${label} does not declare in static filters.`);
      // Left out (undefined): the document carries no value and matches no filter on it.
      if (value === undefined) continue;
      filters[name] = checkFilterScalar(value, `${where}: the filter "${name}"`);
    }
  }
  return { key, locale, fields: texts, filters };
}

/** What a read found: documents to store, keys to remove, and with `tolerant` the keys whose rows broke a check. */
export interface ReadResult {
  readonly documents: StoredDocument[];
  readonly removed: SearchKey[];
  readonly failed: readonly { readonly key: SearchKey; readonly error: unknown }[];
}

/**
 * The documents of the given keys, read through the index's `source()`: a key whose row is gone, or whose row `includes()` refuses,
 * is to be removed; every other becomes a checked document. The index class is built by the container for each read.
 */
export class IndexReader {
  readonly #indexes: SearchIndexes;
  readonly #container: Resolver;

  constructor(indexes: SearchIndexes, container: Resolver) {
    this.#indexes = indexes;
    this.#container = container;
  }

  /**
   * Reads the keys. A key whose row breaks a check throws, before anything is written — unless `tolerant` (the queued job, which no
   * caller watches): then its old document is removed rather than kept, and the key is reported in `failed`.
   */
  async read(Index: SearchIndexClass, keys: readonly SearchKey[], options: { readonly tolerant?: boolean } = {}): Promise<ReadResult> {
    const info = this.#indexes.info(Index);
    const label = nameOf(Index);
    const index = this.#container.make(Index) as SearchIndex<object>;
    const { source, toDocument, includes } = index as unknown as Record<'source' | 'toDocument' | 'includes', unknown>;
    if (typeof source !== 'function' || typeof toDocument !== 'function') throw setup(`${label} has no method source() or toDocument() on the instance the container built.`);
    // Read from the instance, not the class: an instance property that is no function would otherwise read as "every row belongs".
    if (includes !== undefined && typeof includes !== 'function') throw setup(`${label} has an includes that is no method on the instance the container built: define includes(row) as a method, or leave it out.`);

    const query = source.call(index, this.#container.make(Database)) as { where?: unknown } | null | undefined;
    if (typeof query?.where !== 'function') throw new TypeError(`${label}.source() returned ${shown(query)}, but source() returns a select of the query chain.`);
    const rows = (await (query as { where(column: string, operator: 'in', values: readonly SearchKey[]): { execute(): Promise<unknown[]> } }).where(info.key, 'in', keys).execute()) as unknown[];

    const asked = new Set(keys.map(keyId));
    const mismatched = new Set<string>();
    const byKey = new Map<string, Record<string, unknown>>();
    const documents: StoredDocument[] = [];
    const removed: SearchKey[] = [];
    const failed: { readonly key: SearchKey; readonly error: unknown }[] = [];
    for (const row of rows) {
      if (!isRecord(row)) throw new TypeError(`${label}.source() returned a row that is ${shown(row)}, not an object.`);
      const key = checkKey(row[info.key], `The column "${info.key}" of a row of ${label}.source()`);
      const id = keyId(key);
      if (asked.has(id)) {
        if (!byKey.has(id)) byKey.set(id, row);
        continue;
      }
      // The database matched a key in another spelling ("42" or "042" to 42, "About" to "about" under a case-insensitive collation):
      // indexing or removing that key would leave the document of this row as it was.
      const error = new TypeError(
        `${label}.source() returned the row with the key ${id} for none of the keys asked for: the database matched a key of another type or spelling. Pass keys exactly as the column "${info.key}" holds them.`,
      );
      if (!options.tolerant) throw error;
      // Fail closed: the row the database matched loses its document too, rather than keep an old one.
      if (!mismatched.has(id)) {
        mismatched.add(id);
        removed.push(key);
        failed.push({ key, error });
      }
    }
    for (const key of keys) {
      const row = byKey.get(keyId(key));
      try {
        // Only `true` keeps a row: a forgotten return (undefined) or a truthy value never puts a row into the index by accident.
        if (row === undefined || (typeof includes === 'function' && includes.call(index, row) !== true)) removed.push(key);
        else documents.push(storedDocument(info, label, key, toDocument.call(index, row)));
      } catch (error) {
        if (!options.tolerant) throw error;
        // A row whose document cannot be built must not stay searchable with its old one.
        removed.push(key);
        failed.push({ key, error });
      }
    }
    return { documents, removed, failed };
  }
}

/** Writes what a read found: the removals first, so a failing upsert never keeps a row searchable that no longer belongs. */
export async function write(driver: SearchDriver, info: IndexInfo, found: { readonly documents: readonly StoredDocument[]; readonly removed: readonly SearchKey[] }): Promise<void> {
  if (found.removed.length > 0) await driver.delete(info, found.removed);
  if (found.documents.length > 0) await driver.upsert(info, found.documents);
}

/** The most times one call writes its rows while they keep changing: the job, a rebuild batch and an after-commit write. */
export const MAX_WRITES = 3;

/** @internal Whether two reads of the same keys found the same documents and the same removals. */
export function sameRead(first: ReadResult, second: ReadResult): boolean {
  // Filters keep the order toDocument() gave them, so they are compared sorted; fields are already in declared order.
  const shape = (found: ReadResult): string =>
    JSON.stringify([
      found.documents
        .map((document) => [keyId(document.key), { ...document, filters: Object.fromEntries(Object.entries(document.filters).sort(([a], [b]) => (a < b ? -1 : 1))) }] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
      found.removed.map(keyId).sort(),
    ]);
  return shape(first) === shape(second);
}

/** @internal The class of search's advisory locks on Postgres ("SRCH" in ASCII), the first `int4` of the two-key form. */
export const LOCK_CLASS = 0x53524348;
/** @internal How many lock slots the documents of one index share: the most advisory locks one transaction of search holds per index. */
export const LOCK_SLOTS = 128;

/** @internal Whether an error, or one it was caused by, has this SQLSTATE. */
export function hasCode(error: unknown, code: string): boolean {
  for (let current = error, depth = 0; typeof current === 'object' && current !== null && depth < 5; current = (current as { cause?: unknown }).cause, depth++) {
    if ((current as { code?: unknown }).code === code) return true;
  }
  return false;
}

/**
 * @internal Locks the documents of these keys until the current transaction ends, on Postgres; call it in a transaction, before the rows
 * are read. Under READ COMMITTED an `on conflict do update` waits for a newer committed write of the same document and then
 * overwrites it with the state its own older read found: a rebuild batch would put the filters of a row live again after the app
 * changed them and indexed the row. With the lock, the read and the write of one document never interleave with another's.
 *
 * A document locks one of the 128 slots of its index, by a hash of the index name and the key, so a transaction holds at most 128
 * advisory locks per index however many keys it writes: one lock per key would fill the shared lock table of Postgres in a large
 * import. Two documents in one slot wait for each other. The locks use the two-`int4` form with the class `LOCK_CLASS`, a key space
 * of its own (`objsubid` 2 in `pg_locks`, 1 for a `bigint` key), so no key can meet a `bigint` lock such as the one of the migrations.
 * One batch of up to 500 keys takes its slots in sorted order, so two calls of up to 500 keys never deadlock. Several calls in one
 * transaction can deadlock with another transaction that holds a slot they need, even one that writes none of their documents.
 *
 * With `brief`, each wait for a slot ends after `min(200 ms, deadlock_timeout / 2)` and the whole statement after
 * `deadlock_timeout / 2` (each at least 1 ms, and no longer than a limit the transaction already has); then it returns `false` (the transaction is aborted: the caller rolls back). Both stay below
 * `deadlock_timeout` on purpose: an app transaction can only start to wait for a slot of this statement after the statement took
 * it, so it has waited less than `deadlock_timeout` when the statement gives its slots up. Postgres checks a wait for a deadlock only
 * after `deadlock_timeout`, so in a cycle with a rebuild an app transaction is never the 40P01 victim, while `deadlock_timeout` stays
 * well above the round trip to the database. The `lock_timeout` and
 * `statement_timeout` the transaction had are restored after the statement. SQLite needs no lock: its transactions begin
 * immediate, so one writer runs at a time.
 */
export async function lockDocuments(connections: Connections, index: string, keys: readonly SearchKey[], options: { readonly brief?: boolean } = {}): Promise<boolean> {
  if ((connections.options('default').driver as string) !== 'pgsql' || keys.length === 0) return true;
  const ids = keys.map(keyId);
  // The high bits come from the index name, the low 7 from the key: each index has 128 slots of its own, and two indexes meet only
  // when the high bits of their names' hashes are equal.
  const slots = sql`select distinct (hashtext(${index}) & ${~(LOCK_SLOTS - 1)}) | (hashtext(${index} || chr(1) || k) & ${LOCK_SLOTS - 1}) as slot from unnest(${ids}::text[]) as k`;
  // A volatile function of the select list runs after the sort, so the slots are locked in their order.
  const lock = sql`select pg_advisory_xact_lock(${LOCK_CLASS}, slot) from (${slots}) as slots order by slot`;
  const db = connections.get('default');
  if (!options.brief) {
    await lock.execute(db);
    return true;
  }
  const { rows } = await sql<{ lock: string; statement: string; deadlock: number | string; lockMs: number | string; statementMs: number | string }>`select
    current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement,
    extract(epoch from current_setting('deadlock_timeout')::interval) * 1000 as deadlock,
    extract(epoch from current_setting('lock_timeout')::interval) * 1000 as "lockMs",
    extract(epoch from current_setting('statement_timeout')::interval) * 1000 as "statementMs"`.execute(db);
  const previous = rows[0]!;
  const half = Math.max(1, Math.floor(Number(previous.deadlock) / 2));
  // A shorter limit the database or the role sets stays in force; 0 means none.
  const shorter = (configured: number | string, limit: number) => (Number(configured) > 0 ? Math.max(1, Math.min(limit, Math.floor(Number(configured)))) : limit);
  await sql`select set_config('lock_timeout', ${`${shorter(previous.lockMs, Math.min(200, half))}ms`}, true),
    set_config('statement_timeout', ${`${shorter(previous.statementMs, half)}ms`}, true)`.execute(db);
  try {
    await lock.execute(db);
  } catch (error) {
    // 55P03: a wait ran out; 57014: the statement ran out. It failed, so the transaction is aborted and nothing else may run in it.
    if (hasCode(error, '55P03') || hasCode(error, '57014')) return false;
    throw error;
  }
  await sql`select set_config('lock_timeout', ${previous.lock}, true), set_config('statement_timeout', ${previous.statement}, true)`.execute(db);
  return true;
}

/** `list` in slices of at most `size`. */
export function batches<T>(list: readonly T[], size = BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < list.length; start += size) result.push(list.slice(start, start + size));
  return result;
}

/** @internal What `Search` is built from; the provider hands these over. */
export interface SearchParts {
  readonly indexes: SearchIndexes;
  readonly reader: IndexReader;
  readonly driver: () => SearchDriver;
  readonly connections: () => Connections;
  /** Queues `marmeon.search.sync`; set only when the app has @marmeon/queue. */
  readonly dispatch: ((payload: SyncPayload) => Promise<unknown>) | undefined;
}

/** The page meta of a search, as `paginate` builds it. */
function pageMeta(page: number, perPage: number, total: number, count: number): PageMeta {
  const from = count > 0 ? (page - 1) * perPage + 1 : null;
  return { page, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)), from, to: from === null ? null : from + count - 1 };
}

function checkFlag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`search.query({ ${name} }) is ${shown(value)}, but it is true or false.`);
  return value;
}

function checkWhole(value: unknown, name: string, fallback: number, max?: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new TypeError(`search.query({ ${name} }) is ${shown(value)}, but it is a whole number from 1${max === undefined ? '' : ` to ${max}`}.`);
  }
  return value;
}

/**
 * Keeps the indexes current and searches them. `index()` brings the documents of rows into an index, `remove()` takes them out, and
 * `query()` returns a page of hits. Writes follow the driver: in the caller's transaction, through a queued job, or after the
 * commit. Injected like any service. See `docs/full-text-search.md#keeping-the-index-current`.
 */
export class Search {
  readonly #parts: SearchParts;

  /** @internal Built by `SearchServiceProvider`; resolve `Search` from the container. */
  constructor(parts: SearchParts) {
    this.#parts = parts;
  }

  /**
   * Brings rows into the index: one row or key, or a list of only rows or only keys. Each row is read again through `source()`;
   * a row that is gone, or that `includes()` refuses, is removed. An unregistered index, rows and keys in one list, an invalid key, a
   * key the database matched in another spelling or a document `toDocument()` returns broken is a `TypeError`. A document too long for
   * Postgres (`docs/full-text-search.md#postgres`) and rows that change at each of three writes after the commit throw an `Error`. See
   * `docs/full-text-search.md#keeping-the-index-current`.
   */
  async index<I extends SearchIndexClass>(Index: I, rowsOrKeys: IndexInput<I>): Promise<void> {
    const info = this.#parts.indexes.info(Index);
    const keys = this.#keys(Index, info, rowsOrKeys, true);
    const driver = this.#parts.driver();
    // Documents too long for the database fail only themselves: every batch is written, the error comes after the last one. In a
    // transaction of its own, each batch commits the rest and the removal of their old documents first; a rollback would leave the
    // old documents searchable.
    const tooLong: { keys: SearchKey[]; cause?: DocumentsTooLongError } = { keys: [] };
    for (const batch of batches(keys)) {
      if (driver.writes === 'queue') await this.#queue(info, batch);
      else if (driver.writes === 'after-commit') {
        const first = await this.#parts.reader.read(Index, batch);
        // Read again after the write, and written again while the rows changed, as the job does: a slower write of an older read
        // that lands after this one would otherwise leave the older state in the index.
        await afterCommit(async () => {
          let found = first;
          for (let round = 1; ; round++) {
            await write(driver, info, found);
            const again = await this.#parts.reader.read(Index, batch);
            if (sameRead(found, again)) return;
            if (round === MAX_WRITES) throw new Error(`The rows of "${info.name}" changed each of the ${MAX_WRITES} times search.index() wrote them after the commit; call it again.`);
            found = again;
          }
        });
      } else {
        await this.#inTransaction(async () => {
          await lockDocuments(this.#parts.connections(), info.name, batch);
          const found = await this.#parts.reader.read(Index, batch);
          try {
            await write(driver, info, found);
          } catch (error) {
            if (!(error instanceof DocumentsTooLongError)) throw error;
            tooLong.keys.push(...error.keys);
            tooLong.cause ??= error;
          }
        });
      }
    }
    if (tooLong.cause !== undefined) throw tooLong.keys.length === tooLong.cause.keys.length ? tooLong.cause : new DocumentsTooLongError(info.name, tooLong.keys, tooLong.cause.cause);
  }

  /**
   * Takes the documents of these keys out of the index. With a driver that writes through the queue, the job reads the rows when it
   * runs, so a row that still exists and belongs comes back. Pass each key exactly as the key column holds it: on a driver that
   * writes in the transaction or after the commit, and once the row is deleted on any driver, `"42"` for `42` or `"About"` for
   * `"about"` removes nothing. An unregistered index or an invalid key is a `TypeError`. See
   * `docs/full-text-search.md#keeping-the-index-current`.
   */
  async remove<I extends SearchIndexClass>(Index: I, keys: KeyOf<I> | readonly KeyOf<I>[]): Promise<void> {
    const info = this.#parts.indexes.info(Index);
    const list = this.#keys(Index, info, keys, false);
    const driver = this.#parts.driver();
    for (const batch of batches(list)) {
      if (driver.writes === 'queue') await this.#queue(info, batch);
      else if (driver.writes === 'after-commit') await afterCommit(() => driver.delete(info, batch));
      else {
        await this.#inTransaction(async () => {
          // Locked like index(): a write of an older read that waits for this delete would otherwise put the document back.
          await lockDocuments(this.#parts.connections(), info.name, batch);
          await driver.delete(info, batch);
        });
      }
    }
  }

  /**
   * Searches one or more indexes and returns a page of hits, best first. A filter must be declared by every index searched; a
   * filter of `undefined`, `null` or `[]` is a `TypeError`, never "no filter". A term without words finds nothing. An outage or a
   * missing index is an `err`. See `docs/full-text-search.md#searching`.
   */
  async query<const I extends SearchIndexClass>(request: SearchRequest<I>): Promise<Result<Paginated<SearchHit<I>>, SearchFailure>> {
    // A plain object whose options are all its own and enumerable: a misspelt option on a class or a prototype must be seen too.
    const prototype = isRecord(request) ? Object.getPrototypeOf(request) : undefined;
    if (!isRecord(request) || (prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(request).length !== Object.keys(request).length) {
      throw new TypeError(`search.query() takes a plain request object, got ${shown(request)}.`);
    }
    for (const option of Object.keys(request)) {
      // A misspelt `filter` must never run the search without its filters.
      if (!REQUEST_OPTIONS.includes(option)) throw new TypeError(`search.query() got the option ${shown(option)}; a search takes ${REQUEST_OPTIONS.join(', ')}.`);
    }
    const given = request.in;
    const list: readonly unknown[] = Array.isArray(given) ? given : [given];
    if (list.length === 0) throw new TypeError('search.query({ in }) names no index: give an index class or a list of them.');
    const infos: IndexInfo[] = [];
    for (const Index of new Set(list)) infos.push(this.#parts.indexes.info(Index as SearchIndexClass));
    if (typeof request.term !== 'string') throw new TypeError(`search.query({ term }) is ${shown(request.term)}, but the term is a string.`);
    const filters = this.#filters(infos, request.filters);
    const locale = request.locale === undefined ? undefined : canonicalLocale(request.locale, 'search.query({ locale })');
    const prefix = checkFlag(request.prefix, 'prefix');
    const excerpts = checkFlag(request.excerpts, 'excerpts');
    const page = checkWhole(request.page, 'page', 1);
    const perPage = checkWhole(request.perPage, 'perPage', DEFAULT_PER_PAGE, MAX_PER_PAGE);
    if (page * perPage > MAX_REACHABLE_HITS) {
      throw new TypeError(`search.query({ page: ${page}, perPage: ${perPage} }) reaches past hit ${MAX_REACHABLE_HITS}; a search reaches at most the first ${MAX_REACHABLE_HITS} hits.`);
    }

    const found = tokens(request.term);
    if (found.length === 0) return ok({ data: [], meta: pageMeta(page, perPage, 0, 0) });
    const query: DriverQuery = { indexes: infos, tokens: found, term: searchText(request.term), filters, locale, prefix, excerpts, offset: (page - 1) * perPage, limit: perPage };
    const result = await this.#parts.driver().query(query);
    if (!result.ok) {
      if (!isRecord(result.error) || !FAILURE_KINDS.includes(result.error.kind)) throw new TypeError(`The search driver returned a failure of the kind ${shown((result.error as { kind?: unknown } | undefined)?.kind)}; a failure is unavailable or missing-index.`);
      return err(result.error);
    }
    const names = new Set(infos.map((info) => info.name));
    // A hit of an index that was not asked for never reaches the app, whatever the driver returned.
    const data = result.value.hits
      .filter((hit) => names.has(hit.index))
      .slice(0, perPage)
      .map((hit) => {
        if (typeof hit.score !== 'number' || !Number.isFinite(hit.score)) throw new TypeError(`The search driver returned a hit of "${hit.index}" with the score ${shown(hit.score)}; a score is a finite number.`);
        const key = checkKey(hit.key, `The key of a hit of "${hit.index}" the search driver returned`);
        return { index: hit.index, key, score: hit.score, ...(hit.excerpt === undefined ? {} : { excerpt: hit.excerpt }) } as SearchHit<I>;
      });
    const reported: unknown = result.value.total;
    if (typeof reported !== 'number' || !Number.isSafeInteger(reported) || reported < 0) throw new TypeError(`The search driver returned the total ${shown(reported)}; a total is a whole number of 0 or more.`);
    const total = Math.min(reported, MAX_REACHABLE_HITS);
    return ok({ data, meta: pageMeta(page, perPage, total, data.length) });
  }

  /** The filters of a search: declared by every index, each a checked value or a non-empty list of them. */
  #filters(infos: readonly IndexInfo[], given: unknown): Record<string, FilterScalar | readonly FilterScalar[]> {
    const filters: Record<string, FilterScalar | readonly FilterScalar[]> = {};
    if (given === undefined) return filters;
    // Only a plain object whose keys are all its own and enumerable: a getter on a prototype, an inherited or a hidden key would be
    // dropped by Object.entries, and the search would run without that filter.
    const prototype = isRecord(given) ? Object.getPrototypeOf(given) : undefined;
    if (!isRecord(given) || (prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(given).length !== Object.keys(given).length) {
      throw new TypeError(`search.query({ filters }) is ${shown(given)}, but filters are a plain object of values by filter name.`);
    }
    for (const [name, value] of Object.entries(given)) {
      const lacking = infos.find((info) => !info.filters.includes(name));
      if (lacking !== undefined) throw new TypeError(`search.query() filters by ${shown(name)}, which the index "${lacking.name}" does not declare in static filters.`);
      const where = `search.query({ filters: { ${name} } })`;
      if (value === undefined || value === null) {
        // Fail closed: `{ tenant: user.tenantId }` with no tenant must never mean "every tenant".
        throw new TypeError(`${where} is ${String(value)}. A filter always has a value; leave the filter out to search without it.`);
      }
      if (Array.isArray(value)) {
        if (value.length === 0) throw new TypeError(`${where} is an empty list, which no document matches. Give at least one value.`);
        // Array.from, not map: a hole in the list is an entry (undefined) and is refused.
        filters[name] = Object.freeze(Array.from(value as unknown[], (entry, position) => checkFilterScalar(entry, `${where}[${position}]`)));
      } else {
        filters[name] = checkFilterScalar(value, where);
      }
    }
    return filters;
  }

  /** The keys of `index()` or `remove()`, checked, once each; rows only where `rows` allows them, never mixed with keys. */
  #keys(Index: SearchIndexClass, info: IndexInfo, input: unknown, rows: boolean): SearchKey[] {
    const list: readonly unknown[] = Array.isArray(input) ? input : [input];
    const method = rows ? 'index' : 'remove';
    let kind: 'row' | 'key' | undefined;
    const keys = new Map<string, SearchKey>();
    let position = 0;
    for (const item of list) {
      const itemKind = typeof item === 'string' || typeof item === 'number' ? 'key' : rows && isRecord(item) ? 'row' : undefined;
      if (itemKind === undefined) {
        throw new TypeError(`search.${method}(${nameOf(Index)}, …) got ${shown(item)} at position ${position}, but it takes ${rows ? 'rows or keys' : 'keys'}.`);
      }
      if (kind !== undefined && kind !== itemKind) throw new TypeError(`search.${method}(${nameOf(Index)}, …) got rows and keys in one list; give only rows or only keys.`);
      kind = itemKind;
      const key = checkKey(itemKind === 'row' ? (item as Record<string, unknown>)[info.key] : item, itemKind === 'row' ? `The column "${info.key}" of the row at position ${position}` : `The key at position ${position}`);
      keys.set(keyId(key), key);
      position++;
    }
    return [...keys.values()];
  }

  async #queue(info: IndexInfo, keys: SearchKey[]): Promise<void> {
    const dispatch = this.#parts.dispatch;
    // The start refuses a queue driver without @marmeon/queue; this is only reached when something resolved Search before it.
    if (dispatch === undefined) throw setup(`The search driver writes through the queue, but @marmeon/queue is not set up (marmeon add queue).`);
    await dispatch({ index: info.name, keys });
  }

  /** Runs `work` in the caller's transaction of the default connection, or in one of its own. */
  async #inTransaction(work: () => Promise<void>): Promise<void> {
    const connections = this.#parts.connections();
    if (connections.inTransaction()) await work();
    else await connections.transaction(work);
  }
}
