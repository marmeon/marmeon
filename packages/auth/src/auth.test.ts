import { createApplication, defineModule, listen, type Container } from '@bespokecore/core';
import { DatabaseServiceProvider, Migrator } from '@bespokecore/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { Controller, defineRoutes, HttpServiceProvider, type HttpContext } from '@bespokecore/http';
import { createHttpKernel } from '@bespokecore/server';
import { CsrfProtection, Session, SessionServiceProvider, SessionStore } from '@bespokecore/session';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  Auth,
  AUTH_SESSION_KEYS,
  authenticate,
  AuthServiceProvider,
  confirmedPassword,
  DEFAULT_HASHER_OPTIONS,
  Failed,
  PasswordChanged,
  RememberTokenStore,
  guest,
  Hasher,
  Login,
  Logout,
  PasswordHasher,
  UserProvider,
  type Authenticated,
  type AuthTypesNotDeclared,
  type Credentials,
  type PasswordHash,
  type UserOf,
} from './index.ts';

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
  readonly rows = new Map<number, { user: TestUser; hash: PasswordHash | null }>();
  readonly rehashed: number[] = [];

  async findById(id: number): Promise<Credentials<TestUser> | undefined> {
    const row = this.rows.get(id);
    return row && { user: row.user, passwordHash: row.hash };
  }

  async findForLogin(email: string): Promise<Credentials<TestUser> | undefined> {
    for (const row of this.rows.values()) if (row.user.email === email) return { user: row.user, passwordHash: row.hash };
    return undefined;
  }

  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    this.rows.get(id)!.hash = hash;
    this.rehashed.push(id);
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
    const user = await this.#auth.attempt(email, password, { remember: remember === true });
    return user ? this.redirect().intended().route('home') : Response.json({ message: 'These credentials do not match our records.' }, { status: 422 });
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

const events: object[] = [];
class RecordEvent {
  handle(event: object) {
    events.push(event);
  }
}

const routes = defineRoutes((Route) => {
  Route.middleware(guest('/home')).get('/login', () => 'login page').name('auth.login');
  Route.post('/login', LoginController);
  Route.post('/logout', LogoutController);
  Route.get('/token', TokenController);
  Route.get('/home', () => 'home').name('home');
  Route.middleware(authenticate()).get('/me', (ctx) => ({ id: ctx.user.id, name: ctx.user.name }));
  Route.get('/who', WhoController);
  Route.get('/confirm-password', () => 'confirm').name('auth.password.confirm');
  Route.post('/confirm-password', ConfirmPasswordController);
  const signedIn = Route.middleware(authenticate());
  signedIn.middleware(confirmedPassword()).get('/sensitive', () => 'sensitive');
  signedIn.middleware(confirmedPassword({ seconds: 60 })).get('/very-sensitive', () => 'very sensitive');
  signedIn.post('/password', UpdatePasswordController);
  signedIn.post('/logout-others', LogoutOtherDevicesController);
});

const CHEAP = { HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' };

async function boot(options: { env?: Record<string, string>; users?: MemoryUsers } = {}) {
  const users = options.users ?? new MemoryUsers();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', ...CHEAP, ...options.env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [
      defineModule({
        name: 'auth-test',
        routes,
        migrations: new URL('./__fixtures__/migrations/', import.meta.url),
        listeners: [listen(Login, RecordEvent), listen(Logout, RecordEvent), listen(Failed, RecordEvent), listen(PasswordChanged, RecordEvent)],
      }),
    ],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
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
    return { send, cookie: () => (jar.has('bespoke_session') ? `bespoke_session=${jar.get('bespoke_session')}` : ''), jar };
  };
  return { application, users, add, browser, store: application.container.make(SessionStore) };
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

  it('counter-check (session fixation): the session id and the CSRF token from before the login do not survive it', async () => {
    const { add, browser, store, application } = await boot();
    await add(ada);
    const { send, cookie } = browser();
    const sessionId = (header: string) => application.container.make(Encrypter).decrypt(decodeURIComponent(header.split('=')[1]!), 'cookie:bespoke_session');
    const before = (await (await send('/token')).json()) as { token: string };
    const planted = cookie();
    await login(send);
    expect(cookie()).not.toBe(planted);
    expect(((await (await send('/token')).json()) as { token: string }).token).not.toBe(before.token);
    // The planted id is gone from the store: an attacker who set it holds nothing.
    const plantedId = await sessionId(planted);
    expect(plantedId).toMatch(/^[\w-]{40}$/);
    expect(await store.read(plantedId)).toBeUndefined();
    expect(await store.read(await sessionId(cookie()))).toMatchObject({ [AUTH_SESSION_KEYS.id]: 1 });
  });

  it('answers an unknown e-mail exactly like a wrong password (no enumeration)', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const wrong = await login(browser().send, 'wrong');
    const unknown = await login(browser().send, 'secret', 'nobody@example.com');
    expect([wrong.status, await wrong.text()]).toEqual([unknown.status, await unknown.text()]);
    expect(events.filter((event) => event instanceof Failed).slice(-2).map((event) => (event as Failed).identifier)).toEqual(['ada@example.com', 'nobody@example.com']);
  });

  it('counter-check (enumeration by timing): an unknown e-mail takes as long as a wrong password', async () => {
    const users = new MemoryUsers();
    const hasher = new PasswordHasher(); // real costs, so the hash dominates the time
    users.rows.set(1, { user: ada, hash: await hasher.make('secret') });
    const session = { started: true, get: () => undefined, regenerate() {}, put() {}, forget() {} } as unknown as Session;
    const auth = new Auth(session, users as UserProvider, hasher, { dispatch: async () => {} } as never, { get: () => undefined } as never, {} as never, {} as never, {} as never, {} as never);
    await auth.attempt('nobody@example.com', 'x'); // makes dummyVerify's reference hash
    const time = async (email: string) => {
      const started = performance.now();
      expect(await auth.attempt(email, 'wrong')).toBeUndefined();
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

  it('rehashes a password made with other costs when its owner signs in', async () => {
    const { users, browser } = await boot();
    const old = await new PasswordHasher({ driver: 'scrypt', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } }).make('secret');
    users.rows.set(1, { user: ada, hash: old });
    await login(browser().send);
    expect(users.rehashed).toEqual([1]);
    expect(users.rows.get(1)!.hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  it('counter-check (password changed elsewhere): other sessions end on their next request', async () => {
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

  it('dispatches Login with the user', async () => {
    const { add, browser } = await boot();
    await add(ada);
    events.length = 0;
    await login(browser().send);
    expect(events).toEqual([expect.any(Login)]);
    expect((events[0] as Login).user).toEqual(ada);
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
      env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', DB_DATABASE: ':memory:', LOG_LEVEL: 'silent', ...CHEAP },
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
      modules: [defineModule({ name: 'auth-test', routes })], // boots: make:auth must run in apps without an auth module
    });
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

describe('remember me (E26)', () => {
  const rememberLogin = (send: ReturnType<Awaited<ReturnType<typeof boot>>['browser']>['send']) =>
    send('/login', { method: 'POST', json: { email: ada.email, password: 'secret', remember: true } });

  it('keeps signing in by the cookie once the session is gone — and rotates it on every use', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const laptop = browser();
    await rememberLogin(laptop.send);
    const first = laptop.jar.get('remember_web');
    expect(first).toBeTruthy();
    // The browser closes: the session cookie is gone, the remember cookie stays.
    const reopened = browser(new Map([['remember_web', first!]]));
    expect(await (await reopened.send('/who')).json()).toEqual({ id: 1, viaRemember: true });
    expect(reopened.jar.get('remember_web')).not.toBe(first); // rotated
    expect(reopened.jar.has('bespoke_session')).toBe(true); // and a session again
    expect(await (await reopened.send('/who')).json()).toEqual({ id: 1, viaRemember: true }); // from the session now
  });

  it('sets the cookie only when asked to, HttpOnly and long-lived', async () => {
    const { add, browser } = await boot({ env: { AUTH_REMEMBER_DAYS: '7' } });
    await add(ada);
    const plain = browser();
    await login(plain.send);
    expect(plain.jar.has('remember_web')).toBe(false);
    const response = await rememberLogin(browser().send);
    const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith('remember_web='))!;
    expect(header).toMatch(/; Max-Age=60(4799|4800); HttpOnly; SameSite=Lax$/);
  });

  it('counter-check (copied cookie): the thief and the owner are both signed out, and every device of the user with them', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const owner = browser();
    await rememberLogin(owner.send);
    const otherDevice = browser();
    await rememberLogin(otherDevice.send);
    const copied = owner.jar.get('remember_web')!;

    const thief = browser(new Map([['remember_web', copied]]));
    expect(await (await thief.send('/who')).json()).toMatchObject({ id: 1 }); // first use wins, rotates
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      const ownerLater = browser(new Map([['remember_web', copied]])); // the owner's browser, session expired
      expect(await (await ownerLater.send('/who')).json()).toEqual({ id: null, viaRemember: false });
      expect(ownerLater.jar.has('remember_web')).toBe(false); // the cookie is deleted
      const thiefLater = browser(new Map([['remember_web', thief.jar.get('remember_web')!]]));
      expect(await (await thiefLater.send('/who')).json()).toMatchObject({ id: null });
      const otherLater = browser(new Map([['remember_web', otherDevice.jar.get('remember_web')!]]));
      expect(await (await otherLater.send('/who')).json()).toMatchObject({ id: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs out only this device', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const laptop = browser();
    const phone = browser();
    await rememberLogin(laptop.send);
    await rememberLogin(phone.send);
    const laptopCookie = laptop.jar.get('remember_web')!;
    await laptop.send('/logout', { method: 'POST' });
    expect(laptop.jar.has('remember_web')).toBe(false);
    expect(await (await browser(new Map([['remember_web', laptopCookie]])).send('/who')).json()).toMatchObject({ id: null });
    expect(await (await browser(new Map([['remember_web', phone.jar.get('remember_web')!]])).send('/who')).json()).toMatchObject({ id: 1 });
  });

  it('ignores remember cookies of deleted users and forged cookies', async () => {
    const { add, users, browser, application } = await boot();
    await add(ada);
    const laptop = browser();
    await rememberLogin(laptop.send);
    users.rows.delete(1);
    expect(await (await browser(new Map([['remember_web', laptop.jar.get('remember_web')!]])).send('/who')).json()).toMatchObject({ id: null });
    // A cookie the app did not encrypt is not even read.
    const plain = await application.container.make(RememberTokenStore).create(1, new Date(Date.now() + 60_000));
    expect(await (await browser(new Map([['remember_web', plain]])).send('/who')).json()).toMatchObject({ id: null });
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
    const phoneRemember = phone.jar.get('remember_web')!;
    events.length = 0;
    expect(await (await laptop.send('/password', { method: 'POST', json: { password: 'a new secret' } })).json()).toEqual({ changed: true });
    expect((await laptop.send('/me')).status).toBe(200);
    expect((await phone.send('/me')).status).toBe(401);
    expect(await (await browser(new Map([['remember_web', phoneRemember]])).send('/who')).json()).toMatchObject({ id: null });
    expect(events).toEqual([expect.any(PasswordChanged)]);
    expect((await login(browser().send, 'a new secret')).status).toBe(303);
  });

  it('signs out the other devices with the password — this one stays, and keeps its remember-me token', async () => {
    const { add, browser } = await boot();
    await add(ada);
    const laptop = browser();
    const phone = browser();
    await laptop.send('/login', { method: 'POST', json: { email: ada.email, password: 'secret', remember: true } });
    await phone.send('/login', { method: 'POST', json: { email: ada.email, password: 'secret', remember: true } });
    const phoneRemember = phone.jar.get('remember_web')!;
    expect(await (await laptop.send('/logout-others', { method: 'POST', json: { password: 'wrong' } })).json()).toEqual({ done: false });
    expect((await phone.send('/me')).status).toBe(200);
    expect(await (await laptop.send('/logout-others', { method: 'POST', json: { password: 'secret' } })).json()).toEqual({ done: true });
    expect((await laptop.send('/me')).status).toBe(200);
    expect((await phone.send('/me')).status).toBe(401);
    expect(await (await browser(new Map([['remember_web', phoneRemember]])).send('/who')).json()).toMatchObject({ id: null });
    expect(await (await browser(new Map([['remember_web', laptop.jar.get('remember_web')!]])).send('/who')).json()).toMatchObject({ id: 1 });
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
    const later = browser(new Map([['remember_web', remembered.jar.get('remember_web')!]]));
    const away = await later.send('/sensitive?tab=keys', { headers: html });
    expect([away.status, away.headers.get('location')]).toEqual([302, '/confirm-password']);
    expect((await later.send('/sensitive')).status).toBe(423); // JSON clients
    expect((await later.send('/confirm-password', { method: 'POST', json: { password: 'wrong' } })).status).toBe(422);
    const back = await later.send('/confirm-password', { method: 'POST', json: { password: 'secret' } });
    expect(back.headers.get('location')).toBe('/sensitive?tab=keys');
    expect((await later.send('/sensitive', { headers: html })).status).toBe(200);
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
  defineRoutes((Route) => {
    // @ts-expect-error — `ctx.user` needs authenticate() on the route
    Route.get('/me', (ctx: HttpContext<Authenticated>) => ctx.user.name);
    Route.middleware(authenticate()).get('/me', (ctx: HttpContext<Authenticated>) => ctx.user.name);
  });
  // Without `AuthTypes`, the user type says what to declare.
  expectTypeOf<UserOf<{}>>().toEqualTypeOf<AuthTypesNotDeclared>();
  const user = {} as UserOf<{}>;
  // @ts-expect-error — Property 'name' does not exist on type 'AuthTypesNotDeclared'
  user.name;
  // A user type without an id is refused too.
  expectTypeOf<UserOf<{ user: { name: string } }>>().toEqualTypeOf<AuthTypesNotDeclared>();
}
