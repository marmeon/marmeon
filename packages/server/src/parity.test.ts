import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import {
  browserRoutes,
  ClientHistory,
  Controller,
  HttpServiceProvider,
  once,
  PageSession,
  SharedData,
  staticView,
  view,
  type HttpContext,
  type Next,
  type PageObject,
} from '@marmeon/http';
import { LOCATION_HEADER, RELOAD_HEADER } from '@marmeon/http/internal';
import { Router } from '@marmeon/router';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { METHOD_FIELD_WINDOW, overrideMethod } from './method-override.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

/** Once props, the two kinds of 409, method spoofing and the CSRF token of a page — on the server. */

describe('once props on the server', async () => {
  const computed: Record<string, number> = {};
  const count = (name: string) => (computed[name] = (computed[name] ?? 0) + 1);
  /** Who the page is for — what the session package binds (a hash of the session id); changes with every sign-in. */
  let scope: string | undefined = 'ada-session';

  class ShareCountries {
    readonly #shared: SharedData;
    constructor(shared: SharedData) {
      this.#shared = shared;
    }
    handle(_ctx: HttpContext, next: Next<{}>) {
      this.#shared.share('countries' as never, once(() => (count('countries'), ['DE', 'GB'])) as never);
      return next();
    }
  }

  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/a', () => view('pages/A', { rates: once(() => (count('rates'), [1.1, 1.2]), { ttl: 60_000 }), name: 'A' }));
          Route.get('/b', () => view('pages/B', { shared: once(() => (count('shared'), 'kept'), { key: 'shared-key' }) }));
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  application.container.make(Router).middleware.append('web', ShareCountries, 400);
  application.container.scoped(PageSession, () => ({ csrfToken: () => 'csrf-of-the-session', scope: () => scope, generation: () => undefined }));
  const app = createHttpKernel(application);
  const visit = async (path: string, headers: Record<string, string> = {}) =>
    (await (await app.request(path, { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, ...headers } })).json()) as PageObject;
  const reset = () => {
    for (const key of Object.keys(computed)) delete computed[key];
  };

  it('sends a once prop with the first page and says where the browser keeps it: shared by name, a page’s own per view, or its key', async () => {
    reset();
    const page = await visit('/a');
    expect(page.props).toEqual({ countries: ['DE', 'GB'], rates: [1.1, 1.2], name: 'A' });
    expect(page.onceProps).toEqual({ countries: { key: 'countries' }, rates: { key: 'pages/A:rates', expiresAt: expect.any(Number) } });
    expect(page.onceScope).toBe('ada-session');
    expect((await visit('/b')).onceProps).toMatchObject({ shared: { key: 'shared-key' } });
  });

  it('skips what the browser holds under the same scope — not computed, still announced', async () => {
    reset();
    const page = await visit('/a', { 'x-marmeon-once': 'countries,pages/A:rates', 'x-marmeon-once-scope': 'ada-session' });
    expect(page.props).toEqual({ name: 'A' });
    expect(Object.keys(page.onceProps ?? {})).toEqual(['countries', 'rates']);
    expect(computed).toEqual({});
  });

  it('computes it again for another scope — someone else signed in (another tab): never a value held for someone else', async () => {
    reset();
    scope = 'alan-session';
    try {
      const page = await visit('/a', { 'x-marmeon-once': 'countries,pages/A:rates', 'x-marmeon-once-scope': 'ada-session' });
      expect(page.props).toMatchObject({ countries: ['DE', 'GB'], rates: [1.1, 1.2] });
      expect(page.onceScope).toBe('alan-session');
      expect(computed).toEqual({ countries: 1, rates: 1 });
    } finally {
      scope = 'ada-session';
    }
  });

  it('a partial reload that names a once prop gets it fresh; a full load (a document) always computes everything', async () => {
    reset();
    const page = await visit('/a', { 'x-marmeon-once': 'pages/A:rates', 'x-marmeon-once-scope': 'ada-session', 'x-marmeon-partial-component': 'pages/A', 'x-marmeon-partial-data': 'rates' });
    expect(page.props).toEqual({ rates: [1.1, 1.2] });
    const html = await (await app.request('/a')).text();
    expect(html).toContain('"countries":["DE","GB"]');
  });

  it('carries the session’s CSRF token for forms that work without JavaScript (`<Form>` renders `_token`)', async () => {
    expect((await visit('/a')).csrf).toBe('csrf-of-the-session');
  });
});

describe('the two kinds of 409 — a new build may wait, signing in or out never', async () => {
  /** Signs someone in before the version check runs (a remember-me sign-in in early middleware, say). */
  class SignsInEarly {
    readonly #history: ClientHistory;
    constructor(history: ClientHistory) {
      this.#history = history;
    }
    handle(ctx: HttpContext, next: Next<{}>) {
      if (new URL(ctx.request.url).searchParams.has('sign-in')) this.#history.clear();
      return next();
    }
  }
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'pages', routes: openRoutes((Route) => void Route.get('/a', () => view('pages/A', {}))) })],
  }, { env: { APP_KEY: generateKey() } });
  application.container.make(Router).middleware.append('web', SignsInEarly, 220);
  const app = createHttpKernel(application, { version: 'build-2' });
  const stale = (path: string) => app.request(path, { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-version': 'build-1' } });

  it('a new build: 409 with `x-marmeon-reload: version` — the one the client may postpone', async () => {
    const response = await stale('/a');
    expect(response.status).toBe(409);
    expect(response.headers.get(LOCATION_HEADER)).toBe('http://localhost/a');
    expect(response.headers.get(RELOAD_HEADER)).toBe('version');
  });

  it('signed in on the same request — `ClearClientHistory` makes it `history`, whatever the version check said', async () => {
    const response = await stale('/a?sign-in');
    expect(response.status).toBe(409);
    expect(response.headers.get(RELOAD_HEADER)).toBe('history');
  });
});

describe('method spoofing — a form without JavaScript sends PUT, PATCH and DELETE as POST with `_method`', async () => {
  const seen: string[] = [];
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [
      defineModule({
        name: 'pages',
        apiRoutes: openRoutes((Route) => {
          for (const method of ['post', 'put', 'patch', 'delete'] as const) {
            Route[method]('/links/1', async (ctx: HttpContext) => {
              seen.push(`${method} ${JSON.stringify(await ctx.input())}`);
              return new Response(method);
            });
          }
          Route.get('/links/1', () => new Response('get'));
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application);
  const form = (body: string, path = '/api/links/1', type = 'application/x-www-form-urlencoded') => app.request(path, { method: 'POST', headers: { 'content-type': type }, body });

  it('routes a POST with `_method=PUT` in its body as a PUT — the body otherwise as it was', async () => {
    seen.length = 0;
    expect(await (await form('_method=PUT&label=Blog')).text()).toBe('put');
    expect(await (await form('_method=delete')).text()).toBe('delete');
    const multipart = new FormData();
    multipart.set('_method', 'PATCH');
    multipart.set('label', 'Blog');
    expect(await (await app.request('/api/links/1', { method: 'POST', body: multipart })).text()).toBe('patch');
    expect(seen[0]).toBe('put {"_method":"PUT","label":"Blog"}');
  });

  it('never from the query, never to GET, never from JSON — and anything else stays a POST', async () => {
    expect(await (await form('label=Blog', '/api/links/1?_method=DELETE')).text()).toBe('post');
    expect(await (await form('_method=GET')).text()).toBe('post');
    expect(await (await form('_method=TRACE')).text()).toBe('post');
    expect(await (await form(JSON.stringify({ _method: 'DELETE' }), '/api/links/1', 'application/json')).text()).toBe('post');
  });

  it('`_method` next to `_token` (a form written by hand) counts too — in any order at the start', async () => {
    expect(await (await form('_token=abc&_method=PUT&label=Blog')).text()).toBe('put');
    const multipart = new FormData();
    multipart.set('_token', 'abc');
    multipart.set('_method', 'DELETE');
    expect(await (await app.request('/api/links/1', { method: 'POST', body: multipart })).text()).toBe('delete');
  });

  /** A body of `size` bytes that counts what was read of it. */
  function counted(prefix: string, size: number) {
    const encoded = new TextEncoder().encode(prefix);
    const read = { bytes: 0 };
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) return controller.close();
        const chunk = sent === 0 ? encoded : new Uint8Array(Math.min(64 * 1024, size - sent)).fill(120);
        sent += chunk.byteLength;
        read.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return { body, read };
  }

  it('a big body is not read twice: only its start is looked at, then it goes on to the route as it came', async () => {
    const size = 20 * 1024 * 1024;
    const { body, read } = counted('_method=PUT&label=', size);
    const request = new Request('http://localhost/api/links/1', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, duplex: 'half' } as RequestInit);
    const overridden = await overrideMethod(request);
    expect(overridden.method).toBe('PUT');
    // Read so far: the window and a chunk or two the streams fetch ahead — not the 20 MB.
    expect(read.bytes).toBeLessThan(256 * 1024);
    // The route gets every byte, once.
    const reader = overridden.body!.getReader();
    let total = 0;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) total += chunk.value.byteLength;
    expect(total).toBe(size);
    expect(read.bytes).toBe(size);
  });

  it('`_method` after a file, or past the start of the body, does not count', async () => {
    const multipart = new FormData();
    multipart.set('avatar', new File(['png'], 'a.png', { type: 'image/png' }));
    multipart.set('_method', 'DELETE');
    expect(await (await app.request('/api/links/1', { method: 'POST', body: multipart })).text()).toBe('post');
    expect(await (await form(`label=${'x'.repeat(METHOD_FIELD_WINDOW)}&_method=DELETE`)).text()).toBe('post');
  });
});

describe('the view a route renders, for instant visits', () => {
  class ShowController extends Controller {
    handle() {
      return this.view('users/Show' as never, {});
    }
  }
  class EditController extends Controller {
    handle() {
      return this.view('users/Edit' as never, {}).layer({ base: 'users.show' as never, params: {} as never });
    }
  }
  class BothController extends Controller {
    handle(ctx: HttpContext) {
      return ctx.request.url.includes('a') ? this.view('users/A' as never, {}) : this.view('users/B' as never, {});
    }
  }

  it('reads it from the controller when it is written out once — never for a layer, two views or a closure', () => {
    expect(staticView(ShowController)).toBe('users/Show');
    expect(staticView(EditController)).toBeUndefined();
    expect(staticView(BothController)).toBeUndefined();
    expect(staticView(() => view('users/Show' as never, {}))).toBeUndefined();
  });

  it('puts it into the routes the browser may learn', async () => {
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider],
      modules: [defineModule({ name: 'users', routes: openRoutes((Route) => void Route.get('/users/:id', ShowController).name('users.show')) })],
    }, { env: { APP_KEY: generateKey() } });
    expect(browserRoutes(application.container.make(Router).routes).routes).toEqual({ 'users.show': { method: 'get', path: '/users/:id', view: 'users/Show' } });
  });
});
