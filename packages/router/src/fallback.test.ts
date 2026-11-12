import { describe, expect, it } from 'vitest';
import { defineRoutes, everyone, Router, type RouteDefinitions } from './index.ts';
import { RouteDefinition } from './route-definition.ts';

const web = (...files: RouteDefinitions[]) => new Router().load({ group: 'web' }, ...files);
const loadedTwice = (first: RouteDefinitions, second: RouteDefinitions) => () => new Router().load({ group: 'web' }, first).load({ group: 'web' }, second);
const open = (register: (Route: Parameters<RouteDefinitions['register']>[0]) => void): RouteDefinitions => defineRoutes((Route) => register(Route.authorize(everyone)));
const paths = (routes: readonly RouteDefinition[]) => routes.map((route) => route.path);

const fallbackAt = (prefix: string) => open((Route) => void Route.prefix(prefix).fallback(() => `fallback ${prefix}`));
const rest = (path: string) => open((Route) => void Route.get(path, () => 'rest'));

describe('Route.fallback()', () => {
  it('is a GET route at /:path* under the prefix, and a named one like any other', () => {
    const router = web(open((Route) => void Route.prefix('/help').name('help.').fallback(() => 'x').name('page')));
    const [route] = router.routes;
    expect([route!.methods, route!.path, route!.routeName]).toEqual([['GET'], '/help/:path*', 'help.page']);
    expect(router.isFallback(route!)).toBe(true);
  });

  it('keeps fallbacks out of registrationOrder and lists them with the longest prefix first', () => {
    const router = web(fallbackAt('/'), open((Route) => void Route.get('/notes', () => 'n')), fallbackAt('/help'), fallbackAt('/help/api'));
    expect(paths(router.registrationOrder)).toEqual(['/notes']);
    expect(paths(router.fallbacks)).toEqual(['/help/api/:path*', '/help/:path*', '/:path*']);
    expect(paths(router.routes)).toHaveLength(4);
  });

  it('gives the controller the rest of the path, and the empty string at the prefix', async () => {
    const router = web(open((Route) => void Route.prefix('/help').fallback((ctx) => `path=${ctx.params.path}`)));
    const [route] = router.fallbacks;
    const run = (url: string) => router.dispatch(route!, { request: new Request(`http://localhost${url}`), params: {} });
    expect(await (await run('/help')).text()).toBe('path=');
    expect(await (await run('/help/a/b')).text()).toBe('path=a/b');
    await expect(run('/help//x')).rejects.toMatchObject({ status: 404 });
  });

  it('is not made by a route that merely looks like one, nor by a definition built by hand', () => {
    const router = web(open((Route) => void Route.get('/:path*', () => 'x')));
    expect(router.isFallback(router.routes[0]!)).toBe(false);
    const byHand = new RouteDefinition({ methods: ['GET'], path: '/:path*', action: () => 'x', middleware: [], namePrefix: '' });
    expect(router.isFallback(byHand)).toBe(false);
    expect(Object.keys(router.routes[0]!)).not.toContain('fallback');
  });

  it('is an undecided route without authorize, like any other', () => {
    const router = web(defineRoutes((Route) => void Route.fallback(() => 'x')));
    expect(router.accessProblems().map((problem) => problem.kind)).toEqual(['undecided']);
  });

  it('is refused without a group: a package loading routes while booting would run it without the web group', () => {
    expect(() => new Router().load(fallbackAt('/'))).toThrow(/H15.*no group/s);
  });
});

describe('what a fallback refuses', () => {
  it('a second fallback for a prefix, naming both places', () => {
    expect(() => web(fallbackAt('/'), fallbackAt('/'))).toThrow(/H15.*Two fallbacks answer the root: .*fallback\.test\.ts.* and .*fallback\.test\.ts/s);
    expect(() => web(fallbackAt('/help'), open((Route) => void Route.prefix('/help').fallback(() => 'y')))).toThrow(/Two fallbacks answer \/help/);
  });

  it('a second fallback loaded by another load() call', () => {
    const router = new Router().load({ group: 'web' }, fallbackAt('/'));
    expect(() => router.load({ group: 'web' }, fallbackAt('/'))).toThrow(/H15.*Two fallbacks/s);
  });

  it('a prefix with a parameter', () => {
    expect(() => web(open((Route) => void Route.prefix('/:tenant').fallback(() => 'x')))).toThrow(/H15.*no parameter/s);
  });

  it.each(['/assets', '/assets/app'])('a prefix under the build\'s files (%s)', (prefix) => {
    expect(() => web(fallbackAt(prefix))).toThrow(/H15.*build's files/s);
    // Hono matches the case: `/Assets` is no path of the build.
    expect(() => web(fallbackAt('/Assets'))).not.toThrow();
    expect(() => web(fallbackAt('/assetsx'))).not.toThrow();
  });

  it('a prefix under the framework\'s paths', () => {
    expect(() => web(fallbackAt('/_marmeon'))).toThrow(/H15|belong to the framework/);
    expect(() => web(fallbackAt('/_marmeon/x'))).toThrow(/belong to the framework/);
  });

  it('a prefix with a parameter other than the locale, also under localized()', () => {
    expect(() => web(open((Route) => void Route.localized().prefix('/:tenant').fallback(() => 'x')))).toThrow(/H15.*no parameter besides the locale/s);
  });

  it('a group other than web', () => {
    expect(() => new Router().load({ group: 'api' }, fallbackAt('/'))).toThrow(/H15.*api group/s);
  });

  const cases: [string, string, string][] = [
    ['a route of the form of the fallback', '/help/:x*', '/help'],
    ['a rest route at the root', '/:x*', '/help'],
    ['a rest route in front of the prefix', '/help/:x*', '/help/api'],
    ['the root fallback and a rest route at the root', '/:x*', '/'],
  ];

  it.each(cases)('%s — in both orders of loading', (_name, plain, prefix) => {
    expect(() => web(rest(plain), fallbackAt(prefix))).toThrow(/H15.*never answer/s);
    expect(() => web(fallbackAt(prefix), rest(plain))).toThrow(/H15.*never answer/s);
    // Two separate loads, as two modules or a package's boot() make them: each order is checked when the later one arrives.
    expect(loadedTwice(rest(plain), fallbackAt(prefix))).toThrow(/H15.*never answer/s);
    expect(loadedTwice(fallbackAt(prefix), rest(plain))).toThrow(/H15.*never answer/s);
    expect(() => web(open((Route) => {
      Route.prefix(prefix).fallback(() => 'f');
      Route.get(plain, () => 'r');
    }))).toThrow(/H15/);
  });

  const greedy: [string, string, string][] = [
    ['a leftover wildcard parameter at the root', '/:page{.+}', '/'],
    ['a wildcard parameter under the prefix', '/help/:x{.+}', '/help'],
    ['a wildcard that may be empty', '/:page{.*}', '/help'],
    ['a group that takes anything', '/help/:x{(?:.*)}', '/help'],
    ['a class of anything', '/:x{[\\s\\S]+}', '/help'],
    ['an empty negated class', '/help/:x{[^]+}', '/help/support'],
    ['a spaced wildcard', '/:x{ .+ }', '/'],
    ['a parameter in front of the rest', '/:section/:rest*', '/help'],
    ['a parameter with a constraint the segment fits', '/:section{[a-z]+}/:rest*', '/help'],
    ['a wildcard that matches what remains of the prefix', '/help/:p{.+}', '/help/support'],
  ];

  it.each(greedy)('%s covers the fallback — in both orders of loading', (_name, plain, prefix) => {
    expect(loadedTwice(rest(plain), fallbackAt(prefix))).toThrow(/H15.*covers the fallback/s);
    expect(loadedTwice(fallbackAt(prefix), rest(plain))).toThrow(/H15.*covers the fallback/s);
  });

  it.each([
    ['a parameter whose constraint the segment does not fit', '/:section{[0-9]+}/:rest*', '/help'],
    ['another literal', '/blog/:x*', '/help'],
    ['a wildcard with a start the prefix does not have', '/help/:p{a/.*}', '/help/support'],
    ['a wildcard under a longer prefix than the fallback', '/help/support/:p{.+}', '/help'],
    ['a two-segment slug at the root', '/:slug{[a-z0-9-]+/[a-z0-9-]+}', '/'],
    ['a wildcard that starts with a letter, at the prefix', '/help/:p{a/.*}', '/help'],
    ['two segments of letters', '/docs/:p{[a-z]+/[a-z]+}', '/docs'],
    ['a choice with a slash', '/help/:p{(?:a|b)/.*}', '/help'],
    ['a class with a slash, which leaves dots and capitals out', '/help/:x{[a-z/]+}', '/help'],
    ['an escaped slash', '/help/:x{[a-z]+\\/[a-z]+}', '/help'],
    ['a repeated group ending in a slash', '/help/:x{(?:[a-z]+/)*[a-z]+}', '/help'],
    ['a class that leaves one character out, at the root', '/:page{[^!]+}', '/'],
    ['a class that leaves one character out, under a prefix', '/help/:page{[^!]+}', '/help'],
    ['a slot past the end of the prefix', '/help/:s/:r*', '/help'],
    ['a choice that matches the segment but nothing below it', '/help/:p{support|a/b}', '/help/support'],
  ])('finds none in %s — in both orders of loading', (_name, plain, prefix) => {
    expect(loadedTwice(rest(plain), fallbackAt(prefix))).not.toThrow();
    expect(loadedTwice(fallbackAt(prefix), rest(plain))).not.toThrow();
  });

  it('leaves a parameter that cannot take a slash, and a greedy route when there is no fallback', () => {
    expect(() => web(rest('/help/:x{[^/]+}'), fallbackAt('/help'))).not.toThrow();
    expect(() => web(rest('/help/:x{[a-z]+}'), fallbackAt('/help'))).not.toThrow();
    for (const constraint of ['\\d+', 'a|b', '[\\w.+-]+', '[a-z0-9.+-]+', '[.*]+', '\\.+', '[a-z]+\\.+[a-z]+', 'v\\d+\\.+']) {
      expect(() => web(rest(`/help/:x{${constraint}}`), fallbackAt('/help')), constraint).not.toThrow();
      expect(() => web(rest(`/:x{${constraint}}`), fallbackAt('/help')), constraint).not.toThrow();
    }
    expect(() => web(rest('/:page{.+}'))).not.toThrow();
  });

  const localizedRest = open((Route) => void Route.localized().prefix('/docs').get('/:page*', () => 'docs'));

  it('counts the address without a locale of a localized rest route: it redirects everything below its prefix — in both orders', () => {
    expect(loadedTwice(localizedRest, fallbackAt('/docs'))).toThrow(/H15.*the address without a locale of/s);
    expect(loadedTwice(fallbackAt('/docs'), localizedRest)).toThrow(/H15.*the address without a locale of/s);
    expect(() => web(localizedRest, fallbackAt('/other'))).not.toThrow();
  });

  it('says in other words that a route has the form of the fallback than that it covers it', () => {
    expect(() => web(rest('/help/:x*'), fallbackAt('/help'))).toThrow(/has the form of the fallback/);
    expect(() => web(rest('/:x*'), fallbackAt('/help'))).toThrow(/covers the fallback/);
  });

  it('nothing else: an exact path, a longer prefix, a parameter, other methods, the root of another fallback', () => {
    expect(() =>
      web(
        open((Route) => {
          Route.get('/help', () => 'a');
          Route.get('/help/contact', () => 'b');
          Route.get('/help/:topic', () => 'c');
          Route.get('/help/api/:x*', () => 'd');
          Route.post('/help/:x*', () => 'e');
          Route.get('/other/:x*', () => 'f');
        }),
        fallbackAt('/help'),
      ),
    ).not.toThrow();
    expect(() => web(fallbackAt('/'), fallbackAt('/help'), fallbackAt('/help/api'))).not.toThrow();
  });
});

const localizedAt = (prefix: string) => open((Route) => void Route.localized().prefix(prefix).fallback(() => `localized ${prefix}`));

describe('Route.localized().fallback()', () => {
  it('is one route at /:locale/:path*, and under a prefix after it', () => {
    const router = web(localizedAt('/'), localizedAt('/blog'));
    expect(paths(router.routes).sort()).toEqual(['/:locale/:path*', '/:locale/blog/:path*']);
    expect(router.routes.every((route) => route.localized && router.isFallback(route))).toBe(true);
  });

  it('gives the controller the locale and the path below the prefix', async () => {
    const router = web(open((Route) => void Route.localized().prefix('/blog').fallback((ctx) => `${ctx.params.locale}|${ctx.params.path}`)));
    const [route] = router.routes;
    const run = (url: string, locale = 'de') => router.dispatch(route!, { request: new Request(`http://localhost${url}`), params: { locale } });
    expect(await (await run('/de/blog')).text()).toBe('de|');
    expect(await (await run('/en/blog/a/b', 'en')).text()).toBe('en|a/b');
  });

  it('adds its address without a locale to the fallbacks, and keeps it out of registrationOrder', () => {
    const router = web(localizedAt('/'), open((Route) => void Route.localized().get('/about', () => 'a')), localizedAt('/blog'));
    expect(paths(router.registrationOrder)).toEqual(['/:locale/about', '/about']);
    expect(paths(router.fallbacks)).toEqual(['/:locale/blog/:path*', '/blog/:path*', '/:locale/:path*', '/:path*']);
    expect(router.fallbacks.filter((route) => route.generatedFrom).map((route) => route.generatedFrom!.path)).toEqual(['/:locale/blog/:path*', '/:locale/:path*']);
  });
});

describe('a localized fallback next to one without a locale', () => {
  it('refuses the same prefix, naming both places — in both orders of loading', () => {
    for (const prefix of ['/', '/blog']) {
      expect(() => web(localizedAt(prefix), fallbackAt(prefix))).toThrow(/H15.*Two fallbacks answer.*fallback\.test\.ts.* and .*fallback\.test\.ts.*under a locale also takes the address without one/s);
      expect(() => web(fallbackAt(prefix), localizedAt(prefix))).toThrow(/H15.*Two fallbacks answer.*under a locale also takes the address without one/s);
      // Two separate loads, as two modules or a package's boot() make them.
      expect(loadedTwice(localizedAt(prefix), fallbackAt(prefix))).toThrow(/H15.*Two fallbacks answer/s);
      expect(loadedTwice(fallbackAt(prefix), localizedAt(prefix))).toThrow(/H15.*Two fallbacks answer/s);
    }
  });

  it('refuses a second localized fallback for a prefix', () => {
    expect(loadedTwice(localizedAt('/blog'), localizedAt('/blog'))).toThrow(/H15.*Two fallbacks answer \/blog/s);
  });

  it('lets other prefixes coexist: a root fallback beside a localized /blog, and a localized root beside /legacy', () => {
    expect(loadedTwice(fallbackAt('/'), localizedAt('/blog'))).not.toThrow();
    expect(loadedTwice(localizedAt('/blog'), fallbackAt('/'))).not.toThrow();
    expect(loadedTwice(localizedAt('/'), fallbackAt('/legacy'))).not.toThrow();
    expect(loadedTwice(fallbackAt('/legacy'), localizedAt('/'))).not.toThrow();
  });

  it('sorts a localized root between the literal prefix and its own address without a locale', () => {
    const router = web(localizedAt('/'), fallbackAt('/legacy'));
    expect(paths(router.fallbacks)).toEqual(['/legacy/:path*', '/:locale/:path*', '/:path*']);
    expect(paths(web(fallbackAt('/legacy'), localizedAt('/')).fallbacks)).toEqual(['/legacy/:path*', '/:locale/:path*', '/:path*']);
  });

  it('refuses a localized prefix under the framework\'s paths: the address without a locale could never answer', () => {
    expect(() => web(localizedAt('/_marmeon'))).toThrow(/H15.*belongs to the framework/s);
    expect(() => web(localizedAt('/_MARMEON/x'))).toThrow(/H15.*belongs to the framework/s);
    expect(() => web(localizedAt('/_marmeonx'))).not.toThrow();
  });

  it('refuses a localized prefix under the build\'s files: the address without a locale would never answer', () => {
    expect(() => web(localizedAt('/assets'))).toThrow(/H15.*build's files/s);
  });
});

describe('what covers a localized fallback', () => {
  const localizedRest = (path: string) => open((Route) => void Route.localized().get(path, () => 'rest'));

  it.each([
    ['a localized rest route of the same form', '/blog/:x*', '/blog'],
    ['a localized rest route at the root', '/:x*', '/blog'],
    ['a localized rest route of the same form at the root', '/:x*', '/'],
  ])('%s — in both orders of loading, through its address without a locale', (_name, rest, prefix) => {
    expect(loadedTwice(localizedRest(rest), localizedAt(prefix))).toThrow(/H15.*the address without a locale of/s);
    expect(loadedTwice(localizedAt(prefix), localizedRest(rest))).toThrow(/H15.*the address without a locale of/s);
  });

  it('a route without a locale that takes the rest of the path under the locale', () => {
    expect(loadedTwice(rest('/:x*'), localizedAt('/blog'))).toThrow(/H15.*covers/s);
    expect(loadedTwice(localizedAt('/blog'), rest('/:x*'))).toThrow(/H15.*covers/s);
    expect(loadedTwice(rest('/:a/:b*'), localizedAt('/'))).toThrow(/H15.*(covers|has the form of)/s);
  });

  it('nothing else: localized routes of other paths, and the root of the app', () => {
    expect(() =>
      web(
        open((Route) => {
          Route.get('/', () => 'home');
          Route.get('/kontakt', () => 'k');
          Route.localized().get('/about', () => 'a');
          Route.localized().get('/blog/:slug', () => 'b');
          Route.localized().prefix('/docs').get('/:x*', () => 'd');
        }),
        localizedAt('/'),
        localizedAt('/blog'),
      ),
    ).not.toThrow();
  });
});
