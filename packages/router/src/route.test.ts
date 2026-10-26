import { describe, expect, it } from 'vitest';
import { defineMiddleware, defineRoutes, everyone, MiddlewareGroups, Router } from './index.ts';
import { runPipeline } from './middleware.ts';

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

describe('Route.middleware() and Route.authorize() arity', () => {
  const first = defineMiddleware('first', (_ctx, next) => next());
  const second = defineMiddleware('second', (_ctx, next) => next());
  // Untyped callers get past the signature; a dropped argument would leave the route without that check.
  const middleware = (Route: object, ...args: unknown[]) => (Route as { middleware: (...a: unknown[]) => unknown }).middleware(...args);
  const authorize = (Route: object, ...args: unknown[]) => (Route as { authorize: (...a: unknown[]) => unknown }).authorize(...args);

  it('throws when middleware() gets more than one argument and names the chained form', () => {
    loaded((Route) => {
      expect(() => middleware(Route, first, second)).toThrow(TypeError);
      expect(() => middleware(Route, first, second)).toThrow('Route.middleware(a).middleware(b)');
    });
  });

  it('throws when authorize() gets more than one argument', () => {
    loaded((Route) => {
      expect(() => authorize(Route, everyone, everyone)).toThrow(TypeError);
      expect(() => authorize(Route, everyone, everyone)).toThrow('Route.authorize(a).authorize(b)');
    });
  });

  it('accepts one middleware, chained', () => {
    const router = loaded((Route) => {
      Route.middleware(first).middleware(second).authorize(everyone).get('/x', () => 'x');
    });
    expect(router.routes[0]?.middleware).toHaveLength(2);
  });

  it('throws for an entry that is not a middleware, so a condition cannot leave a hole', () => {
    loaded((Route) => {
      expect(() => middleware(Route, undefined)).toThrow(TypeError);
      expect(() => middleware(Route, undefined)).toThrow('takes a middleware');
      expect(() => middleware(Route, { name: 'x' })).toThrow(TypeError);
    });
  });
});

describe('MiddlewareGroups.append() and runPipeline() holes', () => {
  it('refuses a second middleware passed as the priority', () => {
    const groups = new MiddlewareGroups();
    const first = defineMiddleware('first', (_ctx, next) => next());
    const append = groups.append.bind(groups) as (...args: unknown[]) => unknown;
    expect(() => append('web', first, first)).toThrow(TypeError);
    expect(() => append('web', first, Number.NaN)).toThrow('finite number');
  });

  it('refuses an undefined entry in a group', () => {
    const append = new MiddlewareGroups().append.bind(new MiddlewareGroups()) as (...args: unknown[]) => unknown;
    expect(() => append('web', undefined)).toThrow('takes a middleware');
  });

  it('rejects a hole in the pipeline instead of skipping the layers after it', async () => {
    let reached = false;
    const later = defineMiddleware('later', (_ctx, next) => {
      reached = true;
      return next();
    });
    const list = [undefined, later] as unknown as Parameters<typeof runPipeline>[1];
    await expect(runPipeline({}, list, async () => new Response('ok'))).rejects.toThrow(TypeError);
    expect(reached).toBe(false);
  });
});
