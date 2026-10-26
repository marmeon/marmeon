import type { HttpContext, Next } from '@marmeon/http';
import { GLOBAL, Router, type RouteDefinition } from '@marmeon/router';
import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SESSION_PATH } from '@marmeon/http/internal';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

async function kernelFor(routes: ReturnType<typeof openRoutes>) {
  const app = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'greedy', routes })],
  }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });
  return createHttpKernel(app);
}

describe('framework routes against greedy app routes', () => {
  it.each([
    ['a catch-all parameter', '/:page{.+}', '/some/page'],
    ['a wildcard', '/*', '/some/page'],
    ['a parameter before a literal', '/:a/session', '/x/session'],
  ])('are not hidden by %s', async (_name, path, other) => {
    const kernel = await kernelFor(
      openRoutes((Route) => {
        Route.get(path, () => 'app');
      }),
    );
    const response = await kernel.request(SESSION_PATH);
    expect(response.headers.get('content-type')).toMatch(/json/);
    expect(await response.json()).toHaveProperty('epoch');
    // The app's own route still answers everything else.
    expect(await (await kernel.request(other)).text()).toBe('app');
  });
});

describe('unknown paths under /_marmeon/', () => {
  const seen = { global: 0, group: 0, route: 0 };
  class GlobalSpy {
    handle(_ctx: HttpContext, next: Next<{}>) {
      seen.global++;
      return next();
    }
  }
  class GroupSpy {
    handle(_ctx: HttpContext, next: Next<{}>) {
      seen.group++;
      return next();
    }
  }
  class RouteSpy {
    handle(_ctx: HttpContext, next: Next<{}>) {
      seen.route++;
      return next();
    }
  }
  const greedy = async (spy: () => void, mark?: (route: RouteDefinition) => void, forge = false) => {
    seen.global = seen.group = seen.route = 0;
    const app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider],
      modules: [
        defineModule({
          name: 'greedy',
          routes: openRoutes((Route) => {
            const forged = Route.middleware(RouteSpy).any('/:page{.+}', () => {
              spy();
              return 'app';
            });
            if (forge) forged.reserved = true;
          }),
        }),
      ],
    }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });
    const router = app.container.make(Router);
    router.middleware.append(GLOBAL, GlobalSpy);
    router.middleware.append('web', GroupSpy);
    for (const route of router.routes) mark?.(route);
    return createHttpKernel(app);
  };

  it.each([
    ['an unknown path', '/_marmeon/x'],
    ['the bare prefix', '/_marmeon'],
    ['a deeper path', '/_marmeon/a/b/c'],
    ['another case', '/_MARMEON/x'],
    ['an encoded underscore', '/%5Fmarmeon/x'],
    ['a doubled slash', '//_marmeon/x'],
  ])('end in 404 before a wildcard of the app: %s', async (_name, path) => {
    let runs = 0;
    const kernel = await greedy(() => runs++);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'DELETE']) {
      const response = await kernel.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(runs).toBe(0);
    // Only the global middleware runs (five methods); the group's and the route's never do.
    expect(seen).toEqual({ global: 5, group: 0, route: 0 });
  });

  it('do not trust a route that says it is reserved (it cannot be set after loading)', async () => {
    let runs = 0;
    const kernel = await greedy(() => runs++, (route) => {
      expect(() => {
        route.reserved = false; // a loaded route is frozen
      }).toThrow(TypeError);
    }, true);
    expect((await kernel.request('/_marmeon/x')).status).toBe(404);
    expect(runs).toBe(0);
  });

  it('leave the framework routes and the rest of the app alone', async () => {
    let runs = 0;
    const kernel = await greedy(() => runs++);
    expect((await kernel.request(SESSION_PATH)).headers.get('content-type')).toMatch(/json/);
    expect(await (await kernel.request('/_marmeonic/x')).text()).toBe('app');
    expect(await (await kernel.request('/other/_marmeon/x')).text()).toBe('app');
    expect(runs).toBe(2);
  });
});
