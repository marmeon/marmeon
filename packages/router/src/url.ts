/**
 * Building URLs for named routes — the one code path behind `Router.url()`, signed URLs and the
 * browser's `route()`. Free of server code and of imports beyond `pattern.ts`: the browser loads it through
 * `@marmeon/http/page` (as `@marmeon/router/url`).
 */

import { matchParams, tokenizePattern } from './pattern.ts';

/** A value for a path parameter: `{ user: 7 }` or `{ user: 'ada' }`. */
export type Param = string | number;

/** One query value. `null` and `undefined` are left out; an array repeats the key (`?tag=a&tag=b`). */
export type QueryValue = Param | boolean | null | undefined | readonly (Param | boolean)[];

/** The query string of a URL: `{ tab: 'links', page: 2 }` → `?tab=links&page=2`. */
export type Query = Readonly<Record<string, QueryValue>>;

/** @internal Where a route name leads — the router (`findByName`) or the browser's route manifest. */
export interface RouteLookup {
  findByName(name: string): { readonly path: string; readonly localized?: boolean } | undefined;
}

/**
 * Fills a route pattern (`/users/:user/links/:link?`) with `params`. Parameters the path does not take
 * come back as `rest` — callers put them into the query.
 * @internal
 */
export function fillPath(name: string, pattern: string, params: Readonly<Record<string, Param | undefined>> = {}): { path: string; rest: Record<string, Param> } {
  const used = new Set<string>();
  let path = '';
  for (const token of tokenizePattern(pattern)) {
    if ('text' in token) {
      path += token.text;
      continue;
    }
    const key = token.name;
    used.add(key);
    const value = params[key];
    if (value === undefined || value === '') {
      if (token.optional) continue;
      throw new Error(`Missing required parameter [${key}] for route [${name}].`);
    }
    // A browser resolves even `%2E%2E` as a dot segment: no encoding keeps the link on its route.
    if (value === '.' || value === '..') throw new Error(`Parameter [${key}] of route [${name}] cannot be [${value}]: a dot segment leads to another route.`);
    path += `/${encodeURIComponent(String(value))}`;
  }
  const rest: Record<string, Param> = {};
  for (const [key, value] of Object.entries(params)) if (!used.has(key) && value !== undefined) rest[key] = value;
  return { path: path || '/', rest };
}

/** Query values as search parameters, in the given order; `null`/`undefined` left out. */
export function toSearchParams(...queries: Query[]): URLSearchParams {
  const search = new URLSearchParams();
  for (const query of queries) {
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== null && item !== undefined) search.append(key, String(item));
      }
    }
  }
  return search;
}

/**
 * The URL of a named route: path parameters filled in, everything else in the query.
 *
 * ```ts
 * urlFor(router, 'user-profile.show', { user: 7 }, { tab: 'links' })   // → /users/7?tab=links
 * ```
 *
 * @internal The framework's; an app uses `Router.url` and `redirect().route()`.
 */
export function urlFor(routes: RouteLookup, name: string, params: Readonly<Record<string, Param | undefined>> = {}, query: Query = {}): string {
  const route = routes.findByName(name);
  // The code is written out: this file loads in the browser and imports no server code.
  if (!route) throw new Error(`[marmeon:H4] Route [${name}] is not defined.`);
  const { path, rest } = fillPath(name, route.path, params);
  const search = toSearchParams(rest, query).toString();
  return search ? `${path}?${search}` : path;
}

/**
 * Whether `pathname` is a path of route pattern `pattern` (`/users/:user/links/:link?`, constraints like `:id{[0-9]+}`
 * included) — how the browser tells which route the page on screen belongs to, without the server naming it. A trailing slash
 * is ignored, which the server's own matching is not.
 *
 * @internal The framework's.
 */
export function matchesPath(pattern: string, pathname: string): boolean {
  return matchParams(pattern, pathname) !== undefined;
}
