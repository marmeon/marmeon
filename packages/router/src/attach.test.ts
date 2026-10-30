import { describe, expect, it } from 'vitest';
import { everyone } from './access.ts';
import type { RouteAttachment } from './attach.ts';
import { defineMiddleware } from './middleware.ts';
import { defineRequest } from './request-definition.ts';
import { RouteDefinition } from './route-definition.ts';
import { defineRoutes, Router, type RouteDefinitions } from './router.ts';
import type { RouteBinder, RouteBindingContext } from './types.ts';

interface User {
  admin: boolean;
}

/** Reads `x-admin` as a sign-in: the page's request decides on what the middleware adds. */
const authenticate = defineMiddleware<{ user: User }>('authenticate', (ctx, next) => next({ user: { admin: ctx.request.headers.get('x-admin') === '1' } }));

class AdminPage {
  static request = defineRequest({ authorize: (ctx: { user: User }) => ctx.user.admin === true });
  handle() {
    return 'page';
  }
}

const log: string[] = [];

/** What a package hangs on a page: one GET and one POST under `/_part`. */
const part: RouteAttachment = {
  attachTo(routes) {
    routes.get('/_part/export', () => (log.push('export'), 'exported'));
    routes.post('/_part/act', () => (log.push('act'), 'acted'));
  },
};

const load = (register: RouteDefinitions['register']) => new Router().load(defineRoutes(register));

async function call(router: Router, method: string, path: string, params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const route = router.routes.find((candidate) => candidate.path === path && candidate.methods.includes(method as never));
  if (!route) throw new Error(`no route for ${method} ${path}`);
  const request = new Request(`http://app.test${path}`, { method, headers });
  const response = await router.dispatch(route, { request, params }, { onError: (error) => new Response(String(error), { status: (error as { status?: number }).status ?? 500 }) });
  return { status: response.status, body: await response.text() };
}

describe('RouteDefinition.attach()', () => {
  it('carries the request authorize of the page to the routes attached to it', async () => {
    const router = load((Route) => void Route.authorize(everyone).middleware(authenticate).get('/audit', AdminPage).attach(part));
    const admin = { 'x-admin': '1' };
    log.length = 0;
    for (const [method, path] of [['GET', '/audit'], ['GET', '/audit/_part/export'], ['POST', '/audit/_part/act']] as const) {
      expect((await call(router, method, path)).status, `${method} ${path} as a guest`).toBe(403);
    }
    expect(log).toEqual([]);
    expect((await call(router, 'GET', '/audit', {}, admin)).status).toBe(200);
    expect(await call(router, 'GET', '/audit/_part/export', {}, admin)).toEqual({ status: 200, body: 'exported' });
    expect(await call(router, 'POST', '/audit/_part/act', {}, admin)).toEqual({ status: 200, body: 'acted' });
  });

  it('carries the registrar checks, and the middleware of the page runs before the attachment', async () => {
    const ran: string[] = [];
    const seen = defineMiddleware('seen', (_ctx, next) => (ran.push('middleware'), next({})));
    const router = load((Route) => {
      Route.authorize(everyone)
        .middleware(seen)
        .authorize((ctx) => (ran.push('check'), (ctx.request.headers.get('x-let') ?? '') === '1'))
        .get('/page', () => 'page')
        .attach(part);
    });
    expect((await call(router, 'GET', '/page/_part/export')).status).toBe(403);
    expect(ran).toEqual(['middleware', 'check']);
    expect((await call(router, 'GET', '/page/_part/export', {}, { 'x-let': '1' })).status).toBe(200);
  });

  it('runs the registrar check, the authorize of the page, the afterAuthorize hook and the handler of the attachment in that order', async () => {
    const order: string[] = [];
    class Ordered {
      static request = defineRequest({ authorize: () => (order.push('page authorize'), true) });
      handle() {
        return 'page';
      }
    }
    const router = load((Route) => {
      Route.authorize(() => (order.push('check'), true))
        .afterAuthorize(() => void order.push('hook'))
        .get('/ordered', Ordered)
        .attach({ attachTo: (routes) => void routes.get('/_part/export', () => (order.push('handler'), 'ok')) });
    });
    expect((await call(router, 'GET', '/ordered/_part/export')).status).toBe(200);
    expect(order).toEqual(['check', 'page authorize', 'hook', 'handler']);
  });

  it('resolves the scoped bindings of the page for the attached routes: a record of another parent is a 404', async () => {
    interface Team {
      id: number;
    }
    interface Member {
      id: number;
      team: number;
    }
    class Teams implements RouteBinder<Team> {
      resolveRouteBinding(value: string) {
        return value === '1' || value === '2' ? { id: Number(value) } : undefined;
      }
    }
    class Members implements RouteBinder<Member> {
      static readonly routeBindingScoped = true;
      resolveRouteBinding(value: string, { scope }: RouteBindingContext) {
        const member = { id: Number(value), team: value === '10' ? 1 : 2 };
        return member.team === (scope!.parent as Team).id ? member : undefined;
      }
    }
    let seen: unknown;
    const router = load((Route) => {
      Route.authorize(() => true)
        .bind('team', Teams)
        .bind('member', Members, { scopedBy: 'team' })
        .get('/teams/:team/members/:member', () => 'member')
        .attach({ attachTo: (routes) => void routes.get('/_part/export', (ctx) => ((seen = ctx.params), 'ok')) });
    });
    const path = '/teams/:team/members/:member/_part/export';
    expect(router.routes.map((route) => route.path)).toContain(path);
    expect((await call(router, 'GET', path, { team: '1', member: '10' })).status).toBe(200);
    expect(seen).toEqual({ team: { id: 1 }, member: { id: 10, team: 1 } });
    expect((await call(router, 'GET', path, { team: '1', member: '20' })).status).toBe(404);
  });

  it('cannot take a check of the page away: an attachment that registers through everyone still answers 403', async () => {
    const router = load((Route) => {
      Route.authorize(() => false)
        .get('/closed', () => 'page')
        .attach({ attachTo: (routes) => void routes.authorize(everyone).get('/_part/export', () => 'leaked') });
    });
    expect(await call(router, 'GET', '/closed/_part/export')).toMatchObject({ status: 403 });
  });

  it('adds the checks and the middleware of an attachment to the page’s', async () => {
    const router = load((Route) => {
      Route.authorize(everyone)
        .get('/page', () => 'page')
        .attach({ attachTo: (routes) => void routes.authorize(() => false).get('/_part/export', () => 'x') });
    });
    expect((await call(router, 'GET', '/page')).status).toBe(200);
    expect((await call(router, 'GET', '/page/_part/export')).status).toBe(403);
  });

  it('puts the attached routes under /:locale on a localized page, with the redirect variant besides', async () => {
    const router = load((Route) => void Route.localized().authorize(everyone).get('/about', () => 'about').attach(part));
    expect(router.routes.map((route) => `${route.methods.join('|')} ${route.path}`)).toEqual(['GET /:locale/about', 'GET /:locale/about/_part/export', 'POST /:locale/about/_part/act']);
    expect((await call(router, 'GET', '/:locale/about/_part/export', { locale: 'de' })).status).toBe(200);
    // The route without the locale only redirects; it never answers as the export.
    const variant = router.registrationOrder.find((route) => route.generatedFrom?.path === '/:locale/about/_part/export')!;
    expect(variant.path).toBe('/about/_part/export');
    const response = await router.dispatch(variant, { request: new Request('http://app.test/about/_part/export'), params: {} }, { urlLocales: { preferred: () => 'de', supported: ['de', 'en'] } as never });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/de/about/_part/export');
    expect(await response.text()).not.toBe('exported');
  });

  it('keeps the middleware group of the page, so an attached POST gets what the group holds', () => {
    const router = new Router().load({ group: 'web' }, defineRoutes((Route) => void Route.authorize(everyone).get('/g', () => 'page').attach(part)));
    expect(router.routes.map((route) => route.group)).toEqual(['web', 'web', 'web']);
  });

  it('names the app’s attach() line for routes that say nothing about who may call them', () => {
    const router = load((Route) => void Route.get('/open', () => 'page').attach(part));
    const sites = router.accessProblems().map((problem) => problem.route.site);
    expect(sites).toHaveLength(3);
    for (const site of sites) expect(site).toMatch(/attach\.test\.ts:\d+$/);
    // The page and its attachments sit on one line here; the point is that none is a line of attach.ts or route.ts.
    expect(sites.join()).not.toMatch(/route\.ts|route-definition\.ts|attach\.ts/);
  });

  it('refuses a route that is not a GET', () => {
    expect(() => load((Route) => void Route.authorize(everyone).post('/x', () => 'x').attach(part))).toThrow('attach() hangs routes on a page, a GET route — POST /x is none.');
  });

  it('refuses a path with an optional parameter', () => {
    expect(() => load((Route) => void Route.authorize(everyone).get('/x/:page?', () => 'x').attach(part))).toThrow('has an optional parameter');
  });

  it('refuses something without attachTo', () => {
    expect(() => load((Route) => void Route.authorize(everyone).get('/x', () => 'x').attach({} as never))).toThrow("attach() takes what a package makes for a page, such as a route attachment");
    expect(() => load((Route) => void Route.authorize(everyone).get('/x', () => 'x').attach(undefined as never))).toThrow('attach() takes what a package makes');
  });

  it('refuses an attachTo that returns a promise', () => {
    const asynchronous = { attachTo: async () => {} };
    expect(() => load((Route) => void Route.authorize(everyone).get('/x', () => 'x').attach(asynchronous))).toThrow('attach() takes a synchronous attachTo');
  });

  it('refuses a route that was built by hand', () => {
    const route = new RouteDefinition({ methods: ['GET'], path: '/x', action: () => 'x', middleware: [], namePrefix: '' });
    expect(() => route.attach(part)).toThrow('built by hand');
  });

  it('refuses after the routes were loaded', () => {
    let page: RouteDefinition | undefined;
    load((Route) => void (page = Route.authorize(everyone).get('/x', () => 'x')));
    expect(() => page!.attach(part)).toThrow('attach() cannot change a route after its routes were loaded');
  });

  it('refuses a registrar that registers after the files ran', () => {
    let kept: Parameters<RouteAttachment['attachTo']>[0] | undefined;
    load((Route) => void Route.authorize(everyone).get('/x', () => 'x').attach({ attachTo: (routes) => void (kept = routes) }));
    expect(() => kept!.get('/late', () => 'x')).toThrow('A route was registered after its routes were loaded');
  });
});
