import { CacheServiceProvider, RateLimiter } from '@marmeon/cache';
import { createApplication, defineModule, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, secret } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider, SessionStore, sessionKey } from '@marmeon/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineGuard, type GuardAuth, type GuardTwoFactor } from './define-guard.ts';
import { AUTH_SESSION_KEYS } from './auth.ts';
import { Auth, AuthServiceProvider, authenticate, Hasher, TwoFactorState, TwoFactorStore, UserProvider, type AuthUser } from './index.ts';
import { guardNames } from './guard-names.ts';
import { twoFactorCode } from './testing.ts';
import { confirmedSecondFactor, twoFactor } from './two-factor/index.ts';
import { TwoFactor } from './two-factor/two-factor.ts';
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

const OfficeGuard = defineGuard('office', {
  users: OfficeUsers,
  tablePrefix: 'office_',
  twoFactor: TwoFactor,
  settings: { loginAttemptsPerMinute: 60, accountSignInsPerDay: 1000, twoFactorIssuer: 'Back Office' },
});
type OfficeAuth = GuardAuth<OfficeUser>;
const OfficeAuth = OfficeGuard.Auth;
type OfficeTwoFactor = GuardTwoFactor<OfficeUser>;
const OfficeTwoFactor = OfficeGuard.TwoFactor;

class OfficeProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
  }
}

/** One action of a guard's `Auth` and `TwoFactor`, named by the request: both guards run the same ones. */
async function act(auth: GuardAuth<{ readonly id: number }>, factor: GuardTwoFactor<{ readonly id: number }>, ctx: HttpContext): Promise<Record<string, unknown>> {
  const body = (await ctx.input()) as Record<string, any>;
  switch (ctx.request.headers.get('x-action')) {
    case 'login': {
      const done = await auth.attempt('ada@example.com', 'secret');
      return done.ok ? { ok: true } : { ok: false, kind: done.error.kind };
    }
    case 'who':
      return { id: (await auth.user())?.id ?? null };
    case 'begin': {
      const setup = await factor.begin();
      return { secret: setup.secret, uri: setup.uri };
    }
    case 'confirm': {
      const done = await factor.confirm(body.code, 'secret');
      return done.ok ? { ok: true, recoveryCodes: done.value.recoveryCodes } : { ok: false, ...done.error };
    }
    case 'challenge': {
      const done = await factor.challenge(body as never);
      return done.ok ? { ok: true, id: done.value.id } : { ok: false, ...done.error };
    }
    case 'step-up': {
      const done = await factor.stepUp(body as never);
      return done.ok ? { ok: true } : { ok: false, ...done.error };
    }
    case 'status':
      return { ...(await factor.status()) };
    default:
      return { error: 'unknown' };
  }
}

/** Ends the guard's sign-in in the middle of a stack, as only a middleware between `authenticate()` and the factor middleware can. */
class OfficeSignOut {
  static readonly inject = [OfficeAuth] as const;
  readonly #auth: OfficeAuth;
  constructor(auth: OfficeAuth) {
    this.#auth = auth;
  }
  async handle(_ctx: HttpContext, next: () => Promise<Response>): Promise<Response> {
    await this.#auth.signOut();
    return next();
  }
}

class AppAct extends Controller {
  readonly #auth: Auth;
  readonly #factor: TwoFactor;
  constructor(auth: Auth, factor: TwoFactor) {
    super();
    this.#auth = auth;
    this.#factor = factor;
  }
  handle(ctx: HttpContext) {
    return act(this.#auth, this.#factor as never, ctx);
  }
}

// The alias and the constant of the same name: the injection reads the type's name and finds the guard's token.
class OfficeAct extends Controller {
  readonly #auth: OfficeAuth;
  readonly #factor: OfficeTwoFactor;
  constructor(auth: OfficeAuth, factor: OfficeTwoFactor) {
    super();
    this.#auth = auth;
    this.#factor = factor;
  }
  handle(ctx: HttpContext) {
    return act(this.#auth, this.#factor, ctx);
  }
}

const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;
const OFFICE_FACTOR = { setup: 'office.setup', verify: 'office.verify' } as const;

const routes = openRoutes((Route) => {
  Route.post('/app', AppAct);
  Route.post('/office', OfficeAct);
  for (const [path, name] of [['/login', 'auth.login'], ['/app-setup', 'app.setup'], ['/app-verify', 'app.verify'], ['/office-login', 'office.login'], ['/office-home', 'office.home'], ['/office-confirm', 'office.confirm'], ['/office-setup', 'office.setup'], ['/office-verify', 'office.verify']] as const) {
    Route.get(path, () => name).name(name);
  }
  const appOnly = Route.middleware(authenticate());
  const officeOnly = Route.middleware(OfficeGuard.authenticate(OFFICE));
  appOnly.middleware(twoFactor({ setup: 'app.setup', verify: 'app.verify' })).get('/r/app-area', () => 'app area');
  officeOnly.middleware(OfficeGuard.twoFactor(OFFICE_FACTOR)).get('/r/office-area', () => 'office area');
  officeOnly.middleware(OfficeGuard.confirmedSecondFactor({ verify: 'office.verify' })).get('/r/office-confirmed', () => 'office confirmed');
  officeOnly.middleware(OfficeSignOut as never).middleware(OfficeGuard.twoFactor(OFFICE_FACTOR)).get('/r/office-signed-out-two-factor', () => 'signed out');
  officeOnly.middleware(OfficeSignOut as never).middleware(OfficeGuard.confirmedSecondFactor({ verify: 'office.verify' })).get('/r/office-signed-out-confirmed', () => 'signed out');
  // The types refuse these mixtures; the casts are an untyped caller's.
  officeOnly.middleware(twoFactor({ setup: 'app.setup', verify: 'app.verify' }) as never).get('/r/office-app-two-factor', () => 'wrong guard');
  officeOnly.middleware(confirmedSecondFactor({ verify: 'app.verify' }) as never).get('/r/office-app-confirmed', () => 'wrong guard');
  appOnly.middleware(OfficeGuard.twoFactor(OFFICE_FACTOR) as never).get('/r/app-office-two-factor', () => 'wrong guard');
  Route.middleware(OfficeGuard.twoFactor(OFFICE_FACTOR) as never).get('/r/office-without-authenticate', () => 'no stamp');
  // The router stamps `office` ahead of everything here, but the guard's authenticate() has not run when its factor middleware does.
  Route.middleware(OfficeGuard.twoFactor(OFFICE_FACTOR) as never).middleware(OfficeGuard.authenticate(OFFICE)).get('/r/office-factor-first', () => 'no authenticate yet');
  // Behind the guard's guest(): the route is the guard's, but its authenticate() never ran.
  Route.middleware(OfficeGuard.guest(OFFICE)).middleware(OfficeGuard.confirmedSecondFactor({ verify: 'office.verify' }) as never).get('/r/office-nobody', () => 'office nobody');
});

// The app's error page for a 401, as the page payload names it.
const ERROR_PAGE = /"component":"system\/errors\/Error","props":\{"errors":\{\},"status":401,"title":"Unauthorized"/;

type Who = 'app' | 'office';

async function boot() {
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
        defineModule({ name: 'guards-two-factor-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'office-test', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), APP_NAME: 'Acme', SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(Logger, logger);
        container.instance(UserProvider, app as unknown as UserProvider);
        container.bind(TwoFactorState, TwoFactorStore);
        container.scoped(TwoFactor);
      },
    },
  );
  await application.container.make(Migrator).migrate();
  const hash = await application.container.make(Hasher).make('secret');
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  const kernel = createHttpKernel(application);
  const db = application.container.make(Connections).get<any>() as any;

  const browser = () => {
    const jar = new Map<string, string>();
    const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, {
        method,
        headers: { cookie, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Test Browser', ...headers },
        redirect: 'manual',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const send = async (who: Who, action: string, body: unknown = {}) => (await (await call('POST', `/${who}`, { 'x-action': action }, body)).json()) as Record<string, any>;
    const sessionKeyOf = async () => sessionKey(await application.container.make(Encrypter).decrypt(decodeURIComponent(jar.get('marmeon_session')!), 'cookie:marmeon_session'));
    /** Changes what the session stores, as a request of another time would have left it. */
    const edit = async (change: (data: Record<string, unknown>) => void) => {
      const store = application.container.make(SessionStore);
      const key = await sessionKeyOf();
      const read = (await store.read(key))!;
      const data = JSON.parse(read.data) as Record<string, unknown>;
      change(data);
      await store.write(key, JSON.stringify(data), { expectedVersion: read.version, lifetimeSeconds: 7200 });
    };
    return { call, send, edit };
  };

  /** Signs `who`'s user 1 in and turns the authenticator on, as a settings page would. */
  const enable = async (who: Who) => {
    const b = browser();
    expect(await b.send(who, 'login')).toEqual({ ok: true });
    const setup = await b.send(who, 'begin');
    const confirmed = await b.send(who, 'confirm', { code: twoFactorCode(setup.secret) });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    return { b, secret: setup.secret as string, recoveryCodes: confirmed.recoveryCodes as string[] };
  };

  /** A browser that typed the password of `who` and waits for the factor. */
  const waiting = async (who: Who) => {
    const b = browser();
    expect(await b.send(who, 'login')).toEqual({ ok: false, kind: 'two-factor-required' });
    return b;
  };

  /** A fresh browser that signed in to `who` with its factor, one step later than the setup's code. */
  const provenIn = async (who: Who, secret: string) => {
    const b = await waiting(who);
    expect(await b.send(who, 'challenge', { code: twoFactorCode(secret, inSeconds(30)) })).toMatchObject({ ok: true });
    return b;
  };

  const limiter = application.container.make(RateLimiter);
  return { application, browser, enable, waiting, provenIn, db, limiter, failures };
}

const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000);

/** The route fails with error A9: a 500 on its own could be any bug. */
async function expectA9(b: { call(method: string, path: string): Promise<Response> }, failures: string[], path: string): Promise<void> {
  const before = failures.length;
  expect((await b.call('GET', path)).status, path).toBe(500);
  expect(failures.slice(before).join('\n'), path).toContain('A9');
}

// The clock stands still, five seconds into a 30-second code step: a code made "now" and one made "now + 30 s" are always neighbouring steps.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Math.floor(Date.now() / 30_000) * 30_000 + 5_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('two-factor authentication of a package guard', () => {
  it('asks the guard\'s own user for the factor at sign-in, and the app\'s user 1 comes in without one, and the other way round', async () => {
    const booted = await boot();
    await booted.enable('office');
    const app1 = booted.browser();
    expect(await app1.send('app', 'login'), 'the app\'s user 1 has no factor').toEqual({ ok: true });
    expect(await app1.send('app', 'who')).toEqual({ id: 1 });
    const office1 = booted.browser();
    expect(await office1.send('office', 'login')).toEqual({ ok: false, kind: 'two-factor-required' });
    expect(await office1.send('office', 'who'), 'waiting for the factor is nobody').toEqual({ id: null });

    const other = await boot();
    await other.enable('app');
    const office2 = other.browser();
    expect(await office2.send('office', 'login'), 'the office\'s user 1 has no factor').toEqual({ ok: true });
    const app2 = other.browser();
    expect(await app2.send('app', 'login')).toEqual({ ok: false, kind: 'two-factor-required' });
  });

  it('keeps its factor on the guard\'s tables: the app\'s tables stay empty', async () => {
    const booted = await boot();
    const { recoveryCodes } = await booted.enable('office');
    expect(await booted.db.selectFrom('office_two_factor_authentications').select('user_id').execute()).toHaveLength(1);
    expect(await booted.db.selectFrom('office_two_factor_recovery_codes').select('user_id').execute()).toHaveLength(recoveryCodes.length);
    expect(await booted.db.selectFrom('two_factor_authentications').select('user_id').execute()).toHaveLength(0);
    expect(await booted.db.selectFrom('two_factor_recovery_codes').select('user_id').execute()).toHaveLength(0);
  });

  it('puts the guard\'s issuer in the authenticator\'s URI, and the app\'s name in the app\'s', async () => {
    const booted = await boot();
    const officeSetup = await booted.browser();
    expect(await officeSetup.send('office', 'login')).toEqual({ ok: true });
    expect((await officeSetup.send('office', 'begin')).uri).toContain('otpauth://totp/Back%20Office:');
    const appSetup = booted.browser();
    expect(await appSetup.send('app', 'login')).toEqual({ ok: true });
    expect((await appSetup.send('app', 'begin')).uri).toContain('otpauth://totp/Acme:');
  });

  it('spends a recovery code of the guard on the guard\'s table only', async () => {
    const booted = await boot();
    const { recoveryCodes } = await booted.enable('office');
    await booted.enable('app');
    const waitingOffice = await booted.waiting('office');
    expect(await waitingOffice.send('office', 'challenge', { recoveryCode: recoveryCodes[0] })).toMatchObject({ ok: true });
    const spent = async (table: string) => (await booted.db.selectFrom(table).select('used_at').where('used_at', 'is not', null).execute()).length;
    expect(await spent('office_two_factor_recovery_codes')).toBe(1);
    expect(await spent('two_factor_recovery_codes'), 'the app\'s codes are untouched').toBe(0);
  });

  it('completes a waiting sign-in of its own guard only: the app\'s challenge finds none', async () => {
    const booted = await boot();
    const { secret } = await booted.enable('office');
    const pending = await booted.waiting('office');
    const code = twoFactorCode(secret, inSeconds(30));
    // The app's `TwoFactor` reads the app's pending state, which this browser does not have.
    expect(await pending.send('app', 'challenge', { code })).toMatchObject({ ok: false, kind: 'no-challenge' });
    expect(await pending.send('office', 'who')).toEqual({ id: null });
    expect(await pending.send('office', 'challenge', { code })).toMatchObject({ ok: true });
    expect(await pending.send('office', 'who')).toEqual({ id: 1 });
  });

  it('keeps the proof of each guard apart: the office\'s challenge opens no app route and the app\'s no office route', async () => {
    const booted = await boot();
    const office1 = await booted.enable('office');
    const app1 = await booted.enable('app');
    // One browser signed in to both guards, each with its factor proven.
    const both = booted.browser();
    expect(await both.send('office', 'login')).toEqual({ ok: false, kind: 'two-factor-required' });
    expect(await both.send('office', 'challenge', { code: twoFactorCode(office1.secret, inSeconds(30)) })).toMatchObject({ ok: true });
    expect(await both.send('app', 'login')).toEqual({ ok: false, kind: 'two-factor-required' });
    expect(await both.send('app', 'challenge', { code: twoFactorCode(app1.secret, inSeconds(30)) })).toMatchObject({ ok: true });
    expect((await both.call('GET', '/r/office-area')).status).toBe(200);
    expect((await both.call('GET', '/r/app-area')).status).toBe(200);

    // The app's proof ends, the office's stands.
    await both.edit((data) => delete data[AUTH_SESSION_KEYS.twoFactorAt]);
    expect((await both.call('GET', '/r/app-area', { accept: 'text/html' })).status, 'the office\'s proof is none of the app\'s').toBe(302);
    expect((await both.call('GET', '/r/office-area')).status).toBe(200);

    // The other way round: a second browser keeps the app's proof and loses the office's.
    vi.setSystemTime(inSeconds(60)); // later steps: a code counts once
    const again = booted.browser();
    await again.send('office', 'login');
    await again.send('office', 'challenge', { code: twoFactorCode(office1.secret, inSeconds(30)) });
    await again.send('app', 'login');
    await again.send('app', 'challenge', { code: twoFactorCode(app1.secret, inSeconds(30)) });
    await again.edit((data) => delete data[guardNames('office').session.twoFactorAt]);
    expect((await again.call('GET', '/r/office-area', { accept: 'text/html' })).status, 'the app\'s proof is none of the office\'s').toBe(302);
    expect((await again.call('GET', '/r/app-area')).status).toBe(200);
  });

  it('refuses the app\'s second factor on a route of the guard and the guard\'s on a route of the app, and the guard\'s without its authenticate() before it (A9)', async () => {
    const booted = await boot();
    const office1 = await booted.enable('office');
    const app1 = await booted.enable('app');
    const both = booted.browser();
    await both.send('office', 'login');
    await both.send('office', 'challenge', { code: twoFactorCode(office1.secret, inSeconds(30)) });
    await both.send('app', 'login');
    await both.send('app', 'challenge', { code: twoFactorCode(app1.secret, inSeconds(30)) });
    for (const path of ['/r/office-app-two-factor', '/r/office-app-confirmed', '/r/app-office-two-factor', '/r/office-without-authenticate', '/r/office-factor-first']) {
      await expectA9(both, booted.failures, path);
    }
    // The guard's guest() lets nobody through; the factor middleware after it finds no authenticate() of the guard.
    await expectA9(booted.browser(), booted.failures, '/r/office-nobody');
  });
});

describe('the counters of a package guard\'s factor', () => {
  const windows = ['minute', 'hour', 'day'] as const;
  const key = (guard: Who, base: string) => (guard === 'office' ? guardNames('office').limiterKey(base) : base);

  it('counts a wrong code of the guard\'s user 1 in every window of the guard, and in none of the app\'s user 1', async () => {
    const booted = await boot();
    await booted.enable('office');
    await booted.enable('app');
    // Turning the factor on counted a code in the long windows already: only what the wrong code adds is read.
    const counts = async (who: Who) => Promise.all(windows.map((window) => booted.limiter.attempts(key(who, `two-factor-${window}:1`))));
    const [officeBefore, appBefore] = [await counts('office'), await counts('app')];
    const b = await booted.waiting('office');
    expect(await b.send('office', 'challenge', { code: '000000' })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect((await counts('office')).map((count, i) => count - officeBefore[i]!), 'minute, hour, day of the guard').toEqual([1, 1, 1]);
    expect(await counts('app'), 'the app\'s windows').toEqual(appBefore);
    const recoveryBefore = [await booted.limiter.attempts(key('office', 'two-factor-recovery:1')), await booted.limiter.attempts(key('app', 'two-factor-recovery:1'))];
    expect(await b.send('office', 'challenge', { recoveryCode: 'AAAA-AAAA-AAAA-AAAA' })).toMatchObject({ ok: false });
    expect(await booted.limiter.attempts(key('office', 'two-factor-recovery:1'))).toBe(recoveryBefore[0]! + 1);
    expect(await booted.limiter.attempts(key('app', 'two-factor-recovery:1'))).toBe(recoveryBefore[1]);
  });

  it('does not charge the app\'s user 1 for the guard\'s wrong codes, and a right app code frees no attempt of the guard', async () => {
    const booted = await boot();
    await booted.enable('office');
    const app1 = await booted.enable('app');
    const office1 = await booted.waiting('office');
    for (let i = 0; i < 5; i++) expect(await office1.send('office', 'challenge', { code: '000000' })).toMatchObject({ ok: false });
    // Five wrong codes drop a waiting sign-in; a fresh one meets the used-up minute.
    const locked = await booted.waiting('office');
    expect(await locked.send('office', 'challenge', { code: '000000' })).toMatchObject({ ok: false, kind: 'throttled' });

    const app = await booted.waiting('app');
    expect(await app.send('app', 'challenge', { code: twoFactorCode(app1.secret, inSeconds(30)) }), 'the app\'s user 1 has all of its own attempts').toMatchObject({ ok: true });
    expect(await booted.limiter.attempts(key('office', 'two-factor-minute:1')), 'the app\'s success clears the app\'s counter only').toBeGreaterThanOrEqual(5);
    const still = await booted.waiting('office');
    expect(await still.send('office', 'challenge', { code: '000000' })).toMatchObject({ ok: false, kind: 'throttled' });
  });

  it('counts the app\'s wrong codes apart from the guard\'s', async () => {
    const booted = await boot();
    await booted.enable('office');
    await booted.enable('app');
    for (let i = 0; i < 5; i++) {
      const b = await booted.waiting('app');
      expect(await b.send('app', 'challenge', { code: '000000' })).toMatchObject({ ok: false });
    }
    const office1 = await booted.waiting('office');
    expect(await office1.send('office', 'challenge', { code: '000000' }), 'the guard\'s user 1 still has its attempts').toMatchObject({ ok: false, kind: 'invalid-code', attemptsLeft: 4 });
  });
});

describe('what a row copied between the guards is worth', () => {
  it('does not decrypt a secret copied from the app\'s table to the guard\'s, so the guard\'s user 1 is not left with a secret somebody else knows', async () => {
    const booted = await boot();
    const app1 = await booted.enable('app');
    // The office's user 1 has a factor of its own, set up with another secret.
    await booted.enable('office');
    const [appRow] = await booted.db.selectFrom('two_factor_authentications').select((eb: any) => [secret(eb, 'secret' as never)]).execute();
    await booted.db.updateTable('office_two_factor_authentications').set({ secret: appRow.secret, last_used_step: null }).execute();
    const b = await booted.waiting('office');
    expect(await b.send('office', 'challenge', { code: twoFactorCode(app1.secret, inSeconds(30)) }), 'a code of the copied secret').toMatchObject({ ok: false, kind: 'invalid-code' });
  });

  it('does not decrypt a secret copied from the guard\'s table to the app\'s', async () => {
    const booted = await boot();
    const office1 = await booted.enable('office');
    await booted.enable('app');
    const [officeRow] = await booted.db.selectFrom('office_two_factor_authentications').select((eb: any) => [secret(eb, 'secret' as never)]).execute();
    await booted.db.updateTable('two_factor_authentications').set({ secret: officeRow.secret, last_used_step: null }).execute();
    const b = await booted.waiting('app');
    expect(await b.send('app', 'challenge', { code: twoFactorCode(office1.secret, inSeconds(30)) })).toMatchObject({ ok: false, kind: 'invalid-code' });
  });

  it('encrypts the guard\'s secret for the guard: it opens under the guard\'s context and under neither the app\'s nor another guard\'s', async () => {
    const booted = await boot();
    await booted.enable('office');
    const encrypter = booted.application.container.make(Encrypter);
    const [row] = await booted.db.selectFrom('office_two_factor_authentications').select((eb: any) => [secret(eb, 'secret' as never)]).execute();
    await expect(encrypter.decrypt(row.secret, 'marmeon-auth:two-factor@office:1')).resolves.toMatch(/^[A-Z2-7]+$/);
    await expect(encrypter.decrypt(row.secret, 'marmeon-auth:two-factor:1')).rejects.toThrow();
    await expect(encrypter.decrypt(row.secret, guardNames('depot').factorSecretContext(1))).rejects.toThrow();
  });

  it('keeps the app\'s secret under the context it always had', async () => {
    const booted = await boot();
    await booted.enable('app');
    const [row] = await booted.db.selectFrom('two_factor_authentications').select((eb: any) => [secret(eb, 'secret' as never)]).execute();
    await expect(booted.application.container.make(Encrypter).decrypt(row.secret, 'marmeon-auth:two-factor:1')).resolves.toMatch(/^[A-Z2-7]+$/);
  });

  it('does not take recovery code hashes copied from the app\'s table as codes of the guard, and the other way round', async () => {
    const booted = await boot();
    const app1 = await booted.enable('app');
    await booted.enable('office');
    // The attacker knows the app's codes; the office's hashes are replaced by the app's.
    const appHashes = await booted.db.selectFrom('two_factor_recovery_codes').select((eb: any) => [secret(eb, 'code_hash' as never)]).execute();
    await booted.db.deleteFrom('office_two_factor_recovery_codes').execute();
    await booted.db.insertInto('office_two_factor_recovery_codes').values(appHashes.map((row: { code_hash: string }) => ({ user_id: 1, code_hash: row.code_hash, used_at: null, created_at: new Date(), updated_at: new Date() }))).execute();
    const b = await booted.waiting('office');
    expect(await b.send('office', 'challenge', { recoveryCode: app1.recoveryCodes[0] }), 'the app\'s code at the guard').toMatchObject({ ok: false });

    // The reverse: the office's own codes work at the office after they were stored there by the guard, not at the app.
    const fresh = await boot();
    const own = await fresh.enable('office');
    await fresh.enable('app');
    const hashes = await fresh.db.selectFrom('office_two_factor_recovery_codes').select((eb: any) => [secret(eb, 'code_hash' as never)]).execute();
    await fresh.db.deleteFrom('two_factor_recovery_codes').execute();
    await fresh.db.insertInto('two_factor_recovery_codes').values(hashes.map((row: { code_hash: string }) => ({ user_id: 1, code_hash: row.code_hash, used_at: null, created_at: new Date(), updated_at: new Date() }))).execute();
    const appWaiting = await fresh.waiting('app');
    expect(await appWaiting.send('app', 'challenge', { recoveryCode: own.recoveryCodes[0] }), 'the office\'s code at the app').toMatchObject({ ok: false });
  });
});

describe('the middleware of a package guard\'s factor', () => {
  it('sends a guard\'s user without a factor to the guard\'s setup page, and one with a stale session to its verify page', async () => {
    const booted = await boot();
    const plain = booted.browser();
    await plain.send('office', 'login');
    const toSetup = await plain.call('GET', '/r/office-area', { accept: 'text/html' });
    expect([toSetup.status, new URL(toSetup.headers.get('location')!, 'https://example.com').pathname]).toEqual([302, '/office-setup']);
    expect(await (await plain.call('GET', '/r/office-area')).json()).toEqual({ error: 'two_factor_required' });

    const { secret } = await booted.enable('office');
    const stale = await booted.waiting('office');
    expect(await stale.send('office', 'challenge', { code: twoFactorCode(secret, inSeconds(30)) })).toMatchObject({ ok: true });
    await stale.edit((data) => delete data[guardNames('office').session.twoFactorAt]);
    const toVerify = await stale.call('GET', '/r/office-area', { accept: 'text/html' });
    expect([toVerify.status, new URL(toVerify.headers.get('location')!, 'https://example.com').pathname]).toEqual([302, '/office-verify']);
    expect(await (await stale.call('GET', '/r/office-area')).json()).toEqual({ error: 'two_factor_unverified' });
  });

  it('sends nobody to the guard\'s login page, not the app\'s, on a route of confirmedSecondFactor() or twoFactor(): the redirect is authenticate()\'s', async () => {
    const booted = await boot();
    const nobody = booted.browser();
    const onlyApp = booted.browser();
    // The app's sign-in is nobody of the guard.
    await onlyApp.send('app', 'login');
    for (const path of ['/r/office-confirmed', '/r/office-area']) {
      const html = await nobody.call('GET', path, { accept: 'text/html' });
      expect([html.status, new URL(html.headers.get('location')!, 'https://example.com').pathname], path).toEqual([302, '/office-login']);
      expect((await nobody.call('GET', path)).status, path).toBe(401);
      expect((await onlyApp.call('GET', path, { accept: 'text/html' })).headers.get('location'), path).toContain('/office-login');
    }
  });

  it('refuses a guard\'s user signed out after authenticate() with 401 and no redirect, in front of confirmedSecondFactor() or twoFactor()', async () => {
    const booted = await boot();
    for (const path of ['/r/office-signed-out-two-factor', '/r/office-signed-out-confirmed']) {
      // The request signs the user out, so each one needs its own sign-in.
      for (const accept of ['text/html', 'application/json']) {
        const b = booted.browser();
        await b.send('office', 'login');
        const response = await b.call('GET', path, { accept });
        expect([response.status, response.headers.get('location')], `${path} ${accept}`).toEqual([401, null]);
        expect(response.headers.get('vary'), `${path} ${accept}`).toContain('X-Requested-With');
        if (accept === 'application/json') expect(await response.json()).toEqual({ message: 'Unauthenticated.' });
        else {
          expect(response.headers.get('content-type'), `${path} ${accept}`).toContain('text/html');
          expect(await response.text(), `${path} ${accept}`).toMatch(ERROR_PAGE);
        }
      }
    }
  });

  it('needs the guard\'s own pages, also from a caller TypeScript does not check', () => {
    const asked = OfficeGuard as unknown as { twoFactor(options?: object): unknown; confirmedSecondFactor(options?: object): unknown };
    expect(() => asked.twoFactor()).toThrow(/twoFactor\(\) needs `setup`, the named route of the guard's own page\.$/);
    expect(() => asked.twoFactor({})).toThrow(/twoFactor\(\) needs `setup`/);
    expect(() => asked.twoFactor({ setup: 'office.setup' })).toThrow(/twoFactor\(\) needs `verify`/);
    expect(() => asked.twoFactor({ verify: 'office.verify' })).toThrow(/twoFactor\(\) needs `setup`/);
    expect(() => asked.confirmedSecondFactor()).toThrow(/confirmedSecondFactor\(\) needs `verify`/);
    expect(() => asked.confirmedSecondFactor({})).toThrow(/confirmedSecondFactor\(\) needs `verify`/);
  });

  it('opens a route that changes factors to a guard\'s user without one, and refuses a stale session of one with one', async () => {
    const booted = await boot();
    const plain = booted.browser();
    await plain.send('office', 'login');
    expect((await plain.call('GET', '/r/office-confirmed')).status).toBe(200);
    const { secret } = await booted.enable('office');
    const b = await booted.waiting('office');
    await b.send('office', 'challenge', { code: twoFactorCode(secret, inSeconds(30)) });
    expect((await b.call('GET', '/r/office-confirmed')).status).toBe(200);
    await b.edit((data) => delete data[guardNames('office').session.twoFactorAt]);
    expect(await (await b.call('GET', '/r/office-confirmed')).json()).toEqual({ error: 'two_factor_unverified' });
  });
});

describe('a guard without two-factor authentication', () => {
  const Plain = defineGuard('plain', { users: OfficeUsers, tablePrefix: 'plain_' });

  it('has no factors: nobody is asked for one, and no authenticator store is bound', async () => {
    const container = new (await import('@marmeon/core')).Container();
    Plain.register(container);
    expect(container.has((Plain as unknown as { tokens: { totp: never } }).tokens.totp)).toBe(false);
  });

  it('refuses the middleware of a factor it does not have (A8)', () => {
    const asked = Plain as unknown as { twoFactor(options: object): unknown; confirmedSecondFactor(options: object): unknown };
    expect(() => asked.twoFactor({ setup: 'a', verify: 'b' })).toThrow(/\[marmeon:A8\].*twoFactor: TwoFactor/);
    expect(() => asked.confirmedSecondFactor({ verify: 'b' })).toThrow(/\[marmeon:A8\]/);
  });
});

describe('defining a guard with two-factor authentication', () => {
  it('refuses a twoFactor option that is not the TwoFactor class, and an issuer that is empty or too long (A8)', () => {
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: class Other {} as unknown as typeof TwoFactor })).toThrow(/\[marmeon:A8\].*twoFactor/);
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: {} as unknown as typeof TwoFactor })).toThrow(/\[marmeon:A8\].*twoFactor/);
    for (const issuer of ['', '   ', 'x'.repeat(65), 7 as never]) {
      expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, settings: { twoFactorIssuer: issuer } })).toThrow(/\[marmeon:A8\].*twoFactorIssuer/);
    }
  });

  it('knows the TwoFactor class by its brand, not its name: a class of that name without it is refused, a renamed subclass is taken', () => {
    class Impostor {}
    Object.defineProperty(Impostor, 'name', { value: 'TwoFactor' });
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: Impostor as unknown as typeof TwoFactor })).toThrow(/\[marmeon:A8\].*twoFactor/);
    class Renamed extends TwoFactor {}
    Object.defineProperty(Renamed, 'name', { value: 'TwoFactor$1' });
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: Renamed })).not.toThrow();
  });

  it('keeps appName the app\'s: the issuer is a field of its own, which a passkey\'s relying-party name does not read', () => {
    const guard = OfficeGuard as unknown as { settings(resolver: { make(key: unknown): unknown }): { appName?: string; twoFactorIssuer?: string } };
    const settings = guard.settings({ make: () => ({ appName: 'Acme' }) });
    expect(settings).toMatchObject({ appName: 'Acme', twoFactorIssuer: 'Back Office' });
  });

  it('keeps its factor in tables named by its prefix', () => {
    const guard = defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor }) as unknown as { tables: { twoFactor: object } };
    expect(guard.tables.twoFactor).toEqual({ factor: 'depot_two_factor_authentications', recoveryCodes: 'depot_two_factor_recovery_codes' });
  });

  it('makes /up/ready red while the guard\'s factor tables are missing', async () => {
    const { HealthChecks } = await import('@marmeon/core');
    const container = (
      await createApplication(
        {
          root: import.meta.dirname,
          discover: false,
          providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, OfficeProvider, AuthServiceProvider],
          modules: [defineModule({ name: 'no-office-tables', migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
        },
        { env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:' }, override: (c: Container) => void c.instance(UserProvider, app as unknown as UserProvider) },
      )
    ).container;
    await container.make(Migrator).migrate();
    const report = await container.make(HealthChecks).run(container);
    const text = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    expect(text).toContain('office_two_factor_authentications');
    expect(text).toContain('office_two_factor_recovery_codes');
  });
});
