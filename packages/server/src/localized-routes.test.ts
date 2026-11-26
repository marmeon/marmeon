import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import type { Route, RouteDefinitions } from '@marmeon/router';
import { UrlLocales } from '@marmeon/router/internal';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

/** The stub of what `@marmeon/i18n` binds: `en`, `de` and `de-AT`, and a visitor who prefers `de` unless `x-prefer` says otherwise. */
const locales = (supported: readonly string[] = ['en', 'de']): UrlLocales => ({
  supported,
  unprefixed: undefined,
  preferred: async (ctx) => ctx.request.headers.get('x-prefer') ?? 'de',
});

async function kernelFor(routes: RouteDefinitions, urlLocales: UrlLocales | null = locales(), appUrl?: string) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ...(appUrl ? [ServerServiceProvider] : [])],
    modules: [defineModule({ name: 'pages', routes })],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent', ...(appUrl ? { APP_URL: appUrl } : {}) } });
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
  async function start(routes: RouteDefinitions, urlLocales: UrlLocales | null, appUrl?: string) {
    const { application, create } = await kernelFor(routes, urlLocales, appUrl);
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

  it('counts a route of GET and HEAD as GET and names the shared method; a route of HEAD alone answers nothing', async () => {
    const { error } = await start(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.match(['GET', 'HEAD'], '/about', () => 'both');
    }), withDefault('de'));
    expect(error?.message).toMatch(/\[marmeon:H9\] GET\|HEAD \/about and GET \/:locale\/about \(Route\.localized\(\)\) both answer GET \/about/);
    expect((await start(openRoutes((Route) => {
      Route.localized().get('/about', () => 'about');
      Route.match(['HEAD'], '/about', () => 'head');
    }), withDefault('de'))).error).toBeUndefined();
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

  describe('an address with a parameter first, ahead of the fixed path of a later route', () => {
    const shadowing = (register: (Route: Route) => void) => openRoutes(register);

    it('stops the start: /:username answers /login, so GET /login registered after it never runs', async () => {
      const { error } = await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.get('/login', () => 'login');
      }), withDefault('de'));
      expect(error?.message).toMatch(/\[marmeon:H9\] GET \/:locale\/:username \(Route\.localized\(\)\) answers GET \/login at the address of the default locale without a prefix \[de\] \(\/:username\), ahead of GET \/login: that route would never run\. Register \/login before it/);
    });

    it('counts a shared method only, and HEAD as part of GET: a route of HEAD alone neither shadows nor is shadowed', async () => {
      const head = await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.match(['HEAD'], '/login', () => 'head');
      }), withDefault('de'));
      expect(head.error).toBeUndefined();
      const post = await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.post('/login', () => 'login');
      }), withDefault('de'));
      expect(post.error).toBeUndefined();
      const both = await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.match(['GET', 'HEAD'], '/login', () => 'login');
      }), withDefault('de'));
      expect(both.error?.message).toMatch(/\[marmeon:H9\].*answers GET \/login/);
      // A route of HEAD alone before the address is no earlier answer.
      const before = await start(shadowing((Route) => {
        Route.match(['HEAD'], '/login', () => 'head');
        Route.localized().get('/:username', () => 'user');
        Route.get('/login', () => 'login');
      }), withDefault('de'));
      expect(before.error?.message).toMatch(/\[marmeon:H9\].*answers GET \/login/);
    });

    it('starts with /login registered before /:username, and without the mode', async () => {
      expect((await start(shadowing((Route) => {
        Route.get('/login', () => 'login');
        Route.localized().get('/:username', () => 'user');
      }), withDefault('de'))).error).toBeUndefined();
      expect((await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.get('/login', () => 'login');
      }), withDefault(undefined))).error).toBeUndefined();
    });

    it('names fixed paths only: a parameter route behind it starts, and /en is refused for its own reason', async () => {
      // A route at a locale's own path is refused by the rule of the locale's owner, not as shadowed.
      expect((await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.get('/en', () => 'english');
      }), withDefault('de'))).error?.message).toMatch(/starts with the locale \[en\]/);
      expect((await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.get('/:other', () => 'other');
      }), withDefault('de'))).error).toBeUndefined();
    });

    it('stops the start for an address with an optional parameter ahead of the fixed /', async () => {
      const { error } = await start(shadowing((Route) => {
        Route.localized().get('/:page?', () => 'page');
        Route.get('/', () => 'home');
      }), withDefault('de'));
      expect(error?.message).toMatch(/\[marmeon:H9\].*answers GET \/ at the address/);
    });

    it.each([
      ['an optional parameter', (Route: Route) => Route.localized().get('/:page?', () => 'page'), '/login'],
      ['the rest of the path', (Route: Route) => Route.localized().get('/:path*', () => 'rest'), '/login'],
      ['two parameters, the second optional', (Route: Route) => Route.localized().get('/:a/:b?', () => 'two'), '/x/y'],
    ])('stops the start for %s ahead of a fixed path: the localized route itself answers nothing without its prefix', async (_name, register, fixed) => {
      const { error } = await start(shadowing((Route) => {
        register(Route);
        Route.get(fixed, () => 'fixed');
      }), withDefault('de'));
      expect(error?.message).toMatch(new RegExp(`\\[marmeon:H9\\].*answers GET ${fixed}`));
    });

    it('starts when a route before the address already answers the path: the address is not what shadows', async () => {
      // P1: a route of the app first, P10: the same fixed path twice, P11: a parameter route first.
      expect((await start(shadowing((Route) => {
        Route.get('/:slug', () => 'slug');
        Route.localized().get('/:username', () => 'user');
        Route.get('/login', () => 'login');
      }), withDefault('de'))).error).toBeUndefined();
      expect((await start(shadowing((Route) => {
        Route.get('/login', () => 'login');
        Route.localized().get('/:username', () => 'user');
        Route.post('/login', () => 'again');
        Route.get('/login/', () => 'twice');
      }), withDefault('de'))).error).toBeUndefined();
      expect((await start(shadowing((Route) => {
        Route.get('/:other', () => 'other');
        Route.localized().get('/:username', () => 'user');
        Route.get('/about', () => 'about');
      }), withDefault('de'))).error).toBeUndefined();
    });

    it('lets /sitemap.xml and /robots.txt stand behind the address while a route is in the sitemap', async () => {
      const routes = (Route: Route) => {
        Route.get('/plain', () => 'plain').sitemap();
        Route.localized().get('/:username', () => 'user');
        Route.get('/sitemap.xml', () => 'mine');
      };
      expect((await start(shadowing(routes), withDefault('de'), 'https://app.example')).error).toBeUndefined();
      // Without a route in the sitemap the address does take it.
      const { error } = await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.get('/sitemap.xml', () => 'mine');
      }), withDefault('de'));
      expect(error?.message).toMatch(/\[marmeon:H9\].*answers GET \/sitemap\.xml/);
    });

    it('stops the start for a localized route behind it as well, and names the redacted path', async () => {
      const { error } = await start(shadowing((Route) => {
        Route.localized().get('/:username', () => 'user');
        Route.localized().get('/login', () => 'login');
      }), withDefault('de'));
      expect(error?.message).toMatch(/\[marmeon:H9\].*answers GET \/login/);
    });
  });
});
