import { createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AccountSessions, Auth, authenticate, AuthServiceProvider, Failed, Hasher, PasswordHasher, RememberTokenReused, RememberTokenStore, UserProvider, type AuthUser, type Credentials, type PasswordHash } from './index.ts';
import { COMPLETE_PENDING, SIGN_IN_VERIFIED } from './auth.ts';
import { NewPassword } from './new-password.ts';
import { REMEMBER_TABLE } from './remember.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { TwoFactorState } from './two-factor/state.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class Users implements UserProvider {
  readonly rows = new Map<number, { user: AuthUser; hash: PasswordHash | null; key: string | null }>();
  async findById(id: number): Promise<Credentials | undefined> {
    const row = this.rows.get(id);
    return row && { user: row.user, passwordHash: row.hash, sessionKey: row.key };
  }
  async findForLogin(email: string): Promise<Credentials | undefined> {
    for (const row of this.rows.values()) if (row.user.email === email) return { user: row.user, passwordHash: row.hash, sessionKey: row.key };
    return undefined;
  }
  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    this.rows.get(id)!.hash = hash;
  }
  /** Compare-and-set; `expected === undefined` writes regardless. */
  async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || (expected !== undefined && row.key !== expected)) return false;
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
    const result = await this.#auth.attempt(email, password, { remember: remember === true });
    return Response.json({ ok: result.ok, kind: result.ok ? null : result.error.kind, pending: this.#auth.pendingSecondFactor() !== undefined });
  }
}

/** `auth.login()` for the account, remembered. */
class LoginAsController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    try {
      return { result: await this.#auth.login(ada, { remember: true }) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
}

/** Finishes the waiting sign-in as the second factor does. */
class CompleteController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    const done = await this.#auth[COMPLETE_PENDING](1);
    return { ok: done.ok, kind: done.ok ? null : done.error.kind };
  }
}

/** A passkey sign-in, as far as `Auth` is concerned: the account is already proven. */
class PasskeyController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    const done = await this.#auth[SIGN_IN_VERIFIED](1, { remember: true });
    return { ok: done.ok };
  }
}

class ChangePasswordController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    await this.#auth.updatePassword('another secret');
    return { done: true };
  }
}

class EndOthersController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { done: await this.#auth.updateSessionKey() };
  }
}

class LogoutOthersController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { done: await this.#auth.logoutOtherDevices('secret') };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/passkey', PasskeyController);
  Route.middleware(authenticate()).post('/change-password', ChangePasswordController);
  Route.middleware(authenticate()).post('/logout-others', LogoutOthersController);
  Route.middleware(authenticate()).post('/end-others', EndOthersController);
  Route.post('/login', LoginController);
  Route.post('/login-as', LoginAsController);
  Route.post('/complete', CompleteController);
  Route.get('/login', () => 'login').name('auth.login');
  Route.middleware(authenticate()).get('/me', (ctx) => ({ id: ctx.user.id }));
});

const failed: Failed[] = [];
class RecordFailed {
  handle(event: Failed) {
    failed.push(event);
  }
}
const reused: RememberTokenReused[] = [];
class RecordReused {
  handle(event: RememberTokenReused) {
    reused.push(event);
  }
}

/**
 * `hold` is the point where a request stops until the test lets it go: after the hasher compared the password (`verify`), right before
 * a remember-me token is written (`create`), or after one was consumed (`consume`) — the slow steps another request can land in. `verify`
 * holds from the start; the others only after `arm()`, so that the test can set an account up first.
 */
async function boot(options: { totp?: boolean; noRebind?: boolean; hold: 'verify' | 'create' | 'consume' }) {
  failed.length = 0;
  reused.length = 0;
  const users = new Users();
  let hasher!: Hasher;
  let armed = options.hold === 'verify';
  let entered!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'sign-in-race-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url), listeners: [listen(Failed, RecordFailed), listen(RememberTokenReused, RecordReused)] })],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users);
      const real = (hasher = container.make(Hasher)); // the app's own costs: its hashes need no rehash
      container.instance(Hasher, {
        make: (password) => real.make(password),
        needsRehash: (hash) => real.needsRehash(hash),
        dummyVerify: (password) => real.dummyVerify(password),
        verify: async (password, hash) => {
          const right = await real.verify(password, hash);
          if (options.hold === 'verify' && armed) {
            entered();
            await gate;
          }
          return right;
        },
      });
      const tokens = container.make(RememberTokenStore);
      container.instance(RememberTokenStore, {
        create: async (...args) => {
          if (options.hold === 'create' && armed) {
            entered();
            await gate;
          }
          return tokens.create(...args);
        },
        consume: async (cookie) => {
          const consumed = await tokens.consume(cookie);
          if (options.hold === 'consume' && armed) {
            entered();
            await gate;
          }
          return consumed;
        },
        exists: (cookie) => tokens.exists(cookie),
        forget: (cookie) => tokens.forget(cookie),
        forgetUser: (...args) => tokens.forgetUser(...args),
        prune: (days) => tokens.prune(days),
        ...(options.noRebind ? {} : { rebind: (userId: number | string, cookie: string, fingerprint: string) => tokens.rebind!(userId, cookie, fingerprint) }),
      });
      if (options.totp) container.instance(TwoFactorState, { factors: async () => ['totp'], enabledSince: async () => undefined });
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
    return { send, jar };
  };
  const { send, jar } = browser();
  users.rows.set(1, { user: ada, hash: await hasher.make('secret'), key: null });
  const tokenCount = async () => (await application.container.make(Connections).get<any>().selectFrom(REMEMBER_TABLE).selectAll().execute()).length as number;
  const end = async () => void (await application.container.make(AccountSessions).end(1));
  const arm = () => void (armed = true);
  return { application, users, send, jar, browser, arm, held, release, hasher, tokenCount, end };
}

type World = Awaited<ReturnType<typeof boot>>;

/** Runs `start` until it stops at the hold, runs `during` there, then lets it go. */
async function during<T>(world: World, start: () => Promise<T>, between: () => Promise<unknown>): Promise<T> {
  const running = start();
  await world.held;
  await between();
  world.release();
  return running;
}

const attempt = (world: World, remember = false) => async () =>
  (await (await world.send('/login', { email: ada.email, password: 'secret', remember })).json()) as { ok: boolean; kind: string | null; pending: boolean };

describe('a password sign-in while the account changes', () => {
  it('is not signed in when AccountSessions.end() committed during the password check', async () => {
    const world = await boot({ hold: 'verify' });
    const answer = await during(world, attempt(world), world.end);
    expect(answer).toMatchObject({ ok: false, kind: 'invalid-credentials' });
    expect((await world.send('/me')).status).toBe(401);
    expect(failed).toHaveLength(1);
  });

  it('is not signed in when a password reset committed during the check', async () => {
    const world = await boot({ hold: 'verify' });
    const reset = async () => {
      const container = world.application.container;
      await container.make(NewPassword).store(world.users, container.make(RememberTokenStore), 1, await world.hasher.make('reset'), 'reset');
    };
    const answer = await during(world, attempt(world, true), reset);
    expect(answer).toMatchObject({ ok: false, kind: 'invalid-credentials' });
    expect((await world.send('/me')).status).toBe(401);
    expect(world.jar.has('remember_web')).toBe(false);
    expect(await world.tokenCount()).toBe(0);
    expect(failed).toHaveLength(1);
  });

  it('creates no remember-me token then', async () => {
    const world = await boot({ hold: 'verify' });
    await during(world, attempt(world, true), world.end);
    expect(world.jar.has('remember_web')).toBe(false);
    expect(await world.tokenCount()).toBe(0);
  });

  it('holds nothing back for the second factor of an account that changed meanwhile', async () => {
    const world = await boot({ totp: true, hold: 'verify' });
    const answer = await during(world, attempt(world), world.end);
    expect(answer).toMatchObject({ ok: false, kind: 'invalid-credentials', pending: false });
  });

  it('signs in as before when nothing changed', async () => {
    const world = await boot({ hold: 'verify' });
    world.release();
    const answer = (await (await world.send('/login', { email: ada.email, password: 'secret' })).json()) as { ok: boolean };
    expect(answer.ok).toBe(true);
    expect((await world.send('/me')).status).toBe(200);
    expect(failed).toHaveLength(0);
  });

  it('signs in when the password needed a rehash', async () => {
    const world = await boot({ hold: 'verify' });
    world.users.rows.get(1)!.hash = await new PasswordHasher({ driver: 'scrypt', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } }).make('secret');
    world.release();
    expect(((await (await world.send('/login', { email: ada.email, password: 'secret' })).json()) as { ok: boolean }).ok).toBe(true);
    expect(world.users.rows.get(1)!.hash).toMatch(/^\$argon2id/);
    expect((await world.send('/me')).status).toBe(200);
  });
});

const login = async (send: World['send'], remember = true) => {
  const answer = (await (await send('/login', { email: ada.email, password: 'secret', remember })).json()) as { ok: boolean };
  expect(answer.ok).toBe(true);
};

/** The remember-me cookie alone must not sign in: the first request stays a guest, and the token is gone afterwards. */
async function expectRefused(world: World, jar: Map<string, string>, send: World['send']) {
  expect(jar.has('remember_web'), 'the sign-in handed out a cookie').toBe(true);
  expect((await send('/me')).status).toBe(401);
  expect((await send('/me')).status, 'and again').toBe(401);
  expect(jar.has('remember_web')).toBe(false);
  expect(await world.tokenCount()).toBe(0);
}

describe('a remember-me token is bound to the account state it was issued under', () => {
  it('is refused when AccountSessions.end() ran between the check and the token (attempt)', async () => {
    const world = await boot({ hold: 'create' });
    world.arm();
    await during(world, attempt(world, true), world.end);
    await expectRefused(world, world.jar, world.send);
  });

  it('is refused when a password reset ran between the check and the token', async () => {
    const world = await boot({ hold: 'create' });
    world.arm();
    const reset = async () => {
      const container = world.application.container;
      await container.make(NewPassword).store(world.users, container.make(RememberTokenStore), 1, await world.hasher.make('reset'), 'reset');
    };
    await during(world, attempt(world, true), reset);
    await expectRefused(world, world.jar, world.send);
  });

  it('is refused when updatePassword() of another device ran in between', async () => {
    const world = await boot({ hold: 'create' });
    const other = world.browser();
    await login(other.send, false);
    world.arm();
    await during(world, attempt(world, true), async () => void (await other.send('/change-password', {})));
    await expectRefused(world, world.jar, world.send);
  });

  it('is refused when logoutOtherDevices() of another device ran in between', async () => {
    const world = await boot({ hold: 'create' });
    const other = world.browser();
    await login(other.send, false);
    world.arm();
    await during(world, attempt(world, true), async () => expect(await (await other.send('/logout-others', {})).json()).toEqual({ done: true }));
    await expectRefused(world, world.jar, world.send);
  });

  it('is refused for login()', async () => {
    const world = await boot({ hold: 'create' });
    world.arm();
    await during(world, async () => (await world.send('/login-as', {})).json(), world.end);
    await expectRefused(world, world.jar, world.send);
  });

  it('is refused when the second factor finishes the sign-in', async () => {
    const world = await boot({ totp: true, hold: 'create' });
    expect(await attempt(world, true)()).toMatchObject({ kind: 'two-factor-required', pending: true });
    world.arm();
    await during(world, async () => (await world.send('/complete', {})).json(), world.end);
    await expectRefused(world, world.jar, world.send);
  });

  it('is refused for the passkey sign-in', async () => {
    const world = await boot({ hold: 'create' });
    world.arm();
    await during(world, async () => (await world.send('/passkey', {})).json(), world.end);
    await expectRefused(world, world.jar, world.send);
  });

  it('is refused when its cookie is being consumed while end() runs', async () => {
    const world = await boot({ hold: 'consume' });
    await login(world.send);
    const device = world.browser();
    device.jar.set('remember_web', world.jar.get('remember_web')!);
    world.arm();
    const status = await during(world, async () => (await device.send('/me')).status, world.end);
    expect(status).toBe(401);
    expect((await device.send('/me')).status).toBe(401);
    expect(await world.tokenCount()).toBe(0);
  });

  it('is refused after the key changed although the token itself survived (a delete that did not happen)', async () => {
    const world = await boot({ hold: 'create' });
    await login(world.send);
    const device = world.browser();
    device.jar.set('remember_web', world.jar.get('remember_web')!);
    expect(await world.users.updateSessionKey(1, 'another-key', null)).toBe(true);
    expect(await world.tokenCount()).toBe(1);
    expect((await device.send('/me')).status).toBe(401);
    expect(await world.tokenCount()).toBe(0);
  });

  it('is refused when the row has no fingerprint (a token from before the column)', async () => {
    const world = await boot({ hold: 'create' });
    await login(world.send);
    await world.application.container.make(Connections).get<any>().updateTable(REMEMBER_TABLE).set({ account_fingerprint: null }).execute();
    const device = world.browser();
    device.jar.set('remember_web', world.jar.get('remember_web')!);
    expect((await device.send('/me')).status).toBe(401);
    expect(await world.tokenCount()).toBe(0);
  });

  it('keeps the token of the device that updateSessionKey() leaves signed in', async () => {
    const world = await boot({ hold: 'create' });
    await login(world.send);
    const device = world.browser();
    device.jar.set('remember_web', world.jar.get('remember_web')!);
    expect((await device.send('/me')).status).toBe(200);
    expect(await (await device.send('/end-others', {})).json()).toEqual({ done: true });
    const later = world.browser();
    later.jar.set('remember_web', device.jar.get('remember_web')!);
    expect((await later.send('/me')).status, 'the token this device kept').toBe(200);
  });

  it('fails closed with a store that cannot rebind: the kept device signs in again', async () => {
    const world = await boot({ hold: 'create', noRebind: true });
    await login(world.send);
    const device = world.browser();
    device.jar.set('remember_web', world.jar.get('remember_web')!);
    expect((await device.send('/me')).status).toBe(200);
    expect(await (await device.send('/end-others', {})).json()).toEqual({ done: true });
    const later = world.browser();
    later.jar.set('remember_web', device.jar.get('remember_web')!);
    expect((await later.send('/me')).status, 'the kept token no longer fits').toBe(401);
    expect(await world.tokenCount()).toBe(0);
  });

  it.each([
    ['logoutOtherDevices()', '/logout-others'],
    ['updateSessionKey()', '/end-others'],
  ])('does not keep the token of a thief who rotated the owner\'s cookie: %s ends everything and reports the copy', async (_name, route) => {
    const world = await boot({ hold: 'create' });
    await login(world.send);
    const owner = world.send;
    const thief = world.browser();
    thief.jar.set('remember_web', world.jar.get('remember_web')!);
    expect((await thief.send('/me')).status, 'the copy signs in and rotates the cookie').toBe(200);
    // The owner's cookie is the previous validator, and past the grace window.
    await world.application.container.make(Connections).get<any>().updateTable(REMEMBER_TABLE).set({ rotated_at: new Date(Date.now() - 3_600_000) }).execute();

    expect(await (await owner(route, {})).json()).toEqual({ done: false });
    expect(await world.tokenCount(), 'no token is kept').toBe(0);
    const later = world.browser();
    later.jar.set('remember_web', thief.jar.get('remember_web')!);
    expect((await later.send('/me')).status, "the thief's cookie").toBe(401);
    expect((await thief.send('/me')).status, "the thief's session").toBe(401);
    expect((await owner('/me')).status, "the owner's session ends too").toBe(401);
    expect(reused, "the owner is told").toHaveLength(1);
  });

  it('keeps working for an untouched account, and for the device that logoutOtherDevices() leaves signed in', async () => {
    const world = await boot({ hold: 'create' });
    await login(world.send);
    const device = world.browser();
    device.jar.set('remember_web', world.jar.get('remember_web')!);
    expect((await device.send('/me')).status, 'a plain remember-me sign-in').toBe(200);
    expect(await (await device.send('/logout-others', {})).json()).toEqual({ done: true });
    const later = world.browser();
    later.jar.set('remember_web', device.jar.get('remember_web')!);
    expect((await later.send('/me')).status, 'the token this device kept').toBe(200);
  });
});
