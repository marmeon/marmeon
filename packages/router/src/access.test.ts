import { describe, expect, it } from 'vitest';
import { siteOf } from './access.ts';
import {
  accessLabel,
  defineMiddleware,
  defineRequest,
  defineRoutes,
  describeAccess,
  everyone,
  FRAMEWORK_ROUTES,
  routeAccess,
  Router,
  VALIDATE_HEADER,
  type HttpContext,
  type RequestDefinition,
  type RouteBinder,
  type RouteDefinitions,
} from './index.ts';

interface Note {
  id: string;
  ownerId: string;
}

const notes = new Map<string, Note>([['1', { id: '1', ownerId: 'ada' }]]);

class NoteBinder implements RouteBinder<Note> {
  resolveRouteBinding(value: string) {
    return notes.get(value);
  }
}

const signIn = defineMiddleware<{ user: { id: string } }>('sign-in', (ctx, next) => next({ user: { id: ctx.request.headers.get('x-user') ?? 'ada' } }));

const trail: string[] = [];
const built: string[] = [];

class ShowController {
  constructor() {
    built.push('constructed');
  }
  handle() {
    return 'shown';
  }
}

const RequestWithCheck = (answer: boolean) =>
  defineRequest({
    authorize: () => {
      trail.push('request');
      return answer;
    },
  });

function controllerOf<R extends RequestDefinition>(request: R) {
  return class extends ShowController {
    static request: R = request;
  };
}

function load(register: RouteDefinitions['register'], options: Parameters<Router['load']>[0] = {}): Router {
  return new Router().load(options as never, defineRoutes(register));
}

async function call(router: Router, path: string, init: RequestInit = {}, params: Record<string, string> = {}) {
  const route = router.routes.find((candidate) => candidate.path === path)!;
  const request = new Request(`http://app.test${path}`, init);
  try {
    const response = await router.dispatch(route, { request, params });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (error instanceof Error && 'status' in error) return { status: (error as { status: number }).status, body: error.message };
    throw error;
  }
}

describe('Route.authorize()', () => {
  it('answers 403 before the controller is built', async () => {
    built.length = 0;
    const router = load((Route) => Route.authorize(() => false).get('/x', ShowController));
    expect(await call(router, '/x')).toMatchObject({ status: 403 });
    expect(built).toEqual([]);
  });

  it('lets a route through when the check says yes', async () => {
    const router = load((Route) => Route.authorize(() => true).get('/x', ShowController));
    expect(await call(router, '/x')).toEqual({ status: 200, body: 'shown' });
  });

  it('sees the bound record, and runs bindings, then the registrar, then the request', async () => {
    trail.length = 0;
    const router = load((Route) => {
      class TrailBinder implements RouteBinder<Note> {
        resolveRouteBinding(value: string) {
          trail.push('binding');
          return notes.get(value);
        }
      }
      const bound = Route.bind('note', TrailBinder);
      bound.authorize((ctx) => {
        trail.push(`group:${ctx.params.note.ownerId}`);
        return true;
      }).get('/notes/:note', controllerOf(RequestWithCheck(true)));
    });
    expect(await call(router, '/notes/:note', {}, { note: '1' })).toMatchObject({ status: 200 });
    expect(trail).toEqual(['binding', 'group:ada', 'request']);
  });

  it('is combined with the request by AND', async () => {
    trail.length = 0;
    const yesThenNo = load((Route) => Route.authorize(() => true).get('/x', controllerOf(RequestWithCheck(false))));
    expect(await call(yesThenNo, '/x')).toMatchObject({ status: 403 });
    const noThenEveryone = load((Route) => Route.authorize(() => false).get('/x', controllerOf(defineRequest({ authorize: everyone }))));
    expect(await call(noThenEveryone, '/x')).toMatchObject({ status: 403 });
  });

  it('runs several checks, in the order they were declared', async () => {
    trail.length = 0;
    const router = load((Route) => {
      Route.authorize(() => (trail.push('first'), true))
        .authorize(() => (trail.push('second'), true))
        .get('/x', ShowController);
    });
    expect(await call(router, '/x')).toMatchObject({ status: 200 });
    expect(trail).toEqual(['first', 'second']);
  });

  it('refuses a claimed request (interceptor) without calling the interceptor', async () => {
    let answered = 0;
    const router = load((Route) => Route.authorize(() => false).post('/x', controllerOf(defineRequest({}))));
    router.intercept({
      claims: (request) => request.headers.has('x-upload'),
      answer: () => {
        answered += 1;
        return new Response('uploaded');
      },
    });
    expect(await call(router, '/x', { method: 'POST', headers: { 'x-upload': '1' } })).toMatchObject({ status: 403 });
    expect(answered).toBe(0);
  });

  it('refuses a live validation request instead of answering 204', async () => {
    const router = load((Route) => Route.authorize(() => false).post('/x', controllerOf(defineRequest({ schema: { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: {} }) } } }))));
    const answer = await call(router, '/x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', [VALIDATE_HEADER]: 'email' } });
    expect(answer.status).toBe(403);
  });

  it('works with a closure as the action, and leaves a sibling registrar alone', async () => {
    const router = load((Route) => {
      const closed = Route.authorize(() => false);
      closed.get('/closed', () => 'closed');
      Route.get('/sibling', () => 'sibling');
    });
    expect(await call(router, '/closed')).toMatchObject({ status: 403 });
    expect(await call(router, '/sibling')).toEqual({ status: 200, body: 'sibling' });
  });

  it('is inherited by nested groups', async () => {
    const router = load((Route) => {
      Route.authorize(() => false).prefix('/admin').group((Admin) => {
        Admin.get('/x', () => 'x');
      });
    });
    expect(await call(router, '/admin/x')).toMatchObject({ status: 403 });
  });

  it('refuses a registrar made by authorize() that registered nothing, naming where it was made', () => {
    let line = 0;
    const discard = () =>
      load((Route) => {
        line = Number(new Error().stack!.match(/access\.test\.ts:(\d+)/)![1]) + 1;
        Route.authorize(() => false);
        Route.get('/x', () => 'x');
      });
    expect(discard).toThrow(/^Route\.authorize\(\) at \S*access\.test\.ts:\d+ made a registrar that never registered a route/);
    expect(discard).toThrow(/A condition belongs around the whole `Route\.authorize\(…\)…` call/);
    try {
      discard();
    } catch (error) {
      expect((error as Error).message).toContain(`access.test.ts:${line} made`);
    }
  });

  it('accepts a registrar that is stored and used later, or used through group() or prefix()', () => {
    expect(() => load((Route) => {
      const stored = Route.authorize(() => true);
      Route.get('/plain', () => 'plain');
      stored.get('/stored', () => 'stored');
    })).not.toThrow();
    expect(() => load((Route) => Route.authorize(() => true).group((Admin) => Admin.get('/grouped', () => 'g')))).not.toThrow();
    expect(() => load((Route) => Route.authorize(() => true).prefix('/p').get('/x', () => 'x'))).not.toThrow();
    expect(() => load((Route) => Route.authorize(() => true).group(() => {}))).not.toThrow();
    expect(() => load((Route) => Route.authorize(() => true).authorize(() => true).get('/x', () => 'x'))).not.toThrow();
  });

  it('lets a request on only when its authorize says exactly true — a policy response or a string is a 403', async () => {
    for (const answer of [{ allowed: false, message: 'no' }, 'yes', 1, undefined]) {
      const atRequest = load((Route) => Route.get('/x', controllerOf(defineRequest({ authorize: (() => answer) as never }))));
      expect(await call(atRequest, '/x')).toMatchObject({ status: 403 });
      const atRegistrar = load((Route) => Route.authorize((() => answer) as never).get('/x', ShowController));
      expect(await call(atRegistrar, '/x')).toMatchObject({ status: 403 });
    }
  });

  it('keeps the checks of a registered route out of reach', () => {
    const router = load((Route) => Route.authorize(() => false).get('/x', () => 'x'));
    const route = router.routes[0]!;
    expect(Object.isFrozen(route.checks)).toBe(true);
    expect(() => (route.checks as unknown as unknown[]).push(() => true)).toThrow(TypeError);
    expect(() => ((route.checks as unknown as unknown[]).length = 0)).toThrow(TypeError);
    expect(() => ((route as unknown as { checks: unknown }).checks = [])).toThrow(TypeError);
    expect(route.checks).toHaveLength(1);
    expect(Object.isFrozen(routeAccess(route))).toBe(true);
  });

  it('refuses a check that is not a function', () => {
    expect(() => load((Route) => (Route as unknown as { authorize(check: unknown): unknown }).authorize(undefined))).toThrow(/Route\.authorize\(\) takes a function/);
  });
});

describe('everyone and the labels of checks', () => {
  it('says yes, carries its label, and cannot be changed', () => {
    expect(everyone()).toBe(true);
    expect(accessLabel(everyone)).toBe('everyone');
    expect(Object.isFrozen(everyone)).toBe(true);
    expect(accessLabel(() => true)).toBe('check');
    expect(accessLabel(describeAccess(() => true, 'can Thing.view'))).toBe('can Thing.view');
  });

  it('labels frozen and already labelled functions, and keeps the label `everyone` for everyone alone', () => {
    const check = describeAccess(Object.freeze(() => true), 'first');
    expect(accessLabel(describeAccess(check, 'second'))).toBe('second');
    expect(() => describeAccess(() => true, 'everyone')).toThrow(/belongs to everyone alone/);
    expect(() => describeAccess(everyone, 'can AdminPolicy.manage')).toThrow(/belongs to everyone alone/);
    expect(accessLabel(describeAccess(everyone, 'everyone'))).toBe('everyone');
  });

  it('lists the registrar checks, then the request check', () => {
    const own = () => true;
    const router = load((Route) => Route.authorize(everyone).get('/x', controllerOf(defineRequest({ authorize: own }))));
    expect(routeAccess(router.routes[0]!)).toEqual([everyone, own]);
    expect(Object.isFrozen(routeAccess(router.routes[0]!))).toBe(true);
    expect(routeAccess(load((Route) => Route.get('/y', () => 'y')).routes[0]!)).toEqual([]);
  });
});

describe('where a registrar was made', () => {
  it('turns a percent-encoded file URL into a path', () => {
    expect(siteOf('Error\n    at Object.<anonymous> (file:///srv/my%20app/routes.ts:12:5)')).toBe('/srv/my app/routes.ts:12');
    expect(siteOf('    at file:///srv/other/routes.ts:3:1')).toBe('/srv/other/routes.ts:3');
    expect(siteOf('    at fn (/srv/plain/routes.ts:7:2)')).toBe('/srv/plain/routes.ts:7');
    expect(siteOf(undefined)).toBeUndefined();
  });
});

describe('framework routes', () => {
  it('knows the routes loaded with the framework marker', () => {
    const router = load((Route) => Route.get('/_marmeon/x', () => 'x'), { framework: FRAMEWORK_ROUTES });
    expect(router.isFrameworkRoute(router.routes[0]!)).toBe(true);
  });

  it('does not count an app route whose `reserved` was set by hand', () => {
    const router = load((Route) => Route.get('/x', () => 'x'));
    router.routes[0]!.reserved = true;
    expect(router.isFrameworkRoute(router.routes[0]!)).toBe(false);
  });
});

// --- Type guarantees (never called) -----------------------------------------------------------

export function accessTypes() {
  defineRoutes((Route) => {
    const signedIn = Route.middleware(signIn);
    signedIn.authorize((ctx) => ctx.user.id === 'ada');
    signedIn.bind('note', NoteBinder).authorize((ctx) => ctx.params.note.ownerId === ctx.user.id);
    Route.authorize(everyone);
    // @ts-expect-error — the check needs a user, and no middleware here provides one
    Route.authorize((ctx: HttpContext<{ user: { id: string } }>) => ctx.user.id === 'ada');
    // @ts-expect-error — the check needs a bound `note`
    Route.authorize((ctx: HttpContext<{}, { note: Note }>) => ctx.params.note.ownerId === 'ada');
  });
}
