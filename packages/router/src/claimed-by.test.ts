import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineRoutes, everyone, Router, type PathClaim, type RouteDefinitions } from './index.ts';
import { FRAMEWORK_ROUTES } from './internal.ts';
import { namesOtherLocale } from './router.ts';

const open = (register: (Route: Parameters<RouteDefinitions['register']>[0]) => void): RouteDefinitions => defineRoutes((Route) => register(Route.authorize(everyone)));
const web = (...files: RouteDefinitions[]) => new Router().load({ group: 'web' }, ...files);
const routeAt = (router: Router, path: string) => {
  const claim = router.claimedBy(path);
  return claim?.by === 'route' ? claim.route.path : claim;
};

describe('Router.claimedBy()', () => {
  it('names the route that answers a GET path, and nothing for a free one', () => {
    const router = web(open((Route) => void Route.get('/about', () => 'a')));
    expect(routeAt(router, '/about')).toBe('/about');
    expect(router.claimedBy('/free')).toBeUndefined();
    expect(router.claimedBy('/')).toBeUndefined();
  });

  it('counts the root route', () => {
    expect(web(open((Route) => void Route.get('/', () => 'home'))).claimedBy('/')).toMatchObject({ by: 'route' });
  });

  it('answers for a route with a parameter, by its constraint', () => {
    const router = web(open((Route) => void Route.get('/users/:id{[0-9]+}', () => 'u')));
    expect(router.claimedBy('/users/7')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/users/seven')).toBeUndefined();
    expect(router.claimedBy('/users')).toBeUndefined();
    expect(router.claimedBy('/users/7/x')).toBeUndefined();
  });

  it('answers for a rest route: its prefix and everything below', () => {
    const router = web(open((Route) => void Route.get('/files/:rest*', () => 'f')));
    expect(router.claimedBy('/files')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/files/a/b/c')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/other')).toBeUndefined();
  });

  it('matches the path as the server does: a segment with a reserved character stays one segment', () => {
    const router = web(open((Route) => void Route.get('/a/:x', () => 'a')));
    expect(router.claimedBy('/a/b?c')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/a/100%')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/a/é')).toMatchObject({ by: 'route' });
  });

  it('counts only routes that answer GET: a POST route and a HEAD-only route claim nothing', () => {
    const router = web(open((Route) => void Route.post('/submit', () => 's')), open((Route) => void Route.match(['HEAD'], '/probe', () => 'p')));
    expect(router.claimedBy('/submit')).toBeUndefined();
    expect(router.claimedBy('/probe')).toBeUndefined();
    expect(web(open((Route) => void Route.any('/both', () => 'b'))).claimedBy('/both')).toMatchObject({ by: 'route' });
  });

  it('reads a literal % as the server does: /100%25-off is the path of the slug 100%-off', () => {
    const router = web(open((Route) => void Route.get('/100%25-off', () => 'x')));
    expect(router.claimedBy('/100%-off')).toMatchObject({ by: 'route' });
    expect(router.claimedBy('/100-off')).toBeUndefined();
  });

  describe('the health check', () => {
    it('is the default /up and /up/ready until the server says otherwise', () => {
      const router = web();
      expect(router.claimedBy('/up')).toEqual({ by: 'framework', reason: 'health' });
      expect(router.claimedBy('/up/ready')).toEqual({ by: 'framework', reason: 'health' });
    });

    it('is where the server put it, and nowhere when it is off', () => {
      const router = web();
      router.bindServerPaths({ health: ['/healthz', '/healthz/ready'] });
      expect(router.claimedBy('/healthz')).toEqual({ by: 'framework', reason: 'health' });
      expect(router.claimedBy('/up')).toBeUndefined();
      router.bindServerPaths({ health: [] });
      expect(router.claimedBy('/healthz')).toBeUndefined();
    });
  });

  it('counts a route a package loads in a second load()', () => {
    const router = web(open((Route) => void Route.get('/first', () => '1')));
    expect(router.claimedBy('/second')).toBeUndefined();
    router.load({ group: 'web' }, open((Route) => void Route.get('/second', () => '2')));
    expect(router.claimedBy('/second')).toMatchObject({ by: 'route' });
  });

  it('never counts a fallback: it takes what nothing else takes', () => {
    const router = web(open((Route) => void Route.prefix('/help').fallback(() => 'f')), open((Route) => void Route.fallback(() => 'root')));
    expect(router.claimedBy('/help/anything')).toBeUndefined();
    expect(router.claimedBy('/anything')).toBeUndefined();
    expect(router.claimedBy('/help')).toBeUndefined();
  });

  describe('a localized route', () => {
    const about = open((Route) => void Route.localized().get('/about', () => 'about'));

    it('is answered per locale once the locales are bound, and by its address without a locale', () => {
      const router = web(about);
      router.bindServerPaths({ locales: ['de', 'en'], health: [] });
      expect(routeAt(router, '/de/about')).toBe('/:locale/about');
      expect(routeAt(router, '/en/about')).toBe('/:locale/about');
      expect(router.claimedBy('/fr/about')).toBeUndefined();
      expect(routeAt(router, '/about')).toBe('/:locale/about');
    });

    it('takes any first segment while no locales are bound: conservative', () => {
      expect(web(about).claimedBy('/fr/about')).toMatchObject({ by: 'route' });
    });

    it('skips a match only when it names a locale the app lacks: no locale in the match, or none bound, claims', () => {
      expect(namesOtherLocale({ locale: 'fr' }, ['de', 'en'])).toBe(true);
      expect(namesOtherLocale({ locale: 'de' }, ['de', 'en'])).toBe(false);
      expect(namesOtherLocale({}, ['de', 'en'])).toBe(false);
      expect(namesOtherLocale({ locale: 'fr' }, undefined)).toBe(false);
    });

    it('does not tie a route to a prefix: a locale-free address is claimed on its own', () => {
      const router = web(open((Route) => void Route.get('/legal', () => 'l')), about);
      router.bindServerPaths({ locales: ['de'], health: [] });
      expect(router.claimedBy('/legal')).toMatchObject({ by: 'route' });
    });
  });

  describe('the framework', () => {
    it('owns /_marmeon, in any case', () => {
      const router = web();
      expect(router.claimedBy('/_marmeon/x')).toEqual({ by: 'framework', reason: 'reserved' });
      expect(router.claimedBy('/_Marmeon')).toEqual({ by: 'framework', reason: 'reserved' });
    });

    it('owns /assets and what is below it', () => {
      const router = web();
      expect(router.claimedBy('/assets')).toEqual({ by: 'framework', reason: 'assets' });
      expect(router.claimedBy('/assets/a.js')).toEqual({ by: 'framework', reason: 'assets' });
      expect(router.claimedBy('/assetsx')).toBeUndefined();
    });

    it('owns /sitemap.xml and /robots.txt only when a route is marked with .sitemap()', () => {
      const without = web(open((Route) => void Route.get('/about', () => 'a')));
      expect(without.claimedBy('/sitemap.xml')).toBeUndefined();
      expect(without.claimedBy('/robots.txt')).toBeUndefined();
      const listed = web(open((Route) => void Route.get('/about', () => 'a').sitemap()));
      expect(listed.claimedBy('/sitemap.xml')).toEqual({ by: 'framework', reason: 'sitemap' });
      expect(listed.claimedBy('/robots.txt')).toEqual({ by: 'framework', reason: 'sitemap' });
    });

    it('says reserved before it looks at any route', () => {
      const router = new Router().load({ group: 'web', framework: FRAMEWORK_ROUTES }, defineRoutes((Route) => void Route.get('/_marmeon/x', () => 'x')));
      expect(router.claimedBy('/_marmeon/x')).toEqual({ by: 'framework', reason: 'reserved' });
    });
  });

  describe('a path no fallback would ever get', () => {
    // The router has a route that takes everything, so a wrong `undefined` would show as `route` and a missing check as
    // anything but `invalid`: each case has to be refused before any route is asked.
    const router = web(open((Route) => void Route.get('/:any*', () => 'x')));
    it.each([
      ['no leading slash', 'a'],
      ['empty', ''],
      ['a doubled slash', '/a//b'],
      ['a leading doubled slash', '//evil.com/x'],
      ['a trailing slash', '/a/'],
      ['a dot segment', '/./a'],
      ['a parent segment', '/..'],
      ['a parent segment inside', '/a/../b'],
      ['a backslash', '/a\\b'],
      ['a control character', '/a\u0000b'],
      ['a line break', '/a\r\nb'],
      ['a lone surrogate', '/a\ud800'],
    ])('%s is invalid', (_, path) => {
      expect(router.claimedBy(path)).toEqual({ by: 'invalid' });
    });

    it('is invalid before the framework is asked: a reserved or assets path that is not canonical', () => {
      expect(router.claimedBy('/_marmeon//x')).toEqual({ by: 'invalid' });
      expect(router.claimedBy('/assets/')).toEqual({ by: 'invalid' });
    });

    it('leaves the root valid', () => {
      expect(router.claimedBy('/')).toMatchObject({ by: 'route' });
    });
  });

  it('types its answer', () => {
    const router = web();
    expectTypeOf(router.claimedBy('/x')).toEqualTypeOf<PathClaim | undefined>();
    // @ts-expect-error a path is a string
    expect(router.claimedBy(1)).toEqual({ by: 'invalid' });
    // @ts-expect-error a path is a string
    expect(router.claimedBy(undefined)).toEqual({ by: 'invalid' });
  });
});
