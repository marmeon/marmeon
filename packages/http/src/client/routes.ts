import { urlFor } from '@bespokecore/router/url';
import type { Param, Query, RouteManifest } from '../page.ts';

/**
 * Where a named route leads and how to call it — from the routes the browser knows (`routes` of the generated
 * `bootstrap/routes.ts`). Throws for a name the manifest lacks. What an adapter's `route()`, `<Link route>` and
 * `useForm(name, …)` resolve with; the names are typed in the adapter (`CheckBrowserRouteName`).
 */
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
