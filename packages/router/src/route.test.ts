import { describe, expect, it } from 'vitest';
import { defineRoutes, everyone, Router } from './index.ts';

const loaded = (register: Parameters<typeof defineRoutes>[0]) => new Router().load(defineRoutes(register));

describe('Route.localized()', () => {
  it('puts the routes of the registrar under /:locale', () => {
    const router = loaded((Route) => {
      const pages = Route.localized().authorize(everyone);
      pages.get('/', () => 'home').name('home');
      pages.prefix('/about').get('/team', () => 'team').name('about.team');
    });
    expect(router.routes.map((route) => [route.path, route.localized])).toEqual([
      ['/:locale', true],
      ['/:locale/about/team', true],
    ]);
  });

  it('leaves other routes alone', () => {
    const router = loaded((Route) => {
      Route.authorize(everyone).get('/impressum', () => 'legal');
    });
    expect(router.routes.map((route) => route.localized)).toEqual([false]);
  });

  it('throws after prefix(): the locale is the first segment of the path', () => {
    expect(() => loaded((Route) => void Route.prefix('/blog').localized())).toThrow(TypeError);
    expect(() => loaded((Route) => void Route.prefix('/blog').localized())).toThrow('call localized() first: the locale is the first segment of the path');
  });

  it('throws when called twice', () => {
    expect(() => loaded((Route) => void Route.localized().localized())).toThrow(TypeError);
  });

  it('throws under a prefix of load()', () => {
    expect(() => new Router().load({ prefix: '/api' }, defineRoutes((Route) => void Route.localized()))).toThrow('call localized() first');
  });

  it('makes a route without its locale for each localized GET route, outside of routes', () => {
    const router = loaded((Route) => {
      const pages = Route.localized().authorize(everyone);
      pages.get('/', () => 'home');
      pages.get('/about', () => 'about');
      pages.post('/contact', () => 'sent');
    });
    expect(router.routes.map((route) => route.path)).toEqual(['/:locale', '/:locale/about', '/:locale/contact']);
    const order = router.registrationOrder;
    expect(order.map((route) => `${route.methods.join('|')} ${route.path}`)).toEqual([
      'GET /:locale',
      'GET /:locale/about',
      'POST /:locale/contact',
      'GET /',
      'GET /about',
    ]);
    const variant = order[4]!;
    expect(variant.generatedFrom).toBe(order[1]);
    expect(variant.routeName).toBeUndefined();
    expect(variant.bindings).toEqual([]);
    expect(variant.checks).toEqual([]);
  });

  it('does not ask the route without its locale who may call it', () => {
    expect(loaded((Route) => void Route.localized().authorize(everyone).get('/about', () => 'about')).accessProblems()).toEqual([]);
  });
});
