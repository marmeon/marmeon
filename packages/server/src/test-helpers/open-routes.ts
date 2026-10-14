import { defineRoutes, everyone, type Route, type RouteDefinitions } from '@marmeon/router';

/** Route files for tests that are not about access: every route in them is open to everyone. */
export function openRoutes(register: (Route: Route) => void): RouteDefinitions {
  return defineRoutes((Root) => register(Root.authorize(everyone)));
}
