import { describe, expect, it } from 'vitest';
import { formatAccessProblems, isEveryone, openBindings, registrationSite, siteOf, userSite } from './access.ts';
import {
  defineMiddleware,
  defineRequest,
  defineRoutes,
  describeAccess,
  everyone,
  Router,
  type HttpContext,
  type RequestDefinition,
  type RouteBinder,
  RouteDefinition,
  type RouteDefinitions,
} from './index.ts';
import { accessLabel, FRAMEWORK_ROUTES, routeAccess, VALIDATE_HEADER } from './internal.ts';

interface Note {
  id: string;
  ownerId: string;
}

const notes = new Map<string, Note>([['1', { id: '1', ownerId: 'ada' }]]);

class NoteBinder implements RouteBinder<Note> {
  // Marked so the fixture may stand in a scoped binding: these tests judge access, not what the binder finds.
  static readonly routeBindingScoped = true;

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
      Route.authorize(everyone).get('/sibling', () => 'sibling');
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

describe('registration site', () => {
  it('skips node_modules and node: frames, wherever the router lives', () => {
    const stack = ['Error', '    at Route.get (/srv/app/node_modules/@marmeon/router/dist/route.js:9:1)', '    at node:internal/x:1:1', '    at routes (/srv/app/modules/a/routes.ts:4:3)'].join('\n');
    expect(userSite(stack)).toBe('/srv/app/modules/a/routes.ts:4');
  });

  it('starts above the registrar method it is given', () => {
    function registerLikeAMethod() {
      return registrationSite(registerLikeAMethod);
    }
    expect(registerLikeAMethod()).toMatch(/access\.test\.ts:\d+$/);
  });
});

describe('framework routes', () => {
  it('knows the routes loaded with the framework marker', () => {
    const router = load((Route) => Route.get('/_marmeon/x', () => 'x'), { framework: FRAMEWORK_ROUTES });
    expect(router.isFrameworkRoute(router.routes[0]!)).toBe(true);
  });

  it('is not the marker of the old public registry symbol: Symbol.for(\'marmeon.router.framework\') exempts nothing', () => {
    const forged = Symbol.for('marmeon.router.framework') as never;
    expect(forged as unknown).not.toBe(FRAMEWORK_ROUTES);
    // Under /_marmeon/ it is refused, and elsewhere it is an app route like any other.
    expect(() => load((Route) => Route.get('/_marmeon/x', () => 'x'), { framework: forged })).toThrow('belong to the framework');
    const router = load((Route) => Route.get('/x', () => 'x'), { framework: forged });
    expect(router.isFrameworkRoute(router.routes[0]!)).toBe(false);
    expect(router.accessProblems()).toHaveLength(1);
  });

  it('does not count an app route whose `reserved` is set by hand: the loaded route is frozen', () => {
    const router = load((Route) => {
      Route.get('/x', () => 'x').reserved = true;
    });
    expect(() => {
      router.routes[0]!.reserved = false;
    }).toThrow(TypeError); // a loaded route is frozen
    expect(router.routes[0]!.reserved).toBe(true);
    expect(router.isFrameworkRoute(router.routes[0]!)).toBe(false);
  });
});

class NoteRepoWith implements RouteBinder<Note> {
  static routeBindingWith = { relations: ['owner'] } as never;
  resolveRouteBinding() {
    return undefined;
  }
}

describe('Router.accessProblems()', () => {
  class NoteController {
    handle() {
      return 'note';
    }
  }
  const problemsOf = (register: RouteDefinitions['register'], options: Parameters<Router['load']>[0] = {}) => load(register, options).accessProblems();
  const kinds = (problems: ReturnType<Router['accessProblems']>) => problems.map((problem) => [problem.kind, problem.route.path, 'param' in problem ? problem.param : undefined]);

  it('reports a controller without a request, a request without authorize, and a closure', () => {
    const problems = problemsOf((Route) => {
      Route.get('/plain', NoteController);
      Route.get('/request', controllerOf(defineRequest({})));
      Route.get('/closure', () => 'x');
    });
    expect(kinds(problems)).toEqual([
      ['undecided', '/plain', undefined],
      ['undecided', '/request', undefined],
      ['undecided', '/closure', undefined],
    ]);
  });

  it('accepts a decision in the request, in the registrar, or in a function of its own', () => {
    expect(
      problemsOf((Route) => {
        Route.get('/request', controllerOf(defineRequest({ authorize: () => true })));
        Route.authorize(() => true).get('/group', NoteController);
        Route.authorize(everyone).get('/open', () => 'x');
      }),
    ).toEqual([]);
  });

  it('reports an open route that binds a record by its key', () => {
    const problems = problemsOf((Route) => Route.authorize(everyone).bind('note', NoteBinder).get('/notes/:note', NoteController));
    expect(problems).toMatchObject([{ kind: 'open-binding', param: 'note', binder: 'NoteBinder' }]);
  });

  it('reports only the parent of a scoped binding', () => {
    class AttachmentBinder implements RouteBinder<Note> {
      static readonly routeBindingScoped = true;
      resolveRouteBinding() {
        return undefined;
      }
    }
    const problems = problemsOf((Route) =>
      Route.authorize(everyone).bind('note', NoteBinder).bind('attachment', AttachmentBinder, { scopedBy: 'note' }).get('/notes/:note/:attachment', NoteController),
    );
    expect(kinds(problems)).toEqual([['open-binding', '/notes/:note/:attachment', 'note']]);
  });

  it('lets an open route bind publicly, and a route with a check of its own bind anything', () => {
    expect(
      problemsOf((Route) => {
        Route.authorize(everyone).bind('note', NoteBinder, { public: true }).get('/public/:note', NoteController);
        Route.authorize(() => true).bind('note', NoteBinder).get('/guarded/:note', NoteController);
        Route.authorize(everyone).authorize(() => true).bind('note', NoteBinder).get('/both/:note', NoteController);
      }),
    ).toEqual([]);
  });

  it('leaves out framework routes', () => {
    expect(problemsOf((Route) => Route.get('/_marmeon/x', () => 'x'), { framework: FRAMEWORK_ROUTES })).toEqual([]);
  });

  it('still reports an app route whose `reserved` is set by hand: the loaded route is frozen', () => {
    const router = load((Route) => {
      Route.get('/x', () => 'x').reserved = true;
    });
    expect(() => {
      router.routes[0]!.reserved = false;
    }).toThrow(TypeError); // a loaded route is frozen
    expect(router.accessProblems()).toHaveLength(1);
  });

  it('reports an open route whose request says everyone, with an unscoped binding', () => {
    const problems = problemsOf((Route) => Route.bind('note', NoteBinder).get('/notes/:note', controllerOf(defineRequest({ authorize: everyone }))));
    expect(problems).toMatchObject([{ kind: 'open-binding', param: 'note' }]);
  });

  it('refuses a scopedBy that is no parameter bound before, whatever it is', () => {
    for (const scopedBy of ['', null, 0, false, 'missing']) {
      expect(() => load((Route) => Route.bind('note', NoteBinder).bind('child', NoteBinder, { scopedBy } as never))).toThrow(/is not the name of a parameter bound before/);
    }
  });

  it('reports a binding scoped by a public parent, until it is public itself', () => {
    class InvoiceBinder implements RouteBinder<Note> {
      static readonly routeBindingScoped = true;
      resolveRouteBinding() {
        return undefined;
      }
    }
    const open = (invoice: object) => (Route: Parameters<RouteDefinitions['register']>[0]) =>
      Route.authorize(everyone).bind('team', NoteBinder, { public: true }).bind('invoice', InvoiceBinder, { scopedBy: 'team', ...invoice }).get('/t/:team/:invoice', NoteController);
    expect(kinds(problemsOf(open({})))).toEqual([['open-binding', '/t/:team/:invoice', 'invoice']]);
    expect(problemsOf(open({ public: true }))).toEqual([]);
    expect(
      problemsOf((Route) =>
        Route.authorize(() => true).bind('team', NoteBinder).bind('invoice', InvoiceBinder, { scopedBy: 'team' }).get('/t/:team/:invoice', NoteController),
      ),
    ).toEqual([]);
  });

  it('does not excuse a write by a public binding', () => {
    const problems = problemsOf((Route) => Route.authorize(everyone).bind('note', NoteBinder, { public: true }).post('/notes/:note', NoteController));
    expect(problems).toMatchObject([{ kind: 'open-binding', param: 'note', write: true }]);
    expect(formatAccessProblems(problems)).toContain('does not excuse it');
  });

  it('names a check of its own for an open binding', () => {
    const problems = problemsOf((Route) => Route.authorize(everyone).bind('token', NoteBinder).get('/invite/:token', NoteController));
    expect(formatAccessProblems(problems)).toContain("Route.authorize(describeAccess((ctx) => …, 'invitation link')) for a token in its path");
  });

  it('names a check of its own for a write under a public parent', () => {
    const problems = problemsOf((Route) => Route.authorize(everyone).bind('event', NoteBinder, { public: true }).post('/events/:event/register', NoteController));
    expect(problems).toMatchObject([{ kind: 'open-binding', write: true }]);
    expect(formatAccessProblems(problems)).toContain("(…, 'open event') for a write under a public parent that the check finds open");
  });

  it('recognises everyone by its brand, from another copy of the package', () => {
    const other = Object.defineProperty(() => true, Symbol.for('marmeon.access.everyone'), { value: true });
    expect(isEveryone(other)).toBe(true);
    expect(isEveryone(() => true)).toBe(false);
    expect(problemsOf((Route) => Route.authorize(other as never).bind('note', NoteBinder).get('/n/:note', NoteController))).toHaveLength(1);
    expect(describeAccess(other, 'everyone')).toBe(other);
    expect(() => describeAccess(() => true, 'everyone')).toThrow(TypeError);
  });

  it('freezes the bindings of a registered route', () => {
    const route = load((Route) => Route.authorize(everyone).bind('note', NoteBinder, { public: true }).get('/n/:note', NoteController)).routes[0]!;
    expect(Object.isFrozen(route.bindings)).toBe(true);
    expect(Object.isFrozen(route.bindings[0])).toBe(true);
    const withRelations = load((Route) => Route.authorize(everyone).bind('note', NoteRepoWith, { public: true, with: ['owner'] as never }).get('/w/:note', NoteController)).routes[0]!;
    expect(Object.isFrozen(withRelations.bindings[0]!.with)).toBe(true);
    expect(() => {
      (route as { bindings: unknown }).bindings = [];
    }).toThrow(TypeError);
    expect(() => {
      (route.bindings[0] as { public?: boolean }).public = false;
    }).toThrow(TypeError);
  });

  it('hands out a snapshot of the routes, which a pushed route does not change', () => {
    const router = load((Route) => Route.get('/a', () => 'x'));
    const [route] = router.routes;
    expect(() => (router.routes as RouteDefinition[]).push(route!)).toThrow(TypeError);
    expect(router.routes).toBe(router.routes);
  });

  it('counts a scoped binding whose parent is missing as open', () => {
    const route = new RouteDefinition({
      methods: ['GET'],
      path: '/x/:child',
      action: () => 'x',
      middleware: [],
      namePrefix: '',
      bindings: [{ param: 'child', binder: NoteBinder, scopedBy: 'ghost' }],
      checks: [everyone],
    });
    expect(openBindings(route).map((binding) => binding.param)).toEqual(['child']);
  });

  it('refuses to dispatch a hand-built route whose scoped binder does not say it scopes', async () => {
    class Unmarked implements RouteBinder<Note> {
      resolveRouteBinding(value: string) {
        return notes.get(value);
      }
    }
    const route = new RouteDefinition({
      methods: ['GET'],
      path: '/x/:note/:child',
      action: () => 'x',
      middleware: [],
      namePrefix: '',
      bindings: [{ param: 'note', binder: NoteBinder }, { param: 'child', binder: Unmarked, scopedBy: 'note' }],
      checks: [everyone],
    });
    const request = new Request('http://localhost/x/1/1');
    await expect(new Router().dispatch(route, { request, params: { note: '1', child: '1' } })).rejects.toThrow(/\[marmeon:H11\]/);
  });

  it('refuses an async group callback right away', () => {
    expect(() => load((Route) => Route.group((async () => undefined) as never))).toThrow(/synchronous callback/);
  });

  it('refuses a route registered after loading, and an async register function', () => {
    let stored: Parameters<RouteDefinitions['register']>[0] | undefined;
    new Router().load(defineRoutes((Route) => (stored = Route)));
    expect(() => stored!.get('/late', () => 'x')).toThrow(/after its routes were loaded/);
    expect(() => load((async (Route: Parameters<RouteDefinitions['register']>[0]) => Route.get('/a', () => 'x')) as never)).toThrow(/synchronous/);
  });

  it('records where each kind of route was registered', () => {
    const marker = () => Number(new Error().stack!.split('\n')[3]!.match(/:(\d+):\d+\)?$/)![1]);
    const sites: [number, string | undefined][] = [];
    const router = load((Route) => {
      const at = (route: { site: string | undefined }) => sites.push([marker(), route.site]);
      at(Route.get('/g', () => 'x'));
      at(Route.post('/p', () => 'x'));
      at(Route.put('/u', () => 'x'));
      at(Route.patch('/a', () => 'x'));
      at(Route.delete('/d', () => 'x'));
      at(Route.options('/o', () => 'x'));
      at(Route.match(['GET'], '/m', () => 'x'));
      at(Route.any('/y', () => 'x'));
    });
    expect(router.routes).toHaveLength(8);
    for (const [line, site] of sites) expect(site).toMatch(new RegExp(`access\\.test\\.ts:${line}$`));
  });

  it('names the method, path, route name, controller and site of each problem', () => {
    const router = load((Route) => {
      Route.get('/notes', NoteController).name('notes.index');
      Route.authorize(everyone).bind('note', NoteBinder).post('/notes/:note', () => 'x').name('notes.update');
    });
    const text = formatAccessProblems(router.accessProblems());
    expect(text).toMatch(/GET\s+\/notes\s+notes\.index\s+NoteController\s+\S*access\.test\.ts:\d+/);
    expect(text).toContain('POST');
    expect(text).toContain('Closure');
    expect(text).toContain('Route.authorize(');
    expect(text).toContain('binds `note` with NoteBinder');
    expect(text).toContain('{ public: true }');
    expect(text).toContain('docs/authorization.md#every-route-decides');
  });

  it('begins with the code H3', () => {
    const router = load((Route) => {
      Route.get('/notes', NoteController);
    });
    expect(formatAccessProblems(router.accessProblems())).toMatch(/^\[marmeon:H3\] 1 route does not say who may call it:/);
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
    Route.bind('note', NoteBinder).bind('child', NoteBinder, { scopedBy: 'note', public: true });
    // @ts-expect-error — scopedBy names a parameter bound before
    Route.bind('child', NoteBinder, { scopedBy: 'note' });
    // @ts-expect-error — the check needs a bound `note`
    Route.authorize((ctx: HttpContext<{}, { note: Note }>) => ctx.params.note.ownerId === 'ada');
  });
}
