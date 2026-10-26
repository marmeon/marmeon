/**
 * The query of the page on screen as links and islands need it: its defaults filled in, a URL without them. The state that
 * follows and changes it (`QueryState`) is `query-state.ts`.
 */
import { toSearchParams } from '@marmeon/router/url';
import type { Query } from '../page.ts';
import type { PageObject } from '../protocol.ts';

/** The page's query with its defaults filled in — what its controller saw as `ctx.query`. */
export function pageQueryOf(page: Pick<PageObject, 'query' | 'queryDefaults'>): Record<string, unknown> {
  return { ...page.queryDefaults, ...page.query };
}

/** `values` without the fields that are just their default (and without `undefined`) — what a URL needs to carry. */
export function withoutDefaults(values: Readonly<Record<string, unknown>>, defaults: Readonly<Record<string, unknown>> = {}): Query {
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (Object.hasOwn(defaults, key) && JSON.stringify(value) === JSON.stringify(defaults[key])) continue;
    query[key] = value;
  }
  return query as Query;
}

/** The URL of the page on screen with `values` as its query (defaults left out; values as `String()`, lists as repeated keys). */
export function queryUrl(page: Pick<PageObject, 'url' | 'queryDefaults'>, values: Readonly<Record<string, unknown>>): string {
  const pathname = new URL(page.url, 'http://marmeon.invalid').pathname;
  const search = toSearchParams(withoutDefaults(values, page.queryDefaults)).toString();
  return search ? `${pathname}?${search}` : pathname;
}

/**
 * The query of a link to `url` (built without a query): for the page on screen — the same path — without the fields
 * that are just its defaults (`<Link query={{ ...query, sort: '-name' }}>` writes no `q=`); for any other page as given.
 */
export function linkQuery(page: Pick<PageObject, 'url' | 'queryDefaults'>, url: string, query: Query): Query {
  if (!page.queryDefaults) return query;
  const base = 'http://marmeon.invalid';
  return new URL(url, base).pathname === new URL(page.url, base).pathname ? withoutDefaults(query, page.queryDefaults) : query;
}
