import { HttpError } from '@marmeon/router';
import { sql, type Expression, type ExpressionBuilder, type Kysely, type SelectQueryBuilder, type SqlBool } from 'kysely';
import { rules as r } from '@marmeon/validation';

/** Where a page stands — the same shape `@marmeon/http/page` knows as `PaginationMeta` (for `<Pagination>`). */
export interface PageMeta {
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
  readonly lastPage: number;
  /** Position of the first and last row on this page (1-based), or null on an empty page. */
  readonly from: number | null;
  readonly to: number | null;
}

export interface Paginated<T> {
  readonly data: T[];
  readonly meta: PageMeta;
}

export interface CursorPaginated<T> {
  readonly data: T[];
  readonly meta: { readonly perPage: number; readonly nextCursor: string | null };
}

/** The page sizes `pageQuery({ perPage })` allows: one, or a list whose first is the default. */
type PageSizes<P extends number> = P | readonly [P, ...P[]];

/**
 * The page of a list as query fields, rules of @marmeon/validation — spread into a route's query schema (E55): `?page=` (a whole
 * number ≥ 1, default 1) and `?per_page=` (one of `perPage`, default its first). Like every query field, an invalid value falls
 * back to its default (`?page=-1`, `?per_page=100000`), never a 422; the default is left out of URLs the browser builds.
 *
 * ```ts
 * static request = defineRequest({
 *   query: r.query({ ...pageQuery({ perPage: [25, 50, 100] }), sort: r.in(['name', '-name']).default('name') }),
 * });
 * handle(ctx: ContextOf<typeof ListUsersRequest>) {
 *   return this.#users.paginate(this.#users.query().select(['id', 'name']).orderBy('name').orderBy('id'), ctx.query);   // ctx.query.per_page: 25 | 50 | 100
 * }
 * ```
 */
export function pageQuery<const P extends number = 15>({ perPage }: { perPage?: PageSizes<P> } = {}) {
  const sizes = (Array.isArray(perPage) ? perPage : [perPage ?? 15]) as unknown as readonly [P, ...P[]];
  if (sizes.length === 0 || !sizes.every((size) => Number.isSafeInteger(size) && size >= 1)) {
    throw new RangeError(`pageQuery({ perPage }) takes whole numbers ≥ 1, got ${JSON.stringify(perPage)}.`);
  }
  return {
    page: r.integer().min(1).default(1),
    per_page: r.in(sizes).default(sizes[0]),
  };
}

/**
 * Which page `paginate` loads: the parsed query of a route whose schema has {@link pageQuery} (`ctx.query`) — `page` and
 * `per_page` — or `{ page, perPage }` written out.
 */
export interface PageRequest {
  readonly page?: number;
  readonly per_page?: number;
  readonly perPage?: number;
}

/** `Q` when it says which page to load; otherwise the message the compiler shows as the expected type. */
export type CheckPageRequest<Q> = [keyof Q & keyof PageRequest] extends [never]
  ? 'this query has no page — spread pageQuery() into the route\'s query schema: r.query({ ...pageQuery({ perPage: [25, 50] }), … }), or pass { page, perPage }'
  : Q extends PageRequest
    ? Q
    : PageRequest;

/**
 * Page and page size from the query string (`?page=3&per_page=20`), made safe: anything that is not a
 * whole number in range falls back instead of failing — `?page=-1`, `?page=abc`, `?per_page=100000`.
 *
 * @deprecated Since Wave 9: spread {@link pageQuery} into the route's query schema and hand `paginate` the parsed `ctx.query` —
 * the browser's links then come from the same schema (`<Pagination>`). Reads a parsed query object as well as the search params.
 */
export function paginationFrom(
  query: URLSearchParams | Readonly<Record<string, unknown>>,
  { perPage = 15, maxPerPage = 100 }: { perPage?: number; maxPerPage?: number } = {},
): { page: number; perPage: number } {
  const read = (key: string) => (query instanceof URLSearchParams ? query.get(key) : query[key]);
  const page = Number(read('page'));
  const size = Number(read('per_page') ?? perPage);
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    perPage: Number.isSafeInteger(size) && size >= 1 ? Math.min(size, maxPerPage) : perPage,
  };
}

/**
 * One page of `query`, and how many rows there are in all (a second, counting query on the same
 * filter — ordering, selections and relations are left out of it). Which page: the route's parsed query
 * (`ctx.query`, with {@link pageQuery} in its schema), or `{ page, perPage }`.
 *
 * ```ts
 * const people = await paginate(db, db.selectFrom('users').select(['id', 'name']).orderBy('name').orderBy('id'), ctx.query);
 * ```
 */
export async function paginate<DB, TB extends keyof DB, O, const Q = PageRequest>(
  // Only `selectFrom` is needed — so a module's restricted `Database<'…'>` works too.
  db: Pick<Kysely<any>, 'selectFrom'>,
  query: SelectQueryBuilder<DB, TB, O>,
  request?: CheckPageRequest<Q>,
): Promise<Paginated<O>> {
  const { page = 1, perPage = 15 } = pageOf(request as PageRequest | undefined);
  if (!Number.isSafeInteger(page) || page < 1) throw new RangeError(`page must be a whole number ≥ 1, got ${page}.`);
  if (!Number.isSafeInteger(perPage) || perPage < 1) throw new RangeError(`perPage must be a whole number ≥ 1, got ${perPage}.`);
  const counting = db
    .selectFrom(query.clearSelect().clearOrderBy().select(sql<number>`1`.as('row')).as('paginated'))
    .select(sql<number | string>`count(*)`.as('count'));
  // One after the other: on SQLite (one connection) and in a test's transaction they would queue anyway.
  const { count } = (await counting.executeTakeFirstOrThrow()) as { count: number | string };
  const data = await query.limit(perPage).offset((page - 1) * perPage).execute();
  const total = Number(count);
  const from = data.length ? (page - 1) * perPage + 1 : null;
  return {
    data,
    meta: { page, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)), from, to: from === null ? null : from + data.length - 1 },
  };
}

/** `page` and the page size of a {@link PageRequest} — `per_page` (a parsed query's) before `perPage`. */
function pageOf(request: PageRequest | undefined): { page?: number | undefined; perPage?: number | undefined } {
  if (!request) return {};
  return { page: request.page, perPage: request.per_page ?? request.perPage };
}

/** What encrypts a cursor — the app's `Encrypter` (`@marmeon/encryption`), injected where the list is read. */
export interface CursorEncrypter {
  encrypt(plaintext: string, context?: string): Promise<string>;
  decrypt(payload: string, context?: string): Promise<string>;
}

/**
 * A cursor that is not one of this list's (tampered with, written by another list, encrypted with a key that is gone, or in the
 * format before Wave 9): answers 400 — never quietly the first page again, which would make "load more" start over forever.
 */
export class InvalidCursorError extends HttpError {
  override name = 'InvalidCursorError';

  constructor() {
    super(400);
  }
}

/** How `cursorPaginate` reads a list: its order, where it goes on, and what encrypts the cursor. */
export interface CursorOptions<C extends string> {
  /** The column(s) to order by — names of selected columns that are columns of the query (usable in `where`). */
  readonly column: C | readonly [C, ...C[]];
  /**
   * The unique column that breaks ties, ordered by last — default `id`. Added after `column` unless it is there already: rows
   * with the same name (or the same `null`) still come in one order, and nobody shows twice.
   */
  readonly key?: C;
  /** The cursor of the page before (`meta.nextCursor`) — none for the first page. */
  readonly cursor?: string | null | undefined;
  readonly perPage?: number;
  readonly direction?: 'asc' | 'desc';
  /** Encrypts the cursor (inject `Encrypter`): a client can neither read the last row's values nor make one up. */
  readonly encrypter: CursorEncrypter;
}

/**
 * Each order's own context: a cursor of other columns or the other direction does not decrypt here. Per order, not per list — one
 * of another list with the same order is a position among this list's rows (its filters still apply).
 */
const CURSOR_CONTEXT = 'marmeon:cursor';

/**
 * Keyset pagination for large tables and "load more": rows after the cursor, ordered by `column` and then the unique `key` —
 * no count, no offset, stable while rows are added.
 *
 * - **Ties and NULLs:** the key column (`id` by default) is always the last order, so equal names keep one order. A sort column
 *   may be nullable: NULLs come last (`NULLS LAST`, in both directions, SQLite and Postgres alike) and a row whose value is
 *   NULL is a cursor like any other — the next page goes on among the NULLs instead of starting over.
 * - **Its own order:** an `orderBy` the query had is taken out — the cursor follows these columns only.
 * - **Encrypted:** the cursor is the last row's values, encrypted and authenticated with the app key (`encrypter`, its own
 *   context per columns and direction) — a hidden sort column's values do not leak into URLs, and a cursor cannot be made up.
 *   One that does not decrypt answers 400 ({@link InvalidCursorError}).
 *
 * ```ts
 * cursorPaginate(query, { column: 'name', cursor: ctx.query.cursor, perPage: 10, encrypter: this.#encrypter });   // by (name, id)
 * ```
 */
export async function cursorPaginate<DB, TB extends keyof DB, O extends Record<string, unknown>>(
  query: SelectQueryBuilder<DB, TB, O>,
  { column, key = 'id' as keyof O & string, cursor, perPage = 15, direction = 'asc', encrypter }: CursorOptions<keyof O & string>,
): Promise<CursorPaginated<O>> {
  if (!Number.isSafeInteger(perPage) || perPage < 1) throw new RangeError(`perPage must be a whole number ≥ 1, got ${perPage}.`);
  const sorted: readonly string[] = typeof column === 'string' ? [column] : column;
  const columns = sorted.at(-1) === key ? sorted : [...sorted.filter((name) => name !== key), key];
  const context = `${CURSOR_CONTEXT}:${direction}:${columns.join(',')}`;
  let page = (query as SelectQueryBuilder<any, any, O>).clearOrderBy();
  for (const [index, name] of columns.entries()) {
    // The key is unique and never NULL; the columns before it may be NULL — last, in either direction.
    page = index === columns.length - 1 ? page.orderBy(name, direction) : page.orderBy(name, (order) => (direction === 'asc' ? order.asc() : order.desc()).nullsLast());
  }
  page = page.limit(perPage + 1);
  if (cursor) {
    const after = await decodeCursor(encrypter, cursor, context, columns.length);
    // Not one of this list's (changed, made up, another list's or key's, the format before Wave 9): a 400 — never page 1 again.
    if (!after) throw new InvalidCursorError();
    page = page.where((eb) => rowsAfter(eb, columns, after, direction));
  }
  const rows = await page.execute();
  const data = rows.slice(0, perPage);
  const last = data.at(-1);
  if (last && !Object.hasOwn(last, key)) {
    throw new TypeError(`cursorPaginate() orders by the unique key "${key}" last, but the query does not select it — select it, or name another: { key: 'uuid' }.`);
  }
  const next = rows.length > perPage && last ? columns.map((name) => cursorValue(last[name])) : undefined;
  return { data, meta: { perPage, nextCursor: next ? await encrypter.encrypt(JSON.stringify(next), context) : null } };
}

/**
 * The rows after `values` in the order of `columns` (`NULLS LAST`): `c1 > v1 OR (c1 = v1 AND c2 > v2) OR …` — written out instead of
 * a row value `(c1, c2) > (v1, v2)`, which never matches a NULL. After a NULL come only the rows with the same NULL and a later
 * value in the next column; after a value come the greater ones and the NULLs.
 */
function rowsAfter(eb: ExpressionBuilder<any, any>, columns: readonly string[], values: readonly unknown[], direction: 'asc' | 'desc'): Expression<SqlBool> {
  const operator = direction === 'asc' ? '>' : '<';
  const terms: Expression<SqlBool>[] = [];
  for (const [index, name] of columns.entries()) {
    const value = values[index];
    const same = columns.slice(0, index).map((before, at) => (values[at] === null ? eb(before, 'is', null) : eb(before, '=', values[at])));
    const isKey = index === columns.length - 1;
    if (value === null) {
      if (isKey) break;
      continue; // nothing is after a NULL in this column (NULLs come last): only the next columns go on
    }
    const later = isKey ? eb(name, operator, value) : eb.or([eb(name, operator, value), eb(name, 'is', null)]);
    terms.push(same.length === 0 ? later : eb.and([...same, later]));
  }
  // Nothing after it (a NULL in the only column before the key cannot be): no row.
  return terms.length === 0 ? sql<SqlBool>`1 = 0` : eb.or(terms);
}

/** A row's value as the cursor keeps it: a date as its ISO string (what both drivers compare with), the rest as JSON has it. */
function cursorValue(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** The values of a cursor of this list, one per column — undefined for anything else. */
async function decodeCursor(encrypter: CursorEncrypter, cursor: string, context: string, columns: number): Promise<unknown[] | undefined> {
  let values: unknown;
  try {
    values = JSON.parse(await encrypter.decrypt(cursor, context));
  } catch {
    return undefined;
  }
  if (!Array.isArray(values) || values.length !== columns) return undefined;
  return values.every((item) => item === null || typeof item === 'string' || typeof item === 'number') ? values : undefined;
}
