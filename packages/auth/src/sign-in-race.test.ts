import { createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AccountSessions, Auth, authenticate, AuthServiceProvider, Failed, Hasher, PasswordHasher, RememberTokenReused, SignInStore, UserProvider, type AuthUser, type PasswordHash } from './index.ts';
import { COMPLETE_PENDING, SIGN_IN_VERIFIED } from './auth.ts';
import { NewPassword } from './new-password.ts';
import { SIGN_INS_TABLE } from './sign-ins.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { twoFactorState } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { TwoFactorState } from './two-factor/state.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class Users extends MemoryUsers<AuthUser> {
  /** A provider written before the answer was required: it writes and says nothing. */
  silent = false;
  override async updatePasswordHash(id: number, hash: PasswordHash, options: { readonly expected?: PasswordHash; readonly sessionKey?: string } = {}): Promise<boolean> {
    if (!this.silent) return super.updatePasswordHash(id, hash, options);
    this.rows.get(id)!.hash = hash;
    return undefined as never;
  }

  /** Same, for the session key. */
  silentKey = false;
  override async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    if (!this.silentKey) return super.updateSessionKey(id, key, expected);
    this.rows.get(id)!.key = key;
    return undefined as never;
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
    let result;
    try {
      result = await this.#auth.attempt(email, password, { remember: remember === true });
    } catch (error) {
      return Response.json({ thrown: (error as Error).message }, { status: 500 });
    }
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
    try {
      return { done: await this.#auth.logoutOtherDevices('secret') };
    } catch (error) {
      return Response.json({ thrown: (error as Error).message }, { status: 500 });
    }
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
 * a remember-me token is written (`issue`), or after one was consumed (`consume`) — the slow steps another request can land in. `verify`
 * holds from the start; the others only after `arm()`, so that the test can set an account up first.
 */
async function boot(options: { totp?: boolean; hold: 'verify' | 'issue' | 'consume' }) {
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
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'sign-in-race-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url), listeners: [listen(Failed, RecordFailed), listen(RememberTokenReused, RecordReused)] })],
  }, {
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users);
      const real = (hasher = container.make(Hasher)); // the app's own costs: its hashes need no rehash
      container.instance(Hasher, {
        make: (password) => real.make(password),
        needsRehash: (hash) => real.needsRehash(hash),
        dummyVerify: (password) => real.dummyVerify(password),
        failureFloorMs: () => real.failureFloorMs(),
        verify: async (password, hash) => {
          const right = await real.verify(password, hash);
          if (options.hold === 'verify' && armed) {
            entered();
            await gate;
          }
          return right;
        },
      });
      const signIns = container.make(SignInStore);
      container.instance(
        SignInStore,
        new HoldingSignIns(signIns, async (point) => {
          if (options.hold === point && armed) {
            entered();
            await gate;
          }
        }),
      );
      if (options.totp) container.instance(TwoFactorState, twoFactorState({ factors: async () => ['totp'] }));
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
  const tokenCount = async () =>
    (await application.container.make(Connections).get<any>().selectFrom(SIGN_INS_TABLE).select('id').where(sql<boolean>`${sql.ref('remember_selector')} is not null`).execute()).length as number;
  const end = async () => void (await application.container.make(AccountSessions).end(1));
  const arm = () => void (armed = true);
  return { application, users, send, jar, browser, arm, held, release, hasher, tokenCount, end };
}

/** A sign-in store that stops where a test asks it to: `hold('issue')` before a token is made, `hold('consume')` after a cookie was checked. */
class HoldingSignIns extends SignInStore {
  readonly #inner: SignInStore;
  readonly #hold: (point: 'issue' | 'consume') => Promise<void>;

  constructor(inner: SignInStore, hold: (point: 'issue' | 'consume') => Promise<void>) {
    super();
    this.#inner = inner;
    this.#hold = hold;
  }

  create(...args: Parameters<SignInStore['create']>) {
    return this.#inner.create(...args);
  }
  seen(...args: Parameters<SignInStore['seen']>) {
    return this.#inner.seen(...args);
  }
  list(...args: Parameters<SignInStore['list']>) {
    return this.#inner.list(...args);
  }
  end(...args: Parameters<SignInStore['end']>) {
    return this.#inner.end(...args);
  }
  endAll(...args: Parameters<SignInStore['endAll']>) {
    return this.#inner.endAll(...args);
  }
  endEveryone() {
    return this.#inner.endEveryone();
  }
  prune(...args: Parameters<SignInStore['prune']>) {
    return this.#inner.prune(...args);
  }
  async issueToken(...args: Parameters<SignInStore['issueToken']>) {
    await this.#hold('issue');
    return this.#inner.issueToken(...args);
  }
  dropToken(...args: Parameters<SignInStore['dropToken']>) {
    return this.#inner.dropToken(...args);
  }
  async consume(cookie: string) {
    const consumed = await this.#inner.consume(cookie);
    await this.#hold('consume');
    return consumed;
  }
  remembered(cookie: string) {
    return this.#inner.remembered(cookie);
  }
  forgetToken(cookie: string) {
    return this.#inner.forgetToken(cookie);
  }
  rebind(...args: Parameters<SignInStore['rebind']>) {
    return this.#inner.rebind(...args);
  }
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
      await container.make(NewPassword).store(world.users, 1, await world.hasher.make('reset'), 'reset');
    };
    const answer = await during(world, attempt(world, true), reset);
    expect(answer).toMatchObject({ ok: false, kind: 'invalid-credentials' });
    expect((await world.send('/me')).status).toBe(401);
    expect(world.jar.has('marmeon_remember')).toBe(false);
    expect(await world.tokenCount()).toBe(0);
    expect(failed).toHaveLength(1);
  });

  it('creates no remember-me token then', async () => {
    const world = await boot({ hold: 'verify' });
    await during(world, attempt(world, true), world.end);
    expect(world.jar.has('marmeon_remember')).toBe(false);
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

describe('a rehash only over the hash that was verified', () => {
  const oldCosts = () => new PasswordHasher({ driver: 'scrypt', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } });
  const reset = (world: World) => async () => {
    const container = world.application.container;
    await container.make(NewPassword).store(world.users, 1, await world.hasher.make('reset'), 'reset');
  };

  it('keeps the password of a reset that landed between the check and the rehash', async () => {
    const world = await boot({ hold: 'verify' });
    world.users.rows.get(1)!.hash = await oldCosts().make('secret');
    const answer = await during(world, attempt(world, true), reset(world));
    expect(answer).toMatchObject({ ok: false, kind: 'invalid-credentials' });
    const stored = world.users.rows.get(1)!.hash!;
    expect(await world.hasher.verify('reset', stored), 'the reset hash survived').toBe(true);
    expect(await world.hasher.verify('secret', stored), 'the old password was not written back').toBe(false);
    expect((await world.send('/me')).status).toBe(401);
    expect(world.jar.has('marmeon_remember')).toBe(false);
    expect(failed, 'no Failed event: the password was right').toHaveLength(0);
  });

  it('keeps the sign-in that rehashed, signing in under the new hash', async () => {
    const world = await boot({ hold: 'verify' });
    world.users.rows.get(1)!.hash = await oldCosts().make('secret');
    world.release();
    const { send } = world;
    const answer = (await (await send('/login', { email: ada.email, password: 'secret', remember: true })).json()) as { ok: boolean };
    expect(answer.ok).toBe(true);
    expect(world.users.rows.get(1)!.hash).toMatch(/^\$argon2id/);
    expect((await send('/me')).status).toBe(200);
    world.jar.delete('marmeon_session');
    expect((await send('/me')).status, 'the remember-me token carries the new hash').toBe(200);
  });

  it('refuses a provider that does not say whether it wrote: the sign-in fails loudly and no session starts', async () => {
    const world = await boot({ hold: 'verify' });
    world.users.silent = true;
    world.users.rows.get(1)!.hash = await oldCosts().make('secret');
    world.release();
    const response = await world.send('/login', { email: ada.email, password: 'secret' });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ thrown: expect.stringMatching(/^\[marmeon:A5\] auth\.attempt\(\)/) });
    expect((await world.send('/me')).status).toBe(401);
  });

  it('logoutOtherDevices() over a provider whose key write does not say whether it wrote throws A5 and does not report success', async () => {
    const world = await boot({ hold: 'verify' });
    world.release();
    await login(world.send, false);
    world.users.silentKey = true;
    const response = await world.send('/logout-others', {});
    expect(response.status).toBe(500);
    const body = (await response.json()) as { thrown?: string; done?: boolean };
    expect(body.thrown).toMatch(/^\[marmeon:A5\] auth\.updateSessionKey\(\)/);
    expect(body.done).toBeUndefined();
  });

  it('logoutOtherDevices() writes nothing when a reset landed meanwhile, and leaves the hash as it is', async () => {
    const world = await boot({ hold: 'verify' });
    world.release();
    await login(world.send, false);
    const reset = await world.hasher.make('reset');
    // The reset lands after this request read the account and before its write: it writes the hash and a new key first.
    const real = world.users.updateSessionKey.bind(world.users);
    world.users.updateSessionKey = async (id, key, expected) => {
      Object.assign(world.users.rows.get(1)!, { hash: reset, key: 'r'.repeat(43) });
      world.users.updateSessionKey = real;
      return real(id, key, expected);
    };
    const answer = (await (await world.send('/logout-others', {})).json()) as { done: boolean };
    expect(answer.done).toBe(false);
    expect(world.users.rows.get(1)!.hash, 'the reset hash is untouched').toBe(reset);
    expect(world.users.rows.get(1)!.key, 'and so is its key').toBe('r'.repeat(43));
    expect((await world.send('/me')).status).toBe(401);
  });

  it('logoutOtherDevices() leaves the password hash as it is', async () => {
    const world = await boot({ hold: 'verify' });
    world.release();
    await login(world.send, false);
    const before = world.users.rows.get(1)!.hash;
    const answer = (await (await world.send('/logout-others', {})).json()) as { done: boolean };
    expect(answer.done).toBe(true);
    expect(world.users.rows.get(1)!.hash).toBe(before);
    expect((await world.send('/me')).status, 'this device stays').toBe(200);
  });
});

const login = async (send: World['send'], remember = true) => {
  const answer = (await (await send('/login', { email: ada.email, password: 'secret', remember })).json()) as { ok: boolean };
  expect(answer.ok).toBe(true);
};

/** The sign-in whose row an ending took meanwhile does not stand: its token cannot be made, so no cookie is handed out and no session is signed in. */
async function expectNotSignedIn(world: World, jar: Map<string, string>, send: World['send']) {
  expect(jar.has('marmeon_remember'), 'no cookie was handed out').toBe(false);
  expect((await send('/me')).status).toBe(401);
  expect(await world.tokenCount()).toBe(0);
}

/** The remember-me cookie alone must not sign in: the first request stays a guest, and the token is gone afterwards. */
async function expectRefused(world: World, jar: Map<string, string>, send: World['send']) {
  expect(jar.has('marmeon_remember'), 'the sign-in handed out a cookie').toBe(true);
  expect((await send('/me')).status).toBe(401);
  expect((await send('/me')).status, 'and again').toBe(401);
  expect(jar.has('marmeon_remember')).toBe(false);
  expect(await world.tokenCount()).toBe(0);
}

describe('a remember-me token is bound to the account state it was issued under', () => {
  it('is refused at its first use when only the key changed between the check and the token (the rows stay)', async () => {
    const world = await boot({ hold: 'issue' });
    world.arm();
    await during(world, attempt(world, true), async () => void (await world.users.updateSessionKey(1, 'another-key', null)));
    await expectRefused(world, world.jar, world.send);
  });

  it('does not sign in when AccountSessions.end() ran between the check and the token (attempt)', async () => {
    const world = await boot({ hold: 'issue' });
    world.arm();
    await during(world, attempt(world, true), world.end);
    await expectNotSignedIn(world, world.jar, world.send);
  });

  it('does not sign in when a password reset ran between the check and the token', async () => {
    const world = await boot({ hold: 'issue' });
    world.arm();
    const reset = async () => {
      const container = world.application.container;
      await container.make(NewPassword).store(world.users, 1, await world.hasher.make('reset'), 'reset');
    };
    await during(world, attempt(world, true), reset);
    await expectNotSignedIn(world, world.jar, world.send);
  });

  it('does not sign in when updatePassword() of another device ran in between', async () => {
    const world = await boot({ hold: 'issue' });
    const other = world.browser();
    await login(other.send, false);
    world.arm();
    await during(world, attempt(world, true), async () => void (await other.send('/change-password', {})));
    await expectNotSignedIn(world, world.jar, world.send);
  });

  it('does not sign in when logoutOtherDevices() of another device ran in between', async () => {
    const world = await boot({ hold: 'issue' });
    const other = world.browser();
    await login(other.send, false);
    world.arm();
    await during(world, attempt(world, true), async () => expect(await (await other.send('/logout-others', {})).json()).toEqual({ done: true }));
    await expectNotSignedIn(world, world.jar, world.send);
  });

  it('does not sign in login() either', async () => {
    const world = await boot({ hold: 'issue' });
    world.arm();
    await during(world, async () => (await world.send('/login-as', {})).json(), world.end);
    await expectNotSignedIn(world, world.jar, world.send);
  });

  it('does not sign in when the second factor finishes the sign-in', async () => {
    const world = await boot({ totp: true, hold: 'issue' });
    expect(await attempt(world, true)()).toMatchObject({ kind: 'two-factor-required', pending: true });
    world.arm();
    await during(world, async () => (await world.send('/complete', {})).json(), world.end);
    await expectNotSignedIn(world, world.jar, world.send);
  });

  it('does not sign in the passkey sign-in either', async () => {
    const world = await boot({ hold: 'issue' });
    world.arm();
    await during(world, async () => (await world.send('/passkey', {})).json(), world.end);
    await expectNotSignedIn(world, world.jar, world.send);
  });

  it('is refused when its cookie is being consumed while end() runs', async () => {
    const world = await boot({ hold: 'consume' });
    await login(world.send);
    const device = world.browser();
    device.jar.set('marmeon_remember', world.jar.get('marmeon_remember')!);
    world.arm();
    const status = await during(world, async () => (await device.send('/me')).status, world.end);
    expect(status).toBe(401);
    expect((await device.send('/me')).status).toBe(401);
    expect(await world.tokenCount()).toBe(0);
  });

  it('is refused after the key changed although the token itself survived (a delete that did not happen)', async () => {
    const world = await boot({ hold: 'issue' });
    await login(world.send);
    const device = world.browser();
    device.jar.set('marmeon_remember', world.jar.get('marmeon_remember')!);
    expect(await world.users.updateSessionKey(1, 'another-key', null)).toBe(true);
    expect(await world.tokenCount()).toBe(1);
    expect((await device.send('/me')).status).toBe(401);
    expect(await world.tokenCount()).toBe(0);
  });

  it('is refused when the row has no fingerprint (a token from before the column)', async () => {
    const world = await boot({ hold: 'issue' });
    await login(world.send);
    await world.application.container.make(Connections).get<any>().updateTable(SIGN_INS_TABLE).set({ remember_fingerprint: null }).execute();
    const device = world.browser();
    device.jar.set('marmeon_remember', world.jar.get('marmeon_remember')!);
    expect((await device.send('/me')).status).toBe(401);
    expect(await world.tokenCount()).toBe(0);
  });

  it('keeps the token of the device that updateSessionKey() leaves signed in', async () => {
    const world = await boot({ hold: 'issue' });
    await login(world.send);
    const device = world.browser();
    device.jar.set('marmeon_remember', world.jar.get('marmeon_remember')!);
    expect((await device.send('/me')).status).toBe(200);
    expect(await (await device.send('/end-others', {})).json()).toEqual({ done: true });
    const later = world.browser();
    later.jar.set('marmeon_remember', device.jar.get('marmeon_remember')!);
    expect((await later.send('/me')).status, 'the token this device kept').toBe(200);
  });

  it.each([
    ['logoutOtherDevices()', '/logout-others'],
    ['updateSessionKey()', '/end-others'],
  ])('does not keep the token of a thief who rotated the owner\'s cookie: %s ends everything and reports the copy', async (_name, route) => {
    const world = await boot({ hold: 'issue' });
    await login(world.send);
    const owner = world.send;
    const thief = world.browser();
    thief.jar.set('marmeon_remember', world.jar.get('marmeon_remember')!);
    expect((await thief.send('/me')).status, 'the copy signs in and rotates the cookie').toBe(200);
    // The owner's cookie is the previous validator, and past the grace window.
    await world.application.container.make(Connections).get<any>().updateTable(SIGN_INS_TABLE).set({ remember_rotated_at: new Date(Date.now() - 3_600_000) }).execute();

    expect(await (await owner(route, {})).json()).toEqual({ done: false });
    expect(await world.tokenCount(), 'no token is kept').toBe(0);
    const later = world.browser();
    later.jar.set('marmeon_remember', thief.jar.get('marmeon_remember')!);
    expect((await later.send('/me')).status, "the thief's cookie").toBe(401);
    expect((await thief.send('/me')).status, "the thief's session").toBe(401);
    expect((await owner('/me')).status, "the owner's session ends too").toBe(401);
    expect(reused, "the owner is told").toHaveLength(1);
  });

  it.each([
    ['logoutOtherDevices()', '/logout-others'],
    ['updateSessionKey()', '/end-others'],
  ])('%s keeps the owner\'s device when the cookie is only the validator that was just rotated (a lost response)', async (_name, route) => {
    const world = await boot({ hold: 'issue' });
    await login(world.send);
    const other = world.browser();
    other.jar.set('marmeon_remember', world.jar.get('marmeon_remember')!);
    expect((await other.send('/me')).status, 'a second request consumes the cookie and rotates it').toBe(200);

    // Inside the grace window: the owner still presents the previous validator.
    expect(await (await world.send(route, {})).json()).toEqual({ done: true });
    expect((await world.send('/me')).status, 'the owner stays signed in').toBe(200);
    expect(await world.tokenCount()).toBe(1);
    expect(reused).toHaveLength(0);
  });

  it('keeps working for an untouched account, and for the device that logoutOtherDevices() leaves signed in', async () => {
    const world = await boot({ hold: 'issue' });
    await login(world.send);
    const device = world.browser();
    device.jar.set('marmeon_remember', world.jar.get('marmeon_remember')!);
    expect((await device.send('/me')).status, 'a plain remember-me sign-in').toBe(200);
    expect(await (await device.send('/logout-others', {})).json()).toEqual({ done: true });
    const later = world.browser();
    later.jar.set('marmeon_remember', device.jar.get('marmeon_remember')!);
    expect((await later.send('/me')).status, 'the token this device kept').toBe(200);
  });
});
