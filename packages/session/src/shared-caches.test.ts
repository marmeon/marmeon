import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { cacheControl, Controller, HttpServiceProvider, island, view, type PageObject } from '@marmeon/http';
import type { HttpContext, Next } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import type { PageRenderer } from '@marmeon/server/internal';
import { describe, expect, it } from 'vitest';
import { CsrfProtection } from './csrf.ts';
import { SessionServiceProvider } from './provider.ts';
import { Session } from './session.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

class SignIn extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.put('name', 'Alice');
    return { ok: true };
  }
}

class Profile extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    return view('profile/Show', { name: this.#session.get('name') ?? 'guest' });
  }
}

/** What ran, by URL path: a route or middleware that runs twice for one request shows up twice. */
const ran: string[] = [];
class Counts {
  async handle(ctx: HttpContext, next: Next<{}>) {
    ran.push(`middleware ${new URL(ctx.request.url).pathname}`);
    return next();
  }
}

class NameIsland extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle(ctx: HttpContext) {
    ran.push(`route ${new URL(ctx.request.url).pathname}`);
    return island('islands/Name', { name: this.#session.get('name') ?? 'guest' });
  }
}

/** A UI-free renderer: the shell, then each island of the page (`props.islands`) as the server resolves it. */
const renderer: PageRenderer = {
  async render(page: PageObject, _request, options) {
    const islands = (page.props as { islands?: string[] }).islands ?? [];
    const results = await Promise.all(islands.map(async (url) => `<island url="${url}">${JSON.stringify(await options.resolveIsland!(url))}</island>`));
    return `<main>shell</main><script type="application/json">${JSON.stringify(page)}</script>` + results.join('');
  },
  shell: async () => '<main>shell</main>',
};
const islandsOf = (html: string) =>
  Object.fromEntries([...html.matchAll(/<island url="([^"]+)">(.*?)<\/island>/g)].map(([, url, json]) => [url!, JSON.parse(json!) as { status: string; region?: { props: Record<string, unknown> } }]));

// Module routes join the `web` group (the session starts there), API routes the `api` group (it does not).
const routes = openRoutes((Route) => {
  Route.get('/sign-in', SignIn);
  Route.get('/profile', Profile).name('profile.show');
  Route.get('/name-island', NameIsland);
  Route.middleware(cacheControl('public, s-maxage=600')).get('/public-session-page', () => view('pages/Show', { islands: ['/name-island', '/api/cookie-island'] }));
  // A page of the session group that embeds both kinds of island.
  Route.get('/private-page', () => view('pages/Show', { islands: ['/name-island', '/api/cookie-island'] }));
});
const apiRoutes = openRoutes((Route) => {
  // A public layer route whose base belongs to the session.
  Route.middleware(cacheControl('public, s-maxage=600')).get('/public-page', () => view('pages/Show', { islands: ['/name-island', '/api/cookie-island'] }));
  // An island without the session: it reports whether a cookie reached it.
  Route.get('/cookie-island', (ctx: HttpContext) => {
    ran.push(`route ${new URL(ctx.request.url).pathname}`);
    return island('islands/Cookie', { cookie: ctx.request.headers.get('cookie') });
  });
  Route.middleware(cacheControl('public, s-maxage=600')).get('/note', () => view('profile/Note', {}).layer({ base: 'profile.show' }));
});

async function boot(env: Record<string, string> = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, ...(env['SERVER_TRUSTED_PROXIES'] ? [ServerServiceProvider] : [])],
    modules: [defineModule({ name: 'shared', routes, apiRoutes })],
    middleware: { global: [Counts] },
  }, { env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', CACHE_DRIVER: 'memory', ...env }, override: (container) => container.make(CsrfProtection).disable() });
  return createHttpKernel(application, { renderer });
}

describe('answers that carry a session and shared caches', () => {
  it('keeps the deep link of a public layer private when its base is rendered with the visitor’s session', async () => {
    const kernel = await boot();
    const signedIn = await kernel.request('/sign-in', { headers: { accept: 'application/json' } });
    const cookie = signedIn.headers.getSetCookie().map((header) => header.split(';')[0]).join('; ');

    const response = await kernel.request('/api/note', { headers: { cookie } });
    const html = await response.text();
    expect(html).toContain('Alice');
    const control = response.headers.get('cache-control') ?? '';
    expect(control).toContain('private');
    expect(control).not.toContain('s-maxage');
  });

  async function alice() {
    const kernel = await boot();
    const signedIn = await kernel.request('/sign-in', { headers: { accept: 'application/json' } });
    return { kernel, cookie: signedIn.headers.getSetCookie().map((header) => header.split(';')[0]).join('; ') };
  }

  describe('islands of a page that started no session', () => {
    it('leaves an island whose route starts the session to the browser — nothing of the visitor’s reaches the document, and nothing runs twice', async () => {
      const { kernel, cookie } = await alice();
      ran.length = 0;
      const response = await kernel.request('/api/public-page', { headers: { cookie } });
      const html = await response.text();
      expect(html).not.toContain('Alice');
      expect(html).not.toContain('islands/Name');
      expect(islandsOf(html)['/name-island']).toEqual({ status: 'browser' });
      expect(response.headers.get('cache-control')).toBe('public, s-maxage=600');
      // The session island never ran in-process; the page ran once.
      expect(ran).not.toContain('route /name-island');
      expect(ran).not.toContain('middleware /name-island');
      expect(ran.filter((entry) => entry === 'middleware /api/public-page')).toHaveLength(1);
    });

    it('runs an island without the session with no cookie — and still on the server', async () => {
      const { kernel, cookie } = await alice();
      ran.length = 0;
      const html = await (await kernel.request('/api/public-page', { headers: { cookie: `${cookie}; theme=dark` } })).text();
      expect(islandsOf(html)['/api/cookie-island']).toMatchObject({ status: 'ready', region: { props: { cookie: null } } });
      expect(ran.filter((entry) => entry === 'route /api/cookie-island')).toHaveLength(1);
      expect(ran.filter((entry) => entry === 'middleware /api/cookie-island')).toHaveLength(1);
    });

    it('decides on the URL the page was asked for, also behind a trusted proxy that rewrites the host', async () => {
      const kernel = await boot({ SERVER_TRUSTED_PROXIES: '127.0.0.1' });
      ran.length = 0;
      const response = await kernel.request(
        'http://app:3000/api/public-page',
        { headers: { cookie: 'session=x', host: 'app:3000', 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' } },
        { remoteAddress: '127.0.0.1' },
      );
      expect(islandsOf(await response.text())['/name-island']).toEqual({ status: 'browser' });
      expect(ran).not.toContain('route /name-island');
    });

    it('still serves the island to the browser’s own request with the cookie', async () => {
      const { kernel, cookie } = await alice();
      const response = await kernel.request('/name-island', { headers: { cookie, 'x-marmeon': '1', 'x-marmeon-region': 'island' } });
      expect(await response.text()).toContain('Alice');
    });
  });

  describe('islands of a page with a session', () => {
    it('gives a guest’s page no cookies for its islands: its session is not kept, so the public page is not private', async () => {
      const kernel = await boot();
      // A page of the session group that a shared cache may keep, and the guest's cookies that must not reach it.
      const response = await kernel.request('/public-session-page', { headers: { cookie: 'theme=dark; my_app_auth=secret' } });
      const found = islandsOf(await response.text());
      expect(found['/api/cookie-island']).toMatchObject({ status: 'ready', region: { props: { cookie: null } } });
      expect(found['/name-island']).toMatchObject({ status: 'ready', region: { props: { name: 'guest' } } });
    });

    it('render on the server with the visitor’s session and cookies, as before — the page stays private', async () => {
      const { kernel, cookie } = await alice();
      ran.length = 0;
      const response = await kernel.request('/private-page', { headers: { cookie: `${cookie}; theme=dark` } });
      const found = islandsOf(await response.text());
      expect(found['/name-island']).toMatchObject({ status: 'ready', region: { props: { name: 'Alice' } } });
      expect(found['/api/cookie-island']).toMatchObject({ status: 'ready', region: { props: { cookie: expect.stringContaining('theme=dark') } } });
      expect(response.headers.get('cache-control')).toContain('private');
      expect(ran.filter((entry) => entry === 'route /name-island')).toHaveLength(1);
      expect(ran.filter((entry) => entry === 'middleware /name-island')).toHaveLength(1);
    });
  });
});
