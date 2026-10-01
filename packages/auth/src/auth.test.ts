import { createApplication, defineModule, listen, type Container } from '@bespokecore/core';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { Controller, defineRoutes, HttpServiceProvider, type HttpContext } from '@bespokecore/http';
import { createHttpKernel } from '@bespokecore/server';
import { CsrfProtection, Session, SessionServiceProvider, SessionStore } from '@bespokecore/session';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  Auth,
  AUTH_SESSION_KEYS,
  authenticate,
  AuthServiceProvider,
  Failed,
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
    const { email, password } = (await ctx.input()) as { email: string; password: string };
    const user = await this.#auth.attempt(email, password);
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
});

const CHEAP = { HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' };

async function boot(options: { env?: Record<string, string>; users?: MemoryUsers } = {}) {
  const users = options.users ?? new MemoryUsers();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', ...CHEAP, ...options.env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, AuthServiceProvider],
    modules: [
      defineModule({
        name: 'auth-test',
        routes,
        listeners: [listen(Login, RecordEvent), listen(Logout, RecordEvent), listen(Failed, RecordEvent)],
      }),
    ],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
    },
  });
  const kernel = createHttpKernel(application);
  const hasher = application.container.make(Hasher);
  const add = async (user: TestUser, password = 'secret') => users.rows.set(user.id, { user, hash: await hasher.make(password) });

  /** A tiny browser: keeps the session cookie between requests. */
  const browser = () => {
    let cookie = '';
    const send = async (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) => {
      const response = await kernel.request(path, {
        method: init.method ?? 'GET',
        headers: { cookie, accept: 'application/json', ...(init.json ? { 'content-type': 'application/json' } : {}), ...init.headers },
        ...(init.json ? { body: JSON.stringify(init.json) } : {}),
      });
      const set = response.headers.getSetCookie().find((header) => header.startsWith('bespoke_session='));
      if (set) cookie = set.split(';')[0]!;
      return response;
    };
    return { send, cookie: () => cookie };
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
    const session = { started: true, get: () => undefined, regenerate() {}, put() {} } as unknown as Session;
    const auth = new Auth(session, users as UserProvider, hasher, { dispatch: async () => {} } as never);
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

  it('refuses to boot without a UserProvider, and says what to bind', async () => {
    await expect(
      createApplication({
        root: import.meta.dirname,
        discover: false,
        env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', ...CHEAP },
        providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, AuthServiceProvider],
        modules: [defineModule({ name: 'auth-test', routes })],
      }),
    ).rejects.toThrow('container.bind(UserProvider, UserRepository)');
  });

  it('keeps the auth keys out of session.all()', () => {
    expect(Object.values(AUTH_SESSION_KEYS).every((key) => key.startsWith('_'))).toBe(true);
  });
});

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

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
