import { CacheServiceProvider } from '@marmeon/cache';
import { createApplication, defineModule, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { GLOBAL, Router, RouteAccessError } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineGuard, type GuardAuth } from './define-guard.ts';
import { Auth, AuthServiceProvider, authenticate, Gate, guest, Hasher, UserProvider, type AuthUser, type PolicyClass } from './index.ts';
import { newRequestGuard, RequestGuard, stampRoutes } from './request-guard.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

interface OfficeUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}
interface ShopUser {
  readonly id: number;
  readonly email: string;
}

// The same id 1 and address in both tables: only the guard tells the accounts apart.
const app = new MemoryUsers<AuthUser>();
const office = new MemoryUsers<OfficeUser>();
const shop = new MemoryUsers<ShopUser>();

class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return office;
  }
}
class ShopUsers extends MemoryUsers<ShopUser> {
  constructor() {
    super();
    return shop;
  }
}

const settings = { loginAttemptsPerMinute: 60, accountSignInsPerDay: 100 };
const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', settings });
const ShopGuard = defineGuard('shop', { users: ShopUsers, tablePrefix: 'shop_', settings });
const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;
const SHOP = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;

class GuardProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
    ShopGuard.register(container);
  }
}

/** A policy of the app that says yes to the user it is asked about; what it saw is counted. */
function appPolicy() {
  const calls = { built: 0, before: 0 };
  class AdminPolicy {
    constructor() {
      calls.built++;
    }
    before(): undefined {
      calls.before++;
      return undefined;
    }
    admin(_user: AuthUser): boolean {
      return true;
    }
  }
  return { AdminPolicy, calls };
}

/** What the global middleware asks: set by each test. */
const asked: { policy: PolicyClass<{ admin(user: AuthUser): boolean }> | undefined; where: 'global' | 'web' } = { policy: undefined, where: 'web' };
/** The guard of the route as the very first middleware saw it, by path. */
const stamps: Record<string, string | undefined> = {};

/** The guard of the route before anything else runs. */
class ProbeStamp {
  static readonly inject = [RequestGuard] as const;
  readonly #request: RequestGuard;
  constructor(request: RequestGuard) {
    this.#request = request;
  }
  handle(ctx: HttpContext, next: () => Promise<Response>) {
    stamps[new URL(ctx.request.url).pathname] = this.#request.name;
    return next();
  }
}

/** One global middleware that asks a policy at once and hands the answers on, as an app does for an admin flag in shared props. */
class AskEarly {
  static readonly inject = [Gate] as const;
  readonly #gate: Gate;
  constructor(gate: Gate) {
    this.#gate = gate;
  }
  async handle(ctx: HttpContext, next: (extension: object) => Promise<Response>) {
    const mode = ctx.request.headers.get('x-ask');
    const policy = asked.policy;
    if (mode === 'none' || policy === undefined) return next({});
    if (mode === 'authorize') {
      await this.#gate.authorize(policy, 'admin');
      return next({});
    }
    if (mode === 'projection') {
      await this.#gate.abilities(policy, ['admin']);
      return next({});
    }
    if (mode === 'rows') {
      await this.#gate.withAbilities([{ id: 1 }] as never, policy, ['admin'] as never);
      return next({});
    }
    const allowed = await this.#gate.allows(policy, 'admin');
    return next({ allowed, can: this.#gate.abilities(policy, ['admin']) });
  }
}

class GlobalProvider implements ServiceProvider {
  boot(application: { container: Container }): void {
    const router = application.container.make(Router);
    router.middleware.append(GLOBAL, ProbeStamp as never);
    // In the global list the session has not started yet, so every user is a guest there; in the `web` group it has, and the app's user is known.
    router.middleware.append(asked.where === 'global' ? GLOBAL : 'web', AskEarly as never);
  }
}

class Act extends Controller {
  readonly #app: Auth;
  readonly #office: GuardAuth<OfficeUser>;
  static readonly inject = [Auth, OfficeGuard.Auth] as const;
  constructor(auth: Auth, officeAuth: GuardAuth<OfficeUser>) {
    super();
    this.#app = auth;
    this.#office = officeAuth;
  }
  async handle(ctx: HttpContext) {
    const guard = ctx.request.headers.get('x-guard');
    const auth = guard === 'office' ? this.#office : this.#app;
    return { ok: (await auth.attempt('ada@example.com', 'secret')).ok };
  }
}

const answer = async (ctx: HttpContext) => {
  const found = ctx as unknown as { allowed?: boolean; can?: PromiseLike<unknown> };
  return { allowed: found.allowed, can: await found.can };
};

const routes = openRoutes((Route) => {
  Route.post('/act', Act);
  Route.get('/login', () => 'app login').name('auth.login');
  Route.get('/office-login', () => 'office login').name('office.login');
  Route.get('/office-home', () => 'office home').name('office.home');
  Route.get('/office-confirm', () => 'office confirm').name('office.confirm');
  Route.get('/public', answer);
  Route.middleware(OfficeGuard.guest(OFFICE)).get('/o/guest', answer);
  Route.middleware(OfficeGuard.authenticate(OFFICE)).get('/o/auth', answer);
  Route.middleware(OfficeGuard.authenticate(OFFICE)).group((Inner) => void Inner.get('/o/group', answer));
  Route.middleware(authenticate()).get('/a/auth', answer);
  Route.middleware(authenticate('api')).get('/api/x', answer);
  Route.middleware(guest({ homeRoute: 'office.home' })).get('/a/guest', answer);
  // The app's guest() names no guard: a package guard's authenticate() beside it is one guard, not two.
  Route.middleware(guest({ homeRoute: 'office.home' })).middleware(OfficeGuard.authenticate(OFFICE)).get('/o/app-guest', answer);
  Route.middleware(OfficeGuard.authenticate(OFFICE)).middleware(OfficeGuard.guest(OFFICE)).get('/o/twice', answer);
});

async function boot(routeList = routes, options: { logger?: Partial<Logger> } = {}) {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger = { debug() {}, info() {}, warn: (message: string) => void warnings.push(message), error: (message: string, context?: unknown) => void errors.push(`${message} ${JSON.stringify(context)}`), child: () => logger, ...options.logger } as unknown as Logger;
  app.rows.clear();
  office.rows.clear();
  shop.rows.clear();
  for (const key of Object.keys(stamps)) delete stamps[key];
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-route-guard-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, GuardProvider, AuthServiceProvider, GlobalProvider],
      modules: [
        defineModule({ name: 'route-guard-test', routes: routeList, migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'office-test', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(Logger, logger);
        container.instance(UserProvider, app as unknown as UserProvider);
      },
    },
  );
  const hash = await application.container.make(Hasher).make('secret');
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  return { application, warnings, errors, start: () => createHttpKernel(application) };
}

async function running(routeList = routes) {
  const booted = await boot(routeList);
  await booted.application.container.make(Migrator).migrate();
  const kernel = booted.start();
  const browser = () => {
    const jar = new Map<string, string>();
    const call = async (path: string, headers: Record<string, string> = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: headers['x-guard'] ? 'POST' : 'GET', headers: { cookie, accept: 'application/json', 'user-agent': 'Test Browser', 'x-ask': 'allows', ...headers }, redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    return { call };
  };
  /** A browser signed in to the guards named. */
  const signedIn = async (...guards: ('app' | 'office')[]) => {
    const b = browser();
    for (const guard of guards) {
      const login = await b.call('/act', { 'x-guard': guard, 'x-ask': 'none' });
      expect(((await login.json()) as { ok: boolean }).ok).toBe(true);
    }
    return b;
  };
  return { ...booted, browser, signedIn };
}

afterEach(() => {
  asked.policy = undefined;
  asked.where = 'web';
  vi.unstubAllEnvs();
});

describe('a global middleware that asks a policy, on the routes of a package guard', () => {
  it.each(['global', 'web'] as const)('lets the login page and the protected pages work when the policy is asked in %s middleware: allows says no, the projection says no, the page answers', async (where) => {
    const { AdminPolicy, calls } = appPolicy();
    asked.policy = AdminPolicy;
    asked.where = where;
    const { signedIn, application } = await running();
    const both = await signedIn('app', 'office');
    // The login page is for a browser that is not signed in to the office; the app's sign-in is no matter.
    const appOnly = await signedIn('app');
    for (const [browser, path] of [[appOnly, '/o/guest'], [both, '/o/auth'], [both, '/o/group']] as const) {
      const response = await browser.call(path);
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toEqual({ allowed: false, can: { admin: false } });
    }
    expect(calls, 'the policy of the app was never asked: not built, no before(), no user loaded').toEqual({ built: 0, before: 0 });
    await application.shutdown();
  });

  it('answers as before on the app\'s own routes and on a public page', async () => {
    const { AdminPolicy, calls } = appPolicy();
    asked.policy = AdminPolicy;
    vi.stubEnv('NODE_ENV', 'development');
    const { signedIn, application, warnings } = await running();
    const both = await signedIn('app', 'office');
    for (const path of ['/a/auth', '/public']) {
      const response = await both.call(path);
      expect(response.status, path).toBe(200);
      // The public page has the app's user too: a page that asks `can('edit this page')` there still works.
      expect(await response.json(), path).toEqual({ allowed: true, can: { admin: true } });
    }
    expect(calls.built).toBeGreaterThan(0);
    expect(warnings, 'no stamp or the app\'s own guard: no warning, in development too').toEqual([]);
    await application.shutdown();
  });

  it('answers 403 for authorize(), never 200, and never asks the policy of the app', async () => {
    const { AdminPolicy, calls } = appPolicy();
    asked.policy = AdminPolicy;
    const { signedIn, application } = await running();
    const both = await signedIn('app', 'office');
    for (const path of ['/o/auth', '/o/guest', '/o/group']) {
      const response = await both.call(path, { 'x-ask': 'authorize' });
      expect(response.status, path).toBe(403);
    }
    expect(calls).toEqual({ built: 0, before: 0 });
    expect((await both.call('/a/auth', { 'x-ask': 'authorize' })).status, 'the app\'s route is unchanged').toBe(200);
    expect(calls.built).toBeGreaterThan(0);
    await application.shutdown();
  });

  it('warns once in development, naming the policy and both guards, and never in production', async () => {
    const { AdminPolicy } = appPolicy();
    asked.policy = AdminPolicy;
    const { signedIn, warnings, application } = await running();
    const both = await signedIn('app', 'office');
    vi.stubEnv('NODE_ENV', 'production');
    await both.call('/o/auth?secret=hunter2');
    expect(warnings, 'production').toEqual([]);
    vi.stubEnv('NODE_ENV', 'development');
    await both.call('/o/auth?secret=hunter2');
    await both.call('/o/group?secret=hunter2');
    const text = warnings.join('\n');
    expect(warnings, 'once per policy and guard of the route, over two requests and two routes').toHaveLength(1);
    expect(text).toContain('A9');
    expect(text).toContain('AdminPolicy');
    expect(text).toContain("'web'");
    expect(text).toContain("'office'");
    expect(text).not.toMatch(/hunter2|\/o\/auth|secret/);
    await application.shutdown();
  });
});

describe('the warning of a projection', () => {
  it.each([
    ['abilities', 'projection'],
    ['withAbilities', 'rows'],
  ])('names Gate.%s() when that is what asked', async (method, mode) => {
    const { AdminPolicy } = appPolicy();
    asked.policy = AdminPolicy;
    const { signedIn, warnings, application } = await running();
    const both = await signedIn('app', 'office');
    vi.stubEnv('NODE_ENV', 'development');
    await both.call('/o/auth', { 'x-ask': mode });
    expect(warnings.join('\n')).toContain(`Gate.${method}()`);
    await application.shutdown();
  });
});

describe('the guard of a route before its first middleware', () => {
  it('is known to the first global middleware: named, inherited from a group, from guest() of a package guard, from the app', async () => {
    const { signedIn, application } = await running();
    const both = await signedIn('app', 'office');
    for (const path of ['/o/guest', '/o/auth', '/o/group', '/a/auth', '/api/x', '/public', '/a/guest', '/o/app-guest']) await both.call(path, { 'x-ask': 'none' });
    expect(stamps).toMatchObject({
      '/o/auth': 'office',
      '/o/group': 'office',
      '/o/guest': 'office',
      '/o/app-guest': 'office',
      '/a/auth': 'web',
      '/api/x': 'api',
    });
    // No middleware names a guard: no stamp, and the app's `guest()` is no name.
    expect(stamps['/public']).toBeUndefined();
    expect(stamps['/a/guest']).toBeUndefined();
    await application.shutdown();
  });
});

describe('a route whose middleware name two guards', () => {
  const only = (register: (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => void) =>
    openRoutes((Route) => {
      Route.get('/office-login', () => 'x').name('office.login');
      register(Route);
    });

  it.each([
    ['the package guard\'s guest() and the app\'s authenticate()', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => Route.middleware(OfficeGuard.guest(OFFICE)).middleware(authenticate()).get('/mixed', () => 'x')],
    ['two package guards\' guest()', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => Route.middleware(OfficeGuard.guest(OFFICE)).middleware(ShopGuard.guest(SHOP)).get('/mixed', () => 'x')],
    ['the app\'s authenticate() from a group and a package guard\'s guest() on the route', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => Route.middleware(authenticate()).group((Inner) => void Inner.middleware(OfficeGuard.guest(OFFICE)).get('/mixed', () => 'x'))],
    ['the app\'s token guard and a package guard', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => Route.middleware(authenticate('api')).middleware(OfficeGuard.authenticate(OFFICE)).get('/mixed', () => 'x')],
  ])('stops the start with A9 and the path, for %s', async (_what, register) => {
    const { application, start } = await boot(only(register));
    expect(start).toThrow(RouteAccessError);
    expect(start).toThrow(/\[marmeon:A9\].*GET \/mixed: .*a route belongs to one guard/s);
    await application.shutdown();
  });

  it('is found the same way for a global middleware that names a guard', async () => {
    const { application, start } = await boot(only((Route) => void Route.middleware(OfficeGuard.authenticate(OFFICE)).get('/mixed', () => 'x')));
    expect(start).not.toThrow();
    application.container.make(Router).middleware.append(GLOBAL, authenticate());
    expect(start).toThrow(/A9/);
    await application.shutdown();
  });

  it.each([
    ['one package guard, twice', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => Route.middleware(OfficeGuard.guest(OFFICE)).group((Inner) => void Inner.middleware(OfficeGuard.authenticate(OFFICE)).get('/fine', () => 'x'))],
    ['the app\'s guest() and a package guard', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => Route.middleware(guest({ homeRoute: 'office.login' })).middleware(OfficeGuard.authenticate(OFFICE)).get('/fine', () => 'x')],
    ['a package guard on one route and another on the next', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => {
      Route.middleware(OfficeGuard.authenticate(OFFICE)).get('/fine', () => 'x');
      Route.middleware(ShopGuard.authenticate(SHOP)).get('/fine-too', () => 'x');
    }],
    ['a group of the app\'s guard and a route of another group', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => {
      Route.middleware(authenticate()).group((Inner) => void Inner.get('/fine', () => 'x'));
      Route.middleware(OfficeGuard.guest(OFFICE)).get('/fine-too', () => 'x');
    }],
    ['no guard middleware at all', (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => Route.get('/fine', () => 'x')],
  ])('starts with %s', async (_what, register) => {
    const { application, start } = await boot(only(register));
    expect(start).not.toThrow();
    expect(application.container.make(Router).pipelineProblems()).toEqual([]);
    await application.shutdown();
  });

  it('takes the app\'s session and token guard together: no A9 (the two `user` keys are the other start check\'s business)', async () => {
    const { application } = await boot(only((Route) => void Route.middleware(authenticate('api')).middleware(authenticate()).get('/fine', () => 'x')));
    expect(application.container.make(Router).pipelineProblems()).toEqual([]);
    await application.shutdown();
  });

  it('fails the first request with the same A9 when the start check is bypassed (router.dispatch called by hand)', async () => {
    const { application } = await boot(only((Route) => void Route.middleware(OfficeGuard.guest(OFFICE)).middleware(authenticate()).get('/mixed', () => 'x')));
    const router = application.container.make(Router);
    const scope = application.container.createScope();
    const route = router.routes.find((found) => found.path === '/mixed')!;
    await expect(router.dispatch(route, { request: new Request('http://app.test/mixed'), params: {} }, { resolve: (Class) => scope.make(Class as never) })).rejects.toThrow(/A9/);
    await application.shutdown();
  });
});

describe('a guard middleware the router does not see', () => {
  it('is refused with A9 after a policy decided on the request: the controller never runs as the other user', async () => {
    const { AdminPolicy } = appPolicy();
    asked.policy = AdminPolicy;
    const Inner = OfficeGuard.authenticate(OFFICE) as unknown as (new (...args: never[]) => { handle(ctx: HttpContext, next: () => Promise<Response>): Promise<Response> }) & { inject: readonly never[] };
    // Another middleware calls the guard's: the list of the route has no middleware that names a guard, so the route has no stamp.
    class CallsAuthenticate {
      static readonly inject = Inner.inject;
      readonly #inner: InstanceType<typeof Inner>;
      constructor(...args: never[]) {
        this.#inner = new Inner(...args);
      }
      handle(ctx: HttpContext, next: () => Promise<Response>) {
        return this.#inner.handle(ctx, next);
      }
    }
    let ran = false;
    const routeList = openRoutes((Route) => {
      Route.post('/act', Act);
      Route.get('/office-login', () => 'x').name('office.login');
      Route.get('/login', () => 'app login').name('auth.login');
      Route.middleware(CallsAuthenticate as never).get('/hidden', () => {
        ran = true;
        return 'office page';
      });
    });
    // Signed in to both guards: without the note of the policy's decision the guard's middleware would pass and the controller run as the editor.
    const booted = await running(routeList);
    const both = await booted.signedIn('app', 'office');
    const response = await both.call('/hidden');
    expect(response.status, 'the route had no stamp: the policy was asked, and the guard that names itself afterwards is refused').toBe(500);
    expect(booted.errors.join('\n')).toMatch(/A9.*'office'.*policy of 'web'/s);
    expect(ran).toBe(false);
    await booted.application.shutdown();
  });

  it('is wired once per router, however often a provider step asks', async () => {
    const router = new Router().load(openRoutes((Route) => void Route.middleware(OfficeGuard.guest(OFFICE)).middleware(authenticate()).get('/mixed', () => 'x')));
    stampRoutes(router);
    stampRoutes(router);
    expect(router.pipelineProblems(), 'one finding, not one per call').toHaveLength(1);
    const only = new Router().load(openRoutes((Route) => void Route.middleware(OfficeGuard.authenticate(OFFICE)).get('/one', () => 'x')));
    stampRoutes(only);
    stampRoutes(only);
    let stamps = 0;
    const request = newRequestGuard();
    const original = request.stamp.bind(request);
    request.stamp = (guard) => (stamps++, original(guard));
    const resolve = ((Class: unknown) => {
      if (Class === RequestGuard) return request;
      throw new Error('stop after the hook');
    }) as never;
    await only.dispatch(only.routes[0]!, { request: new Request('http://app.test/one'), params: {} }, { resolve, onError: () => new Response(null, { status: 500 }) });
    expect(stamps).toBe(1);
  });
});
