import { createApplication, defineModule, err, inTransaction, listen, Logger, ok, type Container, type LogContext } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { ClientHistory, Controller, NO_REQUEST_INFO, defineRequest, HttpServiceProvider, type ContextOf, type HttpContext } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionServiceProvider, sessionKey, SessionStore } from '@marmeon/session';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  AccessTokenStore,
  Auth,
  authenticate,
  AuthConfig,
  AuthServiceProvider,
  confirmedPassword,
  Failed,
  PasswordChanged,
  RememberTokenStore,
  guest,
  Hasher,
  Login,
  Logout,
  RememberTokenReused,
  PasswordHasher,
  UserProvider,
  type Authenticated,
  type AuthTypesNotDeclared,
  type Credentials,
  type PasswordHash,
  type UserOf,
} from './index.ts';
import { AUTH_SESSION_KEYS } from './auth.ts';
import { COMPLETE_PENDING, READ_PENDING, sessionFingerprint } from './auth.ts';
import { NoTwoFactorState, TwoFactorState, type SecondFactor } from './two-factor/state.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { SignInTracker } from './sign-ins.ts';

interface TestUser {
  id: number;
  name: string;
  email: string;
}

declare module './user.ts' {
  interface AuthTypes {
    user: TestUser;
  }
}

/** Users in memory — what an app's repository does with its table. */
class MemoryUsers implements UserProvider<TestUser> {
  readonly rows = new Map<number, { user: TestUser; hash: PasswordHash | null; key?: string }>();
  readonly rehashed: number[] = [];
  /** Whether each new hash was written inside a database transaction. */
  readonly inTransaction: boolean[] = [];

  async findById(id: number): Promise<Credentials<TestUser> | undefined> {
    const row = this.rows.get(id);
    return row && { user: row.user, passwordHash: row.hash, sessionKey: row.key ?? null };
  }

  async findForLogin(email: string): Promise<Credentials<TestUser> | undefined> {
    for (const row of this.rows.values()) if (row.user.email === email) return { user: row.user, passwordHash: row.hash, sessionKey: row.key ?? null };
    return undefined;
  }

  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    this.rows.get(id)!.hash = hash;
    this.rehashed.push(id);
    this.inTransaction.push(inTransaction());
  }

  /** Compare-and-set; `expected === undefined` writes regardless. */
  async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || (expected !== undefined && (row.key ?? null) !== expected)) return false;
    row.key = key;
    return true;
  }
}

class LoginController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { email, password, remember } = (await ctx.input()) as { email: string; password: string; remember?: boolean };
    const signedIn = await this.#auth.attempt(email, password, { remember: remember === true });
    return signedIn.ok ? this.redirect().intended().route('home') : Response.json({ message: 'These credentials do not match our records.' }, { status: 422 });
  }
}

class LogoutController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    await this.#auth.logout();
    return this.redirect('/login');
  }
}

class ConfirmPasswordController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { password } = (await ctx.input()) as { password: string };
    return (await this.#auth.confirmPassword(password)) ? this.redirect().intended().route('home') : Response.json({ message: 'Wrong password.' }, { status: 422 });
  }
}

class UpdatePasswordController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    await this.#auth.updatePassword(((await ctx.input()) as { password: string }).password);
    return { changed: true };
  }
}

class LogoutOtherDevicesController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    return { done: await this.#auth.logoutOtherDevices(((await ctx.input()) as { password: string }).password) };
  }
}

class WhoController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    const user = await this.#auth.user();
    return { id: user?.id ?? null, viaRemember: this.#auth.viaRemember() };
  }
}

class WhoInTransactionController extends Controller {
  readonly #auth: Auth;
  readonly #connections: Connections;
  constructor(auth: Auth, connections: Connections) {
    super();
    this.#auth = auth;
    this.#connections = connections;
  }
  protected readonly fails: boolean = false;
  async handle() {
    // A route without authenticate() whose first auth.user() happens inside the app's own transaction.
    const user = await this.#connections.transaction(async () => {
      const found = await this.#auth.user();
      if (this.fails) throw new Error('the route fails after auth.user()');
      return found;
    });
    return { id: user?.id ?? null };
  }
}

class WhoInFailingTransactionController extends WhoInTransactionController {
  protected override readonly fails: boolean = true;
}

class TokenController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    return { token: this.#session.token() };
  }
}

/** Signs in, then does what an app that forgot `two-factor-required` would do: nothing with the answer. */
class IgnoringLoginController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { email, password, remember } = (await ctx.input()) as { email: string; password: string; remember?: boolean };
    const result = await this.#auth.attempt(email, password, { remember: remember === true });
    return Response.json({ continued: true, error: result.ok ? null : result.error });
  }
}

class LoginAsController extends Controller {
  readonly #auth: Auth;
  readonly #users: UserProvider;
  constructor(auth: Auth, users: UserProvider) {
    super();
    this.#auth = auth;
    this.#users = users;
  }
  async handle(ctx: HttpContext) {
    const found = await this.#users.findById(Number((ctx.params as { id: string }).id) as never);
    return { result: await this.#auth.login(found!.user as never, { remember: true }) };
  }
}

class PendingController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { pending: this.#auth.pendingSecondFactor() ?? null, user: (await this.#auth.user())?.id ?? null };
  }
}

class CompletePendingController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    // `as`: the account the (pretended) factor was checked for — by default the one the session waits for.
    const { as, direct } = (await ctx.input()) as { as?: number; direct?: boolean };
    // `direct`: finish without reading the pending state first, to reach the check `COMPLETE_PENDING` repeats.
    const pending = direct ? undefined : await this.#auth[READ_PENDING]();
    if (pending === 'expired') return { ok: false, kind: 'expired' };
    const done = await this.#auth[COMPLETE_PENDING](as ?? pending?.userId ?? 1);
    return done.ok ? { ok: true, id: (done.value as TestUser).id } : { ok: false, kind: done.error.kind };
  }
}

const events: object[] = [];
class RecordEvent {
  handle(event: object) {
    events.push(event);
  }
}

const routes = openRoutes((Route) => {
  Route.middleware(guest('/home')).get('/login', () => 'login page').name('auth.login');
  Route.post('/login', LoginController);
  Route.post('/logout', LogoutController);
  Route.post('/login-ignoring', IgnoringLoginController);
  Route.post('/login-as/:id', LoginAsController);
  Route.get('/pending', PendingController);
  Route.post('/complete-pending', CompletePendingController);
  Route.get('/token', TokenController);
  Route.get('/home', () => 'home').name('home');
  Route.middleware(authenticate()).get('/me', (ctx) => ({ id: ctx.user.id, name: ctx.user.name }));
  Route.get('/who', WhoController);
  Route.get('/who-in-transaction', WhoInTransactionController);
  Route.get('/who-in-failing-transaction', WhoInFailingTransactionController);
  Route.get('/confirm-password', () => 'confirm').name('auth.password.confirm');
  Route.post('/confirm-password', ConfirmPasswordController);
  const signedIn = Route.middleware(authenticate());
  signedIn.middleware(confirmedPassword()).get('/sensitive', () => 'sensitive');
  signedIn.middleware(confirmedPassword({ seconds: 60 })).get('/very-sensitive', () => 'very sensitive');
  signedIn.post('/password', UpdatePasswordController);
  signedIn.post('/logout-others', LogoutOtherDevicesController);
});

const CHEAP = { HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' };

async function boot(options: { env?: Record<string, string>; users?: MemoryUsers; logger?: Logger; factors?: Map<number, SecondFactor[]>; consume?: (real: RememberTokenStore) => RememberTokenStore['consume'] } = {}) {
  const users = options.users ?? new MemoryUsers();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [
      defineModule({
        name: 'auth-test',
        routes,
        migrations: new URL('./__fixtures__/migrations/', import.meta.url),
        listeners: [listen(Login, RecordEvent), listen(Logout, RecordEvent), listen(Failed, RecordEvent), listen(PasswordChanged, RecordEvent), listen(RememberTokenReused, RecordEvent)],
      }),
    ],
  }, {
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', ...CHEAP, ...options.env },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
      if (options.logger) container.instance(Logger, options.logger);
      if (options.consume) {
        const real = container.make(RememberTokenStore);
        container.instance(RememberTokenStore, { ...real, create: (...a) => real.create(...a), exists: (c) => real.exists(c), forget: (c) => real.forget(c), forgetUser: (...a) => real.forgetUser(...a), prune: (n) => real.prune(n), consume: options.consume(real) });
      }
      if (options.factors) container.instance(TwoFactorState, { removeAll: async () => {}, factors: async (id) => options.factors!.get(Number(id)) ?? [], enabledSince: async () => undefined });
    },
  });
  await application.container.make(Migrator).migrate();
  const kernel = createHttpKernel(application);
  const hasher = application.container.make(Hasher);
  const add = async (user: TestUser, password = 'secret') => users.rows.set(user.id, { user, hash: await hasher.make(password) });

  /** A tiny browser: keeps the session cookie between requests. */
  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, {
        method: init.method ?? 'GET',
        headers: { cookie, accept: 'application/json', ...(init.json ? { 'content-type': 'application/json' } : {}), ...init.headers },
        ...(init.json ? { body: JSON.stringify(init.json) } : {}),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    return { send, cookie: () => (jar.has('marmeon_session') ? `marmeon_session=${jar.get('marmeon_session')}` : ''), jar };
  };
  return { application, users, add, browser, kernel, store: application.container.make(SessionStore) };
}

const ada: TestUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const login = (send: ReturnType<Awaited<ReturnType<typeof boot>>['browser']>['send'], password = 'secret', email = ada.email) =>
  send('/login', { method: 'POST', json: { email, password } });

describe('Auth (session guard)', () => {
  it('signs in with the right password and keeps the user for the session', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const { send } = browser();
    expect((await send('/me')).status).toBe(401);
    expect((await login(send)).headers.get('location')).toBe('/home');
    expect(await (await send('/me')).json()).toEqual({ id: 1, name: 'Ada' });
  });

  it('session fixation: the session id and the CSRF token from before the login do not survive it', async () => {
    const { add, browser, store, application } = await boot();
    await add(ada);
    const { send, cookie } = browser();
    const sessionId = (header: string) => application.container.make(Encrypter).decrypt(decodeURIComponent(header.split('=')[1]!), 'cookie:marmeon_session');
    const before = (await (await send('/token')).json()) as { token: string };
    const planted = cookie();
    await login(send);
    expect(cookie()).not.toBe(planted);
    expect(((await (await send('/token')).json()) as { token: string }).token).not.toBe(before.token);
    // The planted id is gone from the store: an attacker who set it holds nothing.
    const plantedId = await sessionId(planted);
    expect(plantedId).toMatch(/^[\w-]{40}$/);
    expect(await store.read(sessionKey(plantedId))).toBeUndefined();
    const current = await store.read(sessionKey(await sessionId(cookie())));
    expect(JSON.parse(current!.data)).toMatchObject({ [AUTH_SESSION_KEYS.id]: 1 });
  });

  it('the Login event carries the request\'s address (through TRUSTED_PROXIES) and browser — passed by nobody (RequestInfo)', async () => {
    const { add, kernel } = await boot({ env: { TRUSTED_PROXIES: '127.0.0.1' } });
    await add(ada);
    events.length = 0;
    const post = (remoteAddress: string) =>
      kernel.request(
        '/login',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Firefox/140.0', 'x-forwarded-for': '203.0.113.9' },
          body: JSON.stringify({ email: ada.email, password: 'secret' }),
        },
        { remoteAddress },
      );
    await post('127.0.0.1'); // the trusted proxy: the client is who it forwarded
    await post('198.51.100.7'); // no proxy of ours: its X-Forwarded-For is the client's own word
    const logins = events.filter((event): event is Login => event instanceof Login);
    expect(logins.map((event) => [event.ip, event.userAgent])).toEqual([
      ['203.0.113.9', 'Firefox/140.0'],
      ['198.51.100.7', 'Firefox/140.0'],
    ]);
  });

  it('answers an unknown e-mail exactly like a wrong password (no enumeration)', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const wrong = await login(browser().send, 'wrong');
    const unknown = await login(browser().send, 'secret', 'nobody@example.com');
    expect([wrong.status, await wrong.text()]).toEqual([unknown.status, await unknown.text()]);
    expect(events.filter((event) => event instanceof Failed).slice(-2).map((event) => (event as Failed).identifier)).toEqual(['ada@example.com', 'nobody@example.com']);
  });

  // A timing test: a leak fails every attempt, a stall of a busy machine only some — so a failed attempt is tried again.
  it('enumeration by timing: an unknown e-mail takes as long as a wrong password', { retry: 2 }, async () => {
    const users = new MemoryUsers();
    const hasher = new PasswordHasher(); // real costs, so the hash dominates the time
    users.rows.set(1, { user: ada, hash: await hasher.make('secret') });
    const session = { started: true, get: () => undefined, regenerate() {}, put() {}, forget() {} } as unknown as Session;
    const auth = new Auth(session, users as UserProvider, hasher, { dispatch: async () => {} } as never, { get: () => undefined } as never, {} as never, {} as never, {} as never, {} as never, new ClientHistory(), NO_REQUEST_INFO, {} as never, new NoTwoFactorState(), {} as never, new SignInTracker(undefined), { now: () => Date.now() } as never);
    await auth.attempt('nobody@example.com', 'x'); // makes dummyVerify's reference hash
    const time = async (email: string) => {
      const started = performance.now();
      expect(await auth.attempt(email, 'wrong')).toStrictEqual(err({ kind: 'invalid-credentials' }));
      return performance.now() - started;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 7; i++) {
      known.push(await time('ada@example.com'));
      unknown.push(await time('nobody@example.com'));
    }
    const ratio = median(unknown) / median(known);
    expect(ratio).toBeGreaterThan(0.5); // wide bounds: parallel test workers add noise; skipping the hash would be ~0.02
    expect(ratio).toBeLessThan(2);
  });

  describe('the time floor of a failed sign-in', () => {
    // A stub hasher reports a slow recent check: nothing real is hashed, so the lower bound cannot flake.
    const boot = (floor: number) => {
      const users = new MemoryUsers();
      const real = new PasswordHasher();
      const hasher = { make: real.make.bind(real), verify: real.verify.bind(real), needsRehash: () => false, dummyVerify: async () => false as const, failureFloorMs: () => floor } as unknown as Hasher;
      const session = { started: true, get: () => undefined, regenerate() {}, put() {}, forget() {} } as unknown as Session;
      const auth = new Auth(session, users as UserProvider, hasher, { dispatch: async () => {} } as never, { get: () => undefined } as never, {} as never, {} as never, {} as never, {} as never, new ClientHistory(), NO_REQUEST_INFO, {} as never, new NoTwoFactorState(), {} as never, new SignInTracker(undefined), { now: () => Date.now() } as never);
      return { users, hasher, auth };
    };
    const timed = async (run: () => Promise<unknown>) => {
      const started = performance.now();
      await run();
      return performance.now() - started;
    };

    it('pads an unknown address and a wrong password to the slowest recent hash', async () => {
      const { users, hasher, auth } = boot(300);
      users.rows.set(1, { user: ada, hash: await hasher.make('secret') });
      expect(await timed(() => auth.attempt('nobody@example.com', 'x'))).toBeGreaterThanOrEqual(295);
      expect(await timed(() => auth.attempt('ada@example.com', 'wrong'))).toBeGreaterThanOrEqual(295);
    });

    it('pads an account without a password', async () => {
      const { users, auth } = boot(300);
      users.rows.set(1, { user: ada, hash: null });
      expect(await timed(() => auth.attempt('ada@example.com', 'x'))).toBeGreaterThanOrEqual(295);
    });

    it('does not delay a success', async () => {
      const { users, hasher, auth } = boot(5000);
      users.rows.set(1, { user: ada, hash: await hasher.make('secret') });
      let result: unknown;
      expect(await timed(async () => (result = await auth.attempt('ada@example.com', 'secret')))).toBeLessThan(2500);
      expect(result).toStrictEqual(ok(ada));
    });
  });

  it('answers with one error for an unknown identifier, a wrong password and an account without a password', async () => {
    const users = new MemoryUsers();
    const hasher = new PasswordHasher();
    users.rows.set(1, { user: ada, hash: await hasher.make('secret') });
    users.rows.set(2, { user: { id: 2, name: 'Link', email: 'link@example.com' }, hash: null });
    const session = { started: true, get: () => undefined, regenerate() {}, put() {}, forget() {} } as unknown as Session;
    const dispatched: unknown[] = [];
    const events = { dispatch: async (event: unknown) => void dispatched.push(event) } as never;
    const auth = new Auth(session, users as UserProvider, hasher, events, { get: () => undefined } as never, {} as never, {} as never, {} as never, {} as never, new ClientHistory(), NO_REQUEST_INFO, {} as never, new NoTwoFactorState(), {} as never, new SignInTracker(undefined), { now: () => Date.now() } as never);
    const answers = [
      await auth.attempt('ada@example.com', 'wrong'),
      await auth.attempt('nobody@example.com', 'secret'),
      await auth.attempt('link@example.com', 'secret'),
    ];
    for (const answer of answers) {
      expect(answer).toStrictEqual(err({ kind: 'invalid-credentials' }));
      expect(Object.keys((answer as { error: object }).error)).toEqual(['kind']); // no field says which case it was
    }
    expect(dispatched.filter((event) => event instanceof Failed)).toHaveLength(3);
    const outcome = answers[0]!;
    if (!outcome.ok) {
      const kind = outcome.error.kind;
      switch (kind) {
        case 'invalid-credentials':
        case 'two-factor-required':
          break;
        default:
          kind satisfies never;
      }
    }
  });

  it('rehashes a password made with other costs when its owner signs in', async () => {
    const { users, browser } = await boot();
    const old = await new PasswordHasher({ driver: 'scrypt', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } }).make('secret');
    users.rows.set(1, { user: ada, hash: old });
    await login(browser().send);
    expect(users.rehashed).toEqual([1]);
    expect(users.rows.get(1)!.hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  it('a password changed elsewhere ends the other sessions on their next request', async () => {
    const { add, users, browser, application } = await boot();
    await add(ada);
    const laptop = browser();
    await login(laptop.send);
    expect((await laptop.send('/me')).status).toBe(200);
    // The password changes (on another device, by a reset) — the hash changes:
    users.rows.get(1)!.hash = await application.container.make(Hasher).make('new secret');
    expect((await laptop.send('/me')).status).toBe(401);
    // … and stays out: the session was invalidated, not just this request refused.
    users.rows.get(1)!.hash = null;
    expect((await laptop.send('/me')).status).toBe(401);
  });

  it('refuses users without a password and sessions of deleted users', async () => {
    const { users, add, browser } = await boot();
    users.rows.set(2, { user: { id: 2, name: 'Link', email: 'link@example.com' }, hash: null });
    expect((await login(browser().send, 'secret', 'link@example.com')).status).toBe(422);
    await add(ada);
    const { send } = browser();
    await login(send);
    users.rows.delete(1);
    expect((await send('/me')).status).toBe(401);
  });

  it('signs out: new session, no user, a Logout event', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const { send, cookie } = browser();
    await login(send);
    const signedIn = cookie();
    events.length = 0;
    await send('/logout', { method: 'POST' });
    expect(cookie()).not.toBe(signedIn);
    expect((await send('/me')).status).toBe(401);
    expect(events.map((event) => event.constructor.name)).toEqual(['Logout']);
  });

  it('signs out with Clear-Site-Data for the storage only: the HTTP cache scan would hold the sign-out for seconds', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const { send } = browser();
    await login(send);
    const visit = await send('/logout', { method: 'POST', headers: { 'x-marmeon': 'true' } });
    expect([visit.status, visit.headers.get('x-marmeon-location'), visit.headers.get('clear-site-data')]).toEqual([409, '/login', '"storage"']);
    await login(send);
    expect((await send('/logout', { method: 'POST' })).headers.get('clear-site-data')).toBe('"storage"');
  });

  it('dispatches Login with the user', async () => {
    const { add, browser } = await boot();
    await add(ada);
    events.length = 0;
    await login(browser().send);
    expect(events).toEqual([expect.any(Login)]);
    expect((events[0] as Login).user).toEqual(ada);
  });

  it('says how the user signed in — and is queueable: its payload is JSON, `at` an ISO string', async () => {
    const { add, browser } = await boot();
    await add(ada);
    events.length = 0;
    await login(browser().send);
    const event = events[0] as Login;
    expect(event).toMatchObject({ via: 'attempt', remember: false, ip: null, userAgent: null });
    const queued = await Login.schema['~standard'].validate(event);
    if ('issues' in queued && queued.issues) throw new Error('the schema rejects the event');
    const json = JSON.parse(JSON.stringify(queued.value)) as unknown;
    expect(json).toEqual({ userId: ada.id, remember: false, via: 'attempt', at: event.at.toISOString(), ip: null, userAgent: null });
    // What a worker validates again — the same payload.
    expect(await Login.schema['~standard'].validate(json)).toMatchObject({ value: json });
    expect(new Login(ada).via).toBe('login');
    expect(new Login(ada, false, new Date(), { via: 'remember', ip: '203.0.113.9', userAgent: 'x'.repeat(600) })).toMatchObject({ via: 'remember', ip: '203.0.113.9', userAgent: 'x'.repeat(512) });
  });
});

describe('authenticate() and guest()', () => {
  it('sends browsers to the login page and back to where they wanted to go', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const { send } = browser();
    const html = { accept: 'text/html' };
    const away = await send('/me?tab=links', { headers: html });
    expect([away.status, away.headers.get('location')]).toEqual([302, '/login']);
    expect((await login(send)).headers.get('location')).toBe('/me?tab=links');
    expect((await login(send)).headers.get('location')).toBe('/home'); // the intended page is used once
  });

  it('answers JSON clients with 401', async () => {
    const { browser } = await boot();
    const response = await browser().send('/me');
    expect([response.status, await response.json()]).toEqual([401, { message: 'Unauthenticated.' }]);
    expect(response.headers.get('vary')).toBe('Accept, X-Requested-With');
  });

  it('names the headers that choose between the 401 and the redirect in Vary on the redirect too', async () => {
    const { browser } = await boot();
    const away = await browser().send('/me', { headers: { accept: 'text/html' } });
    expect([away.status, away.headers.get('vary')]).toEqual([302, 'Accept, X-Requested-With']);
  });

  it('keeps signed-in users away from guest pages', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const { send } = browser();
    expect((await send('/login')).status).toBe(200);
    await login(send);
    const away = await send('/login');
    expect([away.status, away.headers.get('location')]).toEqual([302, '/home']);
  });

  it('says what to bind when authentication is used without a UserProvider', async () => {
    const application = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
      modules: [defineModule({ name: 'auth-test', routes })], // boots: make:auth must run in apps without an auth module
    }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', DB_DATABASE: ':memory:', LOG_LEVEL: 'silent', ...CHEAP } });
    const response = await createHttpKernel(application).request('/me', { headers: { accept: 'application/json' } });
    expect(response.status).toBe(500);
    expect(() => application.container.make(UserProvider)).toThrow('container.bind(UserProvider, UserRepository)');
  });

  it('keeps the auth keys out of session.all()', () => {
    expect(Object.values(AUTH_SESSION_KEYS).every((key) => key.startsWith('_'))).toBe(true);
  });
});

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('remember me', () => {
  const rememberLogin = (send: ReturnType<Awaited<ReturnType<typeof boot>>['browser']>['send']) =>
    send('/login', { method: 'POST', json: { email: ada.email, password: 'secret', remember: true } });

  it('keeps signing in by the cookie once the session is gone — and rotates it on every use', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const laptop = browser();
    await rememberLogin(laptop.send);
    const first = laptop.jar.get('marmeon_remember');
    expect(first).toBeTruthy();
    // The browser closes: the session cookie is gone, the remember cookie stays.
    const reopened = browser(new Map([['marmeon_remember', first!]]));
    expect(await (await reopened.send('/who')).json()).toEqual({ id: 1, viaRemember: true });
    expect(reopened.jar.get('marmeon_remember')).not.toBe(first); // rotated
    expect(reopened.jar.has('marmeon_session')).toBe(true); // and a session again
    expect(await (await reopened.send('/who')).json()).toEqual({ id: 1, viaRemember: true }); // from the session now
  });

  it('sets the cookie only when asked to, HttpOnly and long-lived', async () => {
    const { add, browser } = await boot({ env: { AUTH_REMEMBER_DAYS: '7' } });
    await add(ada);
    const plain = browser();
    await login(plain.send);
    expect(plain.jar.has('marmeon_remember')).toBe(false);
    const response = await rememberLogin(browser().send);
    const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith('marmeon_remember='))!;
    expect(header).toMatch(/; Max-Age=60(4799|4800); HttpOnly; SameSite=Lax$/);
  });

  describe('how long it lasts', () => {
    const tokenCount = async (application: Awaited<ReturnType<typeof boot>>['application']) =>
      (await application.container.make(Connections).get<any>().selectFrom('remember_tokens').select('id').execute()).length;
    const age = (application: Awaited<ReturnType<typeof boot>>['application'], madeDaysAgo: number, expiresInDays: number) =>
      application.container
        .make(Connections)
        .get<any>()
        .updateTable('remember_tokens')
        .set({ created_at: new Date(Date.now() - madeDaysAgo * 86_400_000), expires_at: new Date(Date.now() + expiresInDays * 86_400_000) })
        .execute();

    it('refuses values above 30 days at boot, and accepts 0 and the default', async () => {
      await expect(boot({ env: { AUTH_REMEMBER_DAYS: '31' } })).rejects.toThrow(/AUTH_REMEMBER_DAYS/);
      await expect(boot({ env: { AUTH_REMEMBER_DAYS: '-1' } })).rejects.toThrow(/AUTH_REMEMBER_DAYS/);
      const { application } = await boot({ env: { AUTH_REMEMBER_DAYS: '0' } });
      expect(application.container.make(AuthConfig)).toMatchObject({ rememberDays: 0, remember: false });
      expect((await boot()).application.container.make(AuthConfig)).toMatchObject({ rememberDays: 30, remember: true });
    });

    it('with 0 a sign-in that asks to be remembered gets no cookie and no token', async () => {
      const { add, browser, application } = await boot({ env: { AUTH_REMEMBER_DAYS: '0' } });
      await add(ada);
      const laptop = browser();
      const response = await rememberLogin(laptop.send);
      expect(response.headers.get('location')).toBe('/home'); // signed in all the same
      expect(laptop.jar.has('marmeon_remember')).toBe(false);
      expect(await tokenCount(application)).toBe(0);
    });

    it('with 0 a cookie issued earlier signs nobody in and its token is deleted', async () => {
      const { add, users, browser, application } = await boot({ env: { AUTH_REMEMBER_DAYS: '0' } });
      await add(ada);
      // A token a higher value issued: valid by its row, encrypted like the app's own cookie.
      const raw = await application.container.make(RememberTokenStore).create(1, new Date(Date.now() + 10 * 86_400_000), sessionFingerprint((await users.findById(1))!));
      const cookie = encodeURIComponent(await application.container.make(Encrypter).encrypt(raw, 'cookie:marmeon_remember'));
      expect(await tokenCount(application)).toBe(1);
      const reopened = browser(new Map([['marmeon_remember', cookie]]));
      expect(await (await reopened.send('/who')).json()).toEqual({ id: null, viaRemember: false });
      expect(reopened.jar.has('marmeon_remember')).toBe(false);
      expect(await tokenCount(application)).toBe(0);
    });

    it('refuses a token made 31 days ago although its row says it lasts 30 more — and deletes it', async () => {
      const { add, browser, application } = await boot();
      await add(ada);
      const laptop = browser();
      await rememberLogin(laptop.send);
      await age(application, 31, 30);
      const reopened = browser(new Map([['marmeon_remember', laptop.jar.get('marmeon_remember')!]]));
      expect(await (await reopened.send('/who')).json()).toEqual({ id: null, viaRemember: false });
      expect(reopened.jar.has('marmeon_remember')).toBe(false);
      expect(await tokenCount(application)).toBe(0);
    });

    it('refuses a token whose store reports an unreadable expiry, and forgets it', async () => {
      const { add, browser, application } = await boot();
      await add(ada);
      const laptop = browser();
      await rememberLogin(laptop.send);
      const real = application.container.make(RememberTokenStore);
      const forgotten: string[] = [];
      application.container.instance(RememberTokenStore, {
        create: (...args) => real.create(...args),
        consume: async (cookie) => {
          const result = await real.consume(cookie);
          return result.ok ? { ...result, value: { ...result.value, expiresAt: new Date(Number.NaN) } } : result;
        },
        forget: async (cookie) => {
          forgotten.push(cookie);
          await real.forget(cookie);
        },
        exists: (cookie) => real.exists(cookie),
        forgetUser: (...args) => real.forgetUser(...args),
        prune: (days) => real.prune(days),
      });
      const reopened = browser(new Map([['marmeon_remember', laptop.jar.get('marmeon_remember')!]]));
      expect(await (await reopened.send('/who')).json()).toEqual({ id: null, viaRemember: false });
      expect(reopened.jar.has('marmeon_remember')).toBe(false);
      expect(forgotten).toHaveLength(1);
      expect(await tokenCount(application)).toBe(0);
    });

    it('signs in with a token made 29 days ago and shortens the new cookie to what is left', async () => {
      const { add, browser, application } = await boot();
      await add(ada);
      const laptop = browser();
      await rememberLogin(laptop.send);
      await age(application, 29, 30);
      const reopened = browser(new Map([['marmeon_remember', laptop.jar.get('marmeon_remember')!]]));
      const response = await reopened.send('/who');
      expect(await response.json()).toEqual({ id: 1, viaRemember: true });
      const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith('marmeon_remember='))!;
      const maxAge = Number(/Max-Age=(\d+)/.exec(header)![1]);
      expect(maxAge).toBeLessThanOrEqual(86_400);
      expect(maxAge).toBeGreaterThan(86_400 - 60);
    });
  });

  it('a copied cookie signs out the thief and the owner, and every device of the user with them', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const owner = browser();
    await rememberLogin(owner.send);
    const otherDevice = browser();
    await rememberLogin(otherDevice.send);
    const copied = owner.jar.get('marmeon_remember')!;

    const thief = browser(new Map([['marmeon_remember', copied]]));
    expect(await (await thief.send('/who')).json()).toMatchObject({ id: 1 }); // first use wins, rotates
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      const ownerLater = browser(new Map([['marmeon_remember', copied]])); // the owner's browser, session expired
      expect(await (await ownerLater.send('/who')).json()).toEqual({ id: null, viaRemember: false });
      expect(ownerLater.jar.has('marmeon_remember')).toBe(false); // the cookie is deleted
      const thiefLater = browser(new Map([['marmeon_remember', thief.jar.get('marmeon_remember')!]]));
      expect(await (await thiefLater.send('/who')).json()).toMatchObject({ id: null });
      const otherLater = browser(new Map([['marmeon_remember', otherDevice.jar.get('marmeon_remember')!]]));
      expect(await (await otherLater.send('/who')).json()).toMatchObject({ id: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a copied cookie ends the session the thief already holds', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const owner = browser();
    await rememberLogin(owner.send);
    const copied = owner.jar.get('marmeon_remember')!;

    const thief = browser(new Map([['marmeon_remember', copied]]));
    expect(await (await thief.send('/who')).json()).toMatchObject({ id: 1 });
    expect(await (await thief.send('/who')).json()).toMatchObject({ id: 1 }); // from the session now, no cookie needed
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      expect(await (await browser(new Map([['marmeon_remember', copied]])).send('/who')).json()).toEqual({ id: null, viaRemember: false });
    } finally {
      vi.useRealTimers();
    }
    expect(await (await thief.send('/who')).json()).toEqual({ id: null, viaRemember: false });
  });

  it('ends the thief\'s session even when the stolen cookie is presented inside a transaction', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const owner = browser();
    await rememberLogin(owner.send);
    const copied = owner.jar.get('marmeon_remember')!;
    const thief = browser(new Map([['marmeon_remember', copied]]));
    expect(await (await thief.send('/who')).json()).toMatchObject({ id: 1 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      const ownerLater = browser(new Map([['marmeon_remember', copied]]));
      expect(await (await ownerLater.send('/who-in-transaction')).json()).toEqual({ id: null });
    } finally {
      vi.useRealTimers();
    }
    expect(await (await thief.send('/who')).json()).toEqual({ id: null, viaRemember: false });
  });

  it('ends the thief\'s session even when the transaction around the stolen cookie rolls back', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const owner = browser();
    await rememberLogin(owner.send);
    const copied = owner.jar.get('marmeon_remember')!;
    const thief = browser(new Map([['marmeon_remember', copied]]));
    expect(await (await thief.send('/who')).json()).toMatchObject({ id: 1 });
    const rotated = thief.jar.get('marmeon_remember')!;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      expect((await browser(new Map([['marmeon_remember', copied]])).send('/who-in-failing-transaction')).status).toBe(500);
    } finally {
      vi.useRealTimers();
    }
    expect(await (await thief.send('/who')).json()).toEqual({ id: null, viaRemember: false });
    expect(await (await browser(new Map([['marmeon_remember', rotated]])).send('/who')).json()).toEqual({ id: null, viaRemember: false });
  });

  it('ends nothing when a second tab presents the old validator within the grace period', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const owner = browser();
    await rememberLogin(owner.send);
    const old = owner.jar.get('marmeon_remember')!;
    const tab = browser(new Map([['marmeon_remember', old]]));
    expect(await (await tab.send('/who')).json()).toMatchObject({ id: 1 }); // rotates
    const secondTab = browser(new Map([['marmeon_remember', old]]));
    expect(await (await secondTab.send('/who')).json()).toMatchObject({ id: 1 }); // the old validator still passes
    expect(await (await tab.send('/who')).json()).toMatchObject({ id: 1 });
    expect(await (await secondTab.send('/who')).json()).toMatchObject({ id: 1 });
  });

  it('names the address and the browser of the request that presented a rotated cookie', async () => {
    const warnings: { message: string; context?: LogContext }[] = [];
    const logger: Logger = { debug() {}, info() {}, warn: (message, context) => void warnings.push({ message, context }), error() {}, child: () => logger };
    const { add, browser, kernel } = await boot({ logger });
    await add(ada);
    const owner = browser();
    await rememberLogin(owner.send);
    const copied = owner.jar.get('marmeon_remember')!;
    expect(await (await browser(new Map([['marmeon_remember', copied]])).send('/who')).json()).toMatchObject({ id: 1 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11_000 });
    try {
      await kernel.request(
        '/who',
        { headers: { cookie: `marmeon_remember=${copied}`, accept: 'application/json', 'user-agent': `Firefox/${'x'.repeat(600)}` } },
        { remoteAddress: '198.51.100.7' },
      );
    } finally {
      vi.useRealTimers();
    }
    const theft = warnings.filter((warning) => warning.message.startsWith('A rotated remember-me token'));
    expect(theft).toHaveLength(1);
    expect(theft[0]!.context).toMatchObject({ user: 1, ip: '198.51.100.7', userAgent: `Firefox/${'x'.repeat(600)}`.slice(0, 512) });
    expect(JSON.stringify(warnings)).not.toContain(copied);
  });

  describe('RememberTokenReused', () => {
    /** A copied cookie, presented once by the thief and once more after the grace period; returns what the second request dispatched. */
    async function reuse(options: Parameters<typeof boot>[0] = {}, path = '/who', afterFirstUse?: (users: MemoryUsers) => void) {
      const { add, browser, kernel, users } = await boot(options);
      await add(ada);
      const owner = browser();
      await rememberLogin(owner.send);
      const copied = owner.jar.get('marmeon_remember')!;
      expect(await (await browser(new Map([['marmeon_remember', copied]])).send('/who')).json()).toMatchObject({ id: 1 });
      afterFirstUse?.(users);
      events.length = 0;
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
      try {
        await kernel.request(
          path,
          { headers: { cookie: `marmeon_remember=${copied}`, accept: 'application/json', 'user-agent': `Firefox/${'x'.repeat(600)}` } },
          { remoteAddress: '198.51.100.7' },
        );
      } finally {
        vi.useRealTimers();
      }
      return { copied, reused: events.filter((event): event is RememberTokenReused => event instanceof RememberTokenReused) };
    }

    it('is dispatched once, with the address and the capped browser of the second request and no cookie', async () => {
      const { copied, reused } = await reuse();
      expect(reused).toHaveLength(1);
      expect(reused[0]).toMatchObject({ userId: 1, ip: '198.51.100.7', userAgent: `Firefox/${'x'.repeat(600)}`.slice(0, 512), sessionsEnded: true });
      expect(reused[0]!.at).toBeInstanceOf(Date);
      expect(JSON.stringify(reused[0])).not.toContain(copied);
      expect(JSON.stringify(reused[0])).not.toContain(copied.split('.')[0]!);
      const parsed = await RememberTokenReused.schema['~standard'].validate(reused[0]);
      expect(parsed.issues).toBeUndefined();
      expect('value' in parsed && parsed.value).toEqual({
        userId: 1,
        at: reused[0]!.at.toISOString(),
        ip: '198.51.100.7',
        userAgent: `Firefox/${'x'.repeat(600)}`.slice(0, 512),
        sessionsEnded: true,
      });
    });

    it('drops control characters from the browser it carries', () => {
      const event = new RememberTokenReused(ada, { userAgent: 'Fire\r\nfox\u0000/1\u009f', sessionsEnded: true });
      expect(event.userAgent).toBe('Firefox/1');
    });

    it('carries no address that is not one, and still parses', async () => {
      const event = new RememberTokenReused(ada, { ip: 'unknown, 10.0.0.1', sessionsEnded: true });
      expect(event.ip).toBeNull();
      const parsed = await RememberTokenReused.schema['~standard'].validate(event);
      expect(parsed.issues).toBeUndefined();
      expect('value' in parsed && parsed.value).toEqual({ userId: 1, at: event.at.toISOString(), ip: null, userAgent: null, sessionsEnded: true });
      expect(new RememberTokenReused(ada, { ip: '2001:db8::1', sessionsEnded: true }).ip).toBe('2001:db8::1');
    });

    it('is dispatched when the store reports a stale validator that was not the one just replaced', async () => {
      const { add, browser } = await boot({
        consume: (real) => async () => {
          await real.forgetUser(1);
          return err({ kind: 'stolen', userId: 1, reused: false });
        },
      });
      await add(ada);
      const owner = browser();
      await rememberLogin(owner.send);
      expect(await (await owner.send('/who')).json()).toMatchObject({ id: 1 });
      events.length = 0;
      const fresh = browser(new Map([['marmeon_remember', owner.jar.get('marmeon_remember')!]]));
      expect(await (await fresh.send('/who')).json()).toEqual({ id: null, viaRemember: false });
      expect(events.filter((event) => event instanceof RememberTokenReused)).toMatchObject([{ userId: 1, sessionsEnded: true }]);
      expect(await (await owner.send('/who')).json()).toEqual({ id: null, viaRemember: false });
    });

    it('is dispatched once for a copy that comes back after the owner rotated twice', async () => {
      const { add, browser, kernel } = await boot();
      await add(ada);
      const owner = browser();
      await rememberLogin(owner.send);
      const copied = owner.jar.get('marmeon_remember')!;
      const request = (cookie: string) => kernel.request('/who', { headers: { cookie: `marmeon_remember=${cookie}`, accept: 'application/json' } });
      const rotate = async (cookie: string) => {
        const response = await request(cookie);
        expect(await response.json()).toMatchObject({ id: 1, viaRemember: true });
        return /marmeon_remember=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')![1]!;
      };
      events.length = 0;
      const second = await rotate(copied);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
      try {
        await rotate(second);
        vi.setSystemTime(Date.now() + 61_000);
        expect(await (await request(copied)).json()).toEqual({ id: null, viaRemember: false });
      } finally {
        vi.useRealTimers();
      }
      expect(events.filter((event) => event instanceof RememberTokenReused)).toMatchObject([{ userId: 1, sessionsEnded: true }]);
    });

    it('is dispatched once for parallel replays', async () => {
      const { add, browser, kernel } = await boot();
      await add(ada);
      const owner = browser();
      await rememberLogin(owner.send);
      const copied = owner.jar.get('marmeon_remember')!;
      await browser(new Map([['marmeon_remember', copied]])).send('/who');
      events.length = 0;
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
      try {
        await Promise.all([1, 2, 3, 4].map(() => kernel.request('/who', { headers: { cookie: `marmeon_remember=${copied}`, accept: 'application/json' } })));
      } finally {
        vi.useRealTimers();
      }
      expect(events.filter((event) => event instanceof RememberTokenReused)).toHaveLength(1);
    });

    it('announces once and deletes the tokens when a rollback brought them back and the provider cannot end sessions', async () => {
      const users = Object.assign(new MemoryUsers(), { updateSessionKey: undefined }) as unknown as MemoryUsers;
      const { add, browser, kernel } = await boot({ users });
      await add(ada);
      const owner = browser();
      await rememberLogin(owner.send);
      const copied = owner.jar.get('marmeon_remember')!;
      await browser(new Map([['marmeon_remember', copied]])).send('/who');
      events.length = 0;
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
      try {
        for (let replay = 0; replay < 2; replay++) {
          await kernel.request('/who-in-failing-transaction', { headers: { cookie: `marmeon_remember=${copied}`, accept: 'application/json' } });
        }
        expect(events.filter((event) => event instanceof RememberTokenReused)).toHaveLength(1);
        expect(await (await browser(new Map([['marmeon_remember', copied]])).send('/who')).json()).toEqual({ id: null, viaRemember: false });
      } finally {
        vi.useRealTimers();
      }
      expect(events.filter((event) => event instanceof RememberTokenReused)).toHaveLength(1);
    });

    it('is dispatched once when the request ran in a transaction that rolls back', async () => {
      const { reused } = await reuse({}, '/who-in-failing-transaction');
      expect(reused).toHaveLength(1);
      expect(reused[0]!.sessionsEnded).toBe(true);
    });

    it('is dispatched once when the request ran in a transaction that commits', async () => {
      const { reused } = await reuse({}, '/who-in-transaction');
      expect(reused).toHaveLength(1);
    });

    it('says the sessions were not ended when the provider cannot end them', async () => {
      const { reused } = await reuse({ users: Object.assign(new MemoryUsers(), { updateSessionKey: undefined }) as unknown as MemoryUsers });
      expect(reused).toHaveLength(1);
      expect(reused[0]!.sessionsEnded).toBe(false);
    });

    it('is not dispatched for an account that is gone', async () => {
      const { reused } = await reuse({}, '/who', (users) => users.rows.delete(1));
      expect(reused).toEqual([]);
    });

    it('is not dispatched inside the grace period', async () => {
      const { add, browser } = await boot();
      await add(ada);
      const owner = browser();
      await rememberLogin(owner.send);
      const old = owner.jar.get('marmeon_remember')!;
      await browser(new Map([['marmeon_remember', old]])).send('/who');
      events.length = 0;
      await browser(new Map([['marmeon_remember', old]])).send('/who');
      expect(events.some((event) => event instanceof RememberTokenReused)).toBe(false);
    });
  });

  it('logs, and does not throw, when the sessions of a thief cannot be ended', async () => {
    const errors: { message: string; context?: LogContext }[] = [];
    const logger: Logger = { debug() {}, info() {}, warn() {}, error: (message, context) => void errors.push({ message, context }), child: () => logger };
    const { add, browser } = await boot({ users: Object.assign(new MemoryUsers(), { updateSessionKey: undefined }) as unknown as MemoryUsers, logger });
    await add(ada);
    const owner = browser();
    await rememberLogin(owner.send);
    const copied = owner.jar.get('marmeon_remember')!;
    expect(await (await browser(new Map([['marmeon_remember', copied]])).send('/who')).json()).toMatchObject({ id: 1 });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      const later = browser(new Map([['marmeon_remember', copied]]));
      expect(await (await later.send('/who')).json()).toEqual({ id: null, viaRemember: false });
      expect(later.jar.has('marmeon_remember')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]!.context).toMatchObject({ user: 1 });
    expect(JSON.stringify(errors)).not.toContain(copied);
  });

  it('signs out only this device', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const laptop = browser();
    const phone = browser();
    await rememberLogin(laptop.send);
    await rememberLogin(phone.send);
    const laptopCookie = laptop.jar.get('marmeon_remember')!;
    await laptop.send('/logout', { method: 'POST' });
    expect(laptop.jar.has('marmeon_remember')).toBe(false);
    expect(await (await browser(new Map([['marmeon_remember', laptopCookie]])).send('/who')).json()).toMatchObject({ id: null });
    expect(await (await browser(new Map([['marmeon_remember', phone.jar.get('marmeon_remember')!]])).send('/who')).json()).toMatchObject({ id: 1 });
  });

  it('ignores remember cookies of deleted users and forged cookies', async () => {
    const { add, users, browser, application } = await boot();
    await add(ada);
    const laptop = browser();
    await rememberLogin(laptop.send);
    users.rows.delete(1);
    expect(await (await browser(new Map([['marmeon_remember', laptop.jar.get('marmeon_remember')!]])).send('/who')).json()).toMatchObject({ id: null });
    // A cookie the app did not encrypt is not even read.
    const plain = await application.container.make(RememberTokenStore).create(1, new Date(Date.now() + 60_000), 'fingerprint');
    expect(await (await browser(new Map([['marmeon_remember', plain]])).send('/who')).json()).toMatchObject({ id: null });
  });
});

describe('password changes and confirmation', () => {
  it('changing the password ends the other sessions and all remember-me tokens — this session stays', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const laptop = browser();
    const phone = browser();
    await login(laptop.send);
    await phone.send('/login', { method: 'POST', json: { email: ada.email, password: 'secret', remember: true } });
    const phoneRemember = phone.jar.get('marmeon_remember')!;
    events.length = 0;
    expect(await (await laptop.send('/password', { method: 'POST', json: { password: 'a new secret' } })).json()).toEqual({ changed: true });
    expect((await laptop.send('/me')).status).toBe(200);
    expect((await phone.send('/me')).status).toBe(401);
    expect(await (await browser(new Map([['marmeon_remember', phoneRemember]])).send('/who')).json()).toMatchObject({ id: null });
    expect(events).toEqual([expect.any(PasswordChanged)]);
    expect((await login(browser().send, 'a new secret')).status).toBe(303);
  });

  it('revokes every API token of the user with a new password — with AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true, in the transaction of the new hash', async () => {
    for (const revoke of [true, false]) {
      const { add, browser, application, users } = await boot(revoke ? { env: { AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: 'true' } } : {});
      const alan: TestUser = { id: 2, name: 'Alan', email: 'alan@example.com' };
      await add(ada);
      await add(alan);
      const tokens = application.container.make(AccessTokenStore);
      const adas = [await tokens.create(1, 'cli'), await tokens.create(1, 'ci')];
      const alans = await tokens.create(2, 'cli');
      const laptop = browser();
      await login(laptop.send);
      events.length = 0;
      expect(await (await laptop.send('/password', { method: 'POST', json: { password: 'a new secret' } })).json()).toEqual({ changed: true });
      const valid = await Promise.all(adas.map(async ({ plainText }) => (await tokens.find(plainText)) !== undefined));
      expect(valid, `revoke=${revoke}: Ada's tokens still valid: ${JSON.stringify(valid)}`).toEqual(revoke ? [false, false] : [true, true]);
      expect(await tokens.find(alans.plainText), "another user's token").toBeDefined();
      expect((events[0] as PasswordChanged).revokedTokens).toBe(revoke ? 2 : 0);
      if (revoke) expect(users.inTransaction.at(-1), 'the new hash was written outside the transaction').toBe(true);
    }
  });

  it('signs out the other devices with the password — this one stays, and keeps its remember-me token', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const laptop = browser();
    const phone = browser();
    await laptop.send('/login', { method: 'POST', json: { email: ada.email, password: 'secret', remember: true } });
    await phone.send('/login', { method: 'POST', json: { email: ada.email, password: 'secret', remember: true } });
    const phoneRemember = phone.jar.get('marmeon_remember')!;
    expect(await (await laptop.send('/logout-others', { method: 'POST', json: { password: 'wrong' } })).json()).toEqual({ done: false });
    expect((await phone.send('/me')).status).toBe(200);
    expect(await (await laptop.send('/logout-others', { method: 'POST', json: { password: 'secret' } })).json()).toEqual({ done: true });
    expect((await laptop.send('/me')).status).toBe(200);
    expect((await phone.send('/me')).status).toBe(401);
    expect(await (await browser(new Map([['marmeon_remember', phoneRemember]])).send('/who')).json()).toMatchObject({ id: null });
    expect(await (await browser(new Map([['marmeon_remember', laptop.jar.get('marmeon_remember')!]])).send('/who')).json()).toMatchObject({ id: 1 });
    expect((await login(browser().send)).status).toBe(303); // the password itself is unchanged
  });

  it('asks for the password again on sensitive pages — a sign-in counts, a remember-me sign-in does not', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const html = { accept: 'text/html' };
    const fresh = browser();
    await login(fresh.send);
    expect((await fresh.send('/sensitive', { headers: html })).status).toBe(200); // just typed it

    const remembered = browser();
    await remembered.send('/login', { method: 'POST', json: { email: ada.email, password: 'secret', remember: true } });
    const later = browser(new Map([['marmeon_remember', remembered.jar.get('marmeon_remember')!]]));
    const away = await later.send('/sensitive?tab=keys', { headers: html });
    expect([away.status, away.headers.get('location')]).toEqual([302, '/confirm-password']);
    const json = await later.send('/sensitive');
    expect([json.status, json.headers.get('vary')]).toEqual([423, 'Accept, X-Requested-With']); // JSON clients
    expect(away.headers.get('vary')).toBe('Accept, X-Requested-With');
    expect((await later.send('/confirm-password', { method: 'POST', json: { password: 'wrong' } })).status).toBe(422);
    const back = await later.send('/confirm-password', { method: 'POST', json: { password: 'secret' } });
    expect(back.headers.get('location')).toBe('/sensitive?tab=keys');
    expect((await later.send('/sensitive', { headers: html })).status).toBe(200);
  });

  it("does not carry a confirmation over to the next sign-in — login() over another account's session, and over its own", async () => {
    const { add, browser } = await boot();
    const bob: TestUser = { id: 2, name: 'Bob', email: 'bob@example.com' };
    await add(ada);
    await add(bob);
    for (const id of [2, 1]) {
      const { send } = browser();
      await login(send);
      expect((await send('/sensitive')).status).toBe(200); // Ada typed her password
      expect(await (await send(`/login-as/${id}`, { method: 'POST' })).json()).toEqual({ result: 'signed-in' });
      expect((await send('/who')).status).toBe(200);
      expect((await send('/sensitive')).status, `login(${id}) kept the confirmation`).toBe(423);
    }
  });

  it('a password typed for the next sign-in confirms it again — attempt() as another account', async () => {
    const { add, browser } = await boot();
    const bob: TestUser = { id: 2, name: 'Bob', email: 'bob@example.com' };
    await add(ada);
    await add(bob);
    const { send } = browser();
    await login(send);
    await login(send, 'secret', bob.email);
    expect(await (await send('/who')).json()).toMatchObject({ id: 2 });
    expect((await send('/sensitive')).status).toBe(200);
  });

  it('lets a confirmation expire', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const { send } = browser();
    await login(send);
    expect((await send('/very-sensitive')).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      expect((await send('/very-sensitive')).status).toBe(423);
      expect((await send('/sensitive')).status).toBe(200); // 15 minutes by default
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- Type guarantees (never called) -----------------------------------------------------------

export function authTypes() {
  openRoutes((Route) => {
    // @ts-expect-error — `ctx.user` needs authenticate() on the route
    Route.get('/me', (ctx: HttpContext<Authenticated>) => ctx.user.name);
    Route.middleware(authenticate()).get('/me', (ctx: HttpContext<Authenticated>) => ctx.user.name);
  });
  // A controller types its context with `& Authenticated` and carries no `authorize` for it.
  const NameRequest = defineRequest({ schema: r.object({ name: r.string() }) });
  class RenameController extends Controller {
    static request = NameRequest;
    handle(ctx: ContextOf<typeof NameRequest> & Authenticated) {
      return `${ctx.user.name}: ${ctx.body.name}`;
    }
  }
  openRoutes((Route) => {
    Route.middleware(authenticate()).put('/rename', RenameController);
    // @ts-expect-error — `Authenticated` in the controller's context needs authenticate() on the route
    Route.put('/rename-anyone', RenameController);
  });
  // Without `AuthTypes`, the user type says what to declare.
  expectTypeOf<UserOf<{}>>().toEqualTypeOf<AuthTypesNotDeclared>();
  const user = {} as UserOf<{}>;
  // @ts-expect-error — Property 'name' does not exist on type 'AuthTypesNotDeclared'
  user.name;
  // A user type without an id is refused too.
  expectTypeOf<UserOf<{ user: { name: string } }>>().toEqualTypeOf<AuthTypesNotDeclared>();
}

describe('Auth with a second factor (pending state)', () => {
  type Send = ReturnType<Awaited<ReturnType<typeof boot>>['browser']>['send'];
  const withFactor = () => new Map<number, SecondFactor[]>([[1, ['totp']]]);
  const post = (send: Send, path: string, json: unknown = {}) => send(path, { method: 'POST', json });
  const rememberLogin = (send: Send) => post(send, '/login', { email: ada.email, password: 'secret', remember: true });
  const sessionData = async (booted: Awaited<ReturnType<typeof boot>>, cookie: string) => {
    const id = await booted.application.container.make(Encrypter).decrypt(decodeURIComponent(cookie.split('=')[1]!), 'cookie:marmeon_session');
    return JSON.parse((await booted.store.read(sessionKey(id)))!.data) as Record<string, unknown>;
  };

  it('holds a correct password back: user(), authenticate() and the shared props see a guest, nobody is signed in, no Login event, no remember cookie, a new session id', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send, cookie, jar } = booted.browser();
    await send('/token');
    const planted = cookie();
    events.length = 0;
    const answer = await rememberLogin(send);
    expect(answer.status).toBe(422); // the test controller shows anything but ok as a failed sign-in
    expect(events.filter((event) => event instanceof Login)).toEqual([]);
    expect(jar.has('marmeon_remember')).toBe(false);
    expect(cookie()).not.toBe(planted);
    expect(await (await send('/who')).json()).toEqual({ id: null, viaRemember: false });
    expect((await send('/me')).status).toBe(401);
    const stored = await sessionData(booted, cookie());
    expect(stored).toMatchObject({ _auth_pending: { id: 1, remember: true, failures: 0, factors: ['totp'] } });
    expect(Object.keys(stored)).not.toContain(AUTH_SESSION_KEYS.id);
    expect(await (await send('/pending')).json()).toEqual({ pending: { factors: ['totp'] }, user: null });
  });

  it('answers a wrong password as before and starts no pending state', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send } = booted.browser();
    expect(await (await login(send, 'wrong')).json()).toEqual({ message: 'These credentials do not match our records.' });
    expect(await (await send('/pending')).json()).toEqual({ pending: null, user: null });
  });

  it('attempt() reports two-factor-required with the factors, and an account without a factor signs in as before', async () => {
    const booted = await boot({ factors: withFactor() });
    const bob: TestUser = { id: 2, name: 'Bob', email: 'bob@example.com' };
    await booted.add(ada);
    await booted.add(bob);
    const { send } = booted.browser();
    expect((await login(send, 'secret', bob.email)).headers.get('location')).toBe('/home');
    expect(await (await send('/who')).json()).toEqual({ id: 2, viaRemember: false });
  });

  it('login() holds the account back too and answers two-factor-required', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    await booted.add({ id: 2, name: 'Bob', email: 'bob@example.com' });
    const { send, jar } = booted.browser();
    events.length = 0;
    expect(await (await post(send, '/login-as/1')).json()).toEqual({ result: 'two-factor-required' });
    expect(events.filter((event) => event instanceof Login)).toEqual([]);
    expect(jar.has('marmeon_remember')).toBe(false);
    expect(await (await send('/pending')).json()).toEqual({ pending: { factors: ['totp'] }, user: null });
    expect(await (await post(booted.browser().send, '/login-as/2')).json()).toEqual({ result: 'signed-in' });
  });

  it('the factor of a login() sign-in does not confirm the password — nobody typed one; the factor of an attempt() does', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const linked = booted.browser();
    expect(await (await post(linked.send, '/login-as/1')).json()).toEqual({ result: 'two-factor-required' });
    expect(await (await post(linked.send, '/complete-pending')).json()).toEqual({ ok: true, id: 1 });
    expect((await linked.send('/me')).status).toBe(200);
    expect((await linked.send('/sensitive')).status).toBe(423);
    const typed = booted.browser();
    await login(typed.send);
    await post(typed.send, '/complete-pending');
    expect((await typed.send('/sensitive')).status).toBe(200);
  });

  it('dates the confirmation of an attempt() sign-in when the password was typed, not when the factor was proven', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send } = booted.browser();
    await login(send);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 240_000 }); // the factor, 4 minutes later
    try {
      await post(send, '/complete-pending');
      expect((await send('/sensitive')).status).toBe(200);
      expect((await send('/very-sensitive')).status).toBe(423); // 60 seconds from the typing, long gone
      vi.setSystemTime(Date.now() + 660_000 + 1_000); // 15 minutes and a second after the typing
      expect((await send('/sensitive')).status).toBe(423);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a confirmation only inside the sign-in it belongs to — one older than the sign-in is not confirmed', async () => {
    const booted = await boot();
    await booted.add(ada);
    const { send, cookie } = booted.browser();
    await login(send);
    expect((await send('/sensitive')).status).toBe(200);
    const id = await booted.application.container.make(Encrypter).decrypt(decodeURIComponent(cookie().split('=')[1]!), 'cookie:marmeon_session');
    const read = (await booted.store.read(sessionKey(id)))!;
    const data = JSON.parse(read.data) as Record<string, number>;
    data[AUTH_SESSION_KEYS.confirmedAt] = data[AUTH_SESSION_KEYS.signedInAt]! - 120;
    await booted.store.write(sessionKey(id), JSON.stringify(data), { expectedVersion: read.version, lifetimeSeconds: 7200 });
    expect((await send('/sensitive')).status).toBe(423);
    delete data[AUTH_SESSION_KEYS.signedInAt];
    data[AUTH_SESSION_KEYS.confirmedAt] = Math.floor(Date.now() / 1000) - 5;
    const again = (await booted.store.read(sessionKey(id)))!;
    await booted.store.write(sessionKey(id), JSON.stringify(data), { expectedVersion: again.version, lifetimeSeconds: 7200 });
    expect((await send('/sensitive')).status).toBe(423); // a session without signedInAt gets one now, after the confirmation
  });

  it('invariant: a caller that ignores two-factor-required still has nobody signed in', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send } = booted.browser();
    expect(await (await post(send, '/login-ignoring', { email: ada.email, password: 'secret' })).json()).toEqual({ continued: true, error: { kind: 'two-factor-required', factors: ['totp'] } });
    expect(await (await send('/who')).json()).toEqual({ id: null, viaRemember: false });
    expect((await send('/me')).status).toBe(401);
  });

  it('replaces a signed-in session of another account with the pending state', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    await booted.add({ id: 2, name: 'Bob', email: 'bob@example.com' });
    const { send } = booted.browser();
    await login(send, 'secret', 'bob@example.com');
    await login(send);
    expect(await (await send('/who')).json()).toEqual({ id: null, viaRemember: false });
  });

  it('COMPLETE_PENDING signs in: new session id, one Login event, the remember cookie, the factor and password times', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send, cookie, jar } = booted.browser();
    await rememberLogin(send);
    const held = cookie();
    events.length = 0;
    expect(await (await post(send, '/complete-pending')).json()).toEqual({ ok: true, id: 1 });
    expect(cookie()).not.toBe(held);
    expect(events.filter((event) => event instanceof Login)).toEqual([expect.objectContaining({ via: 'attempt', remember: true })]);
    expect(jar.has('marmeon_remember')).toBe(true);
    expect(await (await send('/who')).json()).toEqual({ id: 1, viaRemember: false });
    const stored = await sessionData(booted, cookie());
    expect(stored).toMatchObject({ _auth_id: 1, _auth_two_factor_at: expect.any(Number), _auth_confirmed_at: expect.any(Number) });
    expect(Object.keys(stored)).not.toContain(AUTH_SESSION_KEYS.pending);
    expect(await (await post(send, '/complete-pending')).json()).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('COMPLETE_PENDING refuses without a pending state', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    expect(await (await post(booted.browser().send, '/complete-pending')).json()).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('invariant: a password changed between password and factor ends the pending state', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send } = booted.browser();
    await login(send);
    booted.users.rows.get(1)!.hash = await booted.application.container.make(Hasher).make('new password');
    expect(await (await post(send, '/complete-pending')).json()).toEqual({ ok: false, kind: 'expired' });
    expect(await (await send('/who')).json()).toEqual({ id: null, viaRemember: false });
    expect(await (await send('/pending')).json()).toEqual({ pending: null, user: null });
  });

  it('COMPLETE_PENDING checks the account again by itself', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send } = booted.browser();
    await login(send);
    booted.users.rows.get(1)!.hash = await booted.application.container.make(Hasher).make('new password');
    expect(await (await post(send, '/complete-pending', { direct: true })).json()).toEqual({ ok: false, kind: 'expired' });
    expect(await (await send('/who')).json()).toEqual({ id: null, viaRemember: false });
  });

  it('COMPLETE_PENDING refuses once the pending state ran out', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send } = booted.browser();
    await login(send);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 301_000 });
    try {
      expect(await (await send('/pending')).json()).toEqual({ pending: null, user: null });
      expect(await (await post(send, '/complete-pending')).json()).toEqual({ ok: false, kind: 'expired' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logging out drops the pending state', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send } = booted.browser();
    await login(send);
    await post(send, '/logout');
    expect(await (await send('/pending')).json()).toEqual({ pending: null, user: null });
  });

  it('an account\'s pending sign-in cannot be finished with the factor of another account', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    await booted.add({ id: 2, name: 'Bob', email: 'bob@example.com' });
    const { send } = booted.browser();
    await login(send);
    expect(await (await post(send, '/complete-pending', { as: 2 })).json()).toEqual({ ok: false, kind: 'expired' });
    expect(await (await send('/who')).json()).toEqual({ id: null, viaRemember: false });
    expect(await (await send('/pending')).json()).toEqual({ pending: null, user: null }); // and it is gone: the factor has to be proven again
  });

  it('invariant: a new session key between password and factor ends the pending state', async () => {
    const booted = await boot({ factors: withFactor() });
    await booted.add(ada);
    const { send } = booted.browser();
    await login(send);
    booted.users.rows.get(1)!.key = 'rotated-key';
    expect(await (await post(send, '/complete-pending')).json()).toEqual({ ok: false, kind: 'expired' });
    expect(await (await send('/who')).json()).toEqual({ id: null, viaRemember: false });
  });

  it('the remember-me cookie made after the factor counts as having proven it', async () => {
    const factors = withFactor();
    const booted = await boot({ factors });
    await booted.add(ada);
    const first = booted.browser();
    await rememberLogin(first.send);
    expect(first.jar.has('marmeon_remember')).toBe(false); // nothing is remembered before the factor
    await post(first.send, '/complete-pending');
    const reopened = booted.browser(new Map([['marmeon_remember', first.jar.get('marmeon_remember')!]]));
    expect(await (await reopened.send('/who')).json()).toEqual({ id: 1, viaRemember: true });
    expect(await sessionData(booted, reopened.cookie())).toMatchObject({ _auth_id: 1, _auth_two_factor_at: expect.any(Number) });
  });
});
