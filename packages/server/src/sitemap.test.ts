import { fileURLToPath } from 'node:url';
import { Clock, createApplication, defineModule, Logger, type ErrorReport, type ErrorReporter } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineMiddleware, HttpServiceProvider, type SitemapEntries } from '@marmeon/http';
import { GLOBAL, type RouteDefinitions } from '@marmeon/router';
import { Router } from '@marmeon/router';
import { UrlLocales } from '@marmeon/router/internal';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { SITEMAP_CACHE_MS, SITEMAP_FAILURE_MS, SITEMAP_LIMIT_URLS } from './sitemap.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

/** Records the warnings — the sitemap says what it left out. */
class Recording implements Logger {
  readonly warnings: string[] = [];
  debug() {}
  info() {}
  warn(message: string) {
    this.warnings.push(message);
  }
  error() {}
  child(): Logger {
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

/** What the hooks of the controllers below return — set per test. */
const state = { slugs: [] as { params: { slug: string }; lastModified?: Date }[], calls: 0, fail: false, pause: 0 };

class PostController {
  handle() {
    return 'post';
  }
  sitemap(): SitemapEntries<{ slug: string }> {
    state.calls++;
    if (state.fail) throw new Error('the database is down');
    return (async () => {
      if (state.pause > 0) await new Promise((resolve) => setTimeout(resolve, state.pause));
      return state.slugs;
    })();
  }
}

class StreamController {
  handle() {
    return 'stream';
  }
  async *sitemap(): SitemapEntries<{ slug: string }> {
    yield { params: { slug: 'first' }, lastModified: new Date('2026-01-02T03:04:05Z') };
    yield { params: { slug: 'second' } };
  }
}

class AboutController {
  handle() {
    return 'about';
  }
  sitemap(): SitemapEntries<{}> {
    return [{ params: {}, lastModified: new Date('2026-02-03T23:59:59Z') }, { params: {}, lastModified: new Date('2026-05-06T00:00:01Z') }];
  }
}

const url = 'https://marmeon.example';

async function boot({ routes, env = { APP_URL: url }, urlLocales }: { routes: RouteDefinitions; env?: Record<string, string>; urlLocales?: UrlLocales }) {
  const logger = new Recording();
  const clock = new TestClock();
  clock.freeze();
  const application = await createApplication({
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, Reporting],
    modules: [defineModule({ name: 'pages', routes })],
  }, {
    env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', ...env },
    override: (container) => {
      container.instance(Logger, logger);
      container.instance(Clock, clock);
    },
  });
  if (urlLocales) application.container.instance(UrlLocales, urlLocales);
  return { application, logger, clock, create: () => createHttpKernel(application) };
}

const marked = openRoutes((Route) => {
  Route.get('/about', AboutController).name('about').sitemap();
  Route.get('/posts/:slug', PostController).name('posts.show').sitemap();
  Route.get('/hidden', () => 'hidden').name('hidden');
});

const locs = (xml: string): string[] => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!);

describe('/sitemap.xml', () => {
  it('lists a route without parameters once, with the latest date its hook gives, and a route with its entries', async () => {
    state.slugs = [{ params: { slug: 'hello' }, lastModified: new Date('2026-03-04T10:00:00Z') }, { params: { slug: 'plain' } }];
    const { application, create } = await boot({ routes: marked });
    try {
      const response = await create().request('/sitemap.xml');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
      expect(response.headers.has('set-cookie')).toBe(false);
      const xml = await response.text();
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
      expect(locs(xml)).toEqual([`${url}/about`, `${url}/posts/hello`, `${url}/posts/plain`]);
      expect(xml).toContain(`<loc>${url}/about</loc><lastmod>2026-05-06</lastmod>`);
      expect(xml).toContain(`<loc>${url}/posts/hello</loc><lastmod>2026-03-04</lastmod>`);
      expect(xml).toContain(`<loc>${url}/posts/plain</loc></url>`);
      expect(xml).not.toContain('/hidden');
      expect((await create().request('/sitemap.xml', { method: 'HEAD' })).status).toBe(200);
    } finally {
      await application.shutdown();
    }
  });

  it('takes the entries of an async generator', async () => {
    const { application, create } = await boot({ routes: openRoutes((Route) => void Route.get('/streams/:slug', StreamController).sitemap()) });
    try {
      const xml = await (await create().request('/sitemap.xml')).text();
      expect(xml).toContain(`<loc>${url}/streams/first</loc><lastmod>2026-01-02</lastmod>`);
      expect(xml).toContain(`<loc>${url}/streams/second</loc></url>`);
    } finally {
      await application.shutdown();
    }
  });

  it('writes a parameter encoded and the address escaped for XML', async () => {
    state.slugs = [{ params: { slug: "a&b<c>\"d'e" } }];
    const { application, create } = await boot({ routes: marked });
    try {
      const xml = await (await create().request('/sitemap.xml')).text();
      // encodeURIComponent leaves the apostrophe: the XML escape is what keeps it in its element.
      expect(xml).toContain(`<loc>${url}/posts/a%26b%3Cc%3E%22d&apos;e</loc>`);
      expect(locs(xml).every((loc) => !/[<>"']/.test(loc))).toBe(true);
    } finally {
      await application.shutdown();
    }
  });

  it('leaves out an entry that names no page of the route, with one warning for the route', async () => {
    state.slugs = [{ params: { slug: '../admin' } }, { params: { slug: '..' } }, { params: { slug: 'a/b' } }, { params: { slug: '' } }, { params: { slug: 'ok' } }];
    const { application, create, logger } = await boot({ routes: marked });
    try {
      const xml = await (await create().request('/sitemap.xml')).text();
      expect(locs(xml)).toEqual([`${url}/about`, `${url}/posts/ok`]);
      expect(xml).not.toContain('admin');
      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0]).toContain('/posts/:slug');
    } finally {
      await application.shutdown();
    }
  });

  it('leaves out an entry the constraint of the route refuses', async () => {
    state.slugs = [{ params: { slug: 'Upper' } }, { params: { slug: 'lower-case' } }];
    const routes = openRoutes((Route) => void Route.get('/posts/:slug{[a-z-]+}', PostController).sitemap());
    const { application, create } = await boot({ routes });
    try {
      expect(locs(await (await create().request('/sitemap.xml')).text())).toEqual([`${url}/posts/lower-case`]);
    } finally {
      await application.shutdown();
    }
  });

  it('writes APP_URL into every address, whatever Host or X-Forwarded-Host says', async () => {
    state.slugs = [{ params: { slug: 'x' } }];
    const { application, create } = await boot({ routes: marked, env: { APP_URL: url, SERVER_TRUSTED_PROXIES: '*' } });
    try {
      const response = await create().request('/sitemap.xml', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } });
      const xml = await response.text();
      expect(response.status).toBe(200);
      expect(xml).not.toContain('evil.example');
      expect(locs(xml).every((loc) => loc.startsWith(`${url}/`))).toBe(true);
      const robots = await (await create().request('/robots.txt', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' } })).text();
      expect(robots).not.toContain('evil.example');
    } finally {
      await application.shutdown();
    }
  });

  it('lists nothing else than the marked routes: 404 for both paths without a mark', async () => {
    const { application, create } = await boot({ routes: openRoutes((Route) => void Route.get('/hello', () => 'hi')), env: {} });
    try {
      expect((await create().request('/sitemap.xml')).status).toBe(404);
      expect((await create().request('/robots.txt')).status).toBe(404);
    } finally {
      await application.shutdown();
    }
  });

  it('gives way to a route of the app on the same path', async () => {
    const routes = openRoutes((Route) => {
      Route.get('/about', () => 'about').sitemap();
      Route.get('/sitemap.xml', () => new Response('mine', { headers: { 'content-type': 'text/plain' } }));
      Route.get('/robots.txt', () => new Response('User-agent: *\nDisallow: /search\n', { headers: { 'content-type': 'text/plain' } }));
    });
    const { application, create } = await boot({ routes });
    try {
      expect(await (await create().request('/sitemap.xml')).text()).toBe('mine');
      expect(await (await create().request('/robots.txt')).text()).toBe('User-agent: *\nDisallow: /search\n');
    } finally {
      await application.shutdown();
    }
  });

  it('is not taken by the route without its locale of a localized `/:page`', async () => {
    const urlLocales: UrlLocales = { supported: ['en', 'de'], preferred: async () => 'de' };
    const withMark = openRoutes((Route) => {
      Route.get('/about', () => 'about').sitemap();
      Route.localized().get('/:page', () => 'page');
    });
    const { application, create } = await boot({ routes: withMark, urlLocales });
    try {
      const kernel = create();
      // `GET /:page` (the localized route without its locale) would redirect every one-segment path: not these two.
      expect(locs(await (await kernel.request('/sitemap.xml')).text())).toEqual([`${url}/about`]);
      expect((await kernel.request('/robots.txt')).status).toBe(200);
      expect((await kernel.request('/anything')).status).toBe(302);
      expect((await kernel.request('/de/anything')).status).toBe(200);
    } finally {
      await application.shutdown();
    }
  });

  it('cuts the file at 50 000 URLs and warns once', async () => {
    state.slugs = Array.from({ length: SITEMAP_LIMIT_URLS + 1 }, (_, index) => ({ params: { slug: `p${index}` } }));
    const { application, create, logger, clock } = await boot({ routes: openRoutes((Route) => void Route.get('/posts/:slug', PostController).sitemap()) });
    try {
      const xml = await (await create().request('/sitemap.xml')).text();
      expect(locs(xml)).toHaveLength(SITEMAP_LIMIT_URLS);
      expect(locs(xml).at(-1)).toBe(`${url}/posts/p${SITEMAP_LIMIT_URLS - 1}`);
      expect(logger.warnings.filter((line) => line.includes('50000'))).toHaveLength(1);
      clock.travel({ milliseconds: SITEMAP_CACHE_MS });
      await create().request('/sitemap.xml');
      expect(logger.warnings.filter((line) => line.includes('50000'))).toHaveLength(2);
    } finally {
      await application.shutdown();
    }
  });

  it('runs a hook once for requests that come together, and again only after five minutes', async () => {
    state.slugs = [{ params: { slug: 'one' } }];
    state.calls = 0;
    state.pause = 20;
    const { application, create, clock } = await boot({ routes: openRoutes((Route) => void Route.get('/posts/:slug', PostController).sitemap()) });
    try {
      const kernel = create();
      const [first, second] = await Promise.all([kernel.request('/sitemap.xml'), kernel.request('/sitemap.xml')]);
      expect(await first.text()).toBe(await second.text());
      expect(state.calls).toBe(1);
      state.slugs = [{ params: { slug: 'two' } }];
      clock.travel({ milliseconds: SITEMAP_CACHE_MS - 1 });
      expect(locs(await (await kernel.request('/sitemap.xml')).text())).toEqual([`${url}/posts/one`]);
      expect(state.calls).toBe(1);
      clock.travel({ milliseconds: 1 });
      expect(locs(await (await kernel.request('/sitemap.xml')).text())).toEqual([`${url}/posts/two`]);
      expect(state.calls).toBe(2);
    } finally {
      state.pause = 0;
      await application.shutdown();
    }
  });

  it('reports a failing hook once, answers 503 with Retry-After and leaves the hook alone for a while', async () => {
    state.slugs = [{ params: { slug: 'one' } }];
    state.calls = 0;
    state.fail = true;
    state.pause = 20;
    const { application, create, clock } = await boot({ routes: openRoutes((Route) => void Route.get('/posts/:slug', PostController).sitemap()) });
    reports.length = 0;
    try {
      const kernel = create();
      const [first, second] = await Promise.all([kernel.request('/sitemap.xml'), kernel.request('/sitemap.xml')]);
      for (const failed of [first, second]) {
        expect(failed.status).toBe(503);
        expect(failed.headers.get('retry-after')).toBe('30');
        expect(failed.headers.get('cache-control')).toBe('no-store');
        expect(failed.headers.has('set-cookie')).toBe(false);
        expect(await failed.text()).not.toContain('the database is down');
      }
      expect(reports).toHaveLength(1);
      expect(reports[0]!.error.message).toBe('the database is down');
      expect(state.calls).toBe(1);
      state.fail = false;
      clock.travel({ milliseconds: SITEMAP_FAILURE_MS - 1 });
      expect((await kernel.request('/sitemap.xml')).status).toBe(503);
      expect(state.calls).toBe(1);
      clock.travel({ milliseconds: 1 });
      const recovered = await kernel.request('/sitemap.xml');
      expect(recovered.status).toBe(200);
      expect(locs(await recovered.text())).toEqual([`${url}/posts/one`]);
    } finally {
      state.fail = false;
      state.pause = 0;
      await application.shutdown();
    }
  });

  it('keeps serving the last good file while the hook fails', async () => {
    state.slugs = [{ params: { slug: 'one' } }];
    state.calls = 0;
    state.fail = false;
    const { application, create, clock } = await boot({ routes: openRoutes((Route) => void Route.get('/posts/:slug', PostController).sitemap()) });
    reports.length = 0;
    try {
      const kernel = create();
      expect((await kernel.request('/sitemap.xml')).status).toBe(200);
      state.fail = true;
      clock.travel({ milliseconds: SITEMAP_CACHE_MS });
      const stale = await kernel.request('/sitemap.xml');
      expect(stale.status).toBe(200);
      expect(locs(await stale.text())).toEqual([`${url}/posts/one`]);
      expect(reports).toHaveLength(1);
      expect(state.calls).toBe(2);
      expect((await kernel.request('/sitemap.xml')).status).toBe(200);
      expect(state.calls).toBe(2);
    } finally {
      state.fail = false;
      await application.shutdown();
    }
  });

  it('sends no cookie a global middleware queued', async () => {
    state.slugs = [];
    const baker = defineMiddleware('baker', async (ctx, next) => {
      ctx.cookies.set('tracking', 'abc');
      return next();
    });
    const { application, create } = await boot({ routes: marked });
    try {
      application.container.make(Router).middleware.append(GLOBAL, baker);
      const kernel = create();
      for (const path of ['/sitemap.xml', '/robots.txt']) {
        const response = await kernel.request(path);
        expect(response.status).toBe(200);
        expect(response.headers.has('set-cookie')).toBe(false);
      }
    } finally {
      await application.shutdown();
    }
  });
});

describe('/robots.txt', () => {
  it('names the sitemap and shuts out the framework\'s paths — three lines, nothing more', async () => {
    const { application, create } = await boot({ routes: marked });
    try {
      const response = await create().request('/robots.txt');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(await response.text()).toBe(`User-agent: *\nDisallow: /_marmeon/\n\nSitemap: ${url}/sitemap.xml\n`);
    } finally {
      await application.shutdown();
    }
  });
});

describe('the start with a marked route', () => {
  it('stops without APP_URL, naming the route', async () => {
    const { application, create } = await boot({ routes: marked, env: {} });
    try {
      expect(() => create()).toThrow(/needs APP_URL.*not set|APP_URL.*is not set/);
      expect(() => create()).toThrow('GET /about');
    } finally {
      await application.shutdown();
    }
  });

  it('stops on an APP_URL that is no http address', async () => {
    const { application, create } = await boot({ routes: marked, env: { APP_URL: 'javascript:alert(1)' } });
    try {
      expect(() => create()).toThrow('no http or https URL');
    } finally {
      await application.shutdown();
    }
  });

  it('stops when a middleware of a group adds the user to a marked route', async () => {
    const authenticate = defineMiddleware<{ user: { id: number } }>('authenticate', (_ctx, next) => next({ user: { id: 1 } }), { adds: ['user'] });
    const { application, create } = await boot({ routes: marked });
    try {
      application.container.make(Router).middleware.append(GLOBAL, authenticate);
      expect(() => create()).toThrow('a sitemap lists pages anyone can open');
    } finally {
      await application.shutdown();
    }
  });

  it('stops on a marked route with parameters and no sitemap() on its controller', async () => {
    class Plain {
      handle() {
        return 'x';
      }
    }
    await expect(boot({ routes: openRoutes((Route) => void Route.get('/posts/:slug', Plain).sitemap()) })).rejects.toThrow('needs a sitemap() method');
  });

  it('stops on a marked POST route', async () => {
    await expect(boot({ routes: openRoutes((Route) => void Route.post('/contact', () => 'x').sitemap()) })).rejects.toThrow(TypeError);
  });
});
