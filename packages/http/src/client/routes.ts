import { urlFor } from '@marmeon/router/url';
import type { Param, Query, RouteManifest } from '../page.ts';

/** What {@link resolveRoute} takes besides the route's name. */
export interface ResolveRouteOptions {
  /** The route's parameters. */
  readonly params?: Readonly<Record<string, Param>> | undefined;
  /** The query string to append. */
  readonly query?: Query | undefined;
  /** The locale of the page on screen — a localized route takes it when `params` name no `locale`. */
  readonly pageLocale?: string | undefined;
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
 * segment (encoded), so it never leads off this site.
 */
export function resolveRoute(
  manifest: RouteManifest | undefined,
  name: string,
  options: ResolveRouteOptions = {},
): { url: string; method: string } {
  if (arguments.length > 3 || typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError(`resolveRoute(manifest, name, options) takes { params, query, pageLocale } as its third argument (route [${name}]).`);
  }
  for (const key of Object.keys(options)) {
    if (key !== 'params' && key !== 'query' && key !== 'pageLocale') {
      throw new TypeError(`resolveRoute() takes { params, query, pageLocale }, not [${key}] (route [${name}]).`);
    }
  }
  const { params, query, pageLocale } = options;
  const entry = routeEntry(manifest, name);
  const locale = entry.localized && params?.locale === undefined ? pageLocale : undefined;
  return { url: urlFor({ findByName: () => entry }, name, locale === undefined ? params : { ...params, locale }, query), method: entry.method };
}
