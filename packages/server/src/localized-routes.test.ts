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
  unprefixed: undefined,
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
    const { create } = await kernelFor(pages, { supported: ['en', 'de'], unprefixed: undefined, preferred: async () => '//evil.example' });
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

  it('stops the start for a fallback without localized() under a locale', async () => {
    const { application, create } = await kernelFor(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.prefix('/de').fallback(() => 'legal');
    }));
    try {
      expect(create).toThrow(/\[marmeon:H9\].*GET \/de\/:path\* starts with the locale \[de\].*GET \/:locale\/about/s);
    } finally {
      await application.shutdown();
    }
  });

  it('still finds a route of the app that takes the address without a locale of a localized one, beside a localized fallback', async () => {
    const { application, create } = await kernelFor(openRoutes((Route) => {
      Route.localized().fallback(() => 'page');
      Route.localized().get('/about', () => 'about');
      Route.get('/about', () => 'plain about');
    }));
    try {
      expect(create).toThrow(/\[marmeon:H9\].*both answer GET \/about/s);
    } finally {
      await application.shutdown();
    }
  });

  it('accepts a localized fallback beside localized routes: its address without a locale is no route of the app', async () => {
    const { application, create } = await kernelFor(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.localized().fallback(() => 'page');
      Route.get('/kontakt', () => 'k');
    }));
    try {
      expect(create).not.toThrow();
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

/** The stub with the locale without a prefix set by hand (`@marmeon/i18n` does not bind it yet). */
const withDefault = (unprefixed: string | undefined, supported: readonly string[] = ['en', 'de']): UrlLocales => ({ ...locales(supported), unprefixed });

describe('Route.localized() on the server — the default locale without a prefix', () => {
  /** Boots the routes and returns what the start did: the error, or the kernel. */
  async function start(routes: RouteDefinitions, urlLocales: UrlLocales | null) {
    const { application, create } = await kernelFor(routes, urlLocales);
    try {
      return { error: (() => { try { create(); return undefined; } catch (error) { return error as Error; } })() };
    } finally {
      await application.shutdown();
    }
  }

  it('stops the start for a locale without a prefix that is none of the supported ones, also with no localized route', async () => {
    const withRoutes = await start(pages, withDefault('fr'));
    expect(withRoutes.error?.message).toMatch(/\[marmeon:H9\] The default locale without a prefix \[fr\] is none of the supported ones \(en, de\)/);
    const without = await start(openRoutes((Route) => void Route.get('/plain', () => 'plain')), withDefault('fr'));
    expect(without.error?.message).toMatch(/\[marmeon:H9\] The default locale without a prefix \[fr\] is none of the supported ones/);
    expect((await start(pages, withDefault('de'))).error).toBeUndefined();
  });

  it.each(['/en/x', '/EN/x', '/De/x'])('stops the start for a localized route whose first literal segment is a locale: %s', async (path) => {
    const { error } = await start(openRoutes((Route) => void Route.localized().get(path, () => 'x')), withDefault('de'));
    expect(error?.message).toMatch(/\[marmeon:H9\] GET \/:locale\/\w+\/x \(Route\.localized\(\)\) starts with the locale \[\w+\] after its prefix: the address of the default locale without a prefix, \/\w+\/x, would be the path of the locale \[\w+\]/);
    // Without the mode the same route starts, as it does without the mode.
    expect((await start(openRoutes((Route) => void Route.localized().get(path, () => 'x')), withDefault(undefined))).error).toBeUndefined();
  });

  it('does not refuse a parameter in the first place: /:slug and a fallback at the root start', async () => {
    expect((await start(openRoutes((Route) => void Route.localized().get('/:slug', () => 'x')), withDefault('de'))).error).toBeUndefined();
    expect((await start(openRoutes((Route) => void Route.localized().fallback(() => 'x')), withDefault('de'))).error).toBeUndefined();
    expect((await start(openRoutes((Route) => void Route.localized().get('/entries/en', () => 'x')), withDefault('de'))).error).toBeUndefined();
  });

  it('stops the start when a route of the app shares a method with the address of the default locale, POST included', async () => {
    const post = await start(openRoutes((Route) => {
      Route.localized().post('/contact', () => 'sent');
      Route.post('/contact', () => 'other');
    }), withDefault('de'));
    expect(post.error?.message).toMatch(/\[marmeon:H9\] POST \/contact and POST \/:locale\/contact \(Route\.localized\(\)\) both answer POST \/contact: the address of the default locale without a prefix \[de\] is that route's/);
    // Without the mode only the GET of the redirect counts, as without the mode.
    expect((await start(openRoutes((Route) => {
      Route.localized().post('/contact', () => 'sent');
      Route.post('/contact', () => 'other');
    }), withDefault(undefined))).error).toBeUndefined();
  });

  it('counts HEAD as GET and names the shared method', async () => {
    const { error } = await start(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.match(['HEAD'], '/about', () => 'head');
    }), withDefault('de'));
    expect(error?.message).toMatch(/\[marmeon:H9\] HEAD \/about and GET \/:locale\/about \(Route\.localized\(\)\) both answer GET \/about/);
  });

  it('refuses a route written with a trailing slash too: GET /about/ is /about beside a localized /about', async () => {
    const { error } = await start(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.get('/about/', () => 'slash');
    }), withDefault('de'));
    expect(error?.message).toMatch(/\[marmeon:H9\] GET \/about and GET \/:locale\/about \(Route\.localized\(\)\) both answer GET \/about/);
  });

  it('starts when a localized POST-only route sits beside a GET route on the same path', async () => {
    const { error } = await start(openRoutes((Route) => {
      Route.localized().post('/contact', () => 'sent');
      Route.get('/contact', () => 'form');
    }), withDefault('de'));
    expect(error).toBeUndefined();
  });

  it('keeps the text without the mode for a GET beside a localized GET without the mode', async () => {
    const { error } = await start(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.get('/about', () => 'plain');
    }), withDefault(undefined));
    expect(error?.message).toMatch(/the URL without a locale redirects to the visitor's language/);
  });

  it('says the address of the default locale for a GET beside a localized GET with the mode', async () => {
    const { error } = await start(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.get('/about', () => 'plain');
    }), withDefault('de'));
    expect(error?.message).toMatch(/both answer GET \/about: the address of the default locale without a prefix \[de\] is that route's/);
    expect(error?.message).not.toMatch(/redirects to the visitor's language/);
  });
});
