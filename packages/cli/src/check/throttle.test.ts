import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application } from '@marmeon/core';
import { defineMiddleware, defineRoutes, everyone, Router, type HttpContext, type MiddlewareClass, type Next, type Route } from '@marmeon/router';
import { FRAMEWORK_ROUTES } from '@marmeon/router/internal';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import type { CheckProblem, SilencedProblem } from './report.ts';
import { ThrottleCheck } from './throttle.ts';

/** A middleware class that declares what it ensures (`ensures` as it is, to try wrong forms too). */
function declaring(name: string, ensures?: unknown): MiddlewareClass<{}, {}> {
  const Declared = class {
    handle(_ctx: HttpContext, next: Next<{}>) {
      return next();
    }
  };
  Object.defineProperty(Declared, 'name', { value: name });
  if (ensures !== undefined) Object.defineProperty(Declared, 'ensures', { value: ensures });
  return Declared;
}

const limited = declaring('throttle', ['rate-limited']);
const signedIn = declaring('authenticate', ['authenticated']);
const plain = declaring('plain');

interface Found {
  readonly problems: CheckProblem[];
  readonly silenced: SilencedProblem[];
}

/** A folder whose sources hold no ignore comment: the real comments of the repository must not reach these tests. */
const HERE = fileURLToPath(new URL('.', import.meta.url));

function run(router: Router, root = HERE, middleware: Record<string, readonly unknown[]> = {}): Found {
  const app = { root, definition: { middleware }, container: { has: () => false } } as unknown as Application;
  const result = new ThrottleCheck(router, app).handle() as unknown as Found;
  return { problems: result.problems, silenced: result.silenced };
}

const open = (register: (Route: Route) => void) => defineRoutes((Root) => register(Root.authorize(everyone)));
const routerOf = (register: (Route: Route) => void) => new Router().load(open(register));
const messages = (found: Found) => found.problems.map((problem) => problem.message.split(' can be')[0]);

describe('ThrottleCheck', () => {
  it('warns at every changing method of an open route with nothing in front of it, with file and line', () => {
    const router = routerOf((Route) => {
      Route.post('/contact', () => 'x').name('contact');
      Route.put('/a', () => 'x');
      Route.patch('/b', () => 'x');
      Route.delete('/c', () => 'x');
      Route.any('/d', () => 'x');
    });
    const found = run(router);
    expect(messages(found)).toEqual(['POST /contact (contact)', 'PUT /a', 'PATCH /b', 'DELETE /c', 'POST|PUT|PATCH|DELETE /d']);
    expect(found.problems[0]).toMatchObject({
      severity: 'warning',
      rule: 'marmeon(throttle)',
      docs: 'docs/rate-limiting.md#applying-limits-to-routes',
      file: 'packages/cli/src/check/throttle.test.ts',
      message: expect.stringContaining("throttle('<name>')"),
    });
    expect(found.problems[0]!.message).toContain('marmeon-check-ignore throttle: <why');
    expect(found.problems[0]!.line).toBeGreaterThan(0);
  });

  it('names only the changing methods of a route that also reads', () => {
    expect(messages(run(routerOf((Route) => void Route.match(['GET', 'POST'], '/both', () => 'x'))))).toEqual(['POST /both']);
  });

  it('is quiet about routes that read', () => {
    const router = routerOf((Route) => {
      Route.get('/a', () => 'x');
      Route.match(['GET', 'HEAD'], '/b', () => 'x');
      Route.options('/c', () => 'x');
    });
    expect(run(router).problems).toEqual([]);
  });

  it('is quiet about a route with a limit or a sign-in on the route, in a group, a prefix group or the app', () => {
    const router = new Router().load(
      open((Route) => {
        Route.middleware(limited).post('/on-route', () => 'x');
        Route.middleware(signedIn).delete('/signed-in', () => 'x');
        Route.prefix('/g').middleware(limited).group((Route) => {
          Route.post('/in-group', () => 'x');
          Route.prefix('/deeper').group((Route) => void Route.put('/inherited', () => 'x'));
        });
        Route.middleware(plain).middleware(limited).post('/second', () => 'x');
      }),
    );
    expect(run(router).problems).toEqual([]);

    const named = new Router().load({ group: 'web' }, open((Route) => void Route.post('/in-named-group', () => 'x')));
    expect(messages(run(named))).toEqual(['POST /in-named-group']);
    named.middleware.append('web', limited);
    expect(run(named).problems).toEqual([]);

    const global = routerOf((Route) => void Route.post('/everywhere', () => 'x'));
    global.middleware.append('global', signedIn);
    expect(run(global).problems).toEqual([]);
  });

  it('reads the middleware of the application definition, which the router gets only when the app boots', () => {
    const router = new Router().load({ group: 'web' }, open((Route) => void Route.post('/in-web', () => 'x')));
    expect(messages(run(router))).toEqual(['POST /in-web']);
    expect(run(router, HERE, { web: [limited] }).problems).toEqual([]);
    expect(run(router, HERE, { global: [signedIn] }).problems).toEqual([]);
    // Another group's list, or one that declares nothing, is no proof.
    expect(messages(run(router, HERE, { api: [limited], web: [plain] }))).toEqual(['POST /in-web']);
    const api = new Router().load({ group: 'api' }, open((Route) => void Route.post('/in-api', () => 'x')));
    expect(run(api, HERE, { api: [limited] }).problems).toEqual([]);
    expect(messages(run(api, HERE, { web: [limited] }))).toEqual(['POST /in-api']);
    const ungrouped = routerOf((Route) => void Route.post('/none', () => 'x'));
    expect(messages(run(ungrouped, HERE, { web: [limited], api: [limited] }))).toEqual(['POST /none']);
  });

  it('is not satisfied by middleware that declares nothing, or declares it wrongly', () => {
    const router = routerOf((Route) => {
      Route.middleware(plain).post('/plain', () => 'x');
      Route.middleware(declaring('string', 'rate-limited')).post('/string', () => 'x');
      Route.middleware(declaring('unknown', ['trusted'])).post('/unknown', () => 'x');
      Route.middleware(declaring('empty', [])).post('/empty', () => 'x');
      Route.middleware(declaring('object', { 0: 'rate-limited', length: 1 })).post('/object', () => 'x');
      Route.middleware(defineMiddleware('object-middleware', (_ctx, next) => next())).post('/defined', () => 'x');
    });
    expect(messages(run(router))).toEqual(['POST /plain', 'POST /string', 'POST /unknown', 'POST /empty', 'POST /object', 'POST /defined']);
  });

  it('counts a middleware object that declares ensures', () => {
    const router = routerOf((Route) => {
      Route.middleware(Object.assign(defineMiddleware('limit', (_ctx, next) => next()), { ensures: ['rate-limited'] })).post('/x', () => 'x');
    });
    expect(run(router).problems).toEqual([]);
  });

  it('is quiet about a route a check decides, and about one that decides nothing (route-types says so)', () => {
    const router = new Router().load(
      defineRoutes((Route) => {
        Route.authorize(() => true).post('/policy', () => 'x');
        Route.authorize(everyone).authorize(() => true).post('/both', () => 'x');
      }),
    );
    expect(run(router).problems).toEqual([]);
    expect(run(new Router().load(defineRoutes((Route) => void Route.post('/undecided', () => 'x')))).problems).toEqual([]);
  });

  it('is quiet about a route of the framework, and warns at one that only looks like it', () => {
    const router = new Router()
      .load({ framework: FRAMEWORK_ROUTES }, defineRoutes((Route) => void Route.authorize(everyone).post('/_marmeon/own', () => 'x')))
      .load(open((Route) => void Route.post('/_marmeon-fake', () => 'x')));
    expect(messages(run(router))).toEqual(['POST /_marmeon-fake']);
  });

  it('is quiet about a public route that reads, and still warns at a public route that writes', () => {
    const router = routerOf((Route) => {
      Route.get('/public', () => 'x');
      Route.post('/public', () => 'x');
    });
    expect(messages(run(router))).toEqual(['POST /public']);
  });
});

describe('ThrottleCheck (silenced)', () => {
  function appWithRoutes(source: string): { root: string; router: Router } {
    const root = realpathSync(tempDir('marmeon-throttle-'));
    mkdirSync(join(root, 'modules'), { recursive: true });
    writeFileSync(join(root, 'modules/routes.mjs'), source);
    return { root, router: new Router() };
  }

  async function load(source: string): Promise<{ root: string; router: Router }> {
    const { root, router } = appWithRoutes(source);
    const register = ((await import(join(root, 'modules/routes.mjs'))) as { default: (Route: Route, everyone: unknown) => void }).default;
    router.load(defineRoutes((Root) => register(Root, everyone)));
    return { root, router };
  }

  it('puts the finding on the line of the .post( call, also in a chain over several lines', async () => {
    const { root, router } = await load(
      [
        'export default (Route, everyone) => {',
        '  Route.authorize(everyone).post("/one", () => "x");',
        '  Route.authorize(everyone)',
        '    .prefix("/two")',
        '    .post("/", () => "x");',
        '};',
        '',
      ].join('\n'),
    );
    expect(run(router, root).problems.map((problem) => [problem.file, problem.line])).toEqual([
      ['modules/routes.mjs', 2],
      ['modules/routes.mjs', 5],
    ]);
  });

  it('keeps a silenced finding in the report, with its reason, and warns about a comment without one', async () => {
    const { root, router } = await load(
      [
        'export default (Route, everyone) => {',
        '  // marmeon-check-ignore throttle: sets the visitor\'s own language, touches no record',
        '  Route.authorize(everyone).post("/locale", () => "x");',
        '  Route.authorize(everyone).post("/open", () => "x"); // marmeon-check-ignore throttle',
        '  Route.authorize(everyone).post("/other", () => "x");',
        '};',
        '',
      ].join('\n'),
    );
    const found = run(router, root);
    expect(found.silenced).toMatchObject([{ file: 'modules/routes.mjs', line: 3, rule: 'marmeon(throttle)', reason: "sets the visitor's own language, touches no record" }]);
    expect(found.problems.map((problem) => [problem.line, problem.rule])).toEqual([
      [4, 'marmeon(throttle)'],
      [5, 'marmeon(throttle)'],
      [4, 'marmeon(check-ignore)'],
    ]);
  });

  it('does not let a comment above a group silence the routes inside it', async () => {
    const { root, router } = await load(
      [
        'export default (Route, everyone) => {',
        '  // marmeon-check-ignore throttle: the whole group',
        '  Route.authorize(everyone).prefix("/g").group((Route) => {',
        '    Route.post("/a", () => "x");',
        '  });',
        '};',
        '',
      ].join('\n'),
    );
    const found = run(router, root);
    expect(found.silenced).toEqual([]);
    expect(found.problems.map((problem) => problem.rule)).toEqual(['marmeon(throttle)', 'marmeon(check-ignore)']);
  });
});
