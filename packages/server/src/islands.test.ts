import { ConsoleLogger, createApplication, defineModule, Logger, type Container } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { abort, AfterResponse, defer, HttpServiceProvider, island, merge, view, type HttpContext } from '@bespokecore/http';
import { defineRoutes } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

const ISLAND = { 'x-bespoke': 'true', 'x-bespoke-region': 'island' };

/** A response's JSON body, for assertions. */
const json = async (response: Response) => (await response.json()) as { message?: string; props?: unknown; [key: string]: unknown };

describe('createHttpKernel — islands (E48, E52)', async () => {
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
  const routes = defineRoutes((Route) => {
    Route.get('/islands/feed', (ctx: HttpContext) =>
      island('dashboard/Feed', { items: merge(['a', 'b']), more: defer(() => ['later']), at: new URL(ctx.request.url).search }),
    );
    Route.get('/islands/redirects', () => new Response(null, { status: 302, headers: { location: '/login' } }));
    Route.get('/islands/unauthenticated', () => Response.json({ message: 'Unauthenticated.' }, { status: 401 }));
    Route.get('/islands/forbidden', () => abort(403, 'Only admins.'));
    Route.get('/islands/missing', () => abort(404));
    Route.get('/islands/boom', () => {
      throw new Error('database password is hunter2');
    });
    Route.get('/islands/cookie', (ctx: HttpContext) => {
      ctx.cookies.set('tracking', 'yes');
      return island('dashboard/Feed', { items: [] });
    });
    Route.get('/page', () => view('pages/Show', {}));
    // A route built without the types (plain JS): `Route.post` refuses an island's action at compile time.
    (Route.post as (path: string, action: unknown) => unknown)('/islands/post', () => island('dashboard/Feed', {}));
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
  const deferring = defineRoutes((Route) => Route.get('/islands/defers', DeferringIsland));
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey() },
    providers: [EncryptionServiceProvider, HttpServiceProvider, LoggingProvider],
    modules: [defineModule({ name: 'islands', routes }), defineModule({ name: 'deferring', routes: deferring })],
  });
  const app = createHttpKernel(application, { debug: true });
  const production = createHttpKernel(application, { strictReadOnly: false });

  it('answers an island request with its region object — its own props, no locale, its URL — marked and varied', async () => {
    const response = await app.request('/islands/feed?x=1', { headers: ISLAND });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-bespoke-region')).toBe('island');
    expect(response.headers.get('vary')).toContain('x-bespoke-region');
    expect(await json(response)).toEqual({
      component: 'dashboard/Feed',
      props: { items: ['a', 'b'], at: '?x=1' },
      url: '/islands/feed?x=1',
      version: null,
      deferredProps: { default: ['more'] },
      mergeProps: ['items'],
    });
    // Its deferred props, by a partial reload of the island's component.
    const partial = await app.request('/islands/feed', { headers: { ...ISLAND, 'x-bespoke-partial-component': 'dashboard/Feed', 'x-bespoke-partial-data': 'more' } });
    expect((await json(partial)).props).toEqual({ more: ['later'] });
  });

  it('counter-check: a direct hit is a 404 — and so is a page visit or a prefetch of the island’s URL (E52)', async () => {
    const direct = await app.request('/islands/feed', { headers: { accept: 'text/html' } });
    expect(direct.status).toBe(404);
    expect(await direct.text()).toContain('[dashboard/Feed] is an island: it is loaded by');
    expect((await app.request('/islands/feed', { headers: { 'x-bespoke': 'true' } })).status).toBe(404);
    expect((await app.request('/islands/feed', { headers: { ...ISLAND, purpose: 'prefetch' } })).status).toBe(404);
    // In production, a plain 404 — no hint.
    const quiet = await production.request('/islands/feed', { headers: { accept: 'application/json' } });
    expect(await json(quiet)).toEqual({ message: 'Not Found' });
  });

  it('a page is no island: asked for as one, a 404 (marked `exception` for the island)', async () => {
    const response = await app.request('/page', { headers: ISLAND });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-bespoke-region-status')).toBe('exception');
    expect((await json(response)).message).toContain('[pages/Show] is a page, not an island');
  });

  it('counter-check: a redirect, a 401 or a 403 becomes the island’s outcome (204), never a redirect the browser follows', async () => {
    const redirect = await app.request('/islands/redirects', { headers: ISLAND });
    expect([redirect.status, redirect.headers.get('x-bespoke-region-status'), redirect.headers.get('location')]).toEqual([204, 'unauthorized', null]);
    const unauthenticated = await app.request('/islands/unauthenticated', { headers: ISLAND });
    expect([unauthenticated.status, unauthenticated.headers.get('x-bespoke-region-status'), await unauthenticated.text()]).toEqual([204, 'unauthorized', '']);
    const forbidden = await app.request('/islands/forbidden', { headers: ISLAND });
    expect([forbidden.status, forbidden.headers.get('x-bespoke-region-status'), await forbidden.text()]).toEqual([204, 'forbidden', '']);
    // Never cached, and kept apart from the answer without the header.
    expect([redirect.headers.get('cache-control'), redirect.headers.get('vary')]).toEqual(['no-store', 'x-bespoke-region']);
    // Without the island header the same routes answer as always.
    expect((await app.request('/islands/redirects')).status).toBe(302);
  });

  it('a failure is the island’s `exception`, with its status — the message only in development, no error page', async () => {
    const boom = await app.request('/islands/boom', { headers: ISLAND });
    expect([boom.status, boom.headers.get('x-bespoke-region-status'), boom.headers.get('content-type')]).toEqual([500, 'exception', 'application/json']);
    expect((await json(boom)).message).toBe('database password is hunter2');
    const quiet = await production.request('/islands/boom', { headers: ISLAND });
    expect(await json(quiet)).toMatchObject({ message: 'Server Error', exception: null });
    const missing = await app.request('/islands/missing', { headers: ISLAND });
    expect([missing.status, missing.headers.get('x-bespoke-region-status')]).toEqual([404, 'exception']);
  });

  it('counter-check: islands answer GET only — this.island() on a POST route is an error at runtime too', async () => {
    const response = await app.request('/islands/post', { method: 'POST', headers: ISLAND });
    expect(response.status).toBe(500);
    expect((await json(response)).message).toContain('islands answer GET requests only');
  });

  it('a 409 (a new build) passes as it is — the client loads the whole page again', async () => {
    const versioned = createHttpKernel(application, { version: 'v2' });
    const stale = await versioned.request('/islands/feed', { headers: { ...ISLAND, 'x-bespoke-version': 'v1' } });
    expect(stale.status).toBe(409);
    expect(stale.headers.get('x-bespoke-location')).toBe('http://localhost/islands/feed');
  });

  it('counter-check: read-only (E52) — a cookie or work after the response throws in development …', async () => {
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
    // Outside an island the same routes may write.
    expect((await production.request('/islands/defers', { headers: { accept: 'text/html' } })).status).toBe(404);
    await production.settle();
    expect(logged).toContain('deferred work ran');
  });
});
