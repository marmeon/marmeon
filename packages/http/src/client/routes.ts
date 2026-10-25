import { urlFor } from '@marmeon/router/url';
import type { Param, Query, RouteManifest } from '../page.ts';

/**
 * Where a named route leads and how to call it — from the routes the browser knows (`routes` of
 * `virtual:marmeon/routes`). Throws for a name the manifest lacks. What an adapter's `route()`, `<Link route>` and
 * `useForm(name, …)` resolve with; the names are typed in the adapter (`CheckBrowserRouteName`).
 *
 * A localized route (`Route.localized()`) given no `locale` takes `defaults.locale` — the page on screen's. An explicit
 * `locale` wins; a route that is not localized takes none. The value only fills a path segment (encoded), so it never
 * leads off this site.
 */
export function resolveRoute(
  manifest: RouteManifest | undefined,
  name: string,
  params?: Readonly<Record<string, Param>>,
  query?: Query,
  defaults?: { readonly locale?: string | undefined },
): { url: string; method: string } {
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
  const locale = entry.localized && params?.locale === undefined ? defaults?.locale : undefined;
  return { url: urlFor({ findByName: () => entry }, name, locale === undefined ? params : { ...params, locale }, query), method: entry.method };
}
