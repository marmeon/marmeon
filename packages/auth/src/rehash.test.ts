import { createApplication, defineModule, type Container } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { Auth, authenticate, AuthServiceProvider, Hasher, PasswordHasher, UserProvider, type AuthUser, type PasswordHash } from './index.ts';
import { NewPassword } from './new-password.ts';
import { SIGN_INS_TABLE } from './sign-ins.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';

// A rehash at sign-in changes the stored hash and nothing else: every other sign-in of the account stays. Only a new session key ends
// sign-ins — a new password, a reset, signing out the other devices.

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class LoginController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { email, password } = (await ctx.input()) as { email: string; password: string };
    return { ok: (await this.#auth.attempt(email, password, { remember: true })).ok };
  }
}

/** Signs Ada in without the password check (as a link or a passkey would), remembered. */
class LoginAsController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    await this.#auth.signIn(ada, { remember: true });
    return { ok: true };
  }
}

class ChangePasswordController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    try {
      await this.#auth.checkPassword('secret');
      await this.#auth.updatePassword('another secret');
      return { done: true };
    } catch (error) {
      return Response.json({ thrown: (error as Error).message }, { status: 500 });
    }
  }
}

class LogoutOthersController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { done: (await this.#auth.checkPassword('secret')).ok && (await this.#auth.updateSessionKey()) };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.post('/login-as', LoginAsController);
  Route.middleware(authenticate()).post('/change-password', ChangePasswordController);
  Route.middleware(authenticate()).post('/logout-others', LogoutOthersController);
  Route.get('/login', () => 'login').name('auth.login');
  Route.middleware(authenticate()).get('/me', (ctx) => ({ id: ctx.user.id }));
});

/** Costs the app has since moved away from: a hash made with them is rehashed at the next sign-in. */
const oldCosts = () => new PasswordHasher({ driver: 'scrypt', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } });

async function boot(users = new MemoryUsers<AuthUser>()) {
  let hasher!: Hasher;
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'rehash-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users);
      hasher = container.make(Hasher);
    },
  });
  await application.container.make(Migrator).migrate();
  const kernel = createHttpKernel(application);
  const browser = () => {
    const jar = new Map<string, string>();
    const send = async (path: string, json?: unknown) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, {
        method: json ? 'POST' : 'GET',
        headers: { cookie, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
        ...(json ? { body: JSON.stringify(json) } : {}),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    /** The remember-me cookie alone: the session cookie is gone, as after the browser was closed. */
    const reopen = () => void jar.delete('marmeon_session');
    return { send, jar, reopen };
  };
  users.add(ada, await hasher.make('secret'), null);
  return { application, users, browser, hasher };
}

type World = Awaited<ReturnType<typeof boot>>;

/** Ada signed in on two devices, the costs raised afterwards: the next password sign-in rehashes. */
async function twoDevices(world: World) {
  const [a, b] = [world.browser(), world.browser()];
  await a.send('/login-as', {});
  await b.send('/login-as', {});
  world.users.rows.get(1)!.hash = await oldCosts().make('secret');
  return { a, b };
}

describe('a rehash at sign-in', () => {
  it('keeps the other device signed in, its session and its remember-me cookie', async () => {
    const world = await boot();
    const { a, b } = await twoDevices(world);
    const stale = world.users.rows.get(1)!.hash;
    await a.send('/login', { email: ada.email, password: 'secret' });
    expect(world.users.rows.get(1)!.hash, 'rehashed').not.toBe(stale);
    expect(world.users.rows.get(1)!.hash).toMatch(/^\$argon2id/);
    expect((await b.send('/me')).status, 'the session of the other device').toBe(200);
    b.reopen();
    expect((await b.send('/me')).status, 'its remember-me cookie, without a 401 on the way').toBe(200);
    expect((await a.send('/me')).status, 'and the device that rehashed').toBe(200);
  });

  it('does not touch the session key', async () => {
    const world = await boot();
    world.users.rows.get(1)!.key = 'k'.repeat(43);
    const { a } = await twoDevices(world);
    await a.send('/login', { email: ada.email, password: 'secret' });
    expect(world.users.rows.get(1)!.key).toBe('k'.repeat(43));
  });
});

describe('what ends the sign-ins of the other devices', () => {
  it('a new password: the session and the remember-me cookie of the other device are gone, this one stays', async () => {
    const world = await boot();
    const { a, b } = await twoDevices(world);
    const before = world.users.rows.get(1)!.key;
    expect(await (await a.send('/change-password', {})).json()).toEqual({ done: true });
    expect(world.users.rows.get(1)!.key, 'a key came with the password').toMatch(/^[\w-]{43}$/);
    expect(world.users.rows.get(1)!.key).not.toBe(before);
    expect((await a.send('/me')).status).toBe(200);
    expect((await b.send('/me')).status, 'the session').toBe(401);
    expect(b.jar.has('marmeon_remember')).toBe(true);
    b.reopen();
    expect((await b.send('/me')).status, 'the remember-me cookie').toBe(401);
  });

  it('a reset: every device', async () => {
    const world = await boot();
    const { a, b } = await twoDevices(world);
    const container = world.application.container;
    await container.make(NewPassword).store(world.users, 1, await world.hasher.make('reset'), 'reset');
    expect((await a.send('/me')).status).toBe(401);
    expect((await b.send('/me')).status).toBe(401);
    a.reopen();
    b.reopen();
    expect((await a.send('/me')).status).toBe(401);
    expect((await b.send('/me')).status).toBe(401);
  });

  it('signing out the other devices: the others, with the password hash as it was', async () => {
    const world = await boot();
    const { a, b } = await twoDevices(world);
    const hash = world.users.rows.get(1)!.hash;
    expect(await (await a.send('/logout-others', {})).json()).toEqual({ done: true });
    expect(world.users.rows.get(1)!.hash).toBe(hash);
    expect((await a.send('/me')).status).toBe(200);
    expect((await b.send('/me')).status).toBe(401);
    b.reopen();
    expect((await b.send('/me')).status).toBe(401);
  });

  it('an account without a session key gets one with its first new password', async () => {
    const world = await boot();
    const { a, b } = await twoDevices(world);
    expect(world.users.rows.get(1)!.key).toBeNull();
    await a.send('/change-password', {});
    expect(world.users.rows.get(1)!.key).not.toBeNull();
    expect((await b.send('/me')).status).toBe(401);
  });
});

describe('a provider that ignores the session key of a new password', () => {
  class Forgetful extends MemoryUsers<AuthUser> {
    override async updatePasswordHash(id: number, hash: PasswordHash, options: { readonly expected?: PasswordHash; readonly sessionKey?: string } = {}): Promise<boolean> {
      return super.updatePasswordHash(id, hash, options.expected === undefined ? {} : { expected: options.expected });
    }
  }

  it('makes updatePassword() throw with its code instead of reporting a password change that signed nobody out', async () => {
    const world = await boot(new Forgetful());
    const { a, b } = await twoDevices(world);
    const response = await a.send('/change-password', {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ thrown: expect.stringMatching(/^\[marmeon:A5\] NewPassword: UserProvider\.updatePasswordHash\(id, hash, \{ sessionKey \}\)/) });
    expect((await b.send('/me')).status, 'nothing ended, and nothing was said to').toBe(200);
  });

  it('is caught for an account whose key is null as well', async () => {
    const world = await boot(new Forgetful());
    expect(world.users.rows.get(1)!.key).toBeNull();
    const a = world.browser();
    await a.send('/login-as', {});
    expect(await (await a.send('/change-password', {})).json()).toHaveProperty('thrown');
  });
});

describe('an AccountSessions.end() that lands between the check of the session and the write of a new password', () => {
  /** Ends the account's sessions just before the next password write — after `updatePassword()` read and hashed. */
  class Ending extends MemoryUsers<AuthUser> {
    before: (() => Promise<unknown>) | undefined;
    override async updatePasswordHash(id: number, hash: PasswordHash, options: { readonly expected?: PasswordHash; readonly sessionKey?: string; readonly expectedSessionKey?: string | null } = {}): Promise<boolean> {
      const run = this.before;
      this.before = undefined;
      await run?.();
      return super.updatePasswordHash(id, hash, options);
    }
  }

  it.each([
    ['an account with a session key', 'k'.repeat(43)],
    ['an account without one', null],
  ])('%s: the password stays, the key of end() stays, and the session, its remember-me cookie and its token are gone', async (_name, key) => {
    const users = new Ending();
    const world = await boot(users);
    users.rows.get(1)!.key = key;
    const a = world.browser();
    await a.send('/login-as', {});
    expect(a.jar.has('marmeon_remember'), 'remembered').toBe(true);
    const hash = users.rows.get(1)!.hash;
    // What end() commits: a new key (it runs outside the request's transaction, so the test writes the key as it would have been left).
    users.before = async () => void (users.rows.get(1)!.key = 'e'.repeat(43));
    const response = await a.send('/change-password', {});
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ thrown: expect.stringContaining('needs a signed-in user') });
    const ended = users.rows.get(1)!.key;
    expect(ended, 'the key end() wrote').toBe('e'.repeat(43));
    expect(ended).not.toBe(key);
    expect(users.rows.get(1)!.hash, 'the password was not changed').toBe(hash);
    expect(a.jar.has('marmeon_remember'), 'the cookie of this device went with the session').toBe(false);
    expect(await world.application.container.make(Connections).get<any>().selectFrom(SIGN_INS_TABLE).selectAll().execute(), 'and its sign-in, token included').toHaveLength(0);
    expect((await a.send('/me')).status).toBe(401);
    expect(users.rows.get(1)!.key, 'and nothing wrote over the key of end()').toBe(ended);
  });
});
