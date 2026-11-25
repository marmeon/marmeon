import { describe, expect, it } from 'vitest';
import { defineMiddleware, defineRoutes, everyone, Router, type RouteDefinition, type RouteDefinitions } from './index.ts';
import { FRAMEWORK_ROUTES } from './internal.ts';
import { GLOBAL } from './middleware-groups.ts';
import { createRequestState } from './request.ts';
import type { UrlLocales } from './url-locales.ts';
import { namesLocaleSegment, urlFor } from './url.ts';

const open = (register: (Route: Parameters<RouteDefinitions['register']>[0]) => void): RouteDefinitions => defineRoutes((Route) => register(Route.authorize(everyone)));
const urlLocales = (unprefixed: string | undefined, supported: readonly string[] = ['de', 'en']): UrlLocales => ({ supported, unprefixed, preferred: async () => 'en' });
const web = (...files: RouteDefinitions[]) => new Router().load({ group: 'web' }, ...files);
const bound = (unprefixed: string | undefined, ...files: RouteDefinitions[]) => {
  const router = web(...files);
  router.bindUrlLocales(urlLocales(unprefixed));
  return router;
};

const sourceOf = (router: Router, path: string): RouteDefinition => router.routes.find((route) => route.path === path)!;
/** The address the router registers for the unprefixed locale of the route at `path`. */
const addressOf = (router: Router, path: string): RouteDefinition => router.registrationOrder.find((route) => route.generatedFrom?.path === path)!;
const request = (path: string, method = 'GET') => new Request(`http://localhost${path}`, { method });
const send = (router: Router, route: RouteDefinition, path: string, params: Record<string, string>, method = 'GET') => router.dispatch(route, { request: request(path, method), params });
const show = (response: Response) => [response.status, response.headers.get('location')];

describe('the address of the unprefixed locale', () => {
  const about = open((Route) => void Route.localized().get('/about', (ctx) => `${ctx.route.path}|${ctx.params.locale}`));

  it('answers as the route itself, in the unprefixed locale', async () => {
    const router = bound('de', about);
    const address = addressOf(router, '/:locale/about');
    expect(address.path).toBe('/about');
    const response = await send(router, address, '/about', {});
    expect(await response.text()).toBe('/:locale/about|de');
  });

  it('puts the address right behind its route, not at the end like the redirecting ones of the other mode', () => {
    const files = [about, open((Route) => void Route.get('/first', () => 'f')), open((Route) => void Route.localized().get('/second', () => 's'))];
    const order = (router: Router) => router.registrationOrder.map((route) => route.path);
    expect(order(bound('de', ...files))).toEqual(['/:locale/about', '/about', '/first', '/:locale/second', '/second']);
    // Without the mode the routes without a locale come last.
    expect(order(bound(undefined, ...files))).toEqual(['/:locale/about', '/first', '/:locale/second', '/about', '/second']);
    expect(order(web(...files))).toEqual(['/:locale/about', '/first', '/:locale/second', '/about', '/second']);
  });

  it('lists the framework\'s own routes first, each localized page still followed by its address', () => {
    const router = bound('de', about);
    router.load({ framework: FRAMEWORK_ROUTES }, defineRoutes((Route) => void Route.get('/_marmeon/ping', () => 'ping')));
    expect(router.registrationOrder.map((route) => route.path)).toEqual(['/_marmeon/ping', '/:locale/about', '/about']);
  });

  it('answers a write like the route does: every method of the route has its address', async () => {
    const router = bound('de', open((Route) => void Route.localized().post('/contact', (ctx) => `post|${ctx.params.locale}`)));
    const address = addressOf(router, '/:locale/contact');
    expect(address.methods).toEqual(['POST']);
    expect(await (await send(router, address, '/contact', {}, 'POST')).text()).toBe('post|de');
  });

  it('never answers without the mode: a caller that dispatches it anyway gets a 404', async () => {
    const router = bound('de', about);
    const address = addressOf(router, '/:locale/about');
    router.bindUrlLocales(urlLocales(undefined));
    await expect(send(router, address, '/about', {})).rejects.toMatchObject({ status: 404 });
  });

  it('takes the rest of the path from the address, and the locale from the mode', async () => {
    const router = bound('de', open((Route) => void Route.localized().get('/help/:path*', (ctx) => `${ctx.params.locale}|${ctx.params.path}`)));
    const address = addressOf(router, '/:locale/help/:path*');
    expect(address.path).toBe('/help/:path*');
    expect(await (await send(router, address, '/help/a/b', {})).text()).toBe('de|a/b');
    expect(await (await send(router, address, '/help', {})).text()).toBe('de|');
  });

  it('ignores a locale a caller passes: the mode names it', async () => {
    const router = bound('de', about);
    const response = await send(router, addressOf(router, '/:locale/about'), '/about', { locale: 'en' });
    expect(await response.text()).toBe('/:locale/about|de');
  });

  it('still runs the route\'s middleware, checks and bindings, as for its prefixed address', async () => {
    const log: string[] = [];
    const trace = (name: string) => defineMiddleware(name, (_ctx, next) => (log.push(name), next()));
    const router = new Router();
    router.middleware.append(GLOBAL, trace('global')).append('web', trace('group'));
    router.load({ group: 'web' }, defineRoutes((Route) => void Route.localized().middleware(trace('route')).authorize((ctx) => (log.push(`check ${String(ctx.params.locale)}`), true)).get('/p', () => 'p')));
    router.bindUrlLocales(urlLocales('de'));
    await send(router, addressOf(router, '/:locale/p'), '/p', {});
    expect(log).toEqual(['global', 'group', 'route', 'check de']);
  });
});

describe('the prefix of the unprefixed locale', () => {
  const about = open((Route) => void Route.localized().get('/about', () => 'about'));
  const prefixed = (router: Router, path: string, url: string, params: Record<string, string>, method = 'GET') => send(router, sourceOf(router, path), url, params, method);

  it('sends a GET to the address, with the query, for an hour and with no Vary', async () => {
    const router = bound('de', about);
    const response = await prefixed(router, '/:locale/about', '/de/about?x=1', { locale: 'de' });
    expect(show(response)).toEqual([301, '/about?x=1']);
    expect(response.headers.get('cache-control')).toBe('max-age=3600');
    expect(response.headers.has('vary')).toBe(false);
  });

  it('sends a HEAD the same way', async () => {
    const router = bound('de', about);
    expect(show(await prefixed(router, '/:locale/about', '/de/about', { locale: 'de' }, 'HEAD'))).toEqual([301, '/about']);
  });

  it('answers any other method with a 404: one page, one address', async () => {
    const router = bound('de', open((Route) => void Route.localized().post('/contact', () => 'sent')));
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      await expect(prefixed(router, '/:locale/contact', '/de/contact', { locale: 'de' }, method), method).rejects.toMatchObject({ status: 404 });
    }
  });

  it('sends the locale\'s own root to the root of the site', async () => {
    const router = bound('de', open((Route) => void Route.localized().get('/', () => 'home')));
    expect(show(await prefixed(router, '/:locale', '/de', { locale: 'de' }))).toEqual([301, '/']);
  });

  it('leaves every other locale where it is', async () => {
    const router = bound('de', about);
    expect(await (await prefixed(router, '/:locale/about', '/en/about', { locale: 'en' })).text()).toBe('about');
  });

  it('sends a rest route to its rest of the path, a trailing slash first to the canonical one', async () => {
    const router = bound('de', open((Route) => void Route.localized().get('/help/:path*', () => 'help')));
    const rest = (url: string) => prefixed(router, '/:locale/help/:path*', url, { locale: 'de' });
    expect(show(await rest('/de/help/a/b'))).toEqual([301, '/help/a/b']);
    expect(show(await rest('/de/help/a/'))).toEqual([301, '/de/help/a']);
    expect(show(await rest('/de/help'))).toEqual([301, '/help']);
  });

  it('answers the page itself, with no redirect, without the mode', async () => {
    const router = bound(undefined, about);
    expect(await (await prefixed(router, '/:locale/about', '/de/about', { locale: 'de' })).text()).toBe('about');
  });

  it('reads the locale of the mode at every request, not once at the binding', async () => {
    let current: string | undefined;
    const router = web(about);
    router.bindUrlLocales({ supported: ['de', 'en'], get unprefixed() { return current; }, preferred: async () => 'en' });
    const status = async () => (await prefixed(router, '/:locale/about', '/de/about', { locale: 'de' })).status;
    expect(await status()).toBe(200);
    current = 'de';
    expect(await status()).toBe(301);
    current = 'en';
    expect(await status()).toBe(200);
    expect(router.registrationOrder.map((route) => route.path)).toEqual(['/:locale/about', '/about']);
    current = undefined;
    expect(router.registrationOrder.map((route) => route.path)).toEqual(['/:locale/about', '/about']);
    expect(addressOf(router, '/:locale/about')).toBe(router.registrationOrder[1]);
  });

  describe('where the target comes from', () => {
    const slug = open((Route) => void Route.localized().get('/:slug', () => 'page'));
    // Each value the route's pattern is filled with, and what the visitor gets: an encoded path of this site, or a 404.
    const hostile: [string, number, string | null][] = [
      ['..', 404, null],
      ['.', 404, null],
      ['//evil.example', 301, '/%2F%2Fevil.example'],
      ['/\\evil.example', 301, '/%2F%5Cevil.example'],
      ['/evil.example/x', 301, '/%2Fevil.example%2Fx'],
      ['\\\\evil.example', 301, '/%5C%5Cevil.example'],
      ['%2F%2Fevil.example', 301, '/%252F%252Fevil.example'],
      ['a/../..', 301, '/a%2F..%2F..'],
      ['\t//evil.example', 301, '/%09%2F%2Fevil.example'],
    ];

    it('is an encoded path of this site for any value, and a 404 for a dot segment', async () => {
      const router = bound('de', slug);
      for (const [value, status, location] of hostile) {
        const outcome = await prefixed(router, '/:locale/:slug', '/de/x', { locale: 'de', slug: value }).then(show, (error: { status: number }) => [error.status, null]);
        expect(outcome, value).toEqual([status, location]);
      }
    });

    it('is the page itself when the address would start with a locale: that page keeps its prefix', async () => {
      const router = bound('de', open((Route) => void Route.localized().get('/:slug', (ctx) => `page|${ctx.params.locale}|${ctx.params.slug}`)));
      for (const value of ['en', 'EN', 'De']) {
        const response = await prefixed(router, '/:locale/:slug', `/de/${value}`, { locale: 'de', slug: value });
        expect([response.status, await response.text()], value).toEqual([200, `page|de|${value}`]);
      }
      expect(show(await prefixed(router, '/:locale/:slug', '/de/english', { locale: 'de', slug: 'english' }))).toEqual([301, '/english']);
      expect((await prefixed(router, '/:locale/:slug', '/de/EN', { locale: 'de', slug: 'EN' }, 'POST')).status).toBe(200);
    });

    it('is refused for a dot segment, which a browser would resolve to another route', async () => {
      const router = bound('de', slug);
      for (const value of ['.', '..']) await expect(prefixed(router, '/:locale/:slug', '/de/x', { locale: 'de', slug: value })).rejects.toMatchObject({ status: 404 });
    });

    it('never comes from the path of the request', async () => {
      const router = bound('de', slug);
      for (const url of ['/de//evil.example', '/de/%2F%2Fevil.example', '//evil.example/x', '/\\evil.example', '/de/x/../../evil']) {
        const response = await prefixed(router, '/:locale/:slug', url, { locale: 'de', slug: 'x' });
        expect(show(response), url).toEqual([301, '/x']);
      }
    });

    it('is a 404 for a rest of the path that could name another host', async () => {
      const router = bound('de', open((Route) => void Route.localized().get('/help/:path*', () => 'help')));
      for (const url of ['/de/help//evil.example', '/de/help/a//b', '/de/help/%2F%2Fevil', '/de/help/a%5Cb', '/de/help/%5C%5Cevil']) {
        await expect(prefixed(router, '/:locale/help/:path*', url, { locale: 'de' }), url).rejects.toMatchObject({ status: 404 });
      }
    });

    it('keeps the query out of the path: a hostile query is a query', async () => {
      const router = bound('de', slug);
      const response = await prefixed(router, '/:locale/:slug', '/de/x?next=//evil.example&a=%2F%2F', { locale: 'de', slug: 'x' });
      expect(show(response)).toEqual([301, '/x?next=//evil.example&a=%2F%2F']);
    });
  });

  describe('what it does not run', () => {
    it('asks neither the route\'s middleware, nor a check, nor a binding, and queues no cookie', async () => {
      const log: string[] = [];
      const trace = (name: string) => defineMiddleware(name, (ctx, next) => {
        log.push(name);
        ctx.cookies.set(name, 'x');
        return next();
      });
      class Records {
        resolveRouteBinding() {
          log.push('bind');
          return { id: 1 };
        }
      }
      const router = new Router();
      router.middleware.append(GLOBAL, defineMiddleware('global', (_ctx, next) => (log.push('global'), next()))).append('web', trace('group'));
      router.load({ group: 'web' }, defineRoutes((Route) => void Route.localized().middleware(trace('route')).bind('record', Records).authorize(() => (log.push('check'), false)).get('/records/:record', () => 'record')));
      router.bindUrlLocales(urlLocales('de'));
      const state = createRequestState(request('/de/records/1'));
      const response = await router.dispatch(sourceOf(router, '/:locale/records/:record'), { request: request('/de/records/1'), params: { locale: 'de', record: '1' } }, { state });
      expect(show(response)).toEqual([301, '/records/1']);
      expect(log).toEqual(['global']);
      expect(await state.cookies.queued()).toEqual([]);
    });

    it('is no way around the checks of the route: its address asks them', async () => {
      const log: string[] = [];
      const router = bound('de', defineRoutes((Route) => void Route.localized().authorize(() => (log.push('check'), false)).get('/private', () => 'secret')));
      await expect(send(router, addressOf(router, '/:locale/private'), '/private', {})).rejects.toMatchObject({ status: 403 });
      expect(log).toEqual(['check']);
    });
  });
});

describe('urls of the mode', () => {
  it('builds the unprefixed locale\'s page without a prefix, the others with theirs, and never puts the locale in the query', () => {
    const router = bound('de', open((Route) => void Route.localized().get('/about', () => 'a').name('about')), open((Route) => void Route.localized().get('/help/:path*', () => 'h').name('help')));
    expect(router.url('about' as never, { locale: 'de' } as never)).toBe('/about');
    expect(router.url('about' as never, { locale: 'en' } as never)).toBe('/en/about');
    expect(router.url('about' as never, { locale: 'de', ref: 'a' } as never)).toBe('/about?ref=a');
    expect(router.url('help' as never, { locale: 'de', path: 'a/b' } as never)).toBe('/help/a/b');
    expect(router.unprefixedLocale).toBe('de');
  });

  it('keeps the prefix without the mode', () => {
    const router = bound(undefined, open((Route) => void Route.localized().get('/about', () => 'a').name('about')));
    expect(router.url('about' as never, { locale: 'de' } as never)).toBe('/de/about');
    expect(router.unprefixedLocale).toBeUndefined();
  });

  it('follows the owner\'s value at every call', () => {
    let current: string | undefined;
    const router = web(open((Route) => void Route.localized().get('/about', () => 'a').name('about')));
    router.bindUrlLocales({ supported: ['de', 'en'], get unprefixed() { return current; }, preferred: async () => 'en' });
    expect(urlFor(router, 'about', { locale: 'de' })).toBe('/de/about');
    current = 'de';
    expect(urlFor(router, 'about', { locale: 'de' })).toBe('/about');
    current = undefined;
    expect(urlFor(router, 'about', { locale: 'de' })).toBe('/de/about');
  });
});

describe('the address of a localized fallback', () => {
  const files = [open((Route) => void Route.localized().prefix('/blog').fallback((ctx) => `${ctx.params.locale}|${ctx.params.path}`)), open((Route) => void Route.localized().get('/about', () => 'a'))];

  it('sits with the fallbacks, after the localized one, and answers as the fallback in the unprefixed locale', async () => {
    const router = bound('de', ...files);
    expect(router.fallbacks.map((route) => [route.path, route.generatedFrom?.path ?? null])).toEqual([['/:locale/blog/:path*', null], ['/blog/:path*', '/:locale/blog/:path*']]);
    expect(router.registrationOrder.map((route) => route.path)).toEqual(['/:locale/about', '/about']);
    const response = await send(router, router.fallbacks[1]!, '/blog/x/y', {});
    expect(await response.text()).toBe('de|x/y');
  });

  it('is the redirecting one without the mode: it sends the visitor to the preferred locale', async () => {
    const router = web(...files);
    const variant = router.fallbacks[1]!;
    expect(variant.path).toBe('/blog/:path*');
    const response = await router.dispatch(variant, { request: request('/blog/x/y'), params: {} }, { urlLocales: urlLocales(undefined) });
    expect(show(response)).toEqual([302, '/en/blog/x/y']);
  });
});

describe('namesLocaleSegment()', () => {
  const supported = ['de', 'en', 'de-AT'];

  it('is true for a path whose first segment is a locale, in any case and encoded', () => {
    for (const path of ['/en', '/en/x', '/EN/x', '/De/x', '/de-at/x', '/%65n/x', '/%44E']) expect(namesLocaleSegment(path, supported), path).toBe(true);
  });

  it('is false for another first segment, the root, and a locale further down', () => {
    for (const path of ['/', '', '/about', '/enx', '/x/en', '/fr/x', '/en%2Fx', '//en']) expect(namesLocaleSegment(path, supported), path).toBe(false);
  });

  it('counts a segment that does not decode: fail closed', () => {
    expect(namesLocaleSegment('/%E0%A4%A/x', supported)).toBe(true);
    expect(namesLocaleSegment('/%/x', supported)).toBe(true);
  });
});

describe('what the router names a fallback in the mode', () => {
  it('asks the fallback of a path starting with a locale for the localized one, and the others for the address', () => {
    const router = bound('de', open((Route) => void Route.localized().fallback(() => 'f')));
    expect(router.fallbackFor('/en/x')?.path).toBe('/:locale/:path*');
    expect(router.fallbackFor('/x')?.generatedFrom?.path).toBe('/:locale/:path*');
    expect(router.fallbackFor('/fr/x')?.generatedFrom?.path).toBe('/:locale/:path*');
  });

  it('leaves a path that starts with a locale to that locale, even when the address\'s own prefix is the locale', () => {
    const files = open((Route) => void Route.localized().prefix('/en').fallback(() => 'f'));
    // Without the mode the address redirects and answers the path; with it, `/en/…` is the locale's own and no fallback of the address.
    expect(web(files).fallbackFor('/en/x')?.generatedFrom?.path).toBe('/:locale/en/:path*');
    expect(bound('de', files).fallbackFor('/en/x')).toBeUndefined();
    expect(bound('de', files).fallbackFor('/EN/x')).toBeUndefined();
  });
});

describe('what the mode is read from', () => {
  const about = open((Route) => void Route.localized().get('/about', (ctx) => `${ctx.route.path}|${ctx.params.locale}`));
  const variantOf = (router: Router) => router.registrationOrder.find((route) => route.generatedFrom !== undefined)!;
  const pageOf = async (response: Promise<Response>) => (await response).text();

  it('answers a redirecting variant as the address once the mode is bound: no 302 and 301 chasing each other', async () => {
    const router = web(about);
    const variant = variantOf(router);
    expect(variant.methods).toEqual(['GET']);
    expect(show(await router.dispatch(variant, { request: request('/about'), params: {} }, { urlLocales: urlLocales(undefined) }))).toEqual([302, '/en/about']);
    router.bindUrlLocales(urlLocales('de'));
    expect(await pageOf(send(router, variant, '/about', {}))).toBe('/:locale/about|de');
  });

  it('takes the mode of the options for the call, also on a router nothing is bound to', async () => {
    const router = web(about);
    const variant = variantOf(router);
    expect(await pageOf(router.dispatch(variant, { request: request('/about'), params: {} }, { urlLocales: urlLocales('de') }))).toBe('/:locale/about|de');
    expect(await pageOf(router.dispatch(variant, { request: request('/about'), params: {} }, { urlLocales: urlLocales('en') }))).toBe('/:locale/about|en');
  });

  it('lets the options win over the binding, and let them switch the mode off for the call', async () => {
    const router = bound('de', about);
    const address = addressOf(router, '/:locale/about');
    const given = (unprefixed: string | undefined) => ({ urlLocales: urlLocales(unprefixed) });
    expect(await pageOf(router.dispatch(address, { request: request('/about'), params: {} }, given('en')))).toBe('/:locale/about|en');
    await expect(router.dispatch(address, { request: request('/about'), params: {} }, given(undefined))).rejects.toMatchObject({ status: 404 });
    const prefixed = sourceOf(router, '/:locale/about');
    expect(await pageOf(router.dispatch(prefixed, { request: request('/de/about'), params: { locale: 'de' } }, given(undefined)))).toBe('/:locale/about|de');
    expect(show(await router.dispatch(prefixed, { request: request('/en/about'), params: { locale: 'en' } }, given('en')))).toEqual([301, '/about']);
  });

  it('answers a path that starts with a locale with a 404, never with the page: the address is not that locale\'s', async () => {
    const router = bound('de', open((Route) => void Route.localized().get('/:slug', () => 'page')));
    const address = addressOf(router, '/:locale/:slug');
    for (const path of ['/en', '/EN', '/%65n', '/De']) await expect(send(router, address, path, { slug: path.slice(1) }), path).rejects.toMatchObject({ status: 404 });
    expect(await (await send(router, address, '/english', { slug: 'english' })).text()).toBe('page');
    // The variant of the other mode is held to the same rule once the mode is bound.
    const router2 = web(open((Route) => void Route.localized().get('/:slug', () => 'page')));
    const variant2 = router2.registrationOrder.find((route) => route.generatedFrom !== undefined)!;
    router2.bindUrlLocales(urlLocales('de'));
    await expect(send(router2, variant2, '/en', { slug: 'en' })).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a locale without a prefix that is none of the supported ones, spelled as given', async () => {
    for (const value of ['fr', 'DE', 'de-AT']) {
      const router = bound(value, open((Route) => void Route.localized().get('/about', () => 'a').name('about')));
      expect(() => router.unprefixedLocale, value).toThrow(`[${value}]`);
      expect(() => router.claimedBy('/about'), value).toThrow(`[${value}]`);
      expect(() => router.registrationOrder, value).toThrow(`[${value}]`);
      await expect(send(router, sourceOf(router, '/:locale/about'), '/de/about', { locale: 'de' }), value).rejects.toThrow(`[${value}]`);
      expect(() => urlFor(router, 'about', { locale: 'de' }), value).toThrow(`[${value}]`);
    }
    const router = web(about);
    await expect(router.dispatch(sourceOf(router, '/:locale/about'), { request: request('/de/about'), params: { locale: 'de' } }, { urlLocales: urlLocales('fr') })).rejects.toThrow('[fr]');
  });

  it('builds a page whose address without a prefix would start with a locale (a user named EN) with its prefix, without throwing', () => {
    const router = bound('de', open((Route) => void Route.localized().get('/:slug', () => 'p').name('page')));
    expect(router.url('page' as never, { locale: 'de', slug: 'EN' } as never)).toBe('/de/EN');
    expect(router.url('page' as never, { locale: 'de', slug: 'De' } as never)).toBe('/de/De');
    expect(router.url('page' as never, { locale: 'en', slug: 'en' } as never)).toBe('/en/en');
    expect(router.url('page' as never, { locale: 'de', slug: 'english' } as never)).toBe('/english');
  });
});
