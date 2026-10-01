import { resolveRoute } from '@bespokecore/http/client';
import type { BrowserRouteNameInput, CheckBrowserRouteName, Param, Query, RouteArgs, RouteManifest } from '@bespokecore/http/page';
import { createContext, useContext, useMemo } from 'react';

/** The route manifest of the app (`bootstrap/routes.ts`), from `createBespokeApp({ routes })` / `createSsrRenderer(…, { routes })`. */
export const RoutesContext = createContext<RouteManifest | undefined>(undefined);

/** A named route's URL, typed against the routes the browser knows: `route('user-profile.show', { user: 7 }, { tab: 'links' })`. */
export type RouteFunction = <const N extends BrowserRouteNameInput>(name: CheckBrowserRouteName<N>, ...args: RouteArgs<N>) => string;

/**
 * URLs of named routes, in a component:
 *
 * ```tsx
 * const route = useRoute();
 * <a href={route('user-profile.show', { user: profile.id }, { tab: 'links' })}>…</a>   // /users/7?tab=links
 * ```
 *
 * Names and path parameters are checked against `bootstrap/routes.ts` (`bespoke route:types`).
 */
export function useRoute(): RouteFunction {
  const manifest = useContext(RoutesContext);
  return useMemo(
    () => ((name: string, params?: Readonly<Record<string, Param>>, query?: Query) => resolveRoute(manifest, name, params, query).url) as RouteFunction,
    [manifest],
  );
}
