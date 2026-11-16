import { CacheServiceProvider } from '@marmeon/cache';
import { createApplication, defineModule, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider, SessionStore, sessionKey } from '@marmeon/session';
import { isSessionIdentityKey } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import { defineGuard, type GuardAuth, type GuardTwoFactor } from './define-guard.ts';
import { APP_GUARD_NAMES, guardNames } from './guard-names.ts';
import { Auth, AuthServiceProvider, authenticate, confirmedPassword, guest, Hasher, TwoFactorState, TwoFactorStore, UserProvider, type AuthUser } from './index.ts';
import { twoFactorCode } from './testing.ts';
import { confirmedSecondFactor, twoFactor } from './two-factor/index.ts';
import { TwoFactor } from './two-factor/two-factor.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

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

async function act(auth: GuardAuth<{ readonly id: number }>, factor: GuardTwoFactor<{ readonly id: number }>, ctx: HttpContext): Promise<Record<string, unknown>> {
  const body = (await ctx.input()) as Record<string, any>;
  switch (ctx.request.headers.get('x-action')) {
    case 'login':
      return { ok: (await auth.attempt('ada@example.com', 'secret')).ok };
    case 'begin': {
      const setup = await factor.begin();
      return { secret: setup.secret };
    }
    case 'confirm': {
      const done = await factor.confirm(body.code, 'secret');
      return { ok: done.ok };
    }
    default:
      return { error: 'unknown' };
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

class AppSignIn extends Controller {
  static readonly inject = [Auth] as const;
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return (await this.#auth.attempt('ada@example.com', 'secret')).ok ? this.redirect('/app-home').intended() : { ok: false };
  }
}

class OfficeSignIn extends Controller {
  static readonly inject = [OfficeAuth] as const;
  readonly #auth: OfficeAuth;
  constructor(auth: OfficeAuth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return (await this.#auth.attempt('ada@example.com', 'secret')).ok ? this.redirect('/office-home').intended() : { ok: false };
  }
}

/** Signs in at both guards in one request, which no route should: the redirect must then follow neither wish. */
class BothSignIn extends Controller {
  static readonly inject = [Auth, OfficeAuth] as const;
  readonly #auth: Auth;
  readonly #officeAuth: OfficeAuth;
  constructor(auth: Auth, officeAuth: OfficeAuth) {
    super();
    this.#auth = auth;
    this.#officeAuth = officeAuth;
  }
  async handle() {
    const both = (await this.#auth.attempt('ada@example.com', 'secret')).ok && (await this.#officeAuth.attempt('ada@example.com', 'secret')).ok;
    return both ? this.redirect('/app-home').intended() : { ok: false };
  }
}

/** Signs the app in and asks for the remember-me cookie. */
class AppRememberSignIn extends Controller {
  static readonly inject = [Auth] as const;
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { ok: (await this.#auth.attempt('ada@example.com', 'secret', { remember: true })).ok };
  }
}

/** The app restores its sign-in from the remember-me cookie, as a shared prop does, before the package guard signs in. */
class RestoreThenOfficeSignIn extends Controller {
  static readonly inject = [Auth, OfficeAuth] as const;
  readonly #auth: Auth;
  readonly #officeAuth: OfficeAuth;
  constructor(auth: Auth, officeAuth: OfficeAuth) {
    super();
    this.#auth = auth;
    this.#officeAuth = officeAuth;
  }
  async handle() {
    const restored = await this.#auth.check();
    return restored && (await this.#officeAuth.attempt('ada@example.com', 'secret')).ok ? this.redirect('/office-home').intended() : { restored };
  }
}

const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;

const routes = openRoutes((Route) => {
  Route.post('/app', AppAct);
  Route.post('/office', OfficeAct);
  for (const [path, name] of [['/login', 'auth.login'], ['/confirm', 'auth.password.confirm'], ['/app-home', 'app.home'], ['/app-setup', 'app.setup'], ['/app-verify', 'app.verify'], ['/office-login', 'office.login'], ['/office-home', 'office.home'], ['/office-confirm', 'office.confirm'], ['/office-setup', 'office.setup'], ['/office-verify', 'office.verify']] as const) {
    Route.get(path, () => name).name(name);
  }
  // The app's sign-in carries the app's `guest()`, which names no guard; the package's carries its guard's.
  Route.middleware(guest()).post('/app/sign-in', AppSignIn);
  Route.middleware(OfficeGuard.guest(OFFICE)).post('/office/sign-in', OfficeSignIn);
  // Routes whose middleware does not say whose sign-in this is: the guard that signs in decides.
  Route.post('/office/bare-sign-in', OfficeSignIn);
  Route.middleware(OfficeGuard.throttle('login')).post('/office/throttled-sign-in', OfficeSignIn);
  Route.middleware(OfficeGuard.guest(OFFICE)).post('/app/under-office-guest', AppSignIn);
  Route.post('/both/sign-in', BothSignIn);
  Route.post('/app/remember', AppRememberSignIn);
  Route.post('/office/restore-then-sign-in', RestoreThenOfficeSignIn);
  const appOnly = Route.middleware(authenticate());
  const officeOnly = Route.middleware(OfficeGuard.authenticate(OFFICE));
  appOnly.get('/r/app-page', () => 'app page');
  officeOnly.get('/r/office-page', () => 'office page');
  appOnly.middleware(confirmedPassword()).get('/r/app-sudo', () => 'app sudo');
  officeOnly.middleware(OfficeGuard.confirmedPassword(OFFICE)).get('/r/office-sudo', () => 'office sudo');
  appOnly.middleware(twoFactor({ setup: 'app.setup', verify: 'app.verify' })).get('/r/app-factor', () => 'app factor');
  officeOnly.middleware(OfficeGuard.twoFactor({ setup: 'office.setup', verify: 'office.verify' })).get('/r/office-factor', () => 'office factor');
  appOnly.middleware(confirmedSecondFactor({ verify: 'app.verify' })).get('/r/app-confirmed', () => 'app confirmed');
  officeOnly.middleware(OfficeGuard.confirmedSecondFactor({ verify: 'office.verify' })).get('/r/office-confirmed', () => 'office confirmed');
});

type Who = 'app' | 'office';

const NAMES = { app: APP_GUARD_NAMES, office: guardNames('office') } as const;
const LOGIN = { app: '/login', office: '/office-login' } as const;

async function boot() {
  app.rows.clear();
  office.rows.clear();
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-intended-per-guard-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, OfficeProvider, AuthServiceProvider],
      modules: [
        defineModule({ name: 'intended-per-guard-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'office-test', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), APP_NAME: 'Acme', SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(Logger, { debug() {}, info() {}, warn() {}, error() {}, child: () => container.make(Logger) } as unknown as Logger);
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

  const browser = () => {
    const jar = new Map<string, string>();
    const call = async (method: string, path: string, body: unknown = undefined, headers: Record<string, string> = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, {
        method,
        headers: { cookie, accept: 'text/html', 'content-type': 'application/json', 'user-agent': 'Test Browser', ...headers },
        redirect: 'manual',
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    /** Where a response goes: the path of its `Location`, or `undefined` for an answer that is no redirect. */
    const wentTo = (response: Response) => (response.status === 302 || response.status === 303 ? response.headers.get('location') : undefined);
    const visit = async (path: string) => wentTo(await call('GET', path));
    const signInTo = async (who: Who, path = `/${who}/sign-in`) => wentTo(await call('POST', path));
    const send = async (who: Who, action: string, body: unknown = {}) => (await (await call('POST', `/${who}`, body, { 'x-action': action, accept: 'application/json' })).json()) as Record<string, any>;
    const storage = async () => {
      const key = sessionKey(await application.container.make(Encrypter).decrypt(decodeURIComponent(jar.get('marmeon_session')!), 'cookie:marmeon_session'));
      const store = application.container.make(SessionStore);
      const read = (await store.read(key))!;
      return { key, store, read, data: JSON.parse(read.data) as Record<string, unknown> };
    };
    /** What the session keeps under each guard's key for the wished page. */
    const wishes = async () => {
      const { data } = await storage();
      return { app: data[NAMES.app.session.intended], office: data[NAMES.office.session.intended] };
    };
    /** Takes `key` out of the session, as the passing of time would. */
    const forget = async (key: string) => {
      const { key: sessionId, store, read, data } = await storage();
      delete data[key];
      await store.write(sessionId, JSON.stringify(data), { expectedVersion: read.version, lifetimeSeconds: 7200 });
    };
    const post = async (path: string) => (await call('POST', path, {}, { accept: 'application/json' })).json() as Promise<Record<string, unknown>>;
    return { visit, signInTo, post, send, wishes, forget };
  };
  return { browser };
}

describe('the page a guest wanted, kept per guard', () => {
  it('keeps the package guard\'s wish under its own key and leaves the app\'s key unset', async () => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.visit('/r/office-page')).toBe(LOGIN.office);
    expect(await b.wishes()).toEqual({ app: undefined, office: '/r/office-page' });
    expect(NAMES.office.session.intended).toBe('_auth:office:intended');
    expect(NAMES.app.session.intended).toBe('_intended_url');
    // The key is no identity key: a sign-out or a fingerprint check never takes it for a user's.
    expect(isSessionIdentityKey(NAMES.office.session.intended)).toBe(false);
  });

  it('does not take the package guard\'s wish at the app\'s sign-in: it goes to its fallback and the wish stays', async () => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.visit('/r/office-page')).toBe(LOGIN.office);
    expect(await b.signInTo('app')).toBe('/app-home');
    expect(await b.wishes()).toEqual({ app: undefined, office: '/r/office-page' });
  });

  it('follows the package guard\'s wish at the package guard\'s sign-in, once', async () => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.visit('/r/office-page')).toBe(LOGIN.office);
    expect(await b.signInTo('app')).toBe('/app-home');
    expect(await b.signInTo('office')).toBe('/r/office-page');
    expect(await b.wishes()).toEqual({ app: undefined, office: undefined });
  });

  it('does not take the app\'s wish at the package guard\'s sign-in, and the app\'s own sign-in follows it', async () => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.visit('/r/app-page')).toBe(LOGIN.app);
    expect(await b.wishes()).toEqual({ app: '/r/app-page', office: undefined });
    expect(await b.signInTo('office')).toBe('/office-home');
    expect(await b.wishes()).toEqual({ app: '/r/app-page', office: undefined });
    expect(await b.signInTo('app')).toBe('/r/app-page');
  });

  it.each(['/office/bare-sign-in', '/office/throttled-sign-in'])('follows the package guard\'s wish at its sign-in on %s, whose middleware names no guard, and leaves the app\'s', async (path) => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.visit('/r/app-page')).toBe(LOGIN.app);
    expect(await b.visit('/r/office-page')).toBe(LOGIN.office);
    expect(await b.signInTo('office', path)).toBe('/r/office-page');
    expect(await b.wishes()).toEqual({ app: '/r/app-page', office: undefined });
  });

  it('follows the app\'s wish at the app\'s sign-in on a route behind the package\'s guest(), and leaves the package\'s', async () => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.visit('/r/app-page')).toBe(LOGIN.app);
    expect(await b.visit('/r/office-page')).toBe(LOGIN.office);
    expect(await b.signInTo('app', '/app/under-office-guest')).toBe('/r/app-page');
    expect(await b.wishes()).toEqual({ app: undefined, office: '/r/office-page' });
  });

  it('does not count the other guard\'s restore from its remember-me cookie as an act: the sign-in follows its own wish', async () => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.post('/app/remember')).toEqual({ ok: true });
    await b.forget(NAMES.app.session.id);
    expect(await b.visit('/r/office-page')).toBe(LOGIN.office);
    expect(await b.signInTo('office', '/office/restore-then-sign-in')).toBe('/r/office-page');
    expect(await b.wishes()).toEqual({ app: undefined, office: undefined });
  });

  it('follows no wish when two guards sign in on one request, and keeps both', async () => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.visit('/r/app-page')).toBe(LOGIN.app);
    expect(await b.visit('/r/office-page')).toBe(LOGIN.office);
    expect(await b.signInTo('app', '/both/sign-in')).toBe('/app-home');
    expect(await b.wishes()).toEqual({ app: '/r/app-page', office: '/r/office-page' });
  });

  it.each(['app', 'office'] as const)('keeps the wish of confirmedPassword() of the %s guard under that guard\'s key', async (who) => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.send(who, 'login')).toEqual({ ok: true });
    await b.forget(NAMES[who].session.confirmedAt);
    expect(await b.visit(`/r/${who}-sudo`)).toBe(who === 'app' ? '/confirm' : '/office-confirm');
    expect(await b.wishes()).toEqual({ app: undefined, office: undefined, [who]: `/r/${who}-sudo` });
  });

  it.each(['app', 'office'] as const)('keeps the wish of twoFactor() of the %s guard under that guard\'s key', async (who) => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.send(who, 'login')).toEqual({ ok: true });
    expect(await b.visit(`/r/${who}-factor`)).toBe(`/${who}-setup`);
    expect(await b.wishes()).toEqual({ app: undefined, office: undefined, [who]: `/r/${who}-factor` });
  });

  it.each(['app', 'office'] as const)('keeps the wish of confirmedSecondFactor() of the %s guard under that guard\'s key', async (who) => {
    const { browser } = await boot();
    const b = browser();
    expect(await b.send(who, 'login')).toEqual({ ok: true });
    const setup = await b.send(who, 'begin');
    expect(await b.send(who, 'confirm', { code: twoFactorCode(setup.secret as string) })).toEqual({ ok: true });
    await b.forget(NAMES[who].session.twoFactorAt);
    expect(await b.visit(`/r/${who}-confirmed`)).toBe(`/${who}-verify`);
    expect(await b.wishes()).toEqual({ app: undefined, office: undefined, [who]: `/r/${who}-confirmed` });
  });
});
