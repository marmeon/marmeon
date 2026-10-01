import { describe, expect, it } from 'vitest';
import { defineMiddleware, defineRoutes, Router, type EmptyObject, type HttpContext, type Next } from './index.ts';

interface User {
  id: string;
  isAdmin: boolean;
}

const authenticate = defineMiddleware<{ user: User }>('auth', (ctx, next) => {
  const id = ctx.request.headers.get('x-demo-user');
  return id ? next({ user: { id, isAdmin: id === '1' } }) : new Response('Unauthorized', { status: 401 });
});

const requireAdmin = defineMiddleware<EmptyObject, { user: User }>('admin', (ctx, next) =>
  ctx.user.isAdmin ? next() : new Response('Forbidden', { status: 403 }),
);

class ClassAuthenticate {
  handle(ctx: HttpContext, next: Next<{ user: User }>) {
    const id = ctx.request.headers.get('x-demo-user');
    return id ? next({ user: { id, isAdmin: id === '1' } }) : new Response('Unauthorized', { status: 401 });
  }
}

class RequireAdminClass {
  handle(ctx: HttpContext<{ user: User }>, next: Next<EmptyObject>) {
    return ctx.user.isAdmin ? next() : new Response('Forbidden', { status: 403 });
  }
}

class ShowTeamMemberController {
  handle(ctx: HttpContext<{ user: User }, { team: string; id: string }>) {
    return { team: ctx.params.team, member: ctx.params.id, viewer: ctx.user.id };
  }
}

class PingController {
  handle() {
    return 'pong';
  }
}

function request(userId?: string): Request {
  return new Request('http://localhost/', { headers: userId ? { 'x-demo-user': userId } : {} });
}

const routes = defineRoutes((Route) => {
  Route.get('/', () => 'home').name('home');
  Route.get('/ping', PingController).name('ping');

  Route.prefix('/teams/:team')
    .middleware(authenticate)
    .name('teams.')
    .group((Route) => {
      Route.get('/members/:id', ShowTeamMemberController).name('members.show');

      Route.middleware(requireAdmin).group((Route) => {
        Route.delete('/', (ctx) => `deleted ${ctx.params.team} by ${ctx.user.id}`).name('destroy');
      });
    });
});

describe('Route registration', () => {
  const router = new Router().load(routes);

  it('applies group prefixes, name prefixes and middleware', () => {
    expect(router.routes.map((r) => [r.methods.join('|'), r.path, r.routeName, r.middleware.map((m) => m.name)])).toEqual([
      ['GET', '/', 'home', []],
      ['GET', '/ping', 'ping', []],
      ['GET', '/teams/:team/members/:id', 'teams.members.show', ['auth']],
      ['DELETE', '/teams/:team', 'teams.destroy', ['auth', 'admin']],
    ]);
  });

  it('generates URLs for named routes', () => {
    expect(router.url('teams.members.show', { team: 'core', id: 7 })).toBe('/teams/core/members/7');
    expect(() => router.url('teams.members.show', { team: 'core' })).toThrow(/Missing required parameter \[id\]/);
    expect(() => router.url('nope')).toThrow(/not defined/);
  });

  it('puts parameters the path does not take, and the query, into the query string — like signed URLs', () => {
    // Before W5.2, extra parameters were dropped silently.
    expect(router.url('teams.members.show', { team: 'core', id: 7, tab: 'links' })).toBe('/teams/core/members/7?tab=links');
    expect(router.url('home', {}, { q: 'a b', page: 2, tag: ['x', 'y'], empty: null, gone: undefined, on: true })).toBe(
      '/?q=a+b&page=2&tag=x&tag=y&on=true',
    );
    expect(router.url('teams.members.show', { team: 'a/b', id: 'ü' })).toBe('/teams/a%2Fb/members/%C3%BC');
  });
});

describe('Dispatching', () => {
  const router = new Router().load(routes);
  const route = (name: string) => router.findByName(name)!;

  it('passes middleware context into controller actions', async () => {
    const response = await router.dispatch(route('teams.members.show'), {
      request: request('42'),
      params: { team: 'core', id: '7' },
    });
    expect(await response.json()).toEqual({ team: 'core', member: '7', viewer: '42' });
  });

  it('invokes controllers without parameters', async () => {
    const response = await router.dispatch(route('ping'), { request: request(), params: {} });
    expect(await response.text()).toBe('pong');
  });

  it('lets middleware short-circuit the pipeline', async () => {
    const params = { team: 'core' };
    const destroy = route('teams.destroy');

    expect((await router.dispatch(destroy, { request: request(), params })).status).toBe(401);
    expect((await router.dispatch(destroy, { request: request('42'), params })).status).toBe(403);
    expect(await (await router.dispatch(destroy, { request: request('1'), params })).text()).toBe('deleted core by 1');
  });

  it('uses the controller resolver hook', async () => {
    const resolved: string[] = [];
    const withContainer = new Router({
      resolve: (Class) => {
        resolved.push(Class.name);
        return new Class();
      },
    }).load(routes);

    await withContainer.dispatch(withContainer.findByName('teams.members.show')!, {
      request: request('1'),
      params: { team: 'a', id: 'b' },
    });
    expect(resolved).toEqual(['ShowTeamMemberController']);
  });

  it('builds middleware classes through the resolver, once per dispatch', async () => {
    const built: string[] = [];
    const router = new Router().load(
      defineRoutes((Route) => Route.middleware(ClassAuthenticate).get('/me', (ctx) => ctx.user.id).name('me')),
    );
    const resolve = <T>(Class: new () => T) => {
      built.push(Class.name);
      return new Class();
    };

    const first = await router.dispatch(router.findByName('me')!, { request: request('42'), params: {} }, { resolve });
    await router.dispatch(router.findByName('me')!, { request: request('7'), params: {} }, { resolve });

    expect(await first.text()).toBe('42');
    expect(built).toEqual(['ClassAuthenticate', 'ClassAuthenticate']);
  });

  it('rejects when a middleware calls next() twice', async () => {
    const twice = defineMiddleware('twice', async (_ctx, next) => {
      await next();
      return next();
    });
    const router = new Router().load(defineRoutes((Route) => Route.middleware(twice).get('/', () => 'ok').name('x')));

    await expect(router.dispatch(router.findByName('x')!, { request: request(), params: {} })).rejects.toThrow(
      /called next\(\) more than once/,
    );
  });
});

// ---------------------------------------------------------------------------
// Type-level guarantees — checked by `tsc`, not at runtime.
// ---------------------------------------------------------------------------

defineRoutes((Route) => {
  // @ts-expect-error — requireAdmin needs `user`, but nothing upstream provides it.
  Route.middleware(requireAdmin);

  // @ts-expect-error — `user` is only available after `authenticate`.
  Route.get('/me', (ctx) => ctx.user);

  // Middleware classes add context just like `defineMiddleware` objects:
  Route.middleware(ClassAuthenticate).middleware(RequireAdminClass).get('/admin', (ctx) => ctx.user.isAdmin);

  // @ts-expect-error — the class needs `user`, but nothing upstream provides it.
  Route.middleware(RequireAdminClass);

  // @ts-expect-error — the controller needs `user` and the `team`/`id` params.
  Route.get('/members/:id', ShowTeamMemberController);

  // @ts-expect-error — `user` is there, but the route lacks the `team` param.
  Route.middleware(authenticate).get('/members/:id', ShowTeamMemberController);

  // Provides everything the controller needs:
  Route.prefix('/t/:team').middleware(authenticate).get('/m/:id', ShowTeamMemberController);

  class NotAController {
    show() {}
  }
  // @ts-expect-error — no handle(): not an invokable controller.
  Route.get('/nope', NotAController);

  Route.get('/posts/:slug/:page?', (ctx) => {
    const slug: string = ctx.params.slug;
    const page: string | undefined = ctx.params.page;
    // @ts-expect-error — optional params are not guaranteed.
    const required: string = ctx.params.page;
    return [slug, page, required];
  });
});
