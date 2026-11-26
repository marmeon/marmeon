import { matchesPath, namesLocaleSegment, urlFor, withoutLocale } from '@marmeon/router/url';
import type { Param, Query, RouteManifest } from '../page.ts';

/** What {@link resolveRoute} takes besides the route's name. */
export interface ResolveRouteOptions {
  /** The route's parameters. */
  readonly params?: Readonly<Record<string, Param>> | undefined;
  /** The query string to append. */
  readonly query?: Query | undefined;
  /** The locale of the page on screen — a localized route takes it when `params` name no `locale`. */
  readonly pageLocale?: string | undefined;
  /** `PageObject.urlLocales`: with it the pages of `unprefixed` are built without a prefix (`/about`); the other locales keep theirs. */
  readonly urlLocales?: { readonly unprefixed: string; readonly supported: readonly string[] } | undefined;
}

/**
 * The manifest's entry for route `name`, without building a URL — the lookup {@link resolveRoute} starts with, for code that
 * needs only to know the route is there (query state follows the page's own URL). Throws the [marmeon:C1]/[marmeon:C2] errors.
 *
 * @internal The framework's.
 */
export function routeEntry(manifest: RouteManifest | undefined, name: string): RouteManifest[string] {
  if (!manifest) {
    throw new Error(
      (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
        ? `[marmeon:C1] Route [${name}]: the browser has no route manifest — pass the routes of virtual:marmeon/routes to createMarmeonApp({ routes }) and createSsrRenderer(…, { routes }).`
        : `[marmeon:C1] ${name}`,
    );
  }
  const entry = Object.hasOwn(manifest, name) ? manifest[name] : undefined;
  if (!entry) {
    throw new Error(
      (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')
        ? `[marmeon:C2] Route [${name}] is not defined in the browser: a build ships only the route names client code writes out (<Link route="…">, route('…'), useForm('…', …)), ` +
            'never API routes, .internal() routes or clientRoutes.except (run marmeon route:types after adding a route).'
        : `[marmeon:C2] ${name}`,
    );
  }
  return entry;
}

/**
 * Where a named route leads and how to call it — from the routes the browser knows (`routes` of
 * `virtual:marmeon/routes`). Throws for a name the manifest lacks. What an adapter's `route()`, `<Link route>` and
 * `useForm(name, …)` resolve with; the names are typed in the adapter (`CheckBrowserRouteName`).
 *
 * A localized route (`Route.localized()`) given no `locale` in `params` takes `options.pageLocale`: the locale of the
 * page on screen. An explicit `locale` wins; a route that is not localized takes none. The value only fills a path
 * segment (encoded), so it never leads off this site. With `urlLocales` the pages of its `unprefixed` locale have no prefix
 * (`/about`), except one whose address without it would start with a locale (`/de/EN`).
 */
export function resolveRoute(
  manifest: RouteManifest | undefined,
  name: string,
  options: ResolveRouteOptions = {},
): { url: string; method: string } {
  if (arguments.length > 3 || typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(`resolveRoute(manifest, name, options) takes { params, query, pageLocale, urlLocales } as its third argument (route [${name}]).`);
  }
  for (const key of Object.keys(options)) {
    if (key !== 'params' && key !== 'query' && key !== 'pageLocale' && key !== 'urlLocales') {
      throw new TypeError(`resolveRoute() takes { params, query, pageLocale, urlLocales }, not [${key}] (route [${name}]).`);
    }
  }
  const { params, query, pageLocale, urlLocales } = options;
  if (urlLocales !== undefined && (typeof urlLocales !== 'object' || urlLocales === null || typeof urlLocales.unprefixed !== 'string' || !Array.isArray(urlLocales.supported) || !urlLocales.supported.every((locale) => typeof locale === 'string'))) {
    throw new TypeError(`resolveRoute() takes { params, query, pageLocale, urlLocales } with urlLocales as { unprefixed: string, supported: string[] } (route [${name}]).`);
  }
  const entry = routeEntry(manifest, name);
  const locale = entry.localized && params?.locale === undefined ? pageLocale : undefined;
  return { url: urlFor({ findByName: () => entry, unprefixedLocale: urlLocales?.unprefixed, locales: urlLocales?.supported }, name, locale === undefined ? params : { ...params, locale }, query), method: entry.method };
}

/**
 * Whether `pathname` is a path of the route's page — its pattern, and for a localized route also the pattern without its
 * `/:locale` when `urlLocales` is given (the page of its `unprefixed` locale has no prefix). Like the server, that address never
 * answers a path that starts with a locale (`/en`).
 *
 * @internal The framework's.
 */
export function matchesRoute(entry: { readonly path: string; readonly localized?: boolean | undefined }, pathname: string, urlLocales?: ResolveRouteOptions['urlLocales']): boolean {
  if (matchesPath(entry.path, pathname)) return true;
  return entry.localized === true && urlLocales !== undefined && !namesLocaleSegment(pathname, urlLocales.supported) && matchesPath(withoutLocale(entry.path), pathname);
}
