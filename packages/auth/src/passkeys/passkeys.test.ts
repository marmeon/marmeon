import { CacheServiceProvider, RateLimiter } from '@marmeon/cache';
import { Clock, createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHALLENGE_SECONDS } from './challenge.ts';
import {
  Auth,
  authenticate,
  AuthServiceProvider,
  confirmedPassword,
  combineFactors,
  Hasher,
  Login,
  PasskeyCloneSuspected,
  PasskeyRegistered,
  PasskeyRemoved,
  PasskeySignInFailed,
  RecoveryCodesGenerated,
  TwoFactorChallengeFailed,
  TwoFactorDisabled,
  TwoFactorEnabled,
  TwoFactorState,
  TwoFactorStore,
  UserProvider,
  type Credentials,
  type PasswordHash,
} from '../index.ts';
import { softAuthenticator, twoFactorCode } from '../testing.ts';
import { twoFactor } from '../two-factor/middleware.ts';
import { NoTwoFactorState } from '../two-factor/state.ts';
import { RECOVERY_CODES_TABLE } from '../two-factor/store.ts';
import { TwoFactor } from '../two-factor/two-factor.ts';
import { Passkeys, type RegisterError } from './passkeys.ts';
import { PasskeyServiceProvider } from './provider.ts';
import { PASSKEYS_TABLE, PasskeyStore } from './store.ts';
import { openRoutes } from '../test-helpers/open-routes.ts';

interface TestUser {
  id: number;
  name: string;
  email: string;
}

declare module '../user.ts' {
  interface AuthTypes {
    user: TestUser;
  }
}

/** Accounts in memory that keep the whole `UserProvider` contract; `keys` holds the session keys (an account without one has `null`). */
class MemoryUsers implements UserProvider<TestUser> {
  readonly rows = new Map<number, { user: TestUser; hash: PasswordHash | null }>();
  readonly keys = new Map<number, string>();
  async findById(id: number): Promise<Credentials<TestUser> | undefined> {
    const row = this.rows.get(Number(id));
    return row && { user: row.user, passwordHash: row.hash, sessionKey: this.keys.get(Number(id)) ?? null };
  }
  async findForLogin(email: string): Promise<Credentials<TestUser> | undefined> {
    for (const row of this.rows.values()) if (row.user.email === email) return { user: row.user, passwordHash: row.hash, sessionKey: this.keys.get(row.user.id) ?? null };
    return undefined;
  }
  async updatePasswordHash(id: number, hash: PasswordHash, options: { readonly expected?: PasswordHash; readonly sessionKey?: string; readonly expectedSessionKey?: string | null } = {}): Promise<boolean> {
    const row = this.rows.get(Number(id));
    if (!row || (options.expected !== undefined && row.hash !== options.expected)) return false;
    if (options.sessionKey !== undefined && options.expectedSessionKey !== undefined && (this.keys.get(Number(id)) ?? null) !== options.expectedSessionKey) return false;
    row.hash = hash;
    if (options.sessionKey !== undefined) this.keys.set(Number(id), options.sessionKey);
    return true;
  }
  async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    if (expected !== undefined && (this.keys.get(Number(id)) ?? null) !== expected) return false;
    this.keys.set(Number(id), key);
    return true;
  }
  async updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number }> {
    for (const id of this.rows.keys()) this.keys.set(id, key);
    return { accounts: this.rows.size, sampleId: 1 };
  }
}

const events: object[] = [];
class RecordEvent {
  handle(event: object) {
    events.push(event);
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
    return result.ok ? { signedIn: true } : { signedIn: false, error: result.error };
  }
}

/** One controller for every call: `/pk/<method>` with the arguments as JSON. */
class PasskeyController extends Controller {
  readonly #passkeys: Passkeys;
  readonly #twoFactor: TwoFactor;
  readonly #auth: Auth;
  readonly #session: Session;
  constructor(passkeys: Passkeys, twoFactor: TwoFactor, auth: Auth, session: Session) {
    super();
    this.#session = session;
    this.#passkeys = passkeys;
    this.#twoFactor = twoFactor;
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { method } = ctx.params as { method: string };
    const body = (await ctx.input()) as Record<string, any>;
    const result = (done: { ok: boolean; value?: unknown; error?: unknown }) => (done.ok ? { ok: true, value: done.value } : { ok: false, ...(done.error as object) });
    try {
      switch (method) {
        case 'options':
          return await this.#passkeys.registrationOptions();
        case 'register':
          return result(await this.#passkeys.register(body.response, body.name, body.password));
        case 'release':
          return result(await this.#passkeys.release(body.id, body.password));
        case 'sign-in-options':
          return await this.#passkeys.signInOptions();
        case 'sign-in':
          return result(await this.#passkeys.signIn(body.response, { remember: body.remember === true }));
        case 'challenge-options':
          return result(await this.#passkeys.challengeOptions());
        case 'challenge': {
          const done = await this.#twoFactor.challenge(body as never);
          return done.ok ? { ok: true, id: done.value.id } : { ok: false, ...done.error };
        }
        case 'step-up-options':
          return result(await this.#passkeys.stepUpOptions());
        case 'step-up': {
          const done = await this.#twoFactor.stepUp(body as never);
          return done.ok ? { ok: true } : { ok: false, ...done.error };
        }
        case 'confirm-options':
          return result(await this.#passkeys.confirmOptions());
        case 'confirm':
          return result(await this.#passkeys.confirm(body.response));
        case 'confirmed':
          return { confirmed: this.#auth.passwordRecentlyConfirmed(), proof: this.#session.get('_auth_two_factor_at') ?? null };
        case 'tf-begin':
          return { secret: (await this.#twoFactor.begin()).secret };
        case 'tf-confirm':
          return await this.#twoFactor.confirm(body.code, body.password).then((done) => (done.ok ? { ok: true } : { ok: false, ...done.error }));
        case 'scope':
          return this.#auth.passwordCheckScope();
        case 'login-as':
          await this.#auth.login(body.id === bob.id ? bob : ada);
          return { signedIn: true };
        case 'regenerate':
          return await this.#twoFactor.regenerateRecoveryCodes(body.password ?? '').then((done) => (done.ok ? { ok: true, codes: done.value } : { ok: false, ...done.error }));
        case 'set-confirmed':
          this.#session.put('_auth_confirmed_at', body.value);
          return { set: true };
        case 'forget-confirmed':
          this.#session.forget('_auth_confirmed_at');
          return { forgotten: true };
        case 'set-proof':
          this.#session.put('_auth_two_factor_at', body.value ?? Math.floor(Date.now() / 1000));
          return { set: true };
        case 'forget-proof':
          this.#session.forget('_auth_two_factor_at');
          return { forgotten: true };
        case 'list':
          return await this.#passkeys.list();
        case 'rename':
          return { renamed: await this.#passkeys.rename(body.id, body.name) };
        case 'remove':
          return result(await this.#passkeys.remove(body.id, body.password));
        case 'confirm-password':
          return { confirmed: await this.#auth.confirmPassword(body.password) };
        case 'who':
          return { id: (await this.#auth.user())?.id ?? null };
        default:
          return { unknown: method };
      }
    } catch (error) {
      return Response.json({ thrown: (error as Error).message }, { status: 500 });
    }
  }
}

class Page extends Controller {
  handle() {
    return { page: true };
  }
}

/** `TwoFactor.challenge()` alone — for the app that has not registered the passkeys provider. */
class ChallengeController extends Controller {
  readonly #twoFactor: TwoFactor;
  constructor(twoFactor: TwoFactor) {
    super();
    this.#twoFactor = twoFactor;
  }
  async handle(ctx: HttpContext) {
    const done = await this.#twoFactor.challenge((await ctx.input()) as never);
    return done.ok ? { ok: true, id: done.value.id } : { ok: false, ...done.error };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', LoginController).name('auth.login');
  Route.post('/pk/:method', PasskeyController);
  Route.get('/account/two-factor', Page).name('test.setup');
  Route.get('/account/verify', Page).name('test.verify');
  Route.middleware(authenticate()).middleware(twoFactor({ setup: 'test.setup', verify: 'test.verify' })).post('/area', Page);
  Route.middleware(authenticate()).middleware(twoFactor({ setup: 'test.setup', verify: 'test.verify', maxAge: 60 })).post('/area-fresh', Page);
  Route.middleware(authenticate()).middleware(confirmedPassword()).post('/sudo', Page);
  Route.post('/tf/challenge', ChallengeController);
});

const ada: TestUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const bob: TestUser = { id: 2, name: 'Bob', email: 'bob@example.com' };
const CHEAP = { HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' };
const ORIGIN = 'http://localhost:3000';

async function boot(env: Record<string, string> = {}, options: { passkeys?: boolean; unboundState?: boolean; users?: MemoryUsers; clock?: TestClock } = {}) {
  const users = options.users ?? new MemoryUsers();
  const passkeys = options.passkeys !== false;
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider, ...(passkeys ? [PasskeyServiceProvider] : [])],
    modules: [
      defineModule({
        name: 'passkeys-test',
        routes,
        migrations: new URL('../__fixtures__/migrations/', import.meta.url),
        listeners: [Login, TwoFactorEnabled, TwoFactorDisabled, RecoveryCodesGenerated, TwoFactorChallengeFailed, PasskeyRegistered, PasskeyRemoved, PasskeyCloneSuspected, PasskeySignInFailed].map((event) => listen(event as never, RecordEvent)),
      }),
    ],
  }, {
    env: { APP_KEY: generateKey(), APP_NAME: 'Acme', APP_URL: ORIGIN, SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', CACHE_DRIVER: 'memory', ...CHEAP, ...env },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      if (options.clock) container.instance(Clock, options.clock);
      container.instance(UserProvider, users as UserProvider);
      if (options.unboundState) container.singleton(TwoFactorState, NoTwoFactorState);
      else container.singleton(TwoFactorState, (c) => (passkeys ? combineFactors(c.make(TwoFactorStore), c.make(PasskeyStore)) : combineFactors(c.make(TwoFactorStore))));
      container.scoped(TwoFactor);
      if (passkeys) container.scoped(Passkeys);
    },
  });
  await application.container.make(Migrator).migrate();
  const kernel = createHttpKernel(application);
  const hasher = application.container.make(Hasher);
  for (const user of [ada, bob]) users.rows.set(user.id, { user, hash: await hasher.make('secret') });

  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (path: string, json: unknown = {}, remoteAddress?: string): Promise<any> => {
      const response = await kernel.request(
        path,
        {
          method: 'POST',
          headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(json),
        },
        remoteAddress === undefined ? undefined : { remoteAddress },
      );
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return await response.json();
    };
    const pk = (method: string, json: unknown = {}, remoteAddress?: string) => send(`/pk/${method}`, json, remoteAddress);
    const login = (email = ada.email, password = 'secret', remember = false) => send('/login', { email, password, remember });
    return { send, pk, login, jar };
  };

  const connections = application.container.make(Connections);
  return { application, users, browser, connections };
}

type Booted = Awaited<ReturnType<typeof boot>>;
type Browser = ReturnType<Booted['browser']>;
type Device = ReturnType<typeof softAuthenticator>;

const device = (algorithm: 'ES256' | 'EdDSA' = 'ES256', synced = false) => softAuthenticator({ origin: ORIGIN, rpId: 'localhost', algorithm, synced });

/** Registers a passkey of `authenticator` in `b`'s session, as a settings page would. */
async function addPasskey(b: Browser, authenticator: Device, name = 'Laptop', password: string | null = 'secret') {
  const options = await b.pk('options');
  expect(options.challenge, JSON.stringify(options)).toBeTypeOf('string');
  return b.pk('register', { response: authenticator.register(options), name, ...(password === null ? {} : { password }) });
}

/** A signed-in browser of `email` with `authenticator` registered as its first passkey. */
async function enrolled(booted: Booted, authenticator: Device = device(), email = ada.email) {
  const b = booted.browser();
  await b.login(email);
  const added = await addPasskey(b, authenticator);
  expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
  return { b, recoveryCodes: added.value.recoveryCodes as string[] };
}

/** A fresh browser that typed the password and waits for the factor. */
async function waiting(booted: Booted, email = ada.email): Promise<Browser> {
  const b = booted.browser();
  expect(await b.login(email)).toMatchObject({ signedIn: false, error: { kind: 'two-factor-required' } });
  return b;
}

const rows = (booted: Booted, table: string) => booted.connections.get<any>().selectFrom(table).selectAll().execute();

afterEach(() => {
  events.length = 0;
});

describe('Passkeys: registering', () => {
  it('registers the first passkey as a factor: the account gets recovery codes, the events fire', async () => {
    const booted = await boot();
    const { b, recoveryCodes } = await enrolled(booted);
    expect(recoveryCodes).toHaveLength(10);
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(10);
    expect(await b.pk('list')).toMatchObject([{ id: 1, name: 'Laptop', synced: false, lastUsedAt: null }]);
    expect(events.some((event) => event instanceof PasskeyRegistered && event.name === 'Laptop')).toBe(true);
    expect(events.some((event) => event instanceof TwoFactorEnabled && event.factor === 'passkey')).toBe(true);
    expect(events.some((event) => event instanceof RecoveryCodesGenerated)).toBe(true);
  });

  it('needs a recently typed password for the options and for the registration', async () => {
    const booted = await boot();
    const guest = booted.browser();
    expect(await guest.pk('options')).toMatchObject({ thrown: expect.stringContaining('needs a signed-in user') });
  });

  it('asks the password in the same form for the first factor', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    expect(await addPasskey(b, device(), 'Laptop', null)).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await addPasskey(b, device(), 'Laptop', 'wrong')).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
    expect(await addPasskey(b, device())).toMatchObject({ ok: true });
  });

  it('asks the password for every passkey, not only the first, and makes no new recovery codes for a later one', async () => {
    const booted = await boot();
    const { b, recoveryCodes } = await enrolled(booted);
    expect(await addPasskey(b, device('EdDSA'), 'Phone', null)).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await addPasskey(b, device('EdDSA'), 'Phone', 'wrong')).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(1);
    expect(await addPasskey(b, device('EdDSA'), 'Phone')).toEqual({ ok: true, value: { recoveryCodes: null } });
    expect(recoveryCodes).toHaveLength(10);
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(10);
    expect((await b.pk('list')).map((passkey: any) => passkey.name)).toEqual(['Laptop', 'Phone']);
  });

  it('gives an account without a session key one at the first factor, signs nobody out for a further passkey and leaves the key as it is', async () => {
    const users = new MemoryUsers();
    const booted = await boot({}, { users });
    expect(users.keys.has(1), 'no key before').toBe(false);
    const hash = users.rows.get(1)!.hash;
    const { b } = await enrolled(booted);
    const key = users.keys.get(1);
    expect(key, 'the first factor signed the other devices out with a key').toMatch(/^[\w-]{43}$/);
    expect(users.rows.get(1)!.hash, 'the password hash is not written anew').toBe(hash);
    expect(await addPasskey(b, device('EdDSA'), 'Phone')).toMatchObject({ ok: true });
    expect(users.rows.get(1)!.hash).toBe(hash);
    expect(users.keys.get(1), 'the key is not rotated again').toBe(key);
    expect(await b.pk('who')).toEqual({ id: 1 });
  });

  it('locks the account\'s row when it has a session key: the passkey is stored, the key stays, a further passkey signs nobody out', async () => {
    const users = new MemoryUsers();
    users.keys.set(1, 'k'.repeat(43));
    const booted = await boot({}, { users });
    const { b } = await enrolled(booted);
    const key = users.keys.get(1);
    expect(key, 'the first factor rotated it').not.toBe('k'.repeat(43));
    const hash = users.rows.get(1)!.hash;
    expect(await addPasskey(b, device('EdDSA'), 'Phone')).toMatchObject({ ok: true });
    expect(users.rows.get(1)!.hash, 'the password hash is not written anew').toBe(hash);
    expect(users.keys.get(1)).toBe(key);
    expect(await b.pk('who')).toEqual({ id: 1 });
  });

  it('stops at the lock when the session key was replaced meanwhile: nothing is stored and nothing had to be taken out again', async () => {
    const users = new MemoryUsers();
    users.keys.set(1, 'k'.repeat(43));
    const booted = await boot({}, { users });
    const b = booted.browser();
    await b.login();
    const removed = [vi.spyOn(PasskeyStore.prototype, 'remove'), vi.spyOn(TwoFactorStore.prototype, 'removeTotp')];
    const write = users.updateSessionKey.bind(users);
    let ended = false;
    users.updateSessionKey = async (id, key, expected) => {
      const wrote = await write(id, key, expected);
      if (!ended && wrote) users.keys.set(1, 'e'.repeat(43)); // AccountSessions.end() lands right after the other devices were signed out
      ended = true;
      return wrote;
    };
    try {
      expect(await addPasskey(b, device())).toEqual({ ok: false, kind: 'signed-out' });
      for (const spy of removed) expect(spy, 'the in-transaction claim caught it, not the check after the commit').not.toHaveBeenCalled();
    } finally {
      for (const spy of removed) spy.mockRestore();
    }
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(0);
    expect(await b.pk('who')).toEqual({ id: null });
  });

  it('throws, and names the rule, when updateSessionKey(id, k, k) says false for the key that is stored', async () => {
    const users = new MemoryUsers();
    users.keys.set(1, 'k'.repeat(43));
    const booted = await boot({}, { users });
    const b = booted.browser();
    await b.login();
    const write = users.updateSessionKey.bind(users);
    users.updateSessionKey = async (id, key, expected) => (key === expected ? false : write(id, key, expected)); // a provider that counts only rows whose value changed
    expect(await addPasskey(b, device())).toMatchObject({ thrown: expect.stringContaining('must return true when key equals the stored key') });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
  });

  it('names every kind of RegisterError, signed-out included', () => {
    const label = (error: RegisterError): string => {
      switch (error.kind) {
        case 'no-challenge':
        case 'expired':
        case 'invalid':
        case 'invalid-password':
        case 'throttled':
        case 'limit':
        case 'duplicate':
          return error.kind;
        default: {
          // @ts-expect-error `signed-out` is not handled above
          const unhandled: never = error;
          return unhandled;
        }
      }
    };
    expect(label({ kind: 'signed-out' })).toEqual({ kind: 'signed-out' });
  });

  it('takes the passkey out again when the sessions were ended after the transaction, on an account without a session key', async () => {
    const users = new MemoryUsers();
    const booted = await boot({}, { users });
    const b = booted.browser();
    await b.login();
    const create = PasskeyStore.prototype.create;
    const spy = vi.spyOn(PasskeyStore.prototype, 'create').mockImplementation(async function (this: PasskeyStore, ...args) {
      const created = await create.apply(this, args);
      users.keys.set(1, 'ended-elsewhere'); // AccountSessions.end() commits before the check that follows the transaction
      return created;
    });
    try {
      expect(await addPasskey(b, device())).toEqual({ ok: false, kind: 'signed-out' });
    } finally {
      spy.mockRestore();
    }
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(0);
    expect(await b.pk('who')).toEqual({ id: null });
  });

  it('throttles the password check per account: five wrong ones a minute, then even the right one waits', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    for (let i = 0; i < 5; i++) expect(await addPasskey(b, device(), 'x', 'wrong')).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await addPasskey(b, device(), 'x', 'secret')).toMatchObject({ ok: false, kind: 'throttled', retryAfter: expect.any(Number) });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
  });

  it('puts the credentials of the account into excludeCredentials, so one authenticator is not registered twice', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted, device());
    const [passkey] = await rows(booted, PASSKEYS_TABLE);
    const options = await b.pk('options');
    expect(options.excludeCredentials).toMatchObject([{ id: passkey!.credential_id }]);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(options.attestation).toBe('none');
  });

  it('refuses the options when no source of factors is bound: a passkey would never be asked for', async () => {
    const booted = await boot({}, { unboundState: true });
    const b = booted.browser();
    await b.login();
    expect(await b.pk('options')).toMatchObject({ thrown: expect.stringContaining('source of factors') });
  });

  it('keeps the user handle of the options with the challenge and stores the passkey with exactly that one', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const options = await b.pk('options');
    // Another request registered a passkey with another handle meanwhile: this one still gets the handle its authenticator holds.
    await booted.application.container.make(PasskeyStore).create({
      userId: 1, userHandle: 'someone-elses', credentialId: 'other', publicKey: 'k', algorithm: -7, signCount: 0, transports: [], aaguid: '', backupEligible: false, backedUp: false, name: 'x',
    });
    await b.pk('set-proof'); // the account has a factor now, so a further passkey needs one proven lately
    const done = await b.pk('register', { response: device().register(options), name: 'Laptop', password: 'secret' });
    expect(done).toMatchObject({ ok: true });
    const stored = (await rows(booted, PASSKEYS_TABLE)).find((row) => row.credential_id !== 'other');
    expect(stored!.user_handle).toBe(options.user.id);
  });

  it('spends the challenge: the same response a second time finds none', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const options = await b.pk('options');
    const response = device().register(options);
    expect(await b.pk('register', { response, name: 'a', password: 'secret' })).toMatchObject({ ok: true });
    expect(await b.pk('register', { response, name: 'a', password: 'secret' })).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('spends the challenge even when the password was wrong', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const options = await b.pk('options');
    const response = device().register(options);
    expect(await b.pk('register', { response, name: 'a', password: 'wrong' })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.pk('register', { response, name: 'a', password: 'secret' })).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('refuses a response made for another origin, another challenge, or without user verification', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    for (const overrides of [{ origin: 'http://127.0.0.1:3000' }, { rpId: 'example.com' }, { challenge: 'AAAA' }, { userVerified: false }, { userPresent: false }, { crossOrigin: true }]) {
      const options = await b.pk('options');
      expect(await b.pk('register', { response: device().register(options, overrides), name: 'a', password: 'secret' }), JSON.stringify(overrides)).toEqual({ ok: false, kind: 'invalid' });
    }
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
  });

  it('a remember-me token another device got before the first passkey no longer signs in', async () => {
    const booted = await boot();
    const other = booted.browser();
    await other.login(ada.email, 'secret', true);
    const remembered = new Map([...other.jar].filter(([name]) => name === 'marmeon_remember'));
    expect(remembered.size).toBe(1);
    const own = booted.browser();
    await own.login();
    expect(await addPasskey(own, device())).toMatchObject({ ok: true });
    expect(await booted.browser(new Map(remembered)).pk('who')).toEqual({ id: null });
  });

  it('takes the remember-me token of this device off its sign-in when the first passkey is registered, and keeps the sign-in', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login(ada.email, 'secret', true);
    const withToken = () => booted.connections.get<any>().selectFrom('sign_ins').select('id').where('remember_selector', 'is not', null).execute();
    expect(await withToken()).toHaveLength(1);
    expect(await addPasskey(b, device())).toMatchObject({ ok: true });
    expect(await withToken(), 'no token: it was made before the factor').toEqual([]);
    expect(await booted.connections.get<any>().selectFrom('sign_ins').select('id').execute(), 'the sign-in of this device stays').toHaveLength(1);
    expect(await b.pk('who')).toEqual({ id: 1 });
  });

  it('signs out the other devices when the first passkey is registered, and keeps this one', async () => {
    const booted = await boot();
    const other = booted.browser();
    await other.login();
    expect(await other.pk('who')).toEqual({ id: 1 });
    const { b } = await enrolled(booted);
    expect(await other.pk('who')).toEqual({ id: null });
    expect(await b.pk('who')).toEqual({ id: 1 });
  });

  it('stores no passkey when the password was changed by another device meanwhile: signed-out, nothing stored, the session ends', async () => {
    const booted = await boot();
    const other = await booted.application.container.make(Hasher).make('changed elsewhere');
    const b = booted.browser();
    await b.login();
    // The moment after this request signed the other devices out, another device sets its own password — and with it a key.
    const write = booted.users.updateSessionKey.bind(booted.users);
    let changed = false;
    booted.users.updateSessionKey = async (id, key, expected) => {
      const wrote = await write(id, key, expected);
      if (!changed && wrote) {
        booted.users.rows.get(1)!.hash = other;
        booted.users.keys.set(1, 'e'.repeat(43));
      }
      changed = true;
      return wrote;
    };
    expect(await addPasskey(b, device())).toEqual({ ok: false, kind: 'signed-out' });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
    expect(await b.pk('who')).toEqual({ id: null });
    expect(events.some((event) => event instanceof PasskeyRegistered)).toBe(false);
  });

  it('turns nothing on when the state does not know the passkey: it fails closed and rolls back', async () => {
    const booted = await boot();
    booted.application.container.instance(TwoFactorState, combineFactors(booted.application.container.make(TwoFactorStore)));
    const b = booted.browser();
    await b.login();
    expect(await addPasskey(b, device())).toMatchObject({ thrown: expect.stringContaining('does not report the passkey') });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
  });
});

describe('Passkeys: signing in without a password', () => {
  it('signs in the passkey\'s own account: a new session, Login via passkey, no password window', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    events.length = 0;
    const b = booted.browser();
    const options = await b.pk('sign-in-options');
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe('required');
    const before = new Map(b.jar);
    expect(await b.pk('sign-in', { response: authenticator.authenticate(options) })).toMatchObject({ ok: true, value: { id: 1 } });
    const sessionCookie = [...before.keys()].find((name) => /session/i.test(name))!;
    expect(sessionCookie).toBeDefined();
    expect(b.jar.get(sessionCookie)).not.toBe(before.get(sessionCookie)); // a new session id: nothing handed out before the sign-in survives it
    expect(await b.pk('who')).toEqual({ id: 1 });
    const login = events.find((event): event is Login => event instanceof Login);
    expect(login?.via).toBe('passkey');
    // The passkey with user verification is the confirmation `confirmedPassword()` asks for.
    expect(await b.pk('rename', { id: 1, name: 'x' })).toEqual({ renamed: true });
  });

  it.each([
    ['the account sessions were ended', (users: MemoryUsers) => void users.keys.set(1, 'e'.repeat(43))],
    ['the password was reset', (users: MemoryUsers) => {
        users.rows.get(1)!.hash = null;
        users.keys.set(1, 'r'.repeat(43)); // a reset writes a new key with the hash
      },
    ],
  ])('signs nobody in when %s between the check of the assertion and the sign-in', async (_name, change) => {
    const users = new MemoryUsers();
    const booted = await boot({}, { users });
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = booted.browser();
    const options = await b.pk('sign-in-options');
    const counter = PasskeyStore.prototype.updateCounter;
    const spy = vi.spyOn(PasskeyStore.prototype, 'updateCounter').mockImplementation(async function (this: PasskeyStore, ...args) {
      const written = await counter.apply(this, args);
      change(users); // lands after the assertion was verified, before the sign-in binds
      return written;
    });
    try {
      expect(await b.pk('sign-in', { response: authenticator.authenticate(options), remember: true })).toMatchObject({ ok: false, kind: 'invalid' });
    } finally {
      spy.mockRestore();
    }
    expect(await b.pk('who')).toEqual({ id: null });
    expect(b.jar.has('marmeon_remember')).toBe(false);
    expect(await booted.connections.get<any>().selectFrom('sign_ins').select('id').where('remember_selector', 'is not', null).execute(), 'no remember-me token').toHaveLength(0);
  });

  it('registering the first passkey answers signed-out when this device\'s remember-me cookie turns out to be a copy', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login(ada.email, 'secret', true);
    await booted.browser(new Map([['marmeon_remember', b.jar.get('marmeon_remember')!]])).pk('who'); // somebody else rotates the cookie
    await booted.connections.get<any>().updateTable('sign_ins').set({ remember_rotated_at: new Date(Date.now() - 3_600_000) }).execute();
    expect(await addPasskey(b, device())).toEqual({ ok: false, kind: 'signed-out' });
    expect(await b.pk('who')).toEqual({ id: null });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
  });

  it('works with EdDSA keys and with a synchronised passkey that reports 0', async () => {
    const booted = await boot();
    const synced = device('EdDSA', true);
    await enrolled(booted, synced);
    for (let i = 0; i < 2; i++) {
      const b = booted.browser();
      const options = await b.pk('sign-in-options');
      expect(await b.pk('sign-in', { response: synced.authenticate(options) })).toMatchObject({ ok: true });
    }
  });

  it('a challenge works once: the same assertion a second time finds none', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = booted.browser();
    const response = authenticator.authenticate(await b.pk('sign-in-options'));
    expect(await b.pk('sign-in', { response })).toMatchObject({ ok: true });
    expect(await b.pk('sign-in', { response })).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('a challenge works only for its purpose: a passwordless challenge does not serve a second factor', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = await waiting(booted);
    await b.pk('sign-in-options'); // replaces any open challenge with a passwordless one
    const response = authenticator.authenticate({ challenge: (await b.pk('sign-in-options')).challenge });
    expect(await b.pk('challenge', { passkey: response })).toMatchObject({ ok: false, kind: 'invalid-code' });
  });

  it('refuses a response with another user handle, or none', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = booted.browser();
    const foreign = authenticator.authenticate(await b.pk('sign-in-options'));
    foreign.response.userHandle = Buffer.alloc(32, 9).toString('base64url');
    expect(await b.pk('sign-in', { response: foreign })).toEqual({ ok: false, kind: 'invalid' });
    const bare = authenticator.authenticate(await b.pk('sign-in-options'));
    delete bare.response.userHandle;
    expect(await b.pk('sign-in', { response: bare })).toEqual({ ok: false, kind: 'invalid' });
    expect(await b.pk('who')).toEqual({ id: null });
  });

  it('counts failed sign-ins of one IPv6 /64 together — rotating the address inside it opens no new budget', async () => {
    const booted = await boot();
    await enrolled(booted, device());
    const b = booted.browser();
    const unknown = device();
    unknown.register({ challenge: 'AAAA' });
    const attempt = async (n: number) => {
      const remote = `2001:db8:1:2::${n.toString(16)}`;
      return b.pk('sign-in', { response: unknown.authenticate(await b.pk('sign-in-options', {}, remote)) }, remote);
    };
    for (let n = 1; n <= 60; n++) expect(await attempt(n)).toEqual({ ok: false, kind: 'invalid' });
    expect(await attempt(61)).toMatchObject({ ok: false, kind: 'throttled' });
  });

  it('refuses an unknown passkey, a missing user verification, a missing user presence and a wrong origin', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = booted.browser();
    const unknown = device();
    unknown.register({ challenge: 'AAAA' });
    expect(await b.pk('sign-in', { response: unknown.authenticate(await b.pk('sign-in-options')) })).toEqual({ ok: false, kind: 'invalid' });
    for (const overrides of [{ userVerified: false }, { userPresent: false }, { origin: 'https://evil.example' }, { badSignature: true }]) {
      const response = authenticator.authenticate(await b.pk('sign-in-options'), overrides);
      expect(await b.pk('sign-in', { response }), JSON.stringify(overrides)).toEqual({ ok: false, kind: 'invalid' });
    }
    expect(await b.pk('who')).toEqual({ id: null });
  });

  it('a counter that does not move forward refuses the sign-in, tells the owner and is not written', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    for (let i = 0; i < 2; i++) {
      const b = booted.browser();
      expect(await b.pk('sign-in', { response: authenticator.authenticate(await b.pk('sign-in-options')) })).toMatchObject({ ok: true });
    }
    events.length = 0;
    const b = booted.browser();
    const stale = authenticator.authenticate(await b.pk('sign-in-options'), { signCount: 1 });
    expect(await b.pk('sign-in', { response: stale })).toEqual({ ok: false, kind: 'clone-suspected' });
    expect(events.filter((event) => event instanceof PasskeyCloneSuspected)).toHaveLength(1);
    expect((await rows(booted, PASSKEYS_TABLE))[0]!.sign_count).toBe(2);
    expect(await b.pk('who')).toEqual({ id: null });
  });

  it('of parallel responses with one counter only one signs in', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const browsers = [booted.browser(), booted.browser(), booted.browser()];
    const responses = await Promise.all(browsers.map(async (b) => authenticator.authenticate(await b.pk('sign-in-options'), { signCount: 5 })));
    const results = await Promise.all(browsers.map((b, i) => b.pk('sign-in', { response: responses[i] })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
  });

  it('counts failures per address, 60 a minute, then waits — and garbage cannot lock the owner out', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = booted.browser();
    for (let i = 0; i < 10; i++) {
      const options = await b.pk('sign-in-options');
      expect(await b.pk('sign-in', { response: { id: 'nope', challenge: options.challenge } })).toEqual({ ok: false, kind: 'invalid' });
    }
    const owner = booted.browser();
    expect(await owner.pk('sign-in', { response: authenticator.authenticate(await owner.pk('sign-in-options')) })).toMatchObject({ ok: true });
    for (let i = 10; i < 60; i++) {
      const options = await b.pk('sign-in-options');
      await b.pk('sign-in', { response: { id: 'nope', challenge: options.challenge } });
    }
    const options = await b.pk('sign-in-options');
    expect(await b.pk('sign-in', { response: { id: 'nope' } })).toMatchObject({ ok: false, kind: 'throttled', retryAfter: expect.any(Number) });
    expect(options.challenge).toBeTypeOf('string');
  });

  it('many may sign in from behind one address: successes are not counted', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    for (let i = 0; i < 12; i++) {
      const b = booted.browser();
      expect(await b.pk('sign-in', { response: authenticator.authenticate(await b.pk('sign-in-options')) }), `sign-in ${i}`).toMatchObject({ ok: true });
    }
  });

  it('is not switched on in an app without the passkey provider: no WebAuthn service, passkeys refuse as a factor', async () => {
    const booted = await boot({}, { passkeys: false });
    expect(booted.application.container.has(Passkeys)).toBe(false);
  });
});

describe('Passkeys: replay, clones and audit signals', () => {
  it('lets exactly one of parallel requests with one cookie spend a challenge, also for a synchronised passkey', async () => {
    const booted = await boot();
    const synced = device('ES256', true);
    await enrolled(booted, synced);
    const b = booted.browser();
    const response = synced.authenticate(await b.pk('sign-in-options'));
    const answers = await Promise.all([1, 2, 3].map(() => b.pk('sign-in', { response })));
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
  });

  it('suspends a passkey whose counter went backwards: it signs nobody in until the password releases it', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b: owner } = await enrolled(booted, authenticator);
    for (let i = 0; i < 2; i++) {
      const b = booted.browser();
      await b.pk('sign-in', { response: authenticator.authenticate(await b.pk('sign-in-options')) });
    }
    const b = booted.browser();
    expect(await b.pk('sign-in', { response: authenticator.authenticate(await b.pk('sign-in-options'), { signCount: 1 }) })).toEqual({ ok: false, kind: 'clone-suspected' });
    expect(await owner.pk('list')).toMatchObject([{ suspended: true }]);
    // The honest key, with a counter that would pass, finds no usable passkey meanwhile.
    const again = booted.browser();
    expect(await again.pk('sign-in', { response: authenticator.authenticate(await again.pk('sign-in-options')) })).toEqual({ ok: false, kind: 'invalid' });
    // Releasing and removing need the password; the sudo window alone is not enough.
    expect(await owner.pk('release', { id: 1 })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await owner.pk('release', { id: 1, password: 'wrong' })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await owner.pk('release', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
    expect(await owner.pk('list')).toMatchObject([{ suspended: false }]);
    const last = booted.browser();
    expect(await last.pk('sign-in', { response: authenticator.authenticate(await last.pk('sign-in-options')) })).toMatchObject({ ok: true });
  });

  it('removes a suspended passkey only with the password, though another factor remains', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b: owner } = await enrolled(booted, authenticator);
    await addPasskey(owner, device('EdDSA'), 'Phone');
    const b = booted.browser();
    await b.pk('sign-in', { response: authenticator.authenticate(await b.pk('sign-in-options')) });
    const c = booted.browser();
    await c.pk('sign-in', { response: authenticator.authenticate(await c.pk('sign-in-options'), { signCount: 1 }) });
    expect(await owner.pk('remove', { id: 1 })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await owner.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
  });

  it('keeps a suspended passkey out of the second factor\'s allow list', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b: owner } = await enrolled(booted, authenticator);
    await addPasskey(owner, device('EdDSA'), 'Phone');
    const b = booted.browser();
    await b.pk('sign-in', { response: authenticator.authenticate(await b.pk('sign-in-options')) });
    const c = booted.browser();
    await c.pk('sign-in', { response: authenticator.authenticate(await c.pk('sign-in-options'), { signCount: 1 }) });
    const waitingBrowser = await waiting(booted);
    const options = await waitingBrowser.pk('challenge-options');
    expect(options.value.allowCredentials).toHaveLength(1);
  });

  it('tells the owner when a passkey that exists answers wrongly, and says nothing for an unknown one', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    events.length = 0;
    const b = booted.browser();
    await b.pk('sign-in', { response: authenticator.authenticate(await b.pk('sign-in-options'), { badSignature: true }) });
    const foreign = authenticator.authenticate(await b.pk('sign-in-options'));
    foreign.response.userHandle = Buffer.alloc(32, 9).toString('base64url');
    await b.pk('sign-in', { response: foreign });
    expect(events.filter((event) => event instanceof PasskeySignInFailed)).toHaveLength(2);
    events.length = 0;
    const stranger = device();
    stranger.register({ challenge: 'AAAA' });
    await b.pk('sign-in', { response: stranger.authenticate(await b.pk('sign-in-options')) });
    expect(events.filter((event) => event instanceof PasskeySignInFailed)).toHaveLength(0);
  });

  it('refuses a 21st passkey', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    const store = booted.application.container.make(PasskeyStore);
    for (let i = 0; i < 19; i++) {
      await store.create({ userId: 1, userHandle: 'h', credentialId: `bulk-${i}`, publicKey: 'k', algorithm: -7, signCount: 0, transports: [], aaguid: '', backupEligible: false, backedUp: false, name: `Bulk ${i}` });
    }
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(20);
    expect(await addPasskey(b, device(), 'One too many')).toEqual({ ok: false, kind: 'limit' });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(20);
  });

  it('strips invisible format characters from names', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    expect(await b.pk('rename', { id: 1, name: '\u202Eevil\u200B name' })).toEqual({ renamed: true });
    expect((await b.pk('list'))[0].name).toBe('evil name');
  });

  it('accepts RSA keys with the usual exponent, and refuses an odd exponent or an oversized key', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const register = async (rsa: { modulusLength?: number; publicExponent?: number }) => {
      const authenticator = softAuthenticator({ origin: ORIGIN, rpId: 'localhost', algorithm: 'RS256', rsa });
      return addPasskey(b, authenticator, 'RSA');
    };
    expect(await register({ publicExponent: 3 })).toEqual({ ok: false, kind: 'invalid' });
    expect(await register({ modulusLength: 4160 })).toEqual({ ok: false, kind: 'invalid' });
    expect(await register({})).toMatchObject({ ok: true });
  }, 60_000);
});

describe('Passkeys: as the second factor', () => {
  it('holds a password sign-in back for the passkey, and a passkey of the account completes it', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = booted.browser();
    expect(await b.login()).toEqual({ signedIn: false, error: { kind: 'two-factor-required', factors: ['passkey'] } });
    events.length = 0;
    const options = await b.pk('challenge-options');
    expect(options).toMatchObject({ ok: true, value: { userVerification: 'required' } });
    expect(options.value.allowCredentials).toHaveLength(1);
    expect(await b.pk('who')).toEqual({ id: null });
    expect(await b.pk('challenge', { passkey: authenticator.authenticate(options.value) })).toEqual({ ok: true, id: 1 });
    expect(await b.pk('who')).toEqual({ id: 1 });
    const login = events.find((event): event is Login => event instanceof Login);
    expect(login?.via).toBe('attempt');
  });

  it('answers no-challenge for the options without a waiting sign-in', async () => {
    const booted = await boot();
    expect(await booted.browser().pk('challenge-options')).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('refuses the passkey of another account, counts the failure and tells the owner', async () => {
    const booted = await boot();
    await enrolled(booted, device());
    const bobs = device();
    await enrolled(booted, bobs, bob.email);
    const b = await waiting(booted);
    events.length = 0;
    const options = await b.pk('challenge-options');
    const response = bobs.authenticate({ challenge: options.value.challenge });
    expect(await b.pk('challenge', { passkey: response })).toEqual({ ok: false, kind: 'invalid-code', attemptsLeft: 4 });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toMatchObject([{ during: 'sign-in' }]);
    expect(await b.pk('who')).toEqual({ id: null });
  });

  it('refuses the passkey when it was deleted between the password and the assertion', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b: owner } = await enrolled(booted, authenticator);
    await addPasskey(owner, device('EdDSA'), 'Phone');
    const b = await waiting(booted);
    const options = await b.pk('challenge-options');
    const response = authenticator.authenticate(options.value);
    expect(await owner.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
    expect(await b.pk('challenge', { passkey: response })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await b.pk('who')).toEqual({ id: null });
  });

  it('spends the challenge: the same assertion a second time finds nothing', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = await waiting(booted);
    const options = await b.pk('challenge-options');
    const response = authenticator.authenticate(options.value);
    expect(await b.pk('challenge', { passkey: response })).toMatchObject({ ok: true });
    expect(await b.pk('challenge', { passkey: response })).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('a wrong response for a challenge is final: the challenge is gone', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = await waiting(booted);
    const options = await b.pk('challenge-options');
    expect(await b.pk('challenge', { passkey: authenticator.authenticate(options.value, { userVerified: false }) })).toMatchObject({ kind: 'invalid-code' });
    expect(await b.pk('challenge', { passkey: authenticator.authenticate(options.value) })).toMatchObject({ kind: 'invalid-code' });
  });

  it('a counter regression refuses it and raises the clone event', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const first = await waiting(booted);
    await first.pk('challenge', { passkey: authenticator.authenticate((await first.pk('challenge-options')).value) });
    const b = await waiting(booted);
    events.length = 0;
    const stale = authenticator.authenticate((await b.pk('challenge-options')).value, { signCount: 1 });
    expect(await b.pk('challenge', { passkey: stale })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(events.filter((event) => event instanceof PasskeyCloneSuspected)).toHaveLength(1);
  });

  it('uses the generous counter, 10 a minute, and leaves the budget of authenticator codes untouched', async () => {
    const booted = await boot();
    await enrolled(booted, device());
    const kinds = [];
    for (let i = 0; i < 11; i++) kinds.push((await (await waiting(booted)).pk('challenge', { passkey: { id: 'x' } })).kind);
    expect(kinds.slice(0, 10).every((kind) => kind === 'invalid-code')).toBe(true);
    expect(kinds[10]).toBe('throttled');
    const limiter = booted.application.container.make(RateLimiter);
    for (let i = 0; i < 5; i++) expect(await limiter.attempt('two-factor-minute:1', 5, 60)).toBe(true);
  });

  it('is refused in an app without the passkey provider', async () => {
    const booted = await boot({}, { passkeys: false });
    const b = booted.browser();
    await booted.application.container.make(TwoFactorStore).startSetup(1, 'enc');
    await booted.application.container.make(TwoFactorStore).confirm(1, 5, 'enc', null);
    expect(await b.login()).toMatchObject({ error: { kind: 'two-factor-required', factors: ['totp'] } });
    expect(await b.send('/tf/challenge', { passkey: { id: 'x' } })).toMatchObject({ ok: false, kind: 'invalid-code' });
  });
});

describe('Passkeys: confirming sudo mode', () => {
  /** A signed-in browser of an account with this passkey, whose password confirmation has run out. */
  async function unconfirmed(booted: Booted, authenticator: Device = device(), email = ada.email) {
    const { b } = await enrolled(booted, authenticator, email);
    await b.pk('forget-confirmed');
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
    return b;
  }

  it('confirms with a passkey of the account: a new session id, the confirmation and the factor proof set', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    await b.pk('forget-proof');
    const before = b.jar.get('marmeon_session');
    const options = await b.pk('confirm-options');
    expect(options).toMatchObject({ ok: true, value: { userVerification: 'required' } });
    expect(options.value.allowCredentials).toHaveLength(1);
    expect(await b.pk('confirm', { response: authenticator.authenticate(options.value) })).toEqual({ ok: true });
    expect(b.jar.get('marmeon_session')).not.toBe(before);
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: true, proof: expect.any(Number) });
    expect(await b.pk('who')).toEqual({ id: ada.id });
  });

  it('answers no-challenge for the options when the account has no passkey, and needs a signed-in user', async () => {
    const booted = await boot();
    const b = booted.browser();
    expect(await b.pk('confirm-options')).toMatchObject({ thrown: expect.stringContaining('signed-in user') });
    expect(await b.pk('confirm', { response: { id: 'x' } })).toMatchObject({ thrown: expect.stringContaining('signed-in user') });
    await b.login(bob.email);
    expect(await b.pk('confirm-options')).toEqual({ ok: false, kind: 'no-challenge' });
    expect(await b.pk('confirm', { response: { id: 'x' } })).toMatchObject({ ok: false, kind: 'no-challenge' });
  });

  it('refuses a passkey of another account, and the session stays unconfirmed', async () => {
    const booted = await boot();
    const mine = device();
    const theirs = device();
    const b = await unconfirmed(booted, mine);
    await enrolled(booted, theirs, bob.email);
    const options = (await b.pk('confirm-options')).value;
    // Without the allow list, so that the other account's authenticator answers.
    expect(await b.pk('confirm', { response: theirs.authenticate({ ...options, allowCredentials: [] }) })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
  });

  it('refuses a suspended passkey', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    const options = (await b.pk('confirm-options')).value;
    await booted.connections.get<any>().updateTable('passkeys').set({ suspended_at: new Date().toISOString() }).where('id', '=', 1).execute();
    expect(await b.pk('confirm', { response: authenticator.authenticate(options) })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
    expect(await b.pk('confirm-options')).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('keeps the purposes apart: a step-up, second-factor or sign-in challenge does not confirm', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    events.length = 0;
    const stepUp = (await b.pk('step-up-options')).value;
    expect(await b.pk('confirm', { response: authenticator.authenticate(stepUp) })).toMatchObject({ ok: false, kind: 'invalid' });
    const signIn = await b.pk('sign-in-options');
    expect(await b.pk('confirm', { response: authenticator.authenticate(signIn) })).toMatchObject({ ok: false, kind: 'invalid' });
    // The owner's own correct passkey met a challenge of another purpose: no wrong answer, so no event.
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toEqual([]);
    // The other way round: a confirm challenge serves neither a step-up nor a passwordless sign-in.
    const confirm = (await b.pk('confirm-options')).value;
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(confirm) })).toMatchObject({ ok: false });
    const again = (await b.pk('confirm-options')).value;
    expect(await b.pk('sign-in', { response: authenticator.authenticate(again) })).toMatchObject({ ok: false });
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
  });

  it('works once: the same answer a second time is refused, and confirming again needs a new challenge', async () => {
    const booted = await boot();
    const authenticator = device('ES256', true); // a synchronised passkey has counter 0 and could be replayed without the challenge check
    const b = await unconfirmed(booted, authenticator);
    const options = (await b.pk('confirm-options')).value;
    const response = authenticator.authenticate(options);
    expect(await b.pk('confirm', { response })).toEqual({ ok: true });
    await b.pk('forget-confirmed');
    expect(await b.pk('confirm', { response })).toMatchObject({ ok: false, kind: 'no-challenge' });
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
  });

  it('refuses a challenge that ran out', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const booted = await boot();
      const authenticator = device();
      const b = await unconfirmed(booted, authenticator);
      const options = (await b.pk('confirm-options')).value;
      vi.setSystemTime(Date.now() + (CHALLENGE_SECONDS + 1) * 1000);
      expect(await b.pk('confirm', { response: authenticator.authenticate(options) })).toMatchObject({ ok: false, kind: 'expired' });
      expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an answer that is not a valid assertion and leaves the session unconfirmed', async () => {
    const booted = await boot();
    const b = await unconfirmed(booted);
    await b.pk('confirm-options');
    expect(await b.pk('confirm', { response: { id: 'unknown' } })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
  });

  it('throttles per account: the eleventh attempt in a minute waits', async () => {
    const booted = await boot();
    const b = await unconfirmed(booted);
    for (let attempt = 0; attempt < 10; attempt++) expect(await b.pk('confirm', { response: { id: 'unknown' } })).toMatchObject({ ok: false, kind: 'no-challenge' });
    expect(await b.pk('confirm', { response: { id: 'unknown' } })).toMatchObject({ ok: false, kind: 'throttled', retryAfter: expect.any(Number) });
  });

  it('counts a passwordless sign-in as a fresh confirmation', async () => {
    const booted = await boot();
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = booted.browser();
    const options = await b.pk('sign-in-options');
    expect(await b.pk('sign-in', { response: authenticator.authenticate(options) })).toMatchObject({ ok: true });
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: true });
    expect(await b.send('/sudo')).toEqual({ page: true });
  });

  it('keeps a route behind confirmedPassword() closed until the passkey confirmed, and opens it after', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    expect(await b.send('/sudo')).not.toEqual({ page: true });
    const options = (await b.pk('confirm-options')).value;
    expect(await b.pk('confirm', { response: authenticator.authenticate(options) })).toEqual({ ok: true });
    expect(await b.send('/sudo')).toEqual({ page: true });
  });

  it('tells the owner of a wrong answer to the open challenge through TwoFactorChallengeFailed (during confirm), not of a missing or replaced challenge', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    events.length = 0;
    expect(await b.pk('confirm', { response: { id: 'unknown' } })).toMatchObject({ ok: false, kind: 'no-challenge' });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toEqual([]);
    await b.pk('confirm-options');
    expect(await b.pk('confirm', { response: { id: 'unknown' } })).toMatchObject({ ok: false, kind: 'invalid' });
    const failed = events.filter((event): event is TwoFactorChallengeFailed => event instanceof TwoFactorChallengeFailed);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ during: 'confirm', user: { id: ada.id } });
    expect(JSON.stringify(failed[0])).not.toContain('unknown');
  });

  it('does not tell the owner when a newer challenge replaced the one the browser signed', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    const options = (await b.pk('confirm-options')).value;
    events.length = 0;
    await b.pk('step-up-options'); // a second tab replaces the open challenge
    expect(await b.pk('confirm', { response: authenticator.authenticate(options) })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toEqual([]);
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
  });

  it('does not tell the owner when a second confirmOptions() replaced the challenge, and the newer one still works', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    const first = (await b.pk('confirm-options')).value;
    const second = (await b.pk('confirm-options')).value;
    events.length = 0;
    expect(await b.pk('confirm', { response: authenticator.authenticate(first) })).toMatchObject({ ok: false, kind: 'expired' });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toEqual([]);
    // The stale answer used the open challenge up; the page asks again and the new options work.
    const again = (await b.pk('confirm-options')).value;
    expect(second.challenge).not.toBe(again.challenge);
    expect(await b.pk('confirm', { response: authenticator.authenticate(again) })).toEqual({ ok: true });
  });

  it('still judges an answer whose clientDataJSON cannot be read: invalid, and the owner is told once', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    const options = (await b.pk('confirm-options')).value;
    const response = authenticator.authenticate(options);
    response.response.clientDataJSON = 'not-json';
    events.length = 0;
    expect(await b.pk('confirm', { response })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toMatchObject([{ during: 'confirm' }]);
  });

  it('tells the owner once when a passkey of another account answers a valid challenge', async () => {
    const booted = await boot();
    const mine = device();
    const theirs = device();
    const b = await unconfirmed(booted, mine);
    await enrolled(booted, theirs, bob.email);
    const options = (await b.pk('confirm-options')).value;
    events.length = 0;
    expect(await b.pk('confirm', { response: theirs.authenticate({ ...options, allowCredentials: [] }) })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toMatchObject([{ during: 'confirm' }]);
  });

  it('refuses a response without user verification, and tells the owner once', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unconfirmed(booted, authenticator);
    const options = (await b.pk('confirm-options')).value;
    events.length = 0;
    expect(await b.pk('confirm', { response: authenticator.authenticate(options, { userVerified: false }) })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toMatchObject([{ during: 'confirm' }]);
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
  });

  it('dates a failed passwordless sign-in on the app clock', async () => {
    const clock = new TestClock();
    const booted = await boot({}, { clock });
    const authenticator = device();
    await enrolled(booted, authenticator);
    const b = booted.browser();
    clock.travel({ hours: 3 });
    const from = clock.now();
    events.length = 0;
    await b.pk('sign-in', { response: authenticator.authenticate(await b.pk('sign-in-options'), { badSignature: true }) });
    const failed = events.filter((event): event is PasskeySignInFailed => event instanceof PasskeySignInFailed);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.at.getTime()).toBeGreaterThanOrEqual(from);
    expect(failed[0]?.at.getTime()).toBeLessThanOrEqual(clock.now());
  });

  it('does not let a passkey alone persist: adding or removing a passkey still asks for the password in the same form', async () => {
    const booted = await boot();
    const first = device();
    const { b } = await enrolled(booted, first);
    await addPasskey(b, device('EdDSA'), 'Phone');
    await b.pk('forget-confirmed');
    const options = (await b.pk('confirm-options')).value;
    expect(await b.pk('confirm', { response: first.authenticate(options) })).toEqual({ ok: true });
    // Adding: the password is part of the form.
    expect(await addPasskey(b, device('ES256'), 'Tablet', null)).toEqual({ ok: false, kind: 'invalid-password' });
    // Removing one that is not the last factor, the last factor, and a suspended one.
    expect(await b.pk('remove', { id: 2 })).toEqual({ ok: false, kind: 'invalid-password' });
    await booted.connections.get<any>().updateTable('passkeys').set({ suspended_at: new Date().toISOString() }).where('id', '=', 2).execute();
    expect(await b.pk('remove', { id: 2 })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.pk('remove', { id: 1 })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(2);
    expect(await b.pk('remove', { id: 2, password: 'secret' })).toMatchObject({ ok: true });
  });

  it('does not take a confirmation time in the future for a confirmation', async () => {
    const booted = await boot();
    const b = await unconfirmed(booted);
    await b.pk('set-confirmed', { value: Math.floor(Date.now() / 1000) + 3600 });
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: false });
    await b.pk('set-confirmed', { value: Math.floor(Date.now() / 1000) });
    expect(await b.pk('confirmed')).toMatchObject({ confirmed: true });
  });

  it('lets only one of several parallel answers to one challenge confirm', async () => {
    const booted = await boot();
    const authenticator = device('ES256', true); // counter 0: nothing but the challenge stops a replay
    const b = await unconfirmed(booted, authenticator);
    const options = (await b.pk('confirm-options')).value;
    const response = authenticator.authenticate(options);
    const answers = await Promise.all([1, 2, 3].map(() => b.pk('confirm', { response })));
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
  });
});

describe('Passkeys: password checks of a passkey-only session', () => {
  /** A fresh browser of `email`'s account that signed in with the passkey alone: nobody typed a password in it. */
  async function passkeyOnly(booted: Booted, authenticator: Device) {
    const b = booted.browser();
    const options = await b.pk('sign-in-options');
    expect(await b.pk('sign-in', { response: authenticator.authenticate(options) })).toMatchObject({ ok: true });
    expect(await b.pk('scope')).toMatchObject({ typed: false });
    return b;
  }
  const wrong = (b: Browser, id = 1) => b.pk('remove', { id, password: 'wrong' });

  it('lets the owner, who typed the password to sign in, still remove the passkey after a passkey-only session used up the account', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b: owner } = await enrolled(booted, authenticator);
    expect(await owner.pk('scope')).toMatchObject({ typed: true });
    // Four sessions with five wrong passwords each fill the account's twenty an hour; each is stopped by its own minute first.
    for (let session = 0; session < 4; session++) {
      const attacker = await passkeyOnly(booted, authenticator);
      for (let attempt = 0; attempt < 5; attempt++) expect(await wrong(attacker)).toEqual({ ok: false, kind: 'invalid-password' });
      const held = await wrong(attacker);
      expect(held).toMatchObject({ ok: false, kind: 'throttled' });
      expect(held).not.toHaveProperty('account');
    }
    // A fifth has a fresh session budget, yet the account is used up for passkey-only sessions (the cap is shared).
    // … and says so: the way out is to sign in again with the password, not to wait.
    expect(await wrong(await passkeyOnly(booted, authenticator))).toMatchObject({ ok: false, kind: 'throttled', account: true });
    // The owner's session began with the typed password: the account's cap does not apply to it.
    expect(await owner.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
  });

  it('keeps the owner\'s own windows: five wrong passwords in a signed-in-by-password session stop that session', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    for (let attempt = 0; attempt < 5; attempt++) expect(await wrong(b)).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: false, kind: 'throttled' });
  });

  it('marks a sign-in as typed only when it began with the password: not a passkey, not login(), and a new sign-in has a new key', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b } = await enrolled(booted, authenticator);
    const typed = await b.pk('scope');
    expect(typed).toMatchObject({ typed: true, session: expect.any(String) });
    await b.pk('login-as', { id: bob.id });
    const replaced = await b.pk('scope');
    expect(replaced).toMatchObject({ typed: false });
    expect(replaced.session).not.toBe(typed.session);
    const viaPasskey = await passkeyOnly(booted, authenticator);
    expect((await viaPasskey.pk('scope')).session).not.toBe(typed.session);
  });

  it('keeps the sign-in\'s key when the session id changes within it', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b } = await enrolled(booted, authenticator);
    await b.pk('forget-confirmed');
    const before = await b.pk('scope');
    const cookie = b.jar.get('marmeon_session');
    const options = (await b.pk('confirm-options')).value;
    expect(await b.pk('confirm', { response: authenticator.authenticate(options) })).toEqual({ ok: true });
    expect(b.jar.get('marmeon_session')).not.toBe(cookie);
    expect(await b.pk('scope')).toEqual(before);
  });

  it('does not let a passkey-only session burn the code budget of the owner\'s setup by guessing passwords in confirm()', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b: owner } = await enrolled(booted, authenticator);
    const attacker = await passkeyOnly(booted, authenticator);
    await attacker.pk('tf-begin');
    for (let attempt = 0; attempt < 5; attempt++) expect(await attacker.pk('tf-confirm', { code: '000000', password: 'wrong' })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await attacker.pk('tf-confirm', { code: '000000', password: 'wrong' })).toMatchObject({ ok: false, kind: 'throttled' });
    // The owner sets up their own authenticator: the guesses spent no code budget of the account.
    const { secret } = await owner.pk('tf-begin');
    expect(await owner.pk('tf-confirm', { code: twoFactorCode(secret), password: 'secret' })).toEqual({ ok: true });
  });

  it('asks a passkey-only session for the password to make new recovery codes, and the owner\'s codes stay when it is wrong', async () => {
    const booted = await boot();
    const authenticator = device();
    const { b: owner } = await enrolled(booted, authenticator);
    const codesBefore = await rows(booted, RECOVERY_CODES_TABLE);
    const attacker = await passkeyOnly(booted, authenticator);
    expect(await attacker.pk('regenerate')).toMatchObject({ ok: false, kind: 'invalid-password' });
    // The empty form field counts no try: five wrong passwords are still answered as wrong, the sixth is held up.
    for (let attempt = 0; attempt < 5; attempt++) expect(await attacker.pk('regenerate', { password: 'wrong' })).toMatchObject({ ok: false, kind: 'invalid-password' });
    expect(await attacker.pk('regenerate', { password: 'wrong' })).toMatchObject({ ok: false, kind: 'throttled' });
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toEqual(codesBefore);
    expect(await owner.pk('regenerate', { password: 'secret' })).toMatchObject({ ok: true, codes: expect.any(Array) });
    expect(await rows(booted, RECOVERY_CODES_TABLE)).not.toEqual(codesBefore);
  });
});

describe('Passkeys: as a step-up', () => {
  /** A signed-in browser of an account with only this passkey, whose session has not proven the factor (a session older than `maxAge`, say). */
  async function unproven(booted: Booted, authenticator: Device = device()) {
    const { b } = await enrolled(booted, authenticator);
    expect(await b.pk('forget-proof')).toEqual({ forgotten: true });
    expect(await b.send('/area')).toEqual({ error: 'two_factor_unverified' });
    return b;
  }

  it('lets an account with only a passkey through twoFactor(): a new session id, and asking again once the proof is gone', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unproven(booted, authenticator);
    const before = b.jar.get('marmeon_session');
    events.length = 0;
    const options = await b.pk('step-up-options');
    expect(options).toMatchObject({ ok: true, value: { userVerification: 'required' } });
    expect(options.value.allowCredentials).toHaveLength(1);
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(options.value) })).toEqual({ ok: true });
    expect(b.jar.get('marmeon_session')).not.toBe(before);
    expect(await b.send('/area')).toEqual({ page: true });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toEqual([]);
    expect(await b.pk('forget-proof')).toEqual({ forgotten: true });
    expect(await b.send('/area')).toEqual({ error: 'two_factor_unverified' });
    const again = await b.pk('step-up-options');
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(again.value) })).toEqual({ ok: true });
    expect(await b.send('/area')).toEqual({ page: true });
  });

  it('writes the proof of a step-up on the app clock, so that travelling ages it', async () => {
    const clock = new TestClock();
    const booted = await boot({}, { clock });
    const authenticator = device();
    const b = await unproven(booted, authenticator);
    clock.travel({ seconds: 61 });
    const options = (await b.pk('step-up-options')).value;
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(options) })).toEqual({ ok: true });
    expect(await b.send('/area-fresh')).toEqual({ page: true });
    clock.travel({ seconds: 55 });
    expect(await b.send('/area-fresh')).toEqual({ page: true });
    clock.travel({ seconds: 10 });
    expect(await b.send('/area-fresh')).toEqual({ error: 'two_factor_unverified' });
  });

  it('answers no-challenge for the options when the account has no passkey', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login(bob.email);
    expect(await b.pk('step-up-options')).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('needs a signed-in user for the options and for the step-up', async () => {
    const booted = await boot();
    const b = booted.browser();
    expect(await b.pk('step-up-options')).toMatchObject({ thrown: expect.stringContaining('signed-in user') });
    expect(await b.pk('step-up', { passkey: { id: 'x' } })).toMatchObject({ thrown: expect.stringContaining('signed-in user') });
  });

  it('keeps the purposes apart, in both directions within one session', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unproven(booted, authenticator);
    // A passwordless sign-in's challenge does not serve a step-up.
    const signInOptions = (await b.pk('sign-in-options'));
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(signInOptions) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    // A step-up's challenge does not serve a passwordless sign-in.
    const stepOptions = (await b.pk('step-up-options')).value;
    expect(await b.pk('sign-in', { response: authenticator.authenticate(stepOptions) })).toMatchObject({ ok: false });
    expect(await b.send('/area')).toEqual({ error: 'two_factor_unverified' });
    // The challenge of a waiting sign-in does not finish the step-up either, and the reverse.
    // Step-up and second factor are both bound to the account; what tells them apart is covered in challenge.test.ts.
    const second = (await (await waiting(booted)).pk('challenge-options')).value;
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(second) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    const again = (await b.pk('step-up-options')).value;
    const other = await waiting(booted);
    await other.pk('challenge-options');
    expect(await other.pk('challenge', { passkey: authenticator.authenticate(again) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(again) })).toMatchObject({ ok: true });
  });

  it('refuses a challenge that ran out, and the page stays closed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const booted = await boot();
      const authenticator = device();
      const b = await unproven(booted, authenticator);
      const options = (await b.pk('step-up-options')).value;
      vi.setSystemTime(Date.now() + (CHALLENGE_SECONDS + 1) * 1000);
      expect(await b.pk('step-up', { passkey: authenticator.authenticate(options) })).toMatchObject({ ok: false, kind: 'invalid-code' });
      expect(await b.send('/area')).toEqual({ error: 'two_factor_unverified' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the owner of a wrong answer only, not of a missing, used or expired challenge', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const booted = await boot();
      const authenticator = device();
      const b = await unproven(booted, authenticator);
      const failed = () => events.filter((event) => event instanceof TwoFactorChallengeFailed);
      events.length = 0;
      expect(await b.pk('step-up', { passkey: { id: 'x' } })).toMatchObject({ kind: 'invalid-code' }); // no challenge
      const options = (await b.pk('step-up-options')).value;
      const response = authenticator.authenticate(options);
      expect(await b.pk('step-up', { passkey: response })).toEqual({ ok: true });
      expect(await b.pk('step-up', { passkey: response })).toMatchObject({ kind: 'invalid-code' }); // sent twice
      const late = (await b.pk('step-up-options')).value;
      vi.setSystemTime(Date.now() + (CHALLENGE_SECONDS + 1) * 1000);
      expect(await b.pk('step-up', { passkey: authenticator.authenticate(late) })).toMatchObject({ kind: 'invalid-code' }); // expired
      expect(failed()).toEqual([]);
      const fresh = (await b.pk('step-up-options')).value;
      expect(await b.pk('step-up', { passkey: authenticator.authenticate(fresh, { userVerified: false }) })).toMatchObject({ kind: 'invalid-code' });
      expect(failed()).toMatchObject([{ during: 'step-up' }]);

      // The same at the sign-in's second step.
      events.length = 0;
      const w = await waiting(booted);
      expect(await w.pk('challenge', { passkey: { id: 'x' } })).toMatchObject({ kind: 'invalid-code' }); // no challenge
      expect(failed()).toEqual([]);
      const options2 = (await w.pk('challenge-options')).value;
      expect(await w.pk('challenge', { passkey: authenticator.authenticate(options2, { userVerified: false }) })).toMatchObject({ kind: 'invalid-code' });
      expect(failed()).toMatchObject([{ during: 'sign-in' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses the passkey of another account, counts the failure, and ends no session', async () => {
    const booted = await boot();
    const b = await unproven(booted);
    const bobs = device();
    await enrolled(booted, bobs, bob.email);
    events.length = 0;
    const options = (await b.pk('step-up-options')).value;
    expect(await b.pk('step-up', { passkey: bobs.authenticate({ challenge: options.challenge }) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toMatchObject([{ during: 'step-up' }]);
    expect(await b.pk('who')).toEqual({ id: 1 });
    expect(await b.send('/area')).toEqual({ error: 'two_factor_unverified' });
  });

  it('spends the challenge: the same assertion a second time is refused', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unproven(booted, authenticator);
    const response = authenticator.authenticate((await b.pk('step-up-options')).value);
    expect(await b.pk('step-up', { passkey: response })).toEqual({ ok: true });
    expect(await b.pk('step-up', { passkey: response })).toMatchObject({ ok: false, kind: 'invalid-code' });
  });

  it('refuses a missing user verification and a passkey deleted meanwhile', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unproven(booted, authenticator);
    await b.pk('set-proof');
    await addPasskey(b, device('EdDSA'), 'Phone');
    expect(await b.pk('forget-proof')).toEqual({ forgotten: true });
    const options = (await b.pk('step-up-options')).value;
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(options, { userVerified: false }) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    const response = authenticator.authenticate((await b.pk('step-up-options')).value);
    await b.pk('set-proof');
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
    await b.pk('forget-proof');
    expect(await b.pk('step-up', { passkey: response })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await b.send('/area')).toEqual({ error: 'two_factor_unverified' });
  });

  it('leaves a suspended passkey out of the options, and refuses it as a response', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unproven(booted, authenticator);
    await b.pk('set-proof');
    await addPasskey(b, device('EdDSA'), 'Phone');
    await b.pk('forget-proof');
    const options = (await b.pk('step-up-options')).value;
    await booted.connections.get<any>().updateTable('passkeys').set({ suspended_at: new Date().toISOString() }).where('id', '=', 1).execute();
    expect((await b.pk('step-up-options')).value.allowCredentials).toHaveLength(1);
    expect(await b.pk('step-up', { passkey: authenticator.authenticate(options) })).toMatchObject({ ok: false, kind: 'invalid-code' });
  });

  it('a counter regression refuses it and raises the clone event', async () => {
    const booted = await boot();
    const authenticator = device();
    const b = await unproven(booted, authenticator);
    expect(await b.pk('step-up', { passkey: authenticator.authenticate((await b.pk('step-up-options')).value) })).toEqual({ ok: true });
    await b.pk('forget-proof');
    events.length = 0;
    const stale = authenticator.authenticate((await b.pk('step-up-options')).value, { signCount: 1 });
    expect(await b.pk('step-up', { passkey: stale })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(events.filter((event) => event instanceof PasskeyCloneSuspected)).toHaveLength(1);
  });

  it('uses the generous counter, 10 a minute, and leaves the budget of authenticator codes untouched', async () => {
    const booted = await boot();
    const b = await unproven(booted);
    const kinds = [];
    for (let i = 0; i < 11; i++) kinds.push((await b.pk('step-up', { passkey: { id: 'x' } })).kind);
    expect(kinds.slice(0, 10).every((kind) => kind === 'invalid-code')).toBe(true);
    expect(kinds[10]).toBe('throttled');
    const limiter = booted.application.container.make(RateLimiter);
    for (let i = 0; i < 5; i++) expect(await limiter.attempt('two-factor-minute:1', 5, 60)).toBe(true);
    expect(await b.pk('who')).toEqual({ id: 1 });
  });

  it('has nothing to prove without a factor', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login(bob.email);
    expect(await b.pk('step-up', { passkey: { id: 'x' } })).toEqual({ ok: false, kind: 'no-challenge' });
  });
});

describe('Passkeys: changing the factors of an account that has one', () => {
  const needsProof = { thrown: expect.stringContaining('second factor proven within 15 minutes') };
  const old = () => Math.floor(Date.now() / 1000) - 25 * 3600;

  it('refuses to add a passkey to a session that only has the password: no options, no registration, no passkey to step up with', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    await b.pk('set-proof', { value: old() });
    expect(await b.pk('options')).toMatchObject(needsProof);
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(1);
  });

  it('refuses the registration of a challenge made while the proof was fresh, once it is old', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    const options = await b.pk('options');
    await b.pk('set-proof', { value: old() });
    expect(await b.pk('register', { response: device('EdDSA').register(options), name: 'Phone', password: 'secret' })).toMatchObject(needsProof);
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(1);
  });

  it('refuses to remove or release a passkey, even with the password', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    await addPasskey(b, device('EdDSA'), 'Phone');
    await booted.connections.get<any>().updateTable('passkeys').set({ suspended_at: new Date().toISOString() }).where('id', '=', 2).execute();
    await b.pk('forget-proof');
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject(needsProof);
    expect(await b.pk('release', { id: 2, password: 'secret' })).toMatchObject(needsProof);
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(2);
  });

  it('allows all of it once a factor was proven lately, and the boundary is fifteen minutes', async () => {
    const clock = new TestClock();
    clock.freeze(); // the proof is stamped in whole seconds: a tick between stamping and checking would move the boundary
    const booted = await boot({}, { clock });
    const authenticator = device();
    const { b } = await enrolled(booted, authenticator);
    await b.pk('forget-proof');
    expect(await b.pk('step-up', { passkey: authenticator.authenticate((await b.pk('step-up-options')).value) })).toEqual({ ok: true });
    expect(await addPasskey(b, device('EdDSA'), 'Phone')).toMatchObject({ ok: true });
    await b.pk('set-proof', { value: Math.floor(clock.now() / 1000) - 900 });
    expect(await b.pk('remove', { id: 2, password: 'secret' })).toMatchObject({ ok: true });
    await b.pk('set-proof', { value: Math.floor(clock.now() / 1000) - 901 });
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject(needsProof);
  });

  it('lets an account without a factor add its first passkey with the password alone, and that proves the session', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    expect(await addPasskey(b, device())).toMatchObject({ ok: true });
    expect(await b.pk('options')).toMatchObject({ challenge: expect.any(String) });
  });

  it('drops an authenticator setup begun before the first passkey, so that it cannot be confirmed as a further factor', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    await booted.application.container.make(TwoFactorStore).startSetup(1, 'enc');
    expect(await rows(booted, 'two_factor_authentications')).toHaveLength(1);
    expect(await addPasskey(b, device())).toMatchObject({ ok: true });
    expect(await rows(booted, 'two_factor_authentications')).toHaveLength(0);
  });

  it('keeps renaming free: it changes no factor', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    await b.pk('forget-proof');
    expect(await b.pk('rename', { id: 1, name: 'Work' })).toEqual({ renamed: true });
  });
});

describe('Passkeys: managing', () => {
  it('renames a passkey of the account, trimmed, not an empty name and not another account\'s', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    expect(await b.pk('rename', { id: 1, name: '  Work laptop ' })).toEqual({ renamed: true });
    expect(await b.pk('rename', { id: 1, name: '   ' })).toEqual({ renamed: false });
    expect(await b.pk('rename', { id: 1, name: 'x'.repeat(101) })).toEqual({ renamed: false });
    expect(await b.pk('rename', { id: 99, name: 'x' })).toEqual({ renamed: false });
    expect((await b.pk('list'))[0].name).toBe('Work laptop');
  });

  it('asks the password for the last factor, and the recovery codes go with it', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    expect(await b.pk('remove', { id: 1 })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.pk('remove', { id: 1, password: 'wrong' })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(1);
    events.length = 0;
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(0);
    expect(events.some((event) => event instanceof PasskeyRemoved)).toBe(true);
    expect(events.some((event) => event instanceof TwoFactorDisabled)).toBe(true);
    expect(await booted.browser().login()).toEqual({ signedIn: true });
  });

  it('removes a passkey while another factor remains, and keeps the recovery codes', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    await addPasskey(b, device('EdDSA'), 'Phone');
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(10);
    expect(await b.pk('remove', { id: 99, password: 'secret' })).toEqual({ ok: false, kind: 'not-found' });
  });

  it('two parallel removals of the last two passkeys, with the password, leave no factor and no recovery codes behind', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    await addPasskey(b, device('EdDSA'), 'Phone');
    const answers = await Promise.all([b.pk('remove', { id: 1, password: 'secret' }), b.pk('remove', { id: 2, password: 'secret' })]);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(2);
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(0);
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(0);
  });

  it('takes an empty password for none: nothing is counted against the throttle', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    for (let i = 0; i < 12; i++) expect(await b.pk('remove', { id: 1, password: '' })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.pk('remove', { id: 1 })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
  });

  it('throttles the password of remove() with the one of register()', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    for (let i = 0; i < 5; i++) expect(await b.pk('remove', { id: 1, password: 'wrong' })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: false, kind: 'throttled' });
  });

  it('a TOTP factor beside the last passkey keeps the recovery codes when the passkey goes', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    const store = booted.application.container.make(TwoFactorStore);
    await store.startSetup(1, 'enc');
    await store.confirm(1, 5, 'enc', null);
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: true });
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(10);
  });
});

describe('Passkeys: the events', () => {
  const validate = async (event: { schema: { '~standard': { validate(value: unknown): unknown } } }, value: unknown) => {
    const result = (await event.schema['~standard'].validate(value)) as { issues?: unknown; value?: unknown };
    return result.issues ? undefined : result.value;
  };

  it('a Login payload with via passkey validates for the queue, and one with another via does not', async () => {
    const payload = { userId: 1, remember: false, via: 'passkey', at: new Date().toISOString(), ip: null, userAgent: null };
    expect(await validate(Login, payload)).toEqual(payload);
    expect(await validate(Login, { ...payload, via: 'telepathy' })).toBeUndefined();
    const event = new Login(ada, false, new Date(), { via: 'passkey' });
    expect(JSON.parse(JSON.stringify(await validate(Login, event)))).toMatchObject({ via: 'passkey' });
  });

  it('PasskeyRegistered, PasskeyRemoved and PasskeyCloneSuspected carry JSON payloads and refuse malformed ones', async () => {
    expect(await validate(PasskeyRegistered, new PasskeyRegistered(ada, 'Laptop'))).toEqual({ userId: 1, name: 'Laptop' });
    expect(await validate(PasskeyRegistered, { userId: 1 })).toBeUndefined();
    expect(await validate(PasskeyRemoved, new PasskeyRemoved(ada))).toEqual({ userId: 1, via: 'user' });
    expect(await validate(PasskeyRemoved, { userId: {} })).toBeUndefined();
    expect(await validate(PasskeyCloneSuspected, new PasskeyCloneSuspected(ada, 7))).toEqual({ userId: 1, passkeyId: 7 });
    expect(await validate(PasskeyCloneSuspected, { userId: 1, passkeyId: 'seven' })).toBeUndefined();
    expect(await validate(PasskeySignInFailed, new PasskeySignInFailed(ada, { ip: '203.0.113.9', userAgent: 'x'.repeat(600) }))).toMatchObject({ userId: 1, ip: '203.0.113.9', userAgent: 'x'.repeat(600).slice(0, 512) });
    expect(await validate(PasskeySignInFailed, { userId: 1, ip: 7, userAgent: null })).toBeUndefined();
    // Queued before `at` existed: accepted, dated when it is read.
    expect(await validate(PasskeySignInFailed, { userId: 1, ip: null, userAgent: null })).toMatchObject({ userId: 1, at: expect.any(String) });
    const at = new Date('2030-01-02T03:04:05.000Z');
    expect(await validate(PasskeySignInFailed, new PasskeySignInFailed(ada, {}, at))).toMatchObject({ at: at.toISOString() });
  });
});
