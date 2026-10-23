import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { defineMiddleware, defineRequest, GLOBAL, Router, type EmptyObject, type HttpContext, type ResponseContext } from './index.ts';
import { runPipeline } from './middleware.ts';
import { checkedRoutes, openRoutes } from './test-helpers/open-routes.ts';

const request = (path = '/', init?: RequestInit) => new Request(`http://localhost${path}`, init);

/** What `run` throws, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Assigns to the object and returns what that threw. */
const writeTo = (target: object, key = 'planted') => thrownBy(() => ((target as Record<string, unknown>)[key] = 'x'));

describe('the context is frozen at every step', () => {
  it('after a binding: the context and the bound params', async () => {
    class Teams {
      resolveRouteBinding(value: string) {
        return { id: value };
      }
    }
    let seen: HttpContext<{}, { team: { id: string } }> | undefined;
    const router = new Router().load(
      checkedRoutes((Route) =>
        Route.bind('team', Teams)
          .get('/teams/:team', (ctx) => {
            seen = ctx as never;
            return 'ok';
          })
          .name('team'),
      ),
    );

    await router.dispatch(router.findByName('team')!, { request: request('/teams/7'), params: { team: '7' } });

    expect(seen!.params.team).toEqual({ id: '7' });
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen!.params)).toBe(true);
    expect(writeTo(seen!)).toBeInstanceOf(TypeError);
    expect(writeTo(seen!.params)).toBeInstanceOf(TypeError);
  });

  it('for a controller with a request definition: handle() gets a frozen context with body and query', async () => {
    let seen: object | undefined;
    class StoreController {
      static request = defineRequest({ schema: v.object({ title: v.string() }), query: v.object({ page: v.optional(v.string(), '1') }) });
      handle(ctx: object) {
        seen = ctx;
        return 'ok';
      }
    }
    const router = new Router().load(openRoutes((Route) => Route.post('/notes', StoreController as never).name('store')));

    await router.dispatch(router.findByName('store')!, {
      request: request('/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'a' }) }),
      params: {},
    });

    expect(seen).toMatchObject({ body: { title: 'a' } });
    expect(Object.isFrozen(seen)).toBe(true);
    expect(writeTo(seen!)).toBeInstanceOf(TypeError);
  });

  it('for the response factory, with the page query', async () => {
    class ListController {
      static request = defineRequest({ query: v.object({ page: v.optional(v.pipe(v.string(), v.toNumber()), '1') }) });
      handle() {
        return 'ok';
      }
    }
    const router = new Router().load(openRoutes((Route) => Route.get('/notes', ListController as never).name('list')));
    let seen: ResponseContext | undefined;

    await router.dispatch(
      router.findByName('list')!,
      { request: request('/notes?page=2'), params: {} },
      {
        toResponse: (_result, ctx) => {
          seen = ctx;
          return new Response('ok');
        },
      },
    );

    expect(seen?.pageQuery).toBeDefined();
    expect(Object.isFrozen(seen)).toBe(true);
    expect(writeTo(seen!)).toBeInstanceOf(TypeError);
  });

  it('in the global middleware of a request that matches no route', async () => {
    let thrown: unknown;
    const router = new Router();
    router.middleware.append(
      GLOBAL,
      defineMiddleware<EmptyObject>('writer', (ctx, next) => {
        thrown = writeTo(ctx);
        return next();
      }),
    );

    await router.dispatchNotFound(request('/nope'), { onError: () => new Response('missing', { status: 404 }) });

    expect(thrown).toBeInstanceOf(TypeError);
  });

  it('runPipeline freezes a context it is handed unfrozen', async () => {
    let seen: object | undefined;
    const plain = { request: request() };

    await runPipeline(plain, [], async (ctx) => {
      seen = ctx;
      return new Response('ok');
    });

    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(plain)).toBe(false);
  });
});

describe('a route cannot be changed once it is loaded', () => {
  it('answers a middleware that writes to ctx.route with a TypeError, and the next request normally', async () => {
    const attempts: unknown[] = [];
    const tamper = defineMiddleware('tamper', (ctx, next) => {
      const route = ctx.route as unknown as { action: unknown; middleware: unknown[]; methods: string[] };
      attempts.push(writeTo(route, 'action'));
      attempts.push(thrownBy(() => route.middleware.splice(0)));
      attempts.push(thrownBy(() => route.methods.push('DELETE')));
      return next();
    });
    const router = new Router().load(openRoutes((Route) => Route.middleware(tamper).get('/', () => 'real').name('home')));
    const route = router.findByName('home')!;

    const first = await router.dispatch(route, { request: request(), params: {} });
    const second = await router.dispatch(route, { request: request(), params: {} });

    expect(attempts).toHaveLength(6);
    for (const attempt of attempts) expect(attempt).toBeInstanceOf(TypeError);
    expect(await first.text()).toBe('real');
    expect(await second.text()).toBe('real');
    expect(route.methods).toEqual(['GET']);
    expect(route.middleware).toHaveLength(1);
  });

  it('refuses name(), internal() and block() after loading', () => {
    const router = new Router().load(openRoutes((Route) => Route.get('/', () => 'ok').name('home')));
    const route = router.findByName('home')!;

    expect(() => route.name('other')).toThrow(TypeError);
    expect(() => route.internal()).toThrow(TypeError);
    expect(() => route.block()).toThrow(TypeError);
    expect(route.routeName).toBe('home');
  });
});
