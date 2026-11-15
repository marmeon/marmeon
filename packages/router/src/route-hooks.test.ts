import { describe, expect, it } from 'vitest';
import { defineMiddleware } from './middleware.ts';
import { GLOBAL } from './middleware-groups.ts';
import { Router } from './router.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const request = (path: string) => ({ request: new Request(`http://app.test${path}`), params: {} });

function setup() {
  const log: string[] = [];
  const router = new Router();
  router.middleware.append(
    GLOBAL,
    defineMiddleware('global', (_ctx, next) => {
      log.push('global');
      return next();
    }),
  );
  router.load(
    { group: 'web' },
    openRoutes((Route) => {
      Route.get('/page', () => 'page').name('page');
    }),
  );
  return { router, log };
}

describe('Router.beforeMiddleware', () => {
  it('runs before the first global middleware and gets the route and its whole middleware list', async () => {
    const { router, log } = setup();
    const seen: string[][] = [];
    router.beforeMiddleware((route, pipeline) => {
      log.push(`hook ${route.path}`);
      seen.push(pipeline.map((middleware) => middleware.name));
    });
    await router.dispatch(router.findByName('page')!, request('/page'));
    expect(log).toEqual(['hook /page', 'global']);
    expect(seen).toEqual([['global']]);
  });

  it('answers with what the hook throws, through onError, and runs no middleware', async () => {
    const { router, log } = setup();
    router.beforeMiddleware(() => {
      throw new Error('refused');
    });
    const route = router.findByName('page')!;
    const answered = await router.dispatch(route, request('/page'), { onError: (error) => new Response((error as Error).message, { status: 500 }) });
    expect([answered.status, await answered.text(), log]).toEqual([500, 'refused', []]);
    // Without onError the dispatch rejects, never throws synchronously.
    const dispatched = router.dispatch(route, request('/page'));
    await expect(dispatched).rejects.toThrow('refused');
  });

  it('is not called for a request no route matched', async () => {
    const { router } = setup();
    let called = 0;
    router.beforeMiddleware(() => void called++);
    await router.dispatchNotFound(new Request('http://app.test/nope')).catch(() => undefined);
    await router.dispatchGlobal(new Request('http://app.test/x'), () => new Response('ok'));
    expect(called).toBe(0);
  });
});

describe('Router.checkStart', () => {
  it('collects the findings of every check, in the order registered, next to the findings of routes', () => {
    const { router } = setup();
    router.load(openRoutes((Route) => void Route.get('/other', () => 'other')));
    expect(router.startProblems()).toEqual([]);
    router.checkPipelines(() => ({ message: 'route', code: 'A9' }));
    router.checkStart(() => [{ message: 'first', code: 'A8' }]);
    router.checkStart(() => []).checkStart(() => [{ message: 'second', code: 'A8', docs: 'docs/x.md' }]);
    expect(router.startProblems().map((problem) => [problem.message, problem.code, problem.docs])).toEqual([['first', 'A8', undefined], ['second', 'A8', 'docs/x.md']]);
    expect(new Set(router.pipelineProblems().map((problem) => problem.message))).toEqual(new Set(['route']));
  });
});

describe('Router.checkPipelines', () => {
  it('collects the findings of every route, each with its route', () => {
    const { router } = setup();
    router.load(
      openRoutes((Route) => {
        Route.get('/other', () => 'other').name('other');
      }),
    );
    expect(router.pipelineProblems()).toEqual([]);
    router.checkPipelines((route, pipeline) => (route.path === '/other' && pipeline.length === 1 ? { message: 'no', code: 'A9', docs: 'docs/x.md' } : undefined));
    const problems = router.pipelineProblems();
    expect(problems.map((problem) => [problem.route.path, problem.message, problem.code, problem.docs])).toEqual([['/other', 'no', 'A9', 'docs/x.md']]);
  });

  it('lists the declared middleware layer by layer, as boot does: global, declared global, group, declared group, route', () => {
    const router = new Router();
    const named = (name: string) => defineMiddleware(name, (_ctx, next) => next());
    router.middleware.append(GLOBAL, named('framework global')).append('web', named('framework group'));
    router.load(
      { group: 'web' },
      openRoutes((Route) => {
        Route.middleware(named('route')).get('/page', () => 'page');
      }),
    );
    const seen: string[][] = [];
    router.checkPipelines((_route, pipeline) => (seen.push(pipeline.map((middleware) => middleware.name)), undefined));
    router.pipelineProblems({ global: [named('app global')], web: [named('app group')], api: [named('other group')] });
    expect(seen).toEqual([['framework global', 'app global', 'framework group', 'app group', 'route']]);
  });
});
