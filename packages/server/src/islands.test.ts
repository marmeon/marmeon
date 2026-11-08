import { ConsoleLogger, createApplication, defineModule, Logger, type Container } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, AfterResponse, defer, HttpServiceProvider, island, merge, view, type HttpContext } from '@marmeon/http';
import { openRoutes } from './test-helpers/open-routes.ts';
import { islandRoute } from './test-helpers/island-route.ts';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import type { Next } from '@marmeon/router';

const ISLAND = { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-region': 'island' };

/** A response's JSON body, for assertions. */
const json = async (response: Response) => (await response.json()) as { message?: string; props?: unknown; [key: string]: unknown };

describe('createHttpKernel — islands', async () => {
  const logged: string[] = [];
  class CollectingLogger extends ConsoleLogger {
    override error(message: string): void {
      logged.push(message);
    }
    override child(): Logger {
      return this;
    }
  }
  class LoggingProvider {
    register(container: Container) {
      container.singleton(Logger, () => new CollectingLogger());
    }
  }
  /** An app's own ETag middleware: a fixed tag over the 200, a matching `If-None-Match` answered with a 304 that keeps the 200's headers. */
  class ETagged {
    async handle(ctx: HttpContext, next: Next<{}>) {
      const response = await next();
      if (response.status !== 200) return response;
      const headers = new Headers(response.headers);
      headers.set('etag', '"feed-v1"');
      headers.set('cache-control', 'private, max-age=0, must-revalidate');
      if (ctx.request.headers.get('if-none-match') === '"feed-v1"') {
        await response.body?.cancel();
        return new Response(null, { status: 304, headers });
      }
      return new Response(response.body, { status: 200, headers });
    }
  }
  const routes = openRoutes((Route) => {
    Route.middleware(ETagged).get('/islands/etagged', islandRoute(() => island('dashboard/Feed', { items: ['a'] })));
    Route.get('/islands/feed', islandRoute((ctx) =>
      island('dashboard/Feed', { items: merge(['a', 'b']), more: defer(() => ['later']), at: new URL(ctx.request.url).search }),
    ));
    Route.get('/islands/redirects', islandRoute(() => new Response(null, { status: 302, headers: { location: '/login' } })));
    Route.get('/islands/unauthenticated', islandRoute(() => Response.json({ message: 'Unauthenticated.' }, { status: 401 })));
    Route.get('/islands/forbidden', islandRoute(() => abort(403, 'Only admins.')));
    Route.get('/islands/missing', islandRoute(() => abort(404)));
    Route.get('/islands/boom', islandRoute(() => {
      throw new Error('database password is hunter2');
    }));
    Route.get('/islands/cookie', islandRoute((ctx) => {
      ctx.cookies.set('tracking', 'yes');
      return island('dashboard/Feed', { items: [] });
    }));
    Route.get('/page', () => view('pages/Show', {}));
    // A marked controller that answers a page from a branch: the second line of defence, past the gate.
    Route.get('/islands/answers-page', islandRoute(() => view('pages/Show', {})));
    // A route built without the types (plain JS): `Route.post` refuses an island's action at compile time.
    (Route.post as (path: string, action: unknown) => unknown)('/islands/post', islandRoute(() => island('dashboard/Feed', {})));
  });
  class DeferringIsland {
    readonly #after: AfterResponse;
    constructor(after: AfterResponse) {
      this.#after = after;
    }
    handle() {
      this.#after.defer(() => logged.push('deferred work ran'));
      return island('dashboard/Feed', { items: [] });
    }
  }
  const deferring = openRoutes((Route) => Route.get('/islands/defers', DeferringIsland));
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, LoggingProvider],
    modules: [defineModule({ name: 'islands', routes }), defineModule({ name: 'deferring', routes: deferring })],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application, { debug: true });
  const production = createHttpKernel(application, { strictReadOnly: false });

  it('answers an island request with its region object — its own props, no locale, its URL — marked and varied', async () => {
    const response = await app.request('/islands/feed?x=1', { headers: ISLAND });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-marmeon-region')).toBe('island');
    expect(response.headers.get('vary')).toContain('x-marmeon-region');
    expect(await json(response)).toEqual({
      component: 'dashboard/Feed',
      props: { items: ['a', 'b'], at: '?x=1' },
      url: '/islands/feed?x=1',
      version: null,
      deferredProps: { default: ['more'] },
      mergeProps: ['items'],
    });
    // Its deferred props, by a partial reload of the island's component.
    const partial = await app.request('/islands/feed', { headers: { ...ISLAND, 'x-marmeon-partial-component': 'dashboard/Feed', 'x-marmeon-partial-data': 'more' } });
    expect((await json(partial)).props).toEqual({ more: ['later'] });
  });

  it('an island behind an ETag middleware revalidates: its 304 passes with the island header, not as an outcome', async () => {
    const first = await app.request('/islands/etagged', { headers: ISLAND });
    expect([first.status, first.headers.get('etag'), first.headers.get('x-marmeon-region')]).toEqual([200, '"feed-v1"', 'island']);
    expect((await json(first)).component).toBe('dashboard/Feed');
    const second = await app.request('/islands/etagged', { headers: { ...ISLAND, 'if-none-match': '"feed-v1"' } });
    expect([second.status, second.headers.get('x-marmeon-region'), second.headers.get('etag')]).toEqual([304, 'island', '"feed-v1"']);
    expect(second.headers.has('x-marmeon-region-status')).toBe(false);
  });

  it('a direct hit is a 404 — and so is a page visit or a prefetch of the island’s URL', async () => {
    const direct = await app.request('/islands/feed', { headers: { accept: 'text/html' } });
    expect(direct.status).toBe(404);
    expect(await direct.text()).toContain('GET /islands/feed is an island: it is loaded by');
    expect((await app.request('/islands/feed', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION } })).status).toBe(404);
    expect((await app.request('/islands/feed', { headers: { ...ISLAND, purpose: 'prefetch' } })).status).toBe(404);
    // In production, a plain 404 — no hint.
    const quiet = await production.request('/islands/feed', { headers: { accept: 'application/json' } });
    expect(await json(quiet)).toEqual({ message: 'Not Found' });
  });

  it('a page is no island: asked for as one, a 404 (marked `exception` for the island) that says why in development', async () => {
    const response = await app.request('/page', { headers: ISLAND });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-marmeon-region-status')).toBe('exception');
    expect((await json(response)).message).toContain('GET /page is no island');
  });

  it('a marked controller that answers a page is no island either: a 404 that names the page, in development only', async () => {
    const response = await app.request('/islands/answers-page', { headers: ISLAND });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-marmeon-region-status')).toBe('exception');
    expect((await json(response)).message).toContain('[pages/Show] is a page, not an island');
    expect(await json(await production.request('/islands/answers-page', { headers: ISLAND }))).not.toHaveProperty('message', expect.stringContaining('page'));
  });

  it('a redirect, a 401 or a 403 becomes the island’s outcome (204), never a redirect the browser follows', async () => {
    const redirect = await app.request('/islands/redirects', { headers: ISLAND });
    expect([redirect.status, redirect.headers.get('x-marmeon-region-status'), redirect.headers.get('location')]).toEqual([204, 'unauthorized', null]);
    const unauthenticated = await app.request('/islands/unauthenticated', { headers: ISLAND });
    expect([unauthenticated.status, unauthenticated.headers.get('x-marmeon-region-status'), await unauthenticated.text()]).toEqual([204, 'unauthorized', '']);
    const forbidden = await app.request('/islands/forbidden', { headers: ISLAND });
    expect([forbidden.status, forbidden.headers.get('x-marmeon-region-status'), await forbidden.text()]).toEqual([204, 'forbidden', '']);
    // Never cached, and kept apart from the answer without the header.
    expect([redirect.headers.get('cache-control'), redirect.headers.get('vary')]).toEqual(['no-store', 'x-marmeon-region']);
    // Without the island header the island's route is a 404 before its controller can redirect.
    expect((await app.request('/islands/redirects')).status).toBe(404);
  });

  it('a failure is the island’s `exception`, with its status — the message only in development, no error page', async () => {
    const boom = await app.request('/islands/boom', { headers: ISLAND });
    expect([boom.status, boom.headers.get('x-marmeon-region-status'), boom.headers.get('content-type')]).toEqual([500, 'exception', 'application/json']);
    expect((await json(boom)).message).toBe('database password is hunter2');
    const quiet = await production.request('/islands/boom', { headers: ISLAND });
    expect(await json(quiet)).toMatchObject({ message: 'Server Error', exception: null });
    const missing = await app.request('/islands/missing', { headers: ISLAND });
    expect([missing.status, missing.headers.get('x-marmeon-region-status')]).toEqual([404, 'exception']);
  });

  it('islands answer GET only — this.island() on a POST route is an error at runtime too', async () => {
    const response = await app.request('/islands/post', { method: 'POST', headers: ISLAND });
    expect(response.status).toBe(500);
    expect((await json(response)).message).toContain('islands answer GET requests only');
  });

  it('a 409 (a new build) passes as it is — the client loads the whole page again', async () => {
    const versioned = createHttpKernel(application, { assetVersion: 'v2' });
    const stale = await versioned.request('/islands/feed', { headers: { ...ISLAND, 'x-marmeon-version': 'v1' } });
    expect(stale.status).toBe(409);
    expect(stale.headers.get('x-marmeon-location')).toBe('/islands/feed');
  });

  it('an island is read-only — a cookie or work after the response throws in development …', async () => {
    const cookie = await app.request('/islands/cookie', { headers: ISLAND });
    expect(cookie.status).toBe(500);
    expect(cookie.headers.get('set-cookie')).toBeNull();
    expect((await json(cookie)).message).toContain("cookies.set('tracking') in an island request (GET /islands/cookie): an island is read-only");
    const deferred = await app.request('/islands/defers', { headers: ISLAND });
    expect(deferred.status).toBe(500);
    await app.settle();
    expect(logged).not.toContain('deferred work ran');
    expect((await json(deferred)).message).toContain('afterResponse.defer() in an island request');
  });

  it('… and is dropped and logged in production — the island answers', async () => {
    logged.length = 0;
    const cookie = await production.request('/islands/cookie', { headers: ISLAND });
    expect(cookie.status).toBe(200);
    expect(cookie.headers.get('set-cookie')).toBeNull();
    const deferred = await production.request('/islands/defers', { headers: ISLAND });
    expect(deferred.status).toBe(200);
    await production.settle();
    expect(logged).not.toContain('deferred work ran');
    expect(logged.filter((message) => message.includes('an island is read-only'))).toHaveLength(2);
    // Outside an island the route is a 404 before its controller runs: nothing is deferred.
    expect((await production.request('/islands/defers', { headers: { accept: 'text/html' } })).status).toBe(404);
    await production.settle();
    expect(logged).not.toContain('deferred work ran');
  });
});
