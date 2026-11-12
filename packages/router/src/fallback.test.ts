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

  it('a localized fallback, without promising anything', () => {
    expect(() => web(open((Route) => void Route.localized().fallback(() => 'x')))).toThrow(/H15.*cannot be localized/s);
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
