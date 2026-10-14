import { defineRoutes, everyone } from '@marmeon/http';

type Route = Parameters<Parameters<typeof defineRoutes>[0]>[0];

/** Route files for tests that are not about access: every route in them is open to everyone. */
export function openRoutes(register: (Route: Route) => void): ReturnType<typeof defineRoutes> {
  return defineRoutes((Root) => register(Root.authorize(everyone)));
}
