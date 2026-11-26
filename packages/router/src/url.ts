/**
 * Building URLs for named routes — the one code path behind `Router.url()`, signed URLs and the
 * browser's `route()`. Free of server code and of imports beyond `pattern.ts`: the browser loads it through
 * `@marmeon/http/page` (as `@marmeon/router/url`).
 */

import { matchParams, restSegmentProblem, tokenizePattern } from './pattern.ts';

/** A value for a path parameter: `{ user: 7 }` or `{ user: 'ada' }`. */
export type Param = string | number;

/** One query value. `null` and `undefined` are left out; an array repeats the key (`?tag=a&tag=b`). */
export type QueryValue = Param | boolean | null | undefined | readonly (Param | boolean)[];

/** The query string of a URL: `{ tab: 'links', page: 2 }` → `?tab=links&page=2`. */
export type Query = Readonly<Record<string, QueryValue>>;

/** @internal Where a route name leads — the router (`findByName`) or the browser's route manifest. */
export interface RouteLookup {
  findByName(name: string): { readonly path: string; readonly localized?: boolean } | undefined;
  /** The locale whose pages have no prefix (`/about` for `/de/about`), when the app has one; read at every call. */
  readonly unprefixedLocale: string | undefined;
  /** The locales of the app, when known: a page whose address without a prefix would start with one keeps its prefix. */
  readonly locales: readonly string[] | undefined;
}

/**
 * Whether the first segment of `path` — as a URL has it, encoded — is one of the app's locales, in any case. A segment that does
 * not decode counts as one: the answer errs towards "named". The address of the locale without a prefix takes no such path, since
 * the locale's own prefix is where that path belongs: the router answers it with a 404 and asks no route of it, and a page
 * whose address without a prefix would start so (a user named `EN`) keeps its prefix (`/de/EN`).
 *
 * @internal
 */
export function namesLocaleSegment(path: string, supported: readonly string[]): boolean {
  const first = path.split('/')[1];
  if (first === undefined || first === '') return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    return true;
  }
  const lower = decoded.toLowerCase();
  return supported.some((locale) => locale.toLowerCase() === lower);
}

/** @internal A localized pattern without its `/:locale`: the address of the locale that has no prefix, and the one without a locale. */
export const withoutLocale = (pattern: string): string => pattern.replace(/^\/:locale/, '') || '/';

/**
 * The path of a localized route's page in `locale`: without the prefix for `unprefixed` and for no locale at all (`x-default`),
 * `/<locale>/…` for any other. `params` hold the route's own parameters; a `locale` among them is replaced by the one asked for.
 * `supported` are the app's locales: where the address without a prefix would start with one (`/EN`), or when they are not known
 * (`undefined`) while `unprefixed` is set, the page keeps its prefix (`/<unprefixed>/EN`), since the address without a prefix never answers such a path. Nothing here throws for a value that looks like a locale.
 *
 * @internal
 */
export function localePath(name: string, pattern: string, params: Readonly<Record<string, Param | undefined>>, locale: string | undefined, unprefixed: string | undefined, supported: readonly string[] | undefined): string {
  return localeAddress(name, pattern, params, locale, unprefixed, supported).path;
}

/** @internal What {@link localePath} fills, with the pattern it filled (to check the path against) and the parameters that did not fit it. */
export function localeAddress(name: string, pattern: string, params: Readonly<Record<string, Param | undefined>>, locale: string | undefined, unprefixed: string | undefined, supported: readonly string[] | undefined): { path: string; rest: Record<string, Param>; pattern: string } {
  return fillLocalized(name, pattern, params, locale, unprefixed, supported);
}

/**
 * Fills the address of one locale. `locale` must not come back in `rest`, where it would land in the query; a `locale` in `params` is
 * replaced by `locale` (or by `unprefixed`, for a page that keeps its prefix because its address without one would start with one of `supported`).
 */
function fillLocalized(name: string, pattern: string, params: Readonly<Record<string, Param | undefined>>, locale: string | undefined, unprefixed: string | undefined, supported: readonly string[] | undefined): { path: string; rest: Record<string, Param>; pattern: string } {
  if (locale === undefined || locale === unprefixed) {
    const bare = withoutLocale(pattern);
    const filled = fillPath(name, bare, { ...params, locale: undefined });
    // A path that starts with a locale is that locale's own, which the address without a prefix never answers: the page keeps its prefix.
    // Without the locales to compare with, a locale without a prefix keeps its prefix: that is at worst a 301, never another locale's page.
    if (unprefixed === undefined || (supported !== undefined && !namesLocaleSegment(filled.path, supported))) return { ...filled, pattern: bare };
    return { ...fillPath(name, pattern, { ...params, locale: unprefixed }), pattern };
  }
  return { ...fillPath(name, pattern, { ...params, locale }), pattern };
}

/**
 * Fills a route pattern (`/users/:user/links/:link?`) with `params`. Parameters the path does not take
 * come back as `rest` — callers put them into the query.
 * @internal
 */
export function fillPath(name: string, pattern: string, params: Readonly<Record<string, Param | undefined>> = {}): { path: string; rest: Record<string, Param> } {
  const used = new Set<string>();
  let path = '';
  const tokens = tokenizePattern(pattern);
  const hasRest = tokens.some((token) => 'rest' in token && token.rest);
  for (const token of tokens) {
    if ('text' in token) {
      path += token.text;
      continue;
    }
    const key = token.name;
    used.add(key);
    const value = params[key];
    if (token.rest) {
      path += restPath(name, key, value);
      continue;
    }
    if (value === undefined || value === '') {
      if (token.optional) continue;
      throw new Error(`Missing required parameter [${key}] for route [${name}].`);
    }
    // A browser resolves even `%2E%2E` as a dot segment: no encoding keeps the link on its route.
    if (value === '.' || value === '..') throw new Error(`Parameter [${key}] of route [${name}] cannot be [${value}]: a dot segment leads to another route.`);
    // The server counts the segments before a rest: a value it would read as more than one (or refuse) leads to a 404.
    const problem = hasRest ? restSegmentProblem(String(value)) : undefined;
    if (problem !== undefined) throw new Error(`Parameter [${key}] of route [${name}] cannot be [${value}]: a segment before the rest of the path ${problem}.`);
    path += `/${encodeURIComponent(String(value))}`;
  }
  const rest: Record<string, Param> = {};
  for (const [key, value] of Object.entries(params)) if (!used.has(key) && value !== undefined) rest[key] = value;
  return { path: path || '/', rest };
}

/** The path a `/:name*` parameter adds: each segment of `value` encoded, nothing for a missing or empty value. */
function restPath(route: string, key: string, value: Param | undefined): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new TypeError(`Parameter [${key}] of route [${route}] takes the rest of the path as a string, got ${typeof value}.`);
  let path = '';
  for (const segment of value.split('/')) {
    const problem = restSegmentProblem(segment);
    if (problem !== undefined) {
      const hint = value.startsWith('/') && segment === '' && path === '' ? ' (leave out the leading /)' : '';
      throw new Error(`Parameter [${key}] of route [${route}] cannot be [${value}]: a segment ${problem}${hint}.`);
    }
    path += `/${encodeURIComponent(segment)}`;
  }
  return path;
}

/** @internal The framework's: query values as search parameters, in the given order; `null`/`undefined` left out. */
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
  // The locale without a prefix has the address of the pattern without `/:locale`; any other keeps it.
  const bare = route.localized && typeof params.locale === 'string' && params.locale === routes.unprefixedLocale;
  const { path, rest } = bare ? localeAddress(name, route.path, params, params.locale as string, routes.unprefixedLocale, routes.locales) : fillPath(name, route.path, params);
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
