import { describe, expect, it } from 'vitest';
import { defineMiddleware, defineRoutes, everyone, Router, type SitemapEntries } from './index.ts';

const load = (register: Parameters<typeof defineRoutes>[0], options: { group?: string } = {}) => new Router().load(options, defineRoutes((Route) => register(Route.authorize(everyone))));

class PostController {
  handle() {
    return 'post';
  }
  sitemap(): SitemapEntries<{ slug: string }> {
    return [{ params: { slug: 'a' } }];
  }
}

class PlainController {
  handle() {
    return 'plain';
  }
}

describe('.sitemap()', () => {
  it('marks a route, and a route is not marked until then', () => {
    const router = load((Route) => {
      Route.get('/about', () => 'about').sitemap();
      Route.get('/contact', () => 'contact');
    });
    expect(router.routes.map((route) => route.inSitemap)).toEqual([true, false]);
  });

  it('cannot change a route that was loaded', () => {
    const router = load((Route) => void Route.get('/about', () => 'about'));
    expect(() => router.routes[0]!.sitemap()).toThrow(TypeError);
  });

  it('takes a route with parameters whose controller has sitemap()', () => {
    expect(() => load((Route) => void Route.get('/posts/:slug', PostController).sitemap())).not.toThrow();
  });

  it('refuses a method that is not GET, naming the route', () => {
    expect(() => load((Route) => void Route.post('/contact', () => 'sent').sitemap())).toThrow(TypeError);
    expect(() => load((Route) => void Route.post('/contact', () => 'sent').sitemap())).toThrow('POST /contact');
    expect(() => load((Route) => void Route.match(['GET', 'POST'], '/contact', () => 'x').sitemap())).toThrow('GET pages only');
  });

  it('refuses an internal() route, also through its registrar', () => {
    expect(() => load((Route) => void Route.get('/mail/verify', () => 'x').internal().sitemap())).toThrow('internal()');
    expect(() => load((Route) => void Route.internal().get('/mail/verify', () => 'x').sitemap())).toThrow('internal()');
  });

  it('refuses a route of the api group', () => {
    expect(() => load((Route) => void Route.get('/status', () => 'x').sitemap(), { group: 'api' })).toThrow('an API route');
  });

  it('refuses a route behind a middleware that adds the user', () => {
    const authenticate = defineMiddleware<{ user: { id: number } }>('authenticate', (_ctx, next) => next({ user: { id: 1 } }), { adds: ['user'] });
    expect(() => load((Route) => void Route.middleware(authenticate).get('/account', () => 'x').sitemap())).toThrow('a sitemap lists pages anyone can open');
    // A middleware that adds nothing of the kind is no obstacle.
    const logged = defineMiddleware('logged', (_ctx, next) => next());
    expect(() => load((Route) => void Route.middleware(logged).get('/account', () => 'x').sitemap())).not.toThrow();
  });

  it('refuses a path with parameters whose controller has no sitemap(), and a closure', () => {
    expect(() => load((Route) => void Route.get('/posts/:slug', PlainController).sitemap())).toThrow('needs a sitemap() method');
    expect(() => load((Route) => void Route.get('/posts/:slug', () => 'x').sitemap())).toThrow('a closure cannot');
    expect(() => load((Route) => void Route.get('/posts/:slug?', PlainController).sitemap())).toThrow('needs a sitemap() method');
  });

  it('refuses a route that asks who may call it, or says nothing', () => {
    const asks = () => false;
    expect(() => new Router().load(defineRoutes((Route) => void Route.authorize(asks).get('/admin', () => 'x').sitemap()))).toThrow('asks who may call it');
    expect(() => new Router().load(defineRoutes((Route) => void Route.authorize(everyone).authorize(asks).get('/admin', () => 'x').sitemap()))).toThrow('asks who may call it');
    expect(() => new Router().load(defineRoutes((Route) => void Route.get('/open', () => 'x').sitemap()))).toThrow('asks who may call it');
  });

  it('accepts a localized route, whose `/:locale` is no parameter of its controller', () => {
    expect(() => load((Route) => void Route.localized().get('/about', () => 'x').sitemap())).not.toThrow();
    expect(() => load((Route) => void Route.localized().get('/posts/:slug', () => 'x').sitemap())).toThrow('sitemap() method');
  });

  it('masks a secret segment in the path of the message', () => {
    // Joined at run time: a token-shaped literal in the source would trip secret scanners.
    const secret = ['whsec', '0123456789abcdef0123456789abcdef'].join('_');
    expect(() => load((Route) => void Route.post(`/webhooks/stripe/${secret}`, () => 'x').sitemap())).toThrow('POST /webhooks/stripe/[redacted]');
  });
});
