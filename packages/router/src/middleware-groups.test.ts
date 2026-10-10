import { describe, expect, it } from 'vitest';
import { HttpError } from './errors.ts';
import { defineMiddleware } from './middleware.ts';
import { GLOBAL, MiddlewareGroups, MiddlewarePriority } from './middleware-groups.ts';
import { defineRoutes, Router } from './router.ts';
import type { HttpContext, Next } from './types.ts';

/** A middleware that records its name, so tests can see the order. */
const tracer = (name: string, log: string[]) =>
  defineMiddleware(name, async (_ctx, next) => {
    log.push(name);
    return next();
  });

describe('MiddlewareGroups', () => {
  it('orders by priority, then by registration — whatever order packages boot in', () => {
    const log: string[] = [];
    const [session, cookies, app1, app2] = ['session', 'cookies', 'app1', 'app2'].map((name) => tracer(name, log));
    const groups = new MiddlewareGroups()
      .append('web', app1!)
      .append('web', session!, MiddlewarePriority.startSession)
      .append('web', app2!)
      .append('web', cookies!, MiddlewarePriority.encryptCookies);

    expect(groups.get('web').map((m) => m.name)).toEqual(['cookies', 'session', 'app1', 'app2']);
    expect(groups.remove('web', session!).get('web').map((m) => m.name)).toEqual(['cookies', 'app1', 'app2']);
    expect(groups.get('api')).toEqual([]);
  });
});

describe('Router — groups, global middleware, terminate', () => {
  function setup() {
    const log: string[] = [];
    const router = new Router();
    const group = tracer('group', log);
    router.middleware.append(GLOBAL, tracer('global', log)).append('web', group);
    router.load(
      { group: 'web' },
      defineRoutes((Route) => {
        Route.middleware(tracer('own', log)).get('/page', () => 'page').name('page');
        Route.middleware(group).get('/twice', () => 'twice');
      }),
    );
    router.load({ group: 'api', prefix: '/api' }, defineRoutes((Route) => Route.get('/items', () => []).name('items')));
    return { router, log };
  }
  const request = (path: string) => ({ request: new Request(`http://app.test${path}`), params: {} });

  it('works the list out once per route — and again after a group changed, also after requests ran', async () => {
    const { router, log } = setup();
    const page = router.findByName('page')!;
    expect(router.middlewareFor(page)).toBe(router.middlewareFor(page)); // the same list, not sorted again per request
    expect(Object.isFrozen(router.middlewareFor(page))).toBe(true);
    await router.dispatch(page, request('/page'));
    router.middleware.append('web', tracer('late', log), MiddlewarePriority.startSession);
    log.length = 0;
    await router.dispatch(page, request('/page'));
    expect(log).toEqual(['global', 'late', 'group', 'own']);
    router.middleware.remove(GLOBAL, router.middleware.get(GLOBAL)[0]!);
    log.length = 0;
    await router.dispatch(page, request('/page'));
    expect(log).toEqual(['late', 'group', 'own']);
  });

  it('runs global → group → route middleware, and a middleware listed twice only once', async () => {
    const { router, log } = setup();
    await router.dispatch(router.findByName('page')!, request('/page'));
    expect(log).toEqual(['global', 'group', 'own']);

    log.length = 0;
    await router.dispatch(router.routes.find((route) => route.path === '/twice')!, request('/twice'));
    expect(log).toEqual(['global', 'group']);
  });

  it('prefixes and groups loaded routes', () => {
    const { router } = setup();
    const items = router.findByName('items')!;
    expect([items.path, items.group]).toEqual(['/api/items', 'api']);
    expect(router.middlewareFor(items).map((m) => m.name)).toEqual(['global']);
  });

  it('runs global middleware for unmatched requests, then answers 404', async () => {
    const { router, log } = setup();
    await expect(router.dispatchNotFound(new Request('http://app.test/nope'))).rejects.toBeInstanceOf(HttpError);
    expect(log).toEqual(['global']);
  });

  it('refuses a route name used twice, naming both routes', () => {
    const router = new Router().load(defineRoutes((Route) => Route.get('/a', () => 'a').name('home')));
    expect(() => router.load(defineRoutes((Route) => Route.get('/b', () => 'b').name('home')))).toThrow(
      'Route name [home] is used twice: GET /a and GET /b.',
    );
  });

  it('collects middleware with a terminate hook, with the context each one saw', async () => {
    const terminated: string[] = [];
    class Metrics {
      handle(ctx: HttpContext, next: Next<{ startedAt: number }>) {
        return next({ startedAt: 1 });
      }
      terminate(ctx: HttpContext, response: Response) {
        terminated.push(`${ctx.request.url} → ${response.status}`);
      }
    }
    const router = new Router().load(defineRoutes((Route) => Route.middleware(Metrics).get('/m', () => 'ok')));
    const collected: [{ terminate?: (ctx: HttpContext, response: Response) => unknown }, HttpContext][] = [];
    const response = await router.dispatch(router.routes[0]!, request('/m'), {
      onTerminable: (handler, ctx) => collected.push([handler, ctx]),
    });

    expect(collected).toHaveLength(1);
    await collected[0]![0].terminate!(collected[0]![1], response);
    expect(terminated).toEqual(['http://app.test/m → 200']);
  });
});
