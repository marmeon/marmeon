import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';

/** Where a page stands — the same shape `@bespokecore/http/page` knows as `PaginationMeta` (for `<Pagination>`). */
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

/**
 * Page and page size from the query string (`?page=3&per_page=20`), made safe: anything that is not a
 * whole number in range falls back instead of failing — `?page=-1`, `?page=abc`, `?per_page=100000`.
 */
export function paginationFrom(
  query: URLSearchParams,
  { perPage = 15, maxPerPage = 100 }: { perPage?: number; maxPerPage?: number } = {},
): { page: number; perPage: number } {
  const page = Number(query.get('page'));
  const size = Number(query.get('per_page') ?? perPage);
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    perPage: Number.isSafeInteger(size) && size >= 1 ? Math.min(size, maxPerPage) : perPage,
  };
}

/**
 * One page of `query`, and how many rows there are in all (a second, counting query on the same
 * filter — ordering, selections and relations are left out of it).
 *
 * ```ts
 * const people = await paginate(db, db.selectFrom('users').select(['id', 'name']).orderBy('name'), paginationFrom(ctx.query));
 * ```
 */
export async function paginate<DB, TB extends keyof DB, O>(
  // Only `selectFrom` is needed — so a module's restricted `Database<'…'>` works too.
  db: Pick<Kysely<any>, 'selectFrom'>,
  query: SelectQueryBuilder<DB, TB, O>,
  { page = 1, perPage = 15 }: { page?: number; perPage?: number } = {},
): Promise<Paginated<O>> {
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

/**
 * Keyset pagination for large tables: rows after the cursor, ordered by a unique column — no count, no
 * offset, stable while rows are added. The cursor is opaque (base64url of the last row's value).
 */
export async function cursorPaginate<DB, TB extends keyof DB, O extends Record<string, unknown>>(
  query: SelectQueryBuilder<DB, TB, O>,
  {
    column,
    cursor,
    perPage = 15,
    direction = 'asc',
  }: { column: keyof O & string; cursor?: string | null; perPage?: number; direction?: 'asc' | 'desc' },
): Promise<CursorPaginated<O>> {
  let page = (query as SelectQueryBuilder<any, any, O>).orderBy(column, direction).limit(perPage + 1);
  const after = cursor ? decodeCursor(cursor) : undefined;
  if (after !== undefined) page = page.where(column, direction === 'asc' ? '>' : '<', after as never);
  const rows = await page.execute();
  const data = rows.slice(0, perPage);
  const last = data.at(-1);
  return { data, meta: { perPage, nextCursor: rows.length > perPage && last ? encodeCursor(last[column]) : null } };
}

function encodeCursor(value: unknown): string {
  return new TextEncoder().encode(JSON.stringify(value)).toBase64({ alphabet: 'base64url', omitPadding: true });
}

/** A cursor that does not decode is treated as no cursor (the first page) — it came from the query string. */
function decodeCursor(cursor: string): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(cursor, { alphabet: 'base64url' })));
    return typeof value === 'string' || typeof value === 'number' ? value : undefined;
  } catch {
    return undefined;
  }
}
