import { defineRoutes, everyone } from '@marmeon/http';

type Register = Parameters<typeof defineRoutes>[0];

/** Route files for tests that are not about access: every route in them is open to everyone. */
export function openRoutes(register: (Route: Parameters<Register>[0]) => void): ReturnType<typeof defineRoutes> {
  return defineRoutes((Root) => register(Root.authorize(everyone)));
}
