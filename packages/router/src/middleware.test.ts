import { errorCodeOf } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { defineMiddleware, defineRoutes, everyone, RESERVED_CONTEXT_KEYS, Router, type EmptyObject, type HttpContext } from './index.ts';
import { runPipeline } from './middleware.ts';
import { describeMiddlewareProblem } from './router.ts';

const context = { request: new Request('http://localhost/') } as unknown as HttpContext;
const errorResponse = (error: unknown) => new Response((error as Error).message, { status: 500 });
const ok = async () => new Response('ok');

function run(middleware: Parameters<typeof runPipeline<HttpContext>>[1], destination: (ctx: HttpContext) => Promise<Response> = ok) {
  return runPipeline(context, middleware, destination, { onError: errorResponse });
}

describe('next(extension)', () => {
  it.each(['params', 'request', 'route', 'query', 'cookies', 'ip', 'body', 'pageQuery'])(
    'refuses the reserved key %s with a 500 and never reaches the handler',
    async (key) => {
      let reached = false;
      const greedy = defineMiddleware('greedy', (_ctx, next) => next({ [key]: 'x' } as EmptyObject));

      const response = await run([greedy], async () => {
        reached = true;
        return new Response('ok');
      });

      expect(response.status).toBe(500);
      const message = await response.text();
      expect(message).toContain('Middleware "greedy"');
      expect(message).toContain(`"${key}"`);
      expect(message).toContain('belongs to the framework');
      expect(message).toContain('extends the context with new keys');
      expect(message).toContain('never replaces one');
      expect(errorCodeOf(new Error(message))).toBe('H8');
      expect(reached).toBe(false);
    },
  );

  it('refuses a key an earlier middleware set, so nothing replaces the user of authenticate()', async () => {
    const authenticate = defineMiddleware('authenticate', (_ctx, next) => next({ user: { id: 'ada' } }));
    const swap = defineMiddleware('swap', (_ctx, next) => next({ user: { id: 'mallory' } }));
    let reached = false;

    const response = await run([authenticate, swap], async () => {
      reached = true;
      return new Response('ok');
    });

    expect(response.status).toBe(500);
    const message = await response.text();
    expect(message).toContain('Middleware "swap" cannot set "user"');
    expect(message).toContain('set it already');
    expect(reached).toBe(false);
  });

  it('lets middleware add new keys, one after another', async () => {
    let seen: unknown;
    const user = defineMiddleware('user', (_ctx, next) => next({ user: 'ada' }));
    const team = defineMiddleware('team', (_ctx, next) => next({ team: 'core', token: 't' }));

    const response = await runPipeline(context, [user, team], async (ctx) => {
      seen = ctx;
      return new Response('ok');
    });

    expect(response.status).toBe(200);
    expect(seen).toMatchObject({ user: 'ada', team: 'core', token: 't' });
  });

  it('allows symbol keys, but not over a symbol the context has', async () => {
    const mark = Symbol('mark');
    const first = defineMiddleware('first', (_ctx, next) => next({ [mark]: 1 }));
    const second = defineMiddleware('second', (_ctx, next) => next({ [mark]: 2 }));

    expect((await run([first])).status).toBe(200);
    const response = await run([first, second]);
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('Middleware "second" cannot set Symbol(mark)');
  });

  it.each(['__proto__', 'then', 'toJSON', 'constructor', 'hasOwnProperty'])('refuses %s, a name with a meaning of its own on every object', async (key) => {
    const extension = JSON.parse(`{"${key}":"x","team":"core"}`) as EmptyObject;
    const add = defineMiddleware('add', (_ctx, next) => next(extension));

    const response = await run([add]);

    expect(response.status).toBe(500);
    expect(await response.text()).toContain(`cannot set "${key}"`);
  });

  it('merges the keys it checked: a Proxy that shows `user` from the second look on adds nothing', async () => {
    const mallory = { id: 'mallory' };
    const calls = { count: 0 };
    const target: Record<string, unknown> = { team: 'core' };
    const sneaky = new Proxy(target, {
      ownKeys(inner) {
        calls.count++;
        return calls.count === 1 ? Reflect.ownKeys(inner) : [...Reflect.ownKeys(inner), 'user'];
      },
      getOwnPropertyDescriptor(inner, key) {
        if (key === 'user' && calls.count > 1) return { value: mallory, enumerable: true, configurable: true, writable: true };
        return Reflect.getOwnPropertyDescriptor(inner, key);
      },
      get(inner, key) {
        return key === 'user' && calls.count > 1 ? mallory : Reflect.get(inner, key);
      },
    });
    const authenticate = defineMiddleware('authenticate', (_ctx, next) => next({ user: { id: 'ada' } }));
    const add = defineMiddleware('add', (_ctx, next) => next(sneaky as EmptyObject));
    let seen: { user?: { id: string }; team?: string } | undefined;

    const response = await run([authenticate, add], async (ctx) => {
      seen = ctx as typeof seen;
      return new Response('ok');
    });

    expect(response.status).toBe(200);
    expect(seen?.user?.id).toBe('ada');
    expect(seen?.team).toBe('core');
  });

  it('hands the context on frozen: an assignment throws, next({…}) is the way', async () => {
    let assigned: unknown;
    const user = defineMiddleware('user', (_ctx, next) => next({ user: 'ada' }));
    const swap = defineMiddleware('swap', (ctx, next) => {
      try {
        (ctx as unknown as { user: string }).user = 'mallory';
      } catch (error) {
        assigned = error;
      }
      return next();
    });
    let seen: { user?: string } | undefined;

    await runPipeline(context, [user, swap], async (ctx) => {
      seen = ctx as typeof seen;
      return new Response('ok');
    });

    expect(assigned).toBeInstanceOf(TypeError);
    expect(seen?.user).toBe('ada');
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it('may call next() again after a refusal, because the refused call did not count', async () => {
    const retry = defineMiddleware('retry', async (_ctx, next) => {
      await next({ params: {} } as EmptyObject).catch(() => undefined);
      return next({ team: 'core' });
    });

    expect((await run([retry])).status).toBe(200);
  });
});

describe('the reserved keys of the context', () => {
  it('stay locked when the exported set is changed', async () => {
    const copy = RESERVED_CONTEXT_KEYS as Set<string>;
    copy.delete('params');
    try {
      const greedy = defineMiddleware('greedy', (_ctx, next) => next({ params: {} } as EmptyObject));
      const response = await run([greedy]);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain('belongs to the framework');
    } finally {
      copy.add('params');
    }
  });

  it('are the keys of a dispatched context plus the two the router and validation add', async () => {
    const router = new Router().load(
      defineRoutes((Route) =>
        Route.authorize(everyone)
          .get('/', (ctx) => Object.keys(ctx).sort().join(','))
          .name('keys'),
      ),
    );
    const response = await router.dispatch(router.findByName('keys')!, { request: new Request('http://localhost/'), params: {} });
    const keys = (await response.text()).split(',');

    for (const key of keys) expect(RESERVED_CONTEXT_KEYS.has(key), key).toBe(true);
    expect([...RESERVED_CONTEXT_KEYS].sort()).toEqual([...new Set([...keys, 'body', 'pageQuery'])].sort());
  });
});

describe('the context a route receives', () => {
  const request = () => new Request('http://localhost/');

  it('is frozen, with params a frozen copy of the input', async () => {
    const params = { id: '7' };
    let seen: HttpContext | undefined;
    const router = new Router().load(
      defineRoutes((Route) =>
        Route.authorize(everyone)
          .get('/:id', (ctx) => {
            seen = ctx as unknown as HttpContext;
            return 'ok';
          })
          .name('show'),
      ),
    );

    await router.dispatch(router.findByName('show')!, { request: request(), params });

    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen!.params)).toBe(true);
    expect(seen!.params).not.toBe(params);
    expect(() => {
      (seen as unknown as { params: unknown }).params = {};
    }).toThrow(TypeError);
  });
});

describe('middleware that declare the same key', () => {
  const authenticate = () => defineMiddleware('authenticate', (_ctx, next) => next({ user: 1 }), { adds: ['user'] });
  const Guard = class {
    static adds = ['user'] as const;
    handle(_ctx: HttpContext, next: (extension: { user: number }) => Promise<Response>) {
      return next({ user: 2 });
    }
  };

  it('is a problem of the route, naming the key and both layers, before any request', () => {
    const router = new Router().load(defineRoutes((Route) => Route.authorize(everyone).middleware(authenticate()).middleware(authenticate()).get('/', () => 'ok')));

    const [problem] = router.middlewareProblems();

    expect(router.middlewareProblems()).toHaveLength(1);
    expect(problem).toMatchObject({ key: 'user' });
    expect(describeMiddlewareProblem(problem!)).toMatch(/GET \/: "authenticate" and "authenticate" both add "user"/);
  });

  it('finds a class and an object, and a group’s layer against a route’s', () => {
    const router = new Router();
    router.middleware.append('web', authenticate());
    router.load({ group: 'web' }, defineRoutes((Route) => Route.authorize(everyone).middleware(Guard as never).get('/', () => 'ok')));

    expect(router.middlewareProblems().map((problem) => problem.key)).toEqual(['user']);
  });

  it('is no problem when the same layer is listed twice, or the keys differ', () => {
    const once = authenticate();
    const team = defineMiddleware('team', (_ctx, next) => next({ team: 1 }), { adds: ['team'] });
    const router = new Router().load(defineRoutes((Route) => Route.authorize(everyone).middleware(once).middleware(once).middleware(team).get('/', () => 'ok')));

    expect(router.middlewareProblems()).toEqual([]);
  });
});
