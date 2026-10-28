import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { everyone } from './access.ts';
import { HttpError } from './errors.ts';
import { defineRequest } from './request-definition.ts';
import { defineRoutes, Router, type RouteDefinitions } from './router.ts';
import type { HttpContext, RouteBinder } from './types.ts';

interface Team {
  id: number;
  name: string;
}

const log: string[] = [];

class Teams implements RouteBinder<Team> {
  resolveRouteBinding(value: string) {
    log.push('bind');
    return value === '1' ? { id: 1, name: 'Red' } : undefined;
  }
}

class ShowTeam {
  static request = defineRequest({
    authorize: () => {
      log.push('request authorize');
      return true;
    },
    schema: v.object({ name: v.optional(v.string()) }),
  });
  handle(ctx: HttpContext<{}, { team?: Team }>) {
    log.push('handle');
    return ctx.params.team?.name ?? 'nobody';
  }
}

class RefusedTeam {
  static request = defineRequest({ authorize: () => false });
  handle() {
    log.push('handle');
    return 'handled';
  }
}

function load(register: RouteDefinitions['register']): Router {
  return new Router().load(defineRoutes(register));
}

async function call(router: Router, path: string, init: RequestInit = {}, params: Record<string, string> = {}) {
  const route = router.routes.find((candidate) => candidate.path === path)!;
  try {
    const response = await router.dispatch(route, { request: new Request(`http://app.test${path}`, init), params });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: error.message };
    throw error;
  }
}

const hook = (name: string) => () => {
  log.push(name);
};

describe('Route.afterAuthorize()', () => {
  it('runs after the binding, the checks and the request authorize, and before the validation and the handler', async () => {
    log.length = 0;
    const router = load((Route) => {
      Route.bind('team', Teams)
        .authorize(() => {
          log.push('check');
          return true;
        })
        .afterAuthorize(hook('hook one'))
        .afterAuthorize(hook('hook two'))
        .post('/teams/:team', ShowTeam);
    });
    const json = { 'content-type': 'application/json', accept: 'application/json' };
    expect(await call(router, '/teams/:team', { method: 'POST', body: JSON.stringify({ name: 7 }), headers: json }, { team: '1' })).toMatchObject({ status: 422 });
    // The body is invalid: the hooks ran before the validation, the handler never did.
    expect(log).toEqual(['bind', 'check', 'request authorize', 'hook one', 'hook two']);
    log.length = 0;
    expect(await call(router, '/teams/:team', { method: 'POST', body: JSON.stringify({}), headers: json }, { team: '1' })).toEqual({ status: 200, body: 'Red' });
    expect(log).toEqual(['bind', 'check', 'request authorize', 'hook one', 'hook two', 'handle']);
  });

  it('hands the hook the bound record and the resolver', async () => {
    let seen: unknown;
    let resolved: unknown;
    const router = load((Route) => {
      Route.bind('team', Teams)
        .authorize(() => true)
        .afterAuthorize((ctx, resolve) => {
          seen = ctx.params.team;
          resolved = resolve(Teams);
        })
        .get('/teams/:team', (ctx) => ctx.params.team.name);
    });
    await call(router, '/teams/:team', {}, { team: '1' });
    expect(seen).toEqual({ id: 1, name: 'Red' });
    expect(resolved).toBeInstanceOf(Teams);
  });

  it('never runs for a binder that finds nothing', async () => {
    log.length = 0;
    const router = load((Route) => void Route.bind('team', Teams).authorize(() => true).afterAuthorize(hook('hook')).get('/teams/:team', () => 'x'));
    expect(await call(router, '/teams/:team', {}, { team: '2' })).toMatchObject({ status: 404 });
    expect(log).toEqual(['bind']);
  });

  it('never runs for a check that says no', async () => {
    log.length = 0;
    const router = load((Route) => void Route.bind('team', Teams).authorize(() => false).afterAuthorize(hook('hook')).get('/teams/:team', () => 'x'));
    expect(await call(router, '/teams/:team', {}, { team: '1' })).toMatchObject({ status: 403 });
    expect(log).toEqual(['bind']);
  });

  it('never runs for a check declared after the hook, nor for one of a group inside it', async () => {
    log.length = 0;
    const after = load((Route) => void Route.afterAuthorize(hook('hook')).authorize(() => false).get('/after', () => 'x'));
    expect(await call(after, '/after')).toMatchObject({ status: 403 });
    const grouped = load((Route) => {
      Route.afterAuthorize(hook('hook')).group((Inner) => void Inner.authorize(() => false).get('/grouped', () => 'x'));
    });
    expect(await call(grouped, '/grouped')).toMatchObject({ status: 403 });
    expect(log).toEqual([]);
  });

  it('never runs for a request whose authorize says no', async () => {
    log.length = 0;
    const router = load((Route) => void Route.authorize(everyone).afterAuthorize(hook('hook')).get('/refused', RefusedTeam));
    expect(await call(router, '/refused')).toMatchObject({ status: 403 });
    expect(log).toEqual([]);
  });

  it('never runs for the redirect of a localized route to its locale', async () => {
    log.length = 0;
    const router = load((Route) => void Route.localized().authorize(everyone).afterAuthorize(hook('hook')).get('/about', () => 'about'));
    const variant = router.registrationOrder.find((route) => route.generatedFrom)!;
    const response = await router.dispatch(variant, { request: new Request('http://app.test/about'), params: {} }, { urlLocales: { supported: ['en'], preferred: async () => 'en' } });
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(log).toEqual([]);
  });

  it('runs before an interceptor answers, and after the request authorize', async () => {
    log.length = 0;
    const router = load((Route) => void Route.authorize(everyone).afterAuthorize(hook('hook')).post('/intercepted', ShowTeam));
    router.intercept({
      claims: (request) => request.headers.has('x-intercept'),
      answer: () => {
        log.push('interceptor');
        return new Response('intercepted');
      },
    });
    expect(await call(router, '/intercepted', { method: 'POST', headers: { 'x-intercept': '1' } })).toEqual({ status: 200, body: 'intercepted' });
    expect(log).toEqual(['request authorize', 'hook', 'interceptor']);

    log.length = 0;
    const refused = load((Route) => void Route.authorize(everyone).afterAuthorize(hook('hook')).post('/refused', RefusedTeam));
    refused.intercept({ claims: () => true, answer: () => new Response('intercepted') });
    expect(await call(refused, '/refused', { method: 'POST' })).toMatchObject({ status: 403 });
    expect(log).toEqual([]);
  });

  it('runs before a live validation, after the request authorize, and authorizes the request once', async () => {
    log.length = 0;
    const router = load((Route) => void Route.authorize(everyone).afterAuthorize(hook('hook')).post('/live', ShowTeam));
    const response = await call(router, '/live', { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json', 'x-marmeon-validate': 'name' } });
    expect(response.status).toBe(204);
    expect(log).toEqual(['request authorize', 'hook']);

    log.length = 0;
    const refused = load((Route) => void Route.authorize(everyone).afterAuthorize(hook('hook')).post('/live', RefusedTeam));
    expect(await call(refused, '/live', { method: 'POST', headers: { 'x-marmeon-validate': 'name' } })).toMatchObject({ status: 403 });
    expect(log).toEqual([]);
  });

  it('answers as a check does when the hook throws', async () => {
    const router = load((Route) => {
      Route.authorize(everyone)
        .afterAuthorize(() => {
          throw new HttpError(404);
        })
        .get('/gone', () => 'x');
    });
    expect(await call(router, '/gone')).toMatchObject({ status: 404 });
  });

  it('ignores what the hook returns', async () => {
    const router = load((Route) => void Route.authorize(everyone).afterAuthorize((() => false) as never).get('/ok', () => 'ok'));
    expect(await call(router, '/ok')).toEqual({ status: 200, body: 'ok' });
  });

  it('is no decision: a route with a hook and no check is still undecided', () => {
    const router = new Router().load(defineRoutes((Route) => void Route.afterAuthorize(hook('hook')).get('/open', () => 'x')));
    expect(router.accessProblems()).toMatchObject([{ kind: 'undecided' }]);
  });

  it('freezes the hooks of a registered route', () => {
    const router = load((Route) => void Route.authorize(everyone).afterAuthorize(hook('hook')).get('/x', () => 'x'));
    const route = router.routes[0]!;
    expect(Object.isFrozen(route.afterAuthorize)).toBe(true);
    expect(() => {
      (route as { afterAuthorize: unknown }).afterAuthorize = [];
    }).toThrow(TypeError);
  });

  it('refuses a registrar that registered nothing, naming where it was made', () => {
    const discard = () =>
      load((Route) => {
        const decided = Route.authorize(everyone);
        decided.afterAuthorize(hook('hook'));
        decided.get('/x', () => 'x');
      });
    expect(discard).toThrow(/^Route\.afterAuthorize\(\) at \S*after-authorize\.test\.ts:\d+ made a registrar that never registered a route/);
  });

  it('takes one function', () => {
    expect(() => load((Route) => void Route.afterAuthorize('no' as never))).toThrow(TypeError);
    expect(() => load((Route) => void (Route.afterAuthorize as (...args: unknown[]) => unknown)(hook('a'), hook('b')))).toThrow(/takes one hook/);
  });
});
