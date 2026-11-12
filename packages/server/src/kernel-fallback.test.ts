import { createApplication, defineModule, type Application } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { defineMiddleware, defineRoutes, everyone, Router, type RouteDefinitions } from '@marmeon/router';
import { UrlLocales } from '@marmeon/router/internal';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const calls: string[] = [];
const seen = { global: 0, web: 0 };
const Global = defineMiddleware('global-count', (_ctx, next) => {
  seen.global++;
  return next();
});
const Web = defineMiddleware('web-count', (_ctx, next) => {
  seen.web++;
  return next({ webSeen: 'yes' });
}, { adds: ['webSeen'] });

/** The fallbacks under test sit in the FIRST module; the routes that must beat them come later and from a package's boot(). */
const fallbacks = openRoutes((Route) => {
  Route.fallback((ctx) => {
    calls.push(`root:${ctx.params.path}`);
    return `root:${ctx.params.path}|web=${(ctx as unknown as { webSeen?: string }).webSeen}`;
  });
  Route.prefix('/help').fallback((ctx) => {
    calls.push(`help:${ctx.params.path}`);
    return `help:${ctx.params.path}`;
  });
});
const later = openRoutes((Route) => {
  Route.get('/help/contact', () => 'contact');
  Route.get('/about', () => 'about').sitemap();
  Route.post('/help/send', () => 'sent');
});

class PackageProvider {
  boot(app: Application): void {
    app.container.make(Router).load({ group: 'web' }, defineRoutes((Route) => void Route.authorize(everyone).get('/pkg/ping', () => 'ping')));
  }
}

async function boot(modules: readonly RouteDefinitions[], options: { clientDir?: string; locales?: boolean; middleware?: boolean } = {}) {
  calls.length = 0;
  seen.global = seen.web = 0;
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, PackageProvider],
    modules: modules.map((routes, index) => defineModule({ name: `m${index}`, routes })),
    middleware: { global: [Global], web: [Web] },
  }, { env: { APP_KEY: generateKey(), APP_URL: 'https://app.example', LOG_LEVEL: 'silent' } });
  if (options.locales) application.container.instance(UrlLocales, { supported: ['de', 'en'], preferred: async () => 'de' });
  return { application, kernel: createHttpKernel(application, options.clientDir ? { clientDir: options.clientDir } : {}) };
}

const text = async (response: Response) => response.text();

describe('createHttpKernel — Route.fallback()', () => {
  it('loses to a route of a later module and to a package route, however early its module loaded', async () => {
    const { kernel } = await boot([fallbacks, later]);
    expect(await text(await kernel.request('/help/contact'))).toBe('contact');
    expect(await text(await kernel.request('/about'))).toBe('about');
    expect(await text(await kernel.request('/pkg/ping'))).toBe('ping');
    expect(calls).toEqual([]);
    expect(await text(await kernel.request('/help/other'))).toBe('help:other');
  });

  it('loses the same way when it is the last module to load', async () => {
    const { kernel } = await boot([later, fallbacks]);
    expect(await text(await kernel.request('/help/contact'))).toBe('contact');
    expect(await text(await kernel.request('/pkg/ping'))).toBe('ping');
    expect(calls).toEqual([]);
  });

  it('gives the rest of the path under the longest prefix: the root, the prefix itself, below it, and a path that only starts like it', async () => {
    const { kernel } = await boot([fallbacks, later]);
    expect(await text(await kernel.request('/'))).toMatch(/^root:\|/);
    expect(await text(await kernel.request('/help'))).toBe('help:');
    expect(await text(await kernel.request('/help/a/b'))).toBe('help:a/b');
    expect(await text(await kernel.request('/helpx'))).toMatch(/^root:helpx\|/);
    expect(await text(await kernel.request('/news/a%20b'))).toMatch(/^root:news\/a b\|/);
  });

  it('is behind the web group: the controller sees what its middleware added', async () => {
    const { kernel } = await boot([fallbacks]);
    expect(await text(await kernel.request('/anything'))).toBe('root:anything|web=yes');
  });

  it('yields to the route without its locale, and takes the paths of a locale no route has', async () => {
    const localized = openRoutes((Route) => void Route.localized().get('/about', () => 'about'));
    const { kernel } = await boot([fallbacks, localized], { locales: true });
    const redirect = await kernel.request('/about');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/de/about');
    expect(await text(await kernel.request('/de/about'))).toBe('about');
    expect(calls).toEqual([]);
    expect(await text(await kernel.request('/de/unknown'))).toMatch(/^root:de\/unknown\|/);
  });

  it('tells the router the app\'s locales, so claimedBy() answers a localized route per locale', async () => {
    const localized = openRoutes((Route) => void Route.localized().get('/about', () => 'about'));
    const { application } = await boot([fallbacks, localized], { locales: true });
    const router = application.container.make(Router);
    expect(router.claimedBy('/de/about')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/en/about')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/fr/about')).toBeUndefined();
  });

  it('leaves /sitemap.xml and /robots.txt to the kernel when a route is in the sitemap', async () => {
    const { kernel } = await boot([fallbacks, later]);
    const sitemap = await kernel.request('/sitemap.xml');
    expect(sitemap.headers.get('content-type')).toMatch(/xml/);
    expect(await sitemap.text()).toContain('https://app.example/about');
    expect(await text(await kernel.request('/robots.txt'))).toContain('Sitemap: https://app.example/sitemap.xml');
    expect(calls).toEqual([]);
  });

  it('answers /robots.txt itself when no route is in the sitemap', async () => {
    const { kernel } = await boot([fallbacks]);
    expect(await text(await kernel.request('/robots.txt'))).toMatch(/^root:robots\.txt\|/);
  });

  it.each(['/_marmeon/x', '/_marmeon', '/_MARMEON/x', '//_marmeon/x', '/%5Fmarmeon/x'])('never gives %s to the controller', async (path) => {
    const { kernel } = await boot([fallbacks]);
    expect((await kernel.request(path)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  describe('assets', () => {
    const clientDir = tempDir('marmeon-fallback-assets-');
    mkdirSync(join(clientDir, 'assets'));
    writeFileSync(join(clientDir, 'assets/app-Abc123.js'), 'export {};\n');

    it.each(['/assets/missing.js', '/assets', '/assets/', '/assets/a/b/c.css'])('answers a missing %s with 404 and never asks the controller', async (path) => {
      const { kernel } = await boot([fallbacks], { clientDir });
      const response = await kernel.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type') ?? '').not.toMatch(/html/);
      expect(calls).toEqual([]);
    });

    it('guards without a client build too (development)', async () => {
      const { kernel } = await boot([fallbacks]);
      expect((await kernel.request('/assets/missing.js')).status).toBe(404);
      expect(calls).toEqual([]);
    });

    it('still serves the files of the build', async () => {
      const { kernel } = await boot([fallbacks], { clientDir });
      expect(await text(await kernel.request('/assets/app-Abc123.js'))).toBe('export {};\n');
    });

    it('is no guard of /assets without a fallback: a wildcard of the app answers it as before', async () => {
      const wildcard = openRoutes((Route) => void Route.get('/:page{.+}', (ctx) => `wild:${ctx.params.page}`));
      const { kernel } = await boot([wildcard], { clientDir });
      expect(await text(await kernel.request('/assets/missing.js'))).toBe('wild:assets/missing.js');
    });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('never gives a %s to the controller', async (method) => {
    const { kernel } = await boot([fallbacks, later]);
    for (const path of ['/', '/help', '/help/a', '/anything']) {
      const response = await kernel.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it('answers HEAD like GET, without a body', async () => {
    const { kernel } = await boot([fallbacks]);
    const response = await kernel.request('/anything', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it.each(['//evil.com/x', '/a//b', '/a%2Fb', '/a%5Cb', '/a%00b', '/a%0D%0Ab', '/%ZZ', '/help//x', '/help/a%2Fb'])(
    'ends %s in a 404 behind the global middleware only: no web group, no controller',
    async (path) => {
      const { kernel } = await boot([fallbacks]);
      const response = await kernel.request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
      expect(calls).toEqual([]);
      expect(seen.web).toBe(0);
      expect(seen.global).toBe(1);
    },
  );

  it('sends a trailing slash to the path without it, before the web group', async () => {
    const { kernel } = await boot([fallbacks]);
    const response = await kernel.request('/help/a/');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/help/a');
    expect(seen.web).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('createHttpKernel — a second fallback', () => {
  it('stops the start with both places named, whichever module loads first', async () => {
    const one = openRoutes((Route) => void Route.fallback(() => 'one'));
    const two = openRoutes((Route) => void Route.fallback(() => 'two'));
    await expect(boot([one, two])).rejects.toThrow(/H15.*Two fallbacks answer the root.*kernel-fallback\.test\.ts.*kernel-fallback\.test\.ts/s);
    await expect(boot([two, one])).rejects.toThrow(/H15.*Two fallbacks answer the root/s);
  });
});

describe('createHttpKernel — a fallback that cannot work', () => {
  const create = (providers: unknown[], modules: RouteDefinitions[]) =>
    createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, ...providers] as never,
      modules: modules.map((routes, index) => defineModule({ name: `m${index}`, routes })),
    }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });

  it('stops the start when a package loads it without a group: it would run without the web group', async () => {
    class Ungrouped {
      boot(app: Application): void {
        app.container.make(Router).load(defineRoutes((Route) => void Route.authorize(everyone).fallback(() => 'bare')));
      }
    }
    await expect(create([Ungrouped], [])).rejects.toThrow(/H15.*in no group/s);
  });

  it('stops the start when a route of a later module takes the rest of the path before it, and when the order is the other', async () => {
    const wildcard = openRoutes((Route) => void Route.get('/help/:page{.+}', () => 'wild'));
    const fallback = openRoutes((Route) => void Route.prefix('/help').fallback(() => 'f'));
    await expect(create([], [fallback, wildcard])).rejects.toThrow(/H15.*covers the fallback/s);
    await expect(create([], [wildcard, fallback])).rejects.toThrow(/H15.*covers the fallback/s);
  });
});
