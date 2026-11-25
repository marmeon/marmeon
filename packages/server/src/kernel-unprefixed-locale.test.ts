import { ConsoleLogger, createApplication, defineModule, Logger, type Container, type ErrorReport, type ErrorReporter } from '@marmeon/core';
import { channels, type HttpRequestMessage } from '@marmeon/core/diagnostics';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, island, view, type HttpContext, type RegionResult, type SsrRender } from '@marmeon/http';
import { PageSession } from '@marmeon/http/internal';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import { Router, type Next, type RouteDefinitions } from '@marmeon/router';
import { UrlLocales } from '@marmeon/router/internal';
import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { createDocumentRenderer } from './render.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const ISLAND = { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-region': 'island' };

/** The request log lines (`info`). */
const lines: string[] = [];
/** The context each request log line carries (`route`, `ms`). */
const contexts: Record<string, unknown>[] = [];
class RecordingLogger extends ConsoleLogger {
  override info(message: string, context?: Record<string, unknown>): void {
    lines.push(message);
    contexts.push(context ?? {});
  }
  override child(): Logger {
    return this;
  }
}
const reports: ErrorReport[] = [];
class Collecting implements ErrorReporter {
  report(report: ErrorReport): void {
    reports.push(report);
  }
}
class Reporting {
  static errorReporters = [Collecting];
}
class LoggingProvider {
  register(container: Container) {
    container.singleton(Logger, () => new RecordingLogger());
  }
}

/** What ran: the middleware of the island's route and the controllers. */
const ran = { route: 0, controller: 0 };
class RouteCount {
  handle(_ctx: HttpContext, next: Next<{}>) {
    ran.route++;
    return next();
  }
}
const SESSION_MIDDLEWARE = Symbol.for('marmeon.middleware.session');
/** A middleware class that starts the session, as `StartSession` marks itself. */
class StartsSession {
  static readonly [SESSION_MIDDLEWARE] = true;
  handle(_ctx: HttpContext, next: Next<{}>) {
    return next();
  }
}
class WidgetIsland {
  handle() {
    ran.controller++;
    return island('islands/Widget', { ok: true });
  }
}

/** The stub of what `@marmeon/i18n` binds, with the locale without a prefix set by hand. */
const locales = (unprefixed: string | undefined): UrlLocales => ({ supported: ['de', 'en'], unprefixed, preferred: async () => 'en' });

async function boot(files: readonly RouteDefinitions[], urlLocales: UrlLocales, { debug = false }: { debug?: boolean } = {}) {
  ran.route = ran.controller = 0;
  lines.length = 0;
  contexts.length = 0;
  reports.length = 0;
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, LoggingProvider, Reporting],
    modules: files.map((routes, index) => defineModule({ name: `m${index}`, routes })),
  }, { env: { APP_KEY: generateKey(), APP_URL: 'https://app.example' } });
  application.container.instance(UrlLocales, urlLocales);
  application.container.scoped(PageSession, () => ({ started: () => false, csrfToken: () => undefined, scope: () => undefined, generation: () => undefined, readAt: () => undefined }));
  // A page that embeds islands asks for them in-process, as the renderer does for a document.
  const render: SsrRender = async (page, options = {}) => {
    const urls = (page.props as { islands?: string[] }).islands ?? [];
    const results = await Promise.all(urls.map(async (url) => `<island url="${url}">${JSON.stringify(await options.resolveIsland!(url))}</island>`));
    return { html: `<main>shell</main>${results.join('')}` };
  };
  const renderer = createDocumentRenderer({ template: () => FALLBACK_TEMPLATE, ssr: () => render });
  return { application, kernel: createHttpKernel(application, { renderer, debug }) };
}

const text = async (response: Response) => response.text();
const answer = async (response: Response) => [response.status, response.headers.get('location'), await response.text()] as const;
const regions = async (response: Response) =>
  Object.fromEntries([...(await response.text()).matchAll(/<island url="([^"]+)">(.*?)<\/island>/g)].map(([, url, json]) => [url!, JSON.parse(json!) as RegionResult]));

const pages = openRoutes((Route) => {
  const localized = Route.localized();
  localized.get('/', (ctx) => `home ${ctx.params.locale}`);
  localized.get('/about', (ctx) => `about ${ctx.params.locale}`);
  localized.get('/contact', (ctx) => `form ${ctx.params.locale}`);
  localized.post('/contact', (ctx) => `sent ${ctx.params.locale}`);
  Route.get('/plain', () => 'plain');
});

describe('createHttpKernel — the default locale without a prefix', () => {
  it('answers the page without its prefix in the default locale and keeps the other locale under its own', async () => {
    const { kernel } = await boot([pages], locales('de'));
    expect(await answer(await kernel.request('/about'))).toEqual([200, null, 'about de']);
    expect(await answer(await kernel.request('/en/about'))).toEqual([200, null, 'about en']);
    expect(await answer(await kernel.request('/'))).toEqual([200, null, 'home de']);
    expect(await answer(await kernel.request('/en'))).toEqual([200, null, 'home en']);
    expect(await answer(await kernel.request('/contact', { method: 'POST' }))).toEqual([200, null, 'sent de']);
  });

  it('sends the prefix of the default locale to the address without it, keeping the query, for a GET and a HEAD', async () => {
    const { kernel } = await boot([pages], locales('de'));
    const moved = await kernel.request('/de/about?q=1');
    expect([moved.status, moved.headers.get('location'), moved.headers.get('cache-control'), moved.headers.get('vary')]).toEqual([301, '/about?q=1', 'max-age=3600', null]);
    expect((await kernel.request('/de/about', { method: 'HEAD' })).status).toBe(301);
    expect(await answer(await kernel.request('/de'))).toEqual([301, '/', '']);
    // A write to the prefix is a 404: the form of the page posts to the address without it.
    expect((await kernel.request('/de/contact', { method: 'POST' })).status).toBe(404);
  });

  it('keeps the case a locale is written in: /EN/about and /De/about are no pages', async () => {
    const { kernel } = await boot([pages], locales('de'));
    expect((await kernel.request('/EN/about')).status).toBe(404);
    expect((await kernel.request('/De/about')).status).toBe(404);
  });

  it.each(['//evil.example', '/de//evil.example', '//evil.example/about', '/de//evil.example/about'])('answers %s with a 404 and no location', async (path) => {
    const { kernel } = await boot([pages], locales('de'));
    const response = await kernel.request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('createHttpKernel — a localized fallback at the root without a prefix', () => {
  const root = openRoutes((Route) => {
    Route.localized().fallback((ctx) => `fallback ${ctx.params.locale} ${ctx.params.path}`);
    Route.localized().get('/about', (ctx) => `about ${ctx.params.locale}`);
  });

  it('answers /x in the default locale, sends /de/x to it and keeps /en/x English', async () => {
    const { kernel } = await boot([root], locales('de'));
    expect(await answer(await kernel.request('/x'))).toEqual([200, null, 'fallback de x']);
    expect(await answer(await kernel.request('/de/x'))).toEqual([301, '/x', '']);
    expect(await answer(await kernel.request('/en/x'))).toEqual([200, null, 'fallback en x']);
    expect(await answer(await kernel.request('/about'))).toEqual([200, null, 'about de']);
  });

  it('sends /de/x/ to /de/x and on to /x: two 301s', async () => {
    const { kernel } = await boot([root], locales('de'));
    const first = await kernel.request('/de/x/');
    expect([first.status, first.headers.get('location')]).toEqual([301, '/de/x']);
    const second = await kernel.request('/de/x');
    expect([second.status, second.headers.get('location')]).toEqual([301, '/x']);
  });

  it.each([
    ['/EN/x', 404, ''],
    ['/%45N/x', 404, ''],
    ['/%65n/x', 200, 'fallback en x'],
  ])('hands %s, a path that starts with a locale, on: the address without a prefix does not take it as its own', async (path, status, body) => {
    const { kernel } = await boot([root], locales('de'));
    const response = await kernel.request(path);
    // The localized fallback is case-sensitive and the address never reads the locale as a path of the default one (`fallback de EN/x`).
    expect([response.status, status === 200 ? await response.text() : '']).toEqual([status, body]);
  });
});

describe('createHttpKernel — a parameter in the first segment of a localized route', () => {
  const slugs = openRoutes((Route) => {
    Route.localized().get('/:slug', (ctx) => `page ${ctx.params.locale} ${ctx.params.slug}`);
    Route.localized().fallback((ctx) => `fallback ${ctx.params.locale} ${ctx.params.path}`);
  });

  it('serves /ada as the default locale\'s page and hands /en, /EN and /%65n on instead of reading them as a slug', async () => {
    const { kernel } = await boot([slugs], locales('de'));
    expect(await answer(await kernel.request('/ada'))).toEqual([200, null, 'page de ada']);
    // `/en` is the locale's own address: the page route does not answer it with the slug "en", the localized fallback of the English does.
    expect(await answer(await kernel.request('/en'))).toEqual([200, null, 'fallback en ']);
    expect((await kernel.request('/EN')).status).toBe(404);
    expect(await answer(await kernel.request('/%65n'))).toEqual([200, null, 'fallback en ']);
  });

  it('keeps a slug that looks like a locale under the prefix: /de/EN is the page, /EN is not', async () => {
    const { kernel } = await boot([slugs], locales('de'));
    expect(await answer(await kernel.request('/de/EN'))).toEqual([200, null, 'page de EN']);
    expect((await kernel.request('/EN')).status).toBe(404);
  });

  it('answers /en with a 404, not the slug, when there is no fallback behind it', async () => {
    const bare = openRoutes((Route) => void Route.localized().get('/:slug', (ctx) => `page ${ctx.params.locale} ${ctx.params.slug}`));
    const { kernel } = await boot([bare], locales('de'));
    expect((await kernel.request('/en')).status).toBe(404);
    expect(await text(await kernel.request('/ada'))).toBe('page de ada');
  });
});

describe('createHttpKernel — the order of registration with the default locale without a prefix', () => {
  it('lets a localized /login win over a later /:username and lose to an earlier one, as the files are ordered', async () => {
    const first = openRoutes((Route) => {
      Route.localized().get('/login', (ctx) => `login ${ctx.params.locale}`);
      Route.get('/:username', (ctx) => `user ${ctx.params.username}`);
    });
    const second = openRoutes((Route) => {
      Route.get('/:username', (ctx) => `user ${ctx.params.username}`);
      Route.localized().get('/login', (ctx) => `login ${ctx.params.locale}`);
    });
    expect(await text(await (await boot([first], locales('de'))).kernel.request('/login'))).toBe('login de');
    expect(await text(await (await boot([second], locales('de'))).kernel.request('/login'))).toBe('user login');
    expect(await text(await (await boot([second], locales('de'))).kernel.request('/en/login'))).toBe('login en');
  });

  it('places each address behind its route in the order the server registers', async () => {
    const { application } = await boot([pages], locales('de'));
    expect(application.container.make(Router).registrationOrder.filter((route) => !route.reserved).map((route) => route.path)).toEqual(['/:locale', '/', '/:locale/about', '/about', '/:locale/contact', '/contact', '/:locale/contact', '/contact', '/plain']);
  });

  it('keeps the registration order and the 302s of an app without the mode: the redirects last, to the visitor\'s language', async () => {
    const { application, kernel } = await boot([pages], locales(undefined));
    expect(application.container.make(Router).registrationOrder.filter((route) => !route.reserved).map((route) => route.path)).toEqual(['/:locale', '/:locale/about', '/:locale/contact', '/:locale/contact', '/plain', '/', '/about', '/contact']);
    const response = await kernel.request('/about?x=1', { headers: { 'accept-language': 'en' } });
    expect([response.status, response.headers.get('location'), response.headers.get('cache-control')]).toEqual([302, '/en/about?x=1', 'private, no-store']);
    expect(await text(await kernel.request('/de/about'))).toBe('about de');
    expect((await kernel.request('/contact', { method: 'POST' })).status).toBe(404);
  });
});

describe('createHttpKernel — the address without a prefix of a localized route is that route', () => {
  /** The route's middleware must not run for a visit to an island, and the island answers its own address. */
  const widgets = openRoutes((Route) => {
    Route.middleware(RouteCount).localized().get('/widget', WidgetIsland);
    Route.localized().get('/reset/:token', (ctx) => `reset ${ctx.params.token}`);
    Route.get('/embeds', () => view('pages/Embeds', { islands: ['/widget', '/en/widget', '/about'] }));
    Route.localized().get('/about', () => view('pages/About', {}));
  });

  it('refuses an island\'s address opened by itself before the route\'s middleware, as it does the route', async () => {
    const { kernel } = await boot([widgets], locales('de'));
    for (const path of ['/widget', '/en/widget']) {
      ran.route = ran.controller = 0;
      const response = await kernel.request(path, { headers: { accept: 'text/html' } });
      expect([path, response.status]).toEqual([path, 404]);
      expect(ran).toEqual({ route: 0, controller: 0 });
    }
  });

  it('answers an island request to the address with the island: no 403 or 404 tells it from the route', async () => {
    const { kernel } = await boot([widgets], locales('de'));
    for (const path of ['/widget', '/en/widget']) {
      ran.route = ran.controller = 0;
      const response = await kernel.request(path, { headers: ISLAND });
      expect([path, response.status, response.headers.get('x-marmeon-region')]).toEqual([path, 200, 'island']);
      expect(ran).toEqual({ route: 1, controller: 1 });
    }
  });

  it('refuses a page as an island at its address, and resolves the island in-process (<Island href>) to the island at its address', async () => {
    const { kernel } = await boot([widgets], locales('de'));
    const results = await regions(await kernel.request('/embeds'));
    expect(results['/widget']).toMatchObject({ status: 'ready', region: { component: 'islands/Widget' } });
    expect(results['/en/widget']).toMatchObject({ status: 'ready', region: { component: 'islands/Widget' } });
    expect(results['/about']).toMatchObject({ status: 'exception', failure: { status: 404 } });
    expect(ran).toEqual({ route: 2, controller: 2 });
  });

  it('masks the secret of /reset/:token in the log line, aligned to the address\'s pattern', async () => {
    const { kernel } = await boot([widgets], locales('de'));
    expect((await kernel.request('/reset/geheim')).status).toBe(200);
    expect(lines.some((line) => line.includes('geheim'))).toBe(false);
    expect(lines).toContain('GET /reset/[redacted] 200');
    expect((await kernel.request('/en/reset/geheim')).status).toBe(200);
    expect(lines).toContain('GET /en/reset/[redacted] 200');
    expect(lines.some((line) => line.includes('geheim'))).toBe(false);
  });
});

describe('createHttpKernel — a mode that is switched on after the kernel was made', () => {
  const late = openRoutes((Route) => {
    Route.localized().fallback((ctx) => `fallback ${ctx.params.locale} ${ctx.params.path}`);
    Route.localized().get('/about', (ctx) => `about ${ctx.params.locale}`);
    Route.middleware(RouteCount).localized().get('/widget', WidgetIsland);
  });

  it('answers /about without a loop, refuses the island opened by itself and lets /en/x reach the localized fallback', async () => {
    const urlLocales = locales(undefined);
    const { kernel } = await boot([late], urlLocales);
    // `UrlLocales` is the owner's object, read at every request: the app turns the mode on after the kernel registered its routes.
    (urlLocales as { unprefixed: string | undefined }).unprefixed = 'de';
    expect(await answer(await kernel.request('/about'))).toEqual([200, null, 'about de']);
    ran.route = ran.controller = 0;
    const visited = await kernel.request('/widget', { headers: { accept: 'text/html' } });
    expect(visited.status).toBe(404);
    expect(ran).toEqual({ route: 0, controller: 0 });
    expect((await kernel.request('/widget', { headers: ISLAND })).status).toBe(200);
    expect(await answer(await kernel.request('/en/x'))).toEqual([200, null, 'fallback en x']);
    expect(await answer(await kernel.request('/de/about'))).toEqual([301, '/about', '']);
  });
});

describe('createHttpKernel — the sitemap and robots.txt with the default locale without a prefix', () => {
  const taking = openRoutes((Route) => {
    Route.localized().get('/:slug', (ctx) => `page ${ctx.params.locale} ${ctx.params.slug}`);
    Route.get('/plain', () => 'plain').sitemap();
  });

  it('answers /sitemap.xml and /robots.txt although a localized /:slug stands before them, as claimedBy() says they are taken', async () => {
    const { application, kernel } = await boot([taking], locales('de'));
    const sitemap = await kernel.request('/sitemap.xml');
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get('content-type')).toContain('application/xml');
    expect(await sitemap.text()).toContain('<loc>https://app.example/plain</loc>');
    const robots = await kernel.request('/robots.txt');
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain('Sitemap: https://app.example/sitemap.xml');
    expect(application.container.make(Router).claimedBy('/sitemap.xml')).toEqual({ by: 'framework', reason: 'sitemap' });
    // A slug is still a page.
    expect(await text(await kernel.request('/ada'))).toBe('page de ada');
  });

  it('leaves them to the slug when no route asks for a sitemap, as claimedBy() says they are free', async () => {
    const free = openRoutes((Route) => void Route.localized().get('/:slug', (ctx) => `page ${ctx.params.locale} ${ctx.params.slug}`));
    const { application, kernel } = await boot([free], locales('de'));
    expect(await text(await kernel.request('/sitemap.xml'))).toBe('page de sitemap.xml');
    expect(application.container.make(Router).claimedBy('/sitemap.xml')).toMatchObject({ by: 'route' });
  });

  it('names the pages without a prefix when the mode is turned on after the kernel was made', async () => {
    const urlLocales = locales(undefined);
    const pagesWithSitemap = openRoutes((Route) => void Route.localized().get('/about', (ctx) => `about ${ctx.params.locale}`).sitemap());
    const { kernel } = await boot([pagesWithSitemap], urlLocales);
    (urlLocales as { unprefixed: string | undefined }).unprefixed = 'de';
    const xml = await text(await kernel.request('/sitemap.xml'));
    expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1])).toEqual(['https://app.example/about', 'https://app.example/en/about']);
  });
});

describe('createHttpKernel — what is told of a page met at its address without a prefix', () => {
  class BoomController {
    handle(): never {
      throw new Error('boom');
    }
  }
  class StatController {
    handle() {
      return 'stat';
    }
  }
  const named = openRoutes((Route) => {
    const localized = Route.localized();
    localized.get('/reset/:token', () => 'reset').name('reset');
    localized.get('/boom/:token', BoomController).name('boom');
    localized.get('/stat', StatController).name('stat');
    localized.get('/cookie', () => new Response('x', { headers: { 'cache-control': 'public, max-age=60', 'set-cookie': 'a=b' } })).name('cookie');
  });
  const nameOf = (application: Awaited<ReturnType<typeof boot>>['application'], path: string) => application.container.make(Router).routes.find((route) => route.path === path)!.routeName;

  it('names the page in the request log line, not the address', async () => {
    const { application, kernel } = await boot([named], locales('de'));
    await kernel.request('/stat');
    expect(contexts.at(-1)).toMatchObject({ route: nameOf(application, '/:locale/stat') });
    expect(nameOf(application, '/:locale/stat')).toBeTruthy();
  });

  it('names the page and its controller in the trace of the request, with the pattern of the address', async () => {
    const { application, kernel } = await boot([named], locales('de'));
    const ended: HttpRequestMessage[] = [];
    const off = channels.subscribe(application, 'http.request', { end: (message) => void ended.push(message) });
    try {
      await kernel.request('/stat');
    } finally {
      off();
    }
    expect(ended[0]).toMatchObject({ route: nameOf(application, '/:locale/stat'), routePath: '/stat', controller: 'StatController', status: 200 });
  });

  it('names the page in the report of a failing controller, and masks the path by the address\'s pattern', async () => {
    const { application, kernel } = await boot([named], locales('de'));
    expect((await kernel.request('/boom/geheim')).status).toBe(500);
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]!.context).toMatchObject({ route: nameOf(application, '/:locale/boom/:token'), path: '/boom/[redacted]' });
    expect(JSON.stringify(reports)).not.toContain('geheim');
  });

  it('shows the page on the development error page: its name, its controller, the pattern the request matched', async () => {
    const { application, kernel } = await boot([named], locales('de'), { debug: true });
    const html = await (await kernel.request('/boom/483920', { headers: { accept: 'text/html' } })).text();
    expect(html).toContain(`<code>${nameOf(application, '/:locale/boom/:token')}</code>`);
    expect(html).toContain('BoomController');
    expect(html).toContain('/boom/:token');
    expect(html.includes('/:locale/boom/:token')).toBe(false);
    expect(html.includes('483920')).toBe(false);
  });
});

describe('createHttpKernel — a Referer that points at a page behind a catch-all address', () => {
  const routes = openRoutes((Route) => {
    const localized = Route.localized();
    localized.get('/:a/:b/:c', () => 'three');
    localized.get('/invite/:code', () => 'invite').name('invite');
    localized.get('/explode', () => {
      throw new Error('boom');
    });
    Route.get('/plain', () => 'plain');
  });

  it('masks its parameter by the route that answers it, not by the address that hands the path on', async () => {
    const { application, kernel } = await boot([routes], locales('de'), { debug: true });
    const ended: HttpRequestMessage[] = [];
    const off = channels.subscribe(application, 'http.request', { end: (message) => void ended.push(message) });
    try {
      await kernel.request('/plain', { headers: { referer: 'http://localhost/en/invite/483920' } });
      // The path the address `/:a/:b/:c` would match, `/en/invite/483920`, is the locale's own: the page is `/:locale/invite/:code`.
      expect(ended[0]!.refererRoutePath).toBe('/:locale/invite/:code');
      const html = await (await kernel.request('/explode', { headers: { accept: 'text/html', referer: 'http://localhost/en/invite/483920' } })).text();
      expect(html).toContain('http://localhost/en/invite/[redacted]');
      expect(html.includes('483920')).toBe(false);
    } finally {
      off();
    }
  });
});

describe('createHttpKernel — an island at the address without a prefix, in-process', () => {
  const sessioned = openRoutes((Route) => {
    Route.middleware(StartsSession).localized().get('/widget', WidgetIsland);
    Route.get('/embeds', () => view('pages/Embeds', { islands: ['/widget', '/en/widget'] }));
  });

  it('leaves an island whose route starts the session to the browser: the decision is the island\'s route, not the address\'s', async () => {
    const { kernel } = await boot([sessioned], locales('de'));
    const results = await regions(await kernel.request('/embeds'));
    expect(results['/widget']).toEqual({ status: 'browser' });
    expect(results['/en/widget']).toEqual({ status: 'browser' });
    expect(ran).toEqual({ route: 0, controller: 0 });
  });
});

describe('createHttpKernel — a Referer on a path the sitemap answers', () => {
  const taking = openRoutes((Route) => {
    Route.localized().get('/:slug', () => 'slug');
    Route.get('/plain', () => 'plain').sitemap();
  });

  it('does not point to the /:slug address for /sitemap%2Exml, which Hono matches as /sitemap.xml', async () => {
    const { application, kernel } = await boot([taking], locales('de'));
    const ended: HttpRequestMessage[] = [];
    const off = channels.subscribe(application, 'http.request', { end: (message) => void ended.push(message) });
    try {
      await kernel.request('/plain', { headers: { referer: 'http://localhost/sitemap%2Exml' } });
      await kernel.request('/plain', { headers: { referer: 'http://localhost/ada' } });
    } finally {
      off();
    }
    expect(ended[0]!.refererRoutePath).toBeUndefined();
    expect(ended[1]!.refererRoutePath).toBe('/:slug');
  });
});

describe('createHttpKernel — the mode turned off after the start', () => {
  it('answers the address without a prefix with a 404: turning the mode off needs a restart', async () => {
    const urlLocales = locales('de');
    const { kernel } = await boot([pages], urlLocales);
    expect(await text(await kernel.request('/about'))).toBe('about de');
    (urlLocales as { unprefixed: string | undefined }).unprefixed = undefined;
    expect((await kernel.request('/about')).status).toBe(404);
  });
});
