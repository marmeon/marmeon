import { CacheServiceProvider, RateLimiter, throttle } from '@marmeon/cache';
import { createApplication, defineModule, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { Router } from '@marmeon/router';
import { ensuresOf } from '@marmeon/router/internal';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { defineGuard, type GuardAuth } from './define-guard.ts';
import { abilities, Auth, AuthServiceProvider, authenticate, can, confirmedPassword, Gate, guest, Hasher, UserProvider, verified, type AuthUser } from './index.ts';
import { twoFactor } from './two-factor/middleware.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';

interface OfficeUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

// The same id 1 and address in both tables: only the guard tells the accounts apart.
const app = new MemoryUsers<AuthUser>();
const office = new MemoryUsers<OfficeUser>();

class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return office;
  }
}

const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', settings: { loginAttemptsPerMinute: 60, accountSignInsPerDay: 100 } });
type OfficeAuth = GuardAuth<OfficeUser>;
const OfficeAuth = OfficeGuard.Auth;

class OfficeProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
  }
}

/** The app says yes to everybody it knows: a policy that decided on the wrong user would let a request through. */
class OpenPolicy {
  view(_user: AuthUser): boolean {
    return true;
  }
}

class AppAct extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const action = ctx.request.headers.get('x-action');
    if (action === 'login') return { ok: (await this.#auth.attempt('ada@example.com', 'secret')).ok };
    if (action === 'confirm') return { ok: (await this.#auth.checkPassword('secret')).ok };
    return { unknown: true };
  }
}

class OfficeAct extends Controller {
  readonly #auth: OfficeAuth;
  constructor(auth: OfficeAuth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const action = ctx.request.headers.get('x-action');
    if (action === 'login') return { ok: (await this.#auth.attempt('ada@example.com', 'secret')).ok };
    if (action === 'confirm') return { ok: (await this.#auth.checkPassword('secret')).ok };
    // A sign-in without a password: the window of a password confirmation stays closed.
    if (action === 'as') return { ok: (await this.#auth.signIn(office.rows.get(1)!.user)) === 'signed-in' };
    return { unknown: true };
  }
}

/** Asks the gate in a controller, by the method named in the path; what it throws is the answer. */
class AskGate extends Controller {
  readonly #gate: Gate;
  constructor(gate: Gate) {
    super();
    this.#gate = gate;
  }
  async handle(ctx: HttpContext<{}, { method: string }>) {
    try {
      switch (ctx.params.method) {
        case 'allows':
          return { value: await this.#gate.allows(OpenPolicy, 'view') };
        case 'denies':
          return { value: await this.#gate.denies(OpenPolicy, 'view') };
        case 'authorize':
          await this.#gate.authorize(OpenPolicy, 'view');
          return { value: true };
        case 'inspect':
          return { value: (await this.#gate.inspect(OpenPolicy, 'view')).allowed };
        case 'abilities':
          return { value: await this.#gate.abilities(OpenPolicy, ['view']) };
        case 'withAbilities':
          return { value: await this.#gate.withAbilities([{ id: 1 }] as never, OpenPolicy, ['view'] as never) };
        default:
          return { unknown: true };
      }
    } catch (error) {
      return { threw: (error as Error).message };
    }
  }
}

const Verified = verified();

/** The starter kit's wrapper: `verified()` built by hand with the router alone, so it has no stamp to read. */
class HandBuiltVerified {
  readonly #verified: InstanceType<typeof Verified>;
  constructor(router: Router) {
    this.#verified = new Verified(router);
  }
  handle(ctx: HttpContext<{ readonly user: never }>, next: () => Promise<Response>) {
    return this.#verified.handle(ctx as never, next as never);
  }
}

/** A middleware ahead of every guard's: it hands the page an abilities projection, which is computed when the page renders. */
class ProjectEarly {
  static readonly adds = ['abilities'] as const;
  readonly #gate: Gate;
  constructor(gate: Gate) {
    this.#gate = gate;
  }
  handle(_ctx: HttpContext, next: (extension: object) => Promise<Response>) {
    return next({ abilities: this.#gate.abilities(OpenPolicy, ['view']) });
  }
}

/** A middleware that asks a policy before any guard's `authenticate()`: it judges the app's user, so the route is the app's from there. */
class AuthorizeEarly {
  readonly #gate: Gate;
  constructor(gate: Gate) {
    this.#gate = gate;
  }
  async handle(_ctx: HttpContext, next: () => Promise<Response>) {
    await this.#gate.authorize(OpenPolicy, 'view');
    return next();
  }
}

/** Makes a projection and awaits it ahead of any guard's `authenticate()`: the policy has judged the app's user by then. */
class ProjectAndAwaitEarly {
  readonly #gate: Gate;
  constructor(gate: Gate) {
    this.#gate = gate;
  }
  async handle(_ctx: HttpContext, next: () => Promise<Response>) {
    await this.#gate.abilities(OpenPolicy, ['view']);
    return next();
  }
}

const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;

const routes = openRoutes((Route) => {
  Route.post('/app', AppAct);
  Route.post('/office', OfficeAct);
  Route.get('/login', () => 'app login').name('auth.login');
  Route.get('/confirm', () => 'app confirm').name('auth.password.confirm');
  Route.get('/office-login', () => 'office login').name('office.login');
  Route.get('/office-home', () => 'office home').name('office.home');
  Route.get('/office-confirm', () => 'office confirm').name('office.confirm');

  const officeOnly = Route.middleware(OfficeGuard.authenticate(OFFICE));
  const appOnly = Route.middleware(authenticate());
  officeOnly.get('/r/office', () => 'office page');
  officeOnly.middleware(OfficeGuard.confirmedPassword(OFFICE)).get('/r/office-sudo', () => 'office sudo page');
  officeOnly.middleware(confirmedPassword()).get('/r/office-app-sudo', () => 'confirmed with the app window');
  appOnly.middleware(OfficeGuard.confirmedPassword(OFFICE)).get('/r/app-office-sudo', () => 'confirmed with the office window');
  officeOnly.middleware(twoFactor({ setup: 'office.confirm', verify: 'office.confirm' })).get('/r/office-two-factor', () => 'app two factor');
  officeOnly.middleware(HandBuiltVerified as never).get('/r/office-hand-verified', () => 'hand built');
  officeOnly.middleware(verified() as never).get('/r/office-verified', () => 'app verification');
  // The types refuse most mixtures; the casts are an untyped caller's.
  Route.middleware(OfficeGuard.confirmedPassword(OFFICE) as never).get('/r/sudo-without-authenticate', () => 'no stamp');
  Route.middleware(confirmedPassword() as never).middleware(OfficeGuard.authenticate(OFFICE)).get('/r/sudo-then-office', () => 'mixed');
  Route.middleware(OfficeGuard.guest(OFFICE)).get('/r/office-guest', () => 'office guest page');
  Route.middleware(guest({ homeRoute: 'office.home' })).get('/r/app-guest', () => 'app guest page');
  officeOnly.authorize(can(OpenPolicy, 'view')).get('/r/office-can', () => 'policy');
  appOnly.authorize(can(OpenPolicy, 'view')).get('/r/app-can', () => 'policy');
  Route.middleware(ProjectEarly as never)
    .middleware(OfficeGuard.authenticate(OFFICE))
    .get('/r/late-projection', async (ctx: HttpContext) => {
      try {
        return { value: await (ctx as unknown as { abilities: PromiseLike<unknown> }).abilities };
      } catch (error) {
        return { threw: (error as Error).message };
      }
    });
  Route.middleware(AuthorizeEarly as never).middleware(OfficeGuard.authenticate(OFFICE)).get('/r/early-policy', () => 'office page');
  Route.middleware(ProjectAndAwaitEarly as never).middleware(OfficeGuard.authenticate(OFFICE)).get('/r/early-projection', () => 'office page');
  officeOnly.get('/r/office-gate/:method', AskGate);
  appOnly.get('/r/app-gate/:method', AskGate);
  officeOnly.middleware(OfficeGuard.throttle('passkey-confirm-options')).get('/r/office-throttle', () => 'ok');
  appOnly.middleware(OfficeGuard.throttle('login')).get('/r/app-throttle', () => 'ok');
  Route.middleware(authenticate()).middleware(throttle('auth.passkey-confirm-options')).get('/r/app-limit', () => 'ok');
  Route.middleware(authenticate('api')).middleware(abilities('x')).get('/r/api', () => 'api');
});

async function boot() {
  /** What the server logged as an error: the response of a failure says only "Server Error". */
  const failures: string[] = [];
  const logger: Logger = { debug() {}, info() {}, warn() {}, error: (message, context) => void failures.push(`${message} ${JSON.stringify(context)}`), child: () => logger } as Logger;
  app.rows.clear();
  office.rows.clear();
  const application = await createApplication(
    {
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, OfficeProvider, AuthServiceProvider],
      modules: [
        defineModule({ name: 'package-routes-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
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
  await application.container.make(Migrator).migrate();
  const hash = await application.container.make(Hasher).make('secret');
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  const kernel = createHttpKernel(application);

  const browser = () => {
    const jar = new Map<string, string>();
    const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method, headers: { cookie, accept: 'application/json', 'user-agent': 'Test Browser', ...headers }, redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const act = async (guard: 'app' | 'office', action: string) => ((await (await call('POST', `/${guard}`, { 'x-action': action })).json()) as { ok: boolean }).ok;
    return { call, act };
  };
  /** A browser signed in to the guards named, each with its password window open. */
  const signedIn = async (...guards: ('app' | 'office')[]) => {
    const b = browser();
    for (const guard of guards) {
      expect(await b.act(guard, 'login')).toBe(true);
      expect(await b.act(guard, 'confirm')).toBe(true);
    }
    return b;
  };
  return { application, signedIn, browser, failures };
}

/** The route fails with error A9: a 500 on its own could be any bug. */
async function expectA9(b: { call(method: string, path: string): Promise<Response> }, failures: string[], path: string): Promise<void> {
  const before = failures.length;
  expect((await b.call('GET', path)).status, path).toBe(500);
  expect(failures.slice(before).join('\n'), path).toContain('A9');
}

describe('the routes of a package guard', () => {
  it('refuses the app\'s password window on a route of the package guard, though that window is open (A9)', async () => {
    const { signedIn, failures } = await boot();
    const both = await signedIn('app', 'office');
    expect((await both.call('GET', '/r/office-sudo')).status, 'the guard\'s own middleware, its own window').toBe(200);
    await expectA9(both, failures, '/r/office-app-sudo');
  });

  it('says in the log which two guards met: the guard of the route and the guard the middleware asks', async () => {
    const { signedIn, failures } = await boot();
    const both = await signedIn('app', 'office');
    await both.call('GET', '/r/office-app-sudo');
    await both.call('GET', '/r/app-office-sudo');
    const text = failures.join('\n');
    expect(text).toContain('A9');
    expect(text).toMatch(/confirmedPassword\(\) asks the app's guard, but this route belongs to the guard 'office'/);
    expect(text).toMatch(/confirmedPassword\(\) of the guard 'office'.*|acts for the guard 'office', but this route belongs to 'web'/);
  });

  it('refuses the package guard\'s password window on a route of the app (A9)', async () => {
    const { signedIn, failures } = await boot();
    const both = await signedIn('app', 'office');
    await expectA9(both, failures, '/r/app-office-sudo');
  });

  it('refuses the package guard\'s confirmation without the guard\'s own authenticate() before it, and a password window ahead of the guard\'s authenticate()', async () => {
    const { signedIn, failures } = await boot();
    const both = await signedIn('app', 'office');
    for (const path of ['/r/sudo-without-authenticate', '/r/sudo-then-office']) {
      await expectA9(both, failures, path);
    }
  });

  it('refuses the app\'s second factor and e-mail verification on a route of the package guard (A9)', async () => {
    const { signedIn, failures } = await boot();
    const both = await signedIn('app', 'office');
    await expectA9(both, failures, '/r/office-two-factor');
    await expectA9(both, failures, '/r/office-verified');
    await expectA9(both, failures, '/r/office-hand-verified');
  });

  it('lets a guest of the package guard through to nothing: 302 to the login page, 401 for JSON, and the app\'s sign-in does not count', async () => {
    const { browser, signedIn } = await boot();
    const guest = browser();
    const away = await guest.call('GET', '/r/office', { accept: 'text/html' });
    expect(away.status).toBe(302);
    expect(new URL(away.headers.get('location')!, 'https://example.com').pathname).toBe('/office-login');
    expect((await guest.call('GET', '/r/office')).status).toBe(401);

    const onlyApp = await signedIn('app');
    expect((await onlyApp.call('GET', '/r/office')).status, 'signed in to the app only').toBe(401);
    const onlyOffice = await signedIn('office');
    expect((await onlyOffice.call('GET', '/r/office')).status).toBe(200);
    expect((await onlyOffice.call('GET', '/r/office-sudo')).status).toBe(200);
  });

  it('asks for the guard\'s own confirmation page when its window is closed', async () => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.act('office', 'as')).toBe(true);
    expect((await b.call('GET', '/r/office-sudo')).status).toBe(423);
    const page = await b.call('GET', '/r/office-sudo', { accept: 'text/html' });
    expect(page.status).toBe(302);
    expect(new URL(page.headers.get('location')!, 'https://example.com').pathname).toBe('/office-confirm');
  });

  it('lets the app\'s user pass guest() of the package guard, and sends the guard\'s own user home', async () => {
    const { signedIn } = await boot();
    const onlyApp = await signedIn('app');
    expect((await onlyApp.call('GET', '/r/office-guest')).status, 'an app user is a guest of the package guard').toBe(200);
    const onlyOffice = await signedIn('office');
    const home = await onlyOffice.call('GET', '/r/office-guest');
    expect(home.status).toBe(302);
    expect(new URL(home.headers.get('location')!, 'https://example.com').pathname).toBe('/office-home');
  });

  it('counts the package guard\'s user 1 apart from the app\'s user 1 in a limit', async () => {
    const { signedIn } = await boot();
    const both = await signedIn('app', 'office');
    for (let attempt = 1; attempt <= 10; attempt++) expect((await both.call('GET', '/r/office-throttle')).status, `office ${attempt}`).toBe(200);
    expect((await both.call('GET', '/r/office-throttle')).status, 'office 11').toBe(429);
    expect((await both.call('GET', '/r/app-limit')).status, 'app 1 has its own count').toBe(200);
  });

  it('defines the guard\'s own copy of every limit, and the app\'s replaces it by name', async () => {
    const { application } = await boot();
    const limiter = application.container.make(RateLimiter);
    expect(limiter.limiter('auth.office.login')).toBeTypeOf('function');
    expect(limiter.limiter('auth.office.passkey-confirm-options')).toBeTypeOf('function');
    expect(limiter.limiter('auth.office.office')).toBeUndefined();
    expect(limiter.limiter('auth.office.verification'), 'a guard has no e-mail verification').toBeUndefined();
    expect(limiter.limiter('auth.office.email-change')).toBeUndefined();
  });

  it('gives a route with the guard\'s throttle() the rate-limited mark that marmeon check reads, and refuses a name that is not a limit', () => {
    expect(ensuresOf(OfficeGuard.throttle('login'))).toContain('rate-limited');
    expect(ensuresOf(OfficeGuard.authenticate(OFFICE))).toContain('authenticated');
    expect(() => OfficeGuard.throttle('nothing' as never)).toThrow(TypeError);
    expect(() => OfficeGuard.throttle('verification' as never)).toThrow(TypeError);
  });

  it('needs the guard\'s own pages, also from a caller TypeScript does not check (the types refuse it in define-guard.type-test.ts)', () => {
    expect(() => OfficeGuard.authenticate({} as never)).toThrow(TypeError);
    expect(() => OfficeGuard.guest({} as never)).toThrow(TypeError);
    expect(() => OfficeGuard.confirmedPassword({} as never)).toThrow(TypeError);
  });
});

describe('the gate on the routes of a package guard', () => {
  it('says no to a policy that asks ahead of the guard\'s authenticate(), because the route is the guard\'s from the start', async () => {
    const { signedIn, failures } = await boot();
    const both = await signedIn('app', 'office');
    const before = failures.length;
    // The policy would say yes to the app's user 1; the route belongs to `office`.
    expect((await both.call('GET', '/r/early-policy')).status).toBe(403);
    expect((await both.call('GET', '/r/early-projection')).status).toBe(200);
    expect(failures.slice(before).join('\n')).not.toContain('A9');
  });

  it('answers false for a projection made ahead of the guard\'s authenticate() when the page computes it', async () => {
    const { signedIn } = await boot();
    const both = await signedIn('app', 'office');
    const answer = (await (await both.call('GET', '/r/late-projection')).json()) as { threw?: string; value?: unknown };
    expect(answer).toEqual({ value: { view: false } });
  });

  it('answers 403 for can(), though the policy would say yes to the app\'s user of the same id', async () => {
    const { signedIn } = await boot();
    const both = await signedIn('app', 'office');
    expect((await both.call('GET', '/r/office-can')).status).toBe(403);
    expect((await both.call('GET', '/r/app-can')).status, 'a route of the app is unchanged').toBe(200);
  });

  it.each([
    ['allows', false],
    ['denies', true],
    ['authorize', 'AuthorizationError'],
    ['inspect', false],
    ['abilities', { view: false }],
    ['withAbilities', [{ id: 1, can: { view: false } }]],
  ])('answers no to Gate.%s() in a controller of the package guard, and as before on a route of the app', async (method, no) => {
    const { signedIn } = await boot();
    const both = await signedIn('app', 'office');
    const refused = (await (await both.call('GET', `/r/office-gate/${method}`)).json()) as { threw?: string; value?: unknown };
    if (no === 'AuthorizationError') expect(refused.threw, method).toMatch(/unauthorized/i);
    else expect(refused, method).toEqual({ value: no });
    const answered = (await (await both.call('GET', `/r/app-gate/${method}`)).json()) as { threw?: string; value?: unknown };
    expect(answered.threw, method).toBeUndefined();
    expect(answered.value).not.toBeUndefined();
    expect(answered.value, 'the same policy says yes on the app\'s route').not.toEqual(no);
  });
});
