import { HttpError } from '@marmeon/router';
import * as v from 'valibot';
import type { TableQueryKeys } from './client/index.ts';
import type { TableDefinition, TableQuerySchema } from './define.ts';

/**
 * A table's state in the URL — parsed strictly (E183): the table's own keys allow exactly what it defines, anything else is a **400**.
 * Deliberately stricter than other query fields, which fall back per field (E55/E56): a table says out loud what it cannot do, and a
 * raw identifier never gets near `orderBy`/`where` — a sort or a filter is an alias, looked up in the definition.
 */
export interface TableState {
  readonly sort: { readonly column: string; readonly direction: 'asc' | 'desc' } | undefined;
  readonly page: number;
  readonly perPage: number;
  readonly cursor: string | undefined;
  readonly search: string;
  readonly filters: Readonly<Record<string, string>>;
}

/** The longest search a table takes, in characters. */
export const MAX_SEARCH = 100;
/** The longest cursor a table takes (an encrypted one is ~100–300 characters). */
const MAX_CURSOR = 2048;
const PAGE = /^[1-9]\d{0,8}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The keys of the table's state in the URL — `members_sort` etc. with a prefix. */
export function queryKeys(definition: TableDefinition): TableQueryKeys & { filter: (name: string) => string; filterPrefix: string } {
  const p = definition.prefix ? `${definition.prefix}_` : '';
  return {
    sort: `${p}sort`,
    page: `${p}page`,
    perPage: `${p}per_page`,
    cursor: `${p}cursor`,
    search: `${p}search`,
    filter: (name) => `${p}filter[${name}]`,
    filterPrefix: `${p}filter[`,
  };
}

/** What the table refuses: a 400 with the reason (it names only the table's own key — never a value). */
export class TableQueryError extends HttpError {
  override name = 'TableQueryError';

  constructor(message: string) {
    super(400, message);
  }
}

/** Whether the table can search: one of its columns is searchable. */
function searchable(definition: TableDefinition): boolean {
  return Object.values(definition.columns).some((column) => column.isSearchable);
}

/** One value of a key — a list (`?sort=a&sort=b`) is refused. */
function single(key: string, value: unknown): string {
  if (typeof value === 'string') return value;
  throw new TableQueryError(`${key}: one value.`);
}

/** Checks one of the table's keys and returns what it parses to — or throws a {@link TableQueryError}. */
function parseKey(definition: TableDefinition, key: string, raw: unknown): string | number {
  const keys = queryKeys(definition);
  const value = single(key, raw);
  if (key === keys.sort) {
    const column = value.startsWith('-') ? value.slice(1) : value;
    if (!Object.hasOwn(definition.columns, column) || !definition.columns[column]!.isSortable) {
      throw new TableQueryError(`${key}: the table "${definition.name}" does not sort by that.`);
    }
    return value;
  }
  if (key === keys.perPage) {
    const size = Number(value);
    if (!/^\d{1,4}$/.test(value) || !definition.perPage.includes(size)) throw new TableQueryError(`${key}: one of ${definition.perPage.join(', ')}.`);
    return size;
  }
  if (!definition.cursor && key === keys.page) {
    if (!PAGE.test(value)) throw new TableQueryError(`${key}: a whole number from 1.`);
    return Number(value);
  }
  if (definition.cursor && key === keys.cursor) {
    if (value.length === 0 || value.length > MAX_CURSOR || !/^[\w.~:+/=-]+$/.test(value)) throw new TableQueryError(`${key}: not a cursor of this table.`);
    return value;
  }
  if (key === keys.search && searchable(definition)) {
    const trimmed = value.trim();
    if (trimmed.length > MAX_SEARCH) throw new TableQueryError(`${key}: at most ${MAX_SEARCH} characters.`);
    return trimmed;
  }
  if (key.startsWith(keys.filterPrefix) && key.endsWith(']')) {
    const name = key.slice(keys.filterPrefix.length, -1);
    const found = Object.hasOwn(definition.filters, name) ? definition.filters[name] : undefined;
    if (!found) throw new TableQueryError(`${key}: the table "${definition.name}" has no such filter.`);
    if (found.type === 'select') {
      if (!found.options.includes(value)) throw new TableQueryError(`${key}: one of its options.`);
      return value;
    }
    const [from = '', to = '', ...rest] = value.split('..');
    if (rest.length > 0 || !value.includes('..') || (from === '' && to === '') || (from !== '' && !isDay(from)) || (to !== '' && !isDay(to)) || (from !== '' && to !== '' && from > to)) {
      throw new TableQueryError(`${key}: a range of days, YYYY-MM-DD..YYYY-MM-DD (either end may be empty).`);
    }
    return value;
  }
  throw new TableQueryError(`${key}: the table "${definition.name}" has no such field.`);
}

function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Whether `key` belongs to the table: one of its keys, or anything that looks like one of its filters. */
export function isTableKey(definition: TableDefinition, key: string): boolean {
  const keys = queryKeys(definition);
  return key === keys.sort || key === keys.page || key === keys.perPage || key === keys.cursor || key === keys.search || key.startsWith(keys.filterPrefix);
}

/**
 * The table's state from a query (the URL's, or the body of "all matching"): every key of the table checked — an unknown one in its
 * namespace (`filter[password]`, `page` of a cursor table, `search` of a table without searchable columns) is a 400 as well. Keys
 * that are not the table's are left to the page.
 */
export function parseState(definition: TableDefinition, query: Iterable<[string, unknown]>): TableState {
  const keys = queryKeys(definition);
  const seen = new Map<string, unknown>();
  for (const [key, value] of query) {
    if (!isTableKey(definition, key)) continue;
    // A repeated key is a list: refused (one sort, one page, one value per filter).
    seen.set(key, seen.has(key) ? [seen.get(key), value] : value);
  }
  let sort = definition.defaultSort;
  let page = 1;
  let perPage = definition.perPage[0];
  let cursor: string | undefined;
  let search = '';
  const filters: Record<string, string> = {};
  for (const [key, raw] of seen) {
    const value = parseKey(definition, key, raw);
    if (key === keys.sort) sort = value as string;
    else if (key === keys.page) page = value as number;
    else if (key === keys.perPage) perPage = value as number;
    else if (key === keys.cursor) cursor = value as string;
    else if (key === keys.search) search = value as string;
    else filters[key.slice(keys.filterPrefix.length, -1)] = value as string;
  }
  return {
    sort: sort === undefined ? undefined : sort.startsWith('-') ? { column: sort.slice(1), direction: 'desc' } : { column: sort, direction: 'asc' },
    page,
    perPage,
    cursor,
    search,
    filters,
  };
}

/** The state's URL fields without defaults — what an export URL carries and "all matching" sends back. Never the page or cursor. */
export function stateQuery(definition: TableDefinition, state: TableState): Record<string, string> {
  const keys = queryKeys(definition);
  const out: Record<string, string> = {};
  const sort = state.sort && (state.sort.direction === 'desc' ? `-${state.sort.column}` : state.sort.column);
  if (sort !== undefined && sort !== definition.defaultSort) out[keys.sort] = sort;
  if (state.search) out[keys.search] = state.search;
  for (const [name, value] of Object.entries(state.filters)) out[keys.filter(name)] = value;
  return out;
}

/** A field that is the table's: its value checked by {@link parseKey} — a wrong one throws the 400 out of the query's parsing. */
function strict(definition: TableDefinition, key: string) {
  return v.pipe(
    v.unknown(),
    v.transform((value: unknown) => parseKey(definition, key, value)),
  );
}

/**
 * The table's state as a query schema (Valibot) — what `MembersTable.query` is. Its fields parse what {@link parseState} parses and
 * **throw** the 400 instead of reporting an issue: the router's query parsing falls back per field on issues (E56), a table must not.
 * Defaults are filled in (sort, page, per_page), so the browser leaves them out of URLs it builds.
 */
export function querySchema(definition: TableDefinition): TableQuerySchema {
  const keys = queryKeys(definition);
  const fields: Record<string, v.GenericSchema> = {};
  if (definition.defaultSort !== undefined) fields[keys.sort] = v.optional(strict(definition, keys.sort), definition.defaultSort);
  if (definition.cursor) fields[keys.cursor] = v.optional(strict(definition, keys.cursor));
  else fields[keys.page] = v.optional(strict(definition, keys.page), '1');
  fields[keys.perPage] = v.optional(strict(definition, keys.perPage), String(definition.perPage[0]));
  if (searchable(definition)) fields[keys.search] = v.optional(strict(definition, keys.search), '');
  for (const name of Object.keys(definition.filters)) fields[keys.filter(name)] = v.optional(strict(definition, keys.filter(name)));
  return v.object(fields) as unknown as TableQuerySchema;
}
