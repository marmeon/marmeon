import { ConsoleLogger, createApplication, defineModule, Logger, type Container } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, CloseLayerResult, HttpServiceProvider, isPageObject, MAX_LAYER_DEPTH, view, type HttpContext, type PageObject } from '@marmeon/http';
import { defineRoutes, type Next } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

const LAYER = { 'x-marmeon': 'true', 'x-marmeon-region': 'layer' };

/** The page object a document carries (`#marmeon-page`). */
function documentPage(html: string): PageObject {
  const match = /<script type="application\/json" id="marmeon-page">([\s\S]*?)<\/script>/.exec(html);
  const page: unknown = match ? JSON.parse(match[1]!.replaceAll('\\u003c', '<')) : undefined;
  if (!isPageObject(page)) throw new Error(`No page in:\n${html.slice(0, 400)}`);
  return page;
}

describe('createHttpKernel — layers (E53, E54)', async () => {
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
  /** How often each base's controller ran — a forbidden base's must never. */
  const ran: string[] = [];
  /** The base's own middleware: turns away who it should. */
  class Guarded {
    handle(ctx: HttpContext, next: Next<{}>) {
      if (ctx.request.headers.get('cookie') !== 'role=admin') return new Response(null, { status: 302, headers: { location: '/login' } });
      return next();
    }
  }
  const routes = defineRoutes((Route) => {
    Route.get('/users/:user', (ctx: HttpContext<{}, { user: string }>) => {
      ran.push('profile');
      return view('users/Show', { name: `User ${ctx.params.user}`, secret: 'profile data' });
    }).name('users.show');
    Route.get('/users/:user/edit', (ctx: HttpContext<{}, { user: string }>) =>
      view('users/Edit', { name: `User ${ctx.params.user}` }).layer({ base: 'users.show', params: { user: ctx.params.user } }),
    ).name('users.edit');
    // Depth 2 by a deep link: the confirmation's base is the edit layer, whose base is the profile.
    Route.get('/users/:user/links/:link/remove', (ctx: HttpContext<{}, { user: string; link: string }>) =>
      view('users/RemoveLink', { link: ctx.params.link }).layer({ base: 'users.edit', params: { user: ctx.params.user } }),
    ).name('users.links.remove');
    // A base the user may not see (E54): 403 by its own authorization, a redirect by its middleware.
    Route.get('/admin', () => {
      ran.push('admin');
      return abort(403, 'Admins only.');
    }).name('admin');
    Route.middleware(Guarded).get('/admin/report', () => {
      ran.push('report');
      return view('admin/Report', { numbers: [1, 2, 3] });
    }).name('admin.report');
    Route.get('/admin/note', () => view('admin/Note', { text: 'hello' }).layer({ base: 'admin' })).name('admin.note');
    Route.get('/admin/report/note', () => view('admin/Note', { text: 'hello' }).layer({ base: 'admin.report' })).name('admin.report.note');
    // A layer's own authorization is its own: forbidden whatever its base.
    Route.get('/users/:user/private', () => abort(403, 'Not yours.')).name('users.private');
    // Bases in a circle: the deep link stops at the depth limit.
    Route.get('/loop/a', () => (ran.push('loop'), view('loop/A', {}).layer({ base: 'loop.b' }))).name('loop.a');
    Route.get('/loop/b', () => (ran.push('loop'), view('loop/B', {}).layer({ base: 'loop.a' }))).name('loop.b');
    // The answer of an action is a layer shown once.
    Route.post('/tokens', () => view('tokens/New', { plainText: 'marmeon_1|secret' }).layer({ base: 'users.show', params: { user: '1' }, key: 'tokens.create' })).name('tokens.store');
    Route.put('/users/:user', () => new CloseLayerResult({ reload: ['name'] }).route('users.show', { user: '1' })).name('users.update');
    Route.get('/writes', (ctx: HttpContext) => {
      ctx.cookies.set('written', 'yes');
      return view('users/Show', {});
    }).name('writes');
    Route.get('/writes/note', () => view('admin/Note', {}).layer({ base: 'writes' })).name('writes.note');
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey() },
    providers: [EncryptionServiceProvider, HttpServiceProvider, LoggingProvider],
    modules: [defineModule({ name: 'layers', routes })],
  });
  const app = createHttpKernel(application, { debug: true });

  it('answers a layer’s request with its page object — `layer: { key, base }`, the region header', async () => {
    const response = await app.request('/users/7/edit', { headers: LAYER });
    expect(response.headers.get('x-marmeon-region')).toBe('layer');
    const page = (await response.json()) as PageObject;
    expect(page).toMatchObject({ component: 'users/Edit', url: '/users/7/edit', layer: { key: 'users/Edit', base: '/users/7' } });
    expect(page.layer).not.toHaveProperty('once');
    // A plain visit (no region header) gets the same: the client opens it over what is on screen.
    expect(((await (await app.request('/users/7/edit', { headers: { 'x-marmeon': 'true' } })).json()) as PageObject).layer?.base).toBe('/users/7');
  });

  it('a layer answered by an action (not a GET) is shown once', async () => {
    const page = (await (await app.request('/tokens', { method: 'POST', headers: LAYER })).json()) as PageObject;
    expect(page.layer).toEqual({ key: 'tokens.create', base: '/users/1', once: true });
  });

  it('a deep link renders the declared base and the layer in one document — the base resolved in-process', async () => {
    ran.length = 0;
    const response = await app.request('/users/7/edit');
    expect(response.status).toBe(200);
    const page = documentPage(await response.text());
    expect(page).toMatchObject({ component: 'users/Show', url: '/users/7', props: { name: 'User 7' } });
    expect(page.layers?.map((layer) => [layer.component, layer.url])).toEqual([['users/Edit', '/users/7/edit']]);
    expect(ran).toEqual(['profile']);
  });

  it('a deep link two layers deep: the base’s base too — page, layer, layer', async () => {
    const page = documentPage(await (await app.request('/users/7/links/3/remove')).text());
    expect(page.component).toBe('users/Show');
    expect(page.layers?.map((layer) => layer.component)).toEqual(['users/Edit', 'users/RemoveLink']);
  });

  it('counter-check (E54): a forbidden base — the layer alone over the neutral surface, the base’s data never computed or sent', async () => {
    ran.length = 0;
    const forbidden = documentPage(await (await app.request('/admin/note')).text());
    expect(forbidden).toMatchObject({ component: 'layers/Backdrop', url: '/admin' });
    expect(forbidden.layers?.map((layer) => layer.component)).toEqual(['admin/Note']);
    // Turned away by its middleware (a redirect): the base's controller never ran.
    const redirected = await (await app.request('/admin/report/note')).text();
    const surface = documentPage(redirected);
    expect(surface).toMatchObject({ component: 'layers/Backdrop', url: '/admin/report', props: {} });
    expect(redirected).not.toContain('numbers');
    expect(ran).toEqual(['admin']); // the 403 came from its handler — the guarded report's handler never ran
    // Allowed (the cookie), the same layer gets its base.
    const allowed = documentPage(await (await app.request('/admin/report/note', { headers: { cookie: 'role=admin' } })).text());
    expect(allowed).toMatchObject({ component: 'admin/Report', props: { numbers: [1, 2, 3] } });
  });

  it('a layer’s own authorization holds — whatever its base', async () => {
    expect((await app.request('/users/7/private', { headers: LAYER })).status).toBe(403);
    expect((await app.request('/users/7/private')).status).toBe(403);
  });

  it(`counter-check: bases in a circle stop at the depth limit — logged, the layers shown alone`, async () => {
    logged.length = 0;
    ran.length = 0;
    const page = documentPage(await (await app.request('/loop/a')).text());
    // The layer itself and at most 10 bases asked for — then it stops.
    expect(ran.length).toBeLessThanOrEqual(MAX_LAYER_DEPTH + 1);
    expect(page.component).toBe('layers/Backdrop');
    expect(page.layers?.map((layer) => layer.component)).toEqual(['loop/A']);
    expect(logged.some((message) => message.includes('more than 10 bases'))).toBe(true);
  });

  it('resolves the base read-only: a base that writes (a cookie) is not shown — and the write never reaches the browser', async () => {
    logged.length = 0;
    const response = await app.request('/writes/note');
    const page = documentPage(await response.text());
    expect(page.component).toBe('layers/Backdrop');
    expect(response.headers.getSetCookie().join()).not.toContain('written');
  });

  it('closeLayer(): “close” to a layer’s request — a redirect to anything else (no JavaScript)', async () => {
    const closed = await app.request('/users/1', { method: 'PUT', headers: { ...LAYER, 'content-type': 'application/json' }, body: '{}' });
    expect(closed.headers.get('x-marmeon-layer-close')).toBe('true');
    expect(await closed.json()).toEqual({ close: { layers: 1, reload: ['name'] } });
    const redirected = await app.request('/users/1', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get('location')).toBe('/users/1');
  });
});
