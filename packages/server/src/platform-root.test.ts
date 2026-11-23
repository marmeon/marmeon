import { getRequestListener } from '@hono/node-server';
import { expect, it } from 'vitest';

// Made before the adapter replaces the global, and the router's module is first loaded after it: the class `isResponse`
// compares with must be the platform's own, not the adapter's.
const early = new Response('early');
getRequestListener(() => new Response());

it('a Response made before the adapter was installed is one, for a router module loaded after it', async () => {
  expect(Object.getPrototypeOf(Response)).not.toBe(Function.prototype);
  const { isResponse } = await import('@marmeon/router/internal');
  expect(isResponse(early)).toBe(true);
  expect(isResponse(new Response('later'))).toBe(true);
  expect(isResponse({ status: 200 })).toBe(false);
});
