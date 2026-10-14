import { everyone } from '../access.ts';
import type { Route } from '../route.ts';
import { defineRoutes, type RouteDefinitions } from '../router.ts';

/** Route files for tests that are not about access: every route in them is open to everyone. */
export function openRoutes(register: (Route: Route) => void): RouteDefinitions {
  return defineRoutes((Root) => register(Root.authorize(everyone)));
}

/** Route files for tests of bindings: a check of their own decides, so no binding is an open one. */
export function checkedRoutes(register: (Route: Route) => void): RouteDefinitions {
  return defineRoutes((Root) => register(Root.authorize(() => true)));
}
