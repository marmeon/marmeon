import { regionOf } from '@marmeon/http';
import type { RouteDefinition } from '@marmeon/router';
import { isIslandAction } from '@marmeon/router/internal';
import { toRegionResponse } from './render.ts';

/** Why a request for an island reached no island: the text a debugging app reads (JSON `message`, or an island's failure). */
export function islandRefusalMessage(method: string, path: string, route: RouteDefinition | undefined): string {
  return route === undefined
    ? `${method} ${path} is no route: an island's request is refused before any middleware runs (docs/deferred-props.md#the-islands-route).`
    : `${method} ${path} is no island: no controller class of it calls this.island(…) — a closure is never an island's route; keep the call in the controller class (docs/deferred-props.md#the-islands-route).`;
}

/**
 * The answer to an island request (`x-marmeon-region: island`) for a route that is no island — a page, a JSON endpoint, a
 * closure, a path no route answers: a `404` marked as the island's `exception`. Undefined for any other request, and for a
 * route whose controller is marked as one that answers with `island()` (see docs/deferred-props.md#the-islands-route).
 *
 * It runs in the route's handler before `handle()`, so no middleware (the global ones included) and no controller sees the
 * request: whoever steers an island's `href` cannot run another route with the visitor's cookies. A route whose mark is missing
 * is refused too, in every mode. In production the answer equals the one for an unknown path and says nothing more; with
 * `debug` the `message` names cause and remedy.
 */
export async function refuseIslandRequest(
  request: Request,
  route: RouteDefinition | undefined,
  debug: boolean,
  render: (message: string | undefined) => Response | Promise<Response>,
): Promise<Response | undefined> {
  if (regionOf(request) !== 'island') return undefined;
  if (route !== undefined && isIslandAction(route.action)) return undefined;
  // The exception handler's own answer to a 404, as for an unknown path: in production no request tells the two apart.
  const message = debug ? islandRefusalMessage(request.method, new URL(request.url).pathname, route) : undefined;
  return toRegionResponse(await render(message));
}
