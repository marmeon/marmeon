import { urlFor, type CheckBrowserRouteName, type Param, type Query, type RouteArgs, type BrowserRouteNameInput, type RouteManifest } from '@bespokecore/http/page';
import { createContext, useContext, useMemo } from 'react';

/** The route manifest of the app (`bootstrap/routes.ts`), from `createBespokeApp({ routes })` / `createSsrRenderer(…, { routes })`. */
export const RoutesContext = createContext<RouteManifest | undefined>(undefined);

/** A named route's URL, typed against the routes the browser knows: `route('user-profile.show', { user: 7 }, { tab: 'links' })`. */
export type RouteFunction = <const N extends BrowserRouteNameInput>(name: CheckBrowserRouteName<N>, ...args: RouteArgs<N>) => string;

/** Where a named route leads and how to call it. Throws for a name the manifest lacks. */
export function resolveRoute(
  manifest: RouteManifest | undefined,
  name: string,
  params?: Readonly<Record<string, Param>>,
  query?: Query,
): { url: string; method: string } {
  if (!manifest) {
    throw new Error(`Route [${name}]: the browser has no route manifest — pass the routes of bootstrap/routes.ts to createBespokeApp({ routes }) and createSsrRenderer(…, { routes }).`);
  }
  const entry = Object.hasOwn(manifest, name) ? manifest[name] : undefined;
  if (!entry) throw new Error(`Route [${name}] is not defined in the browser (API routes and clientRoutes.except are left out; run bespoke route:types after adding one).`);
  return { url: urlFor({ findByName: () => entry }, name, params, query), method: entry.method };
}

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
