import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import type { RouteDefinitions } from '@marmeon/router';
import { UrlLocales } from '@marmeon/router/internal';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

/** The stub of what `@marmeon/i18n` binds: `en`, `de` and `de-AT`, and a visitor who prefers `de` unless `x-prefer` says otherwise. */
const locales = (supported: readonly string[] = ['en', 'de']): UrlLocales => ({
  supported,
  preferred: async (ctx) => ctx.request.headers.get('x-prefer') ?? 'de',
});

async function kernelFor(routes: RouteDefinitions, urlLocales: UrlLocales | null = locales()) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'pages', routes })],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });
  if (urlLocales) application.container.instance(UrlLocales, urlLocales);
  return { application, create: () => createHttpKernel(application) };
}

const pages = openRoutes((Route) => {
  const localized = Route.localized();
  localized.get('/', () => 'home');
  localized.get('/about', () => 'about');
  localized.get('/about/features/:feature', (ctx) => `feature ${ctx.params.feature}`);
  localized.post('/contact', () => 'sent');
  Route.get('/up-to-date', () => 'plain');
});

describe('Route.localized() on the server', () => {
  it('serves the localized routes under the locales of the app, in their spelling', async () => {
    const { create } = await kernelFor(pages);
    const kernel = create();
    expect(await (await kernel.request('/de/about')).text()).toBe('about');
    expect(await (await kernel.request('/en')).text()).toBe('home');
    expect(await (await kernel.request('/de/about/features/x')).text()).toBe('feature x');
    expect((await kernel.request('/fr/about')).status).toBe(404);
    expect((await kernel.request('/DE/about')).status).toBe(404);
    expect((await kernel.request('/de-AT/about')).status).toBe(404);
  });

  it('writes the spelling of each locale into the constraint', async () => {
    const { create } = await kernelFor(pages, locales(['en', 'de-AT']));
    const kernel = create();
    expect((await kernel.request('/de-AT/about')).status).toBe(200);
    expect((await kernel.request('/de-at/about')).status).toBe(404);
    expect((await kernel.request('/de/about')).status).toBe(404);
  });

  it('redirects the URL without a locale to the preferred one, keeping the query, for nobody else to keep', async () => {
    const { create } = await kernelFor(pages);
    const kernel = create();
    const response = await kernel.request('/about?x=1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/de/about?x=1');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('accept-language, cookie');
    expect((await kernel.request('/about', { headers: { 'x-prefer': 'en' } })).headers.get('location')).toBe('/en/about');
    const head = await kernel.request('/about', { method: 'HEAD' });
    expect(head.status).toBe(302);
    expect(head.headers.get('location')).toBe('/de/about');
    expect(head.headers.get('cache-control')).toBe('private, no-store');
  });

  it('redirects the root of a localized group to the bare locale', async () => {
    const { create } = await kernelFor(pages);
    const response = await create().request('/');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/de');
  });

  it('answers a write without a locale with a 404, not a redirect', async () => {
    const { create } = await kernelFor(pages);
    expect((await create().request('/contact', { method: 'POST' })).status).toBe(404);
  });

  it('never lets the raw path decide where the redirect leads', async () => {
    const { create } = await kernelFor(pages);
    const kernel = create();
    const hostile = [
      '/about/features/%2F%2Fevil.example',
      '/about/features/%5C%5Cevil.example',
      '/about/features/%2Fevil.example%2F..',
      '/about/features/..%2F..%2Fevil.example',
      '//about',
      '/%2Fabout',
      '/about?next=//evil.example',
      '/about/features/%2E%2E',
      '/about/features/%2e',
    ];
    for (const path of hostile) {
      const response = await kernel.request(path);
      const location = response.headers.get('location');
      if (response.status === 302) {
        expect(location, path).toMatch(/^\/de(\/|$)/);
        expect(location, path).not.toMatch(/^\/[/\\]/);
      } else {
        expect(location, path).toBeNull();
      }
    }
    const encoded = await kernel.request('/about/features/%2F%2Fevil.example');
    expect(encoded.headers.get('location')).toBe('/de/about/features/%2F%2Fevil.example');
    const query = await kernel.request('/about?next=//evil.example');
    expect(query.headers.get('location')).toBe('/de/about?next=//evil.example');
  });

  it('refuses a preferred locale that the app does not support', async () => {
    const { create } = await kernelFor(pages, { supported: ['en', 'de'], preferred: async () => '//evil.example' });
    const response = await create().request('/about');
    expect(response.status).toBe(500);
    expect(response.headers.get('location')).toBeNull();
  });

  it('stops the start for a route without localized() under a locale', async () => {
    const { application, create } = await kernelFor(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.get('/de/impressum', () => 'legal');
    }));
    try {
      expect(create).toThrow(/\[marmeon:H9\].*GET \/de\/impressum starts with the locale \[de\].*GET \/:locale\/about/s);
    } finally {
      await application.shutdown();
    }
  });

  it('compares the first segment without regard to case', async () => {
    const { application, create } = await kernelFor(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.get('/DE', () => 'legal');
    }));
    try {
      expect(create).toThrow(/starts with the locale \[DE\]/);
    } finally {
      await application.shutdown();
    }
  });

  it('allows a route that is not under a locale, when no route is localized', async () => {
    const { application, create } = await kernelFor(openRoutes((Route) => void Route.get('/de/impressum', () => 'legal')));
    try {
      expect(create).not.toThrow();
    } finally {
      await application.shutdown();
    }
  });

  it('stops the start when a route of the app takes the URL without a locale', async () => {
    const { application, create } = await kernelFor(openRoutes((Route) => {
      Route.localized().get('/', () => 'home');
      Route.get('/', () => 'dashboard');
    }));
    try {
      expect(create).toThrow(/\[marmeon:H9\].*GET \/ and GET \/:locale \(Route\.localized\(\)\) both answer GET \//s);
    } finally {
      await application.shutdown();
    }
  });

  it('lets a route of the app win over the URL without a locale of a parameter route', async () => {
    const { create } = await kernelFor(openRoutes((Route) => {
      Route.localized().get('/:slug', () => 'page');
      Route.get('/login', () => 'login');
    }));
    const kernel = create();
    expect(await (await kernel.request('/login')).text()).toBe('login');
    expect((await kernel.request('/elsewhere')).headers.get('location')).toBe('/de/elsewhere');
  });

  it('answers a dot segment in the URL without a locale with 404', async () => {
    const { create } = await kernelFor(pages);
    expect((await create().request('/about/features/%2E%2E')).status).toBe(404);
  });

  it.each([[[]], [['en', 'de/x']], [['en', '(a|b)']]])('stops the start for locales a URL cannot hold: %j', async (supported) => {
    const { application, create } = await kernelFor(pages, locales(supported));
    try {
      expect(create).toThrow(/\[marmeon:H9\] Route\.localized\(\) needs locales it can write into a URL/);
    } finally {
      await application.shutdown();
    }
  });

  it('stops the start without locales bound', async () => {
    const { application, create } = await kernelFor(pages, null);
    try {
      expect(create).toThrow(/\[marmeon:H9\] Route\.localized\(\) needs @marmeon\/i18n: GET \/:locale/);
    } finally {
      await application.shutdown();
    }
  });
});
