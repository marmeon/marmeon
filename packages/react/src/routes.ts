import { resolveRoute } from '@marmeon/http/client';
import type { BrowserParamsOf, BrowserRouteNameInput, CheckBrowserRouteName, Param, Query, QueryParams, RouteManifest } from '@marmeon/http/page';
import { createContext, useContext, useMemo } from 'react';
import { RouterContext, useStableUrlLocales } from './app.tsx';

/** The route manifest of the app (`virtual:marmeon/routes`), from `createMarmeonApp({ routes })` / `createSsrRenderer(…, { routes })`. */
export const RoutesContext = createContext<RouteManifest | undefined>(undefined);

/** What the page on screen tells `resolveRoute` about the address of a localized route: its locale, and how the app prefixes its locales. */
export function pageUrlOptions(page: { readonly locale?: string | undefined; readonly urlLocales?: { readonly unprefixed: string; readonly supported: readonly string[] } | undefined } | undefined): { pageLocale: string | undefined; urlLocales: { readonly unprefixed: string; readonly supported: readonly string[] } | undefined } {
  return { pageLocale: page?.locale, urlLocales: page?.urlLocales };
}

/** A named route's URL, typed against the routes the browser knows: `route('user-profile.show', { user: 7 }, { tab: 'links' })`. */
export type RouteFunction = <const N extends BrowserRouteNameInput>(
  name: CheckBrowserRouteName<N>,
  ...args: {} extends BrowserParamsOf<N> ? [params?: BrowserParamsOf<N>, query?: QueryParams<N>] : [params: BrowserParamsOf<N>, query?: QueryParams<N>]
) => string;

/**
 * URLs of named routes, in a component:
 *
 * ```tsx
 * const route = useRoute();
 * <a href={route('user-profile.show', { user: profile.id }, { tab: 'links' })}>…</a>   // /users/7?tab=links
 * ```
 *
 * Names and path parameters are checked against `bootstrap/routes.ts` (`marmeon route:types`). A localized route takes the
 * locale of the page on screen; `{ locale: 'de' }` names another (docs/navigation.md#links-to-routes).
 */
export function useRoute(): RouteFunction {
  const manifest = useContext(RoutesContext);
  const page = useContext(RouterContext)?.page;
  const pageLocale = page?.locale;
  const urlLocales = useStableUrlLocales(page?.urlLocales);
  return useMemo(
    () => ((name: string, params?: Readonly<Record<string, Param>>, query?: Query) => resolveRoute(manifest, name, { params, query, pageLocale, urlLocales }).url) as RouteFunction,
    [manifest, pageLocale, urlLocales],
  );
}
