import { CacheServiceProvider, RateLimiter } from '@marmeon/cache';
import { createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, defineRoutes, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Auth,
  AuthServiceProvider,
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
  softAuthenticator,
  type Credentials,
  type PasswordHash,
} from '../index.ts';
import { NoTwoFactorState } from '../two-factor/state.ts';
import { RECOVERY_CODES_TABLE } from '../two-factor/store.ts';
import { TwoFactor } from '../two-factor/two-factor.ts';
import { Passkeys } from './passkeys.ts';
import { PasskeyServiceProvider } from './provider.ts';
import { PASSKEYS_TABLE, PasskeyStore } from './store.ts';

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

class MemoryUsers implements UserProvider<TestUser> {
  readonly rows = new Map<number, { user: TestUser; hash: PasswordHash | null }>();
  async findById(id: number): Promise<Credentials<TestUser> | undefined> {
    const row = this.rows.get(Number(id));
    return row && { user: row.user, passwordHash: row.hash };
  }
  async findForLogin(email: string): Promise<Credentials<TestUser> | undefined> {
    for (const row of this.rows.values()) if (row.user.email === email) return { user: row.user, passwordHash: row.hash };
    return undefined;
  }
  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    this.rows.get(Number(id))!.hash = hash;
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
  constructor(passkeys: Passkeys, twoFactor: TwoFactor, auth: Auth) {
    super();
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

const routes = defineRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.post('/pk/:method', PasskeyController);
  Route.post('/tf/challenge', ChallengeController);
});

const ada: TestUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const bob: TestUser = { id: 2, name: 'Bob', email: 'bob@example.com' };
const CHEAP = { HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' };
const ORIGIN = 'http://localhost:3000';

async function boot(env: Record<string, string> = {}, options: { passkeys?: boolean; unboundState?: boolean } = {}) {
  const users = new MemoryUsers();
  const passkeys = options.passkeys !== false;
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), APP_NAME: 'Acme', APP_URL: ORIGIN, SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', CACHE_DRIVER: 'memory', ...CHEAP, ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider, ...(passkeys ? [PasskeyServiceProvider] : [])],
    modules: [
      defineModule({
        name: 'passkeys-test',
        routes,
        migrations: new URL('../__fixtures__/migrations/', import.meta.url),
        listeners: [Login, TwoFactorEnabled, TwoFactorDisabled, RecoveryCodesGenerated, TwoFactorChallengeFailed, PasskeyRegistered, PasskeyRemoved, PasskeyCloneSuspected, PasskeySignInFailed].map((event) => listen(event as never, RecordEvent)),
      }),
    ],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
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
    const send = async (path: string, json: unknown = {}): Promise<any> => {
      const response = await kernel.request(path, {
        method: 'POST',
        headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(json),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return await response.json();
    };
    const pk = (method: string, json: unknown = {}) => send(`/pk/${method}`, json);
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
    const remembered = new Map([...other.jar].filter(([name]) => name === 'remember_web'));
    expect(remembered.size).toBe(1);
    const own = booted.browser();
    await own.login();
    expect(await addPasskey(own, device())).toMatchObject({ ok: true });
    expect(await booted.browser(new Map(remembered)).pk('who')).toEqual({ id: null });
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
    expect(await b.pk('rename', { id: 1, name: 'x' })).toMatchObject({ thrown: expect.stringContaining('recently typed password') });
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
    expect(await owner.pk('remove', { id: 1 })).toMatchObject({ ok: true });
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

  it('removes a passkey without a password while another factor remains, and keeps the recovery codes', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    await addPasskey(b, device('EdDSA'), 'Phone');
    expect(await b.pk('remove', { id: 1 })).toMatchObject({ ok: true });
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(10);
    expect(await b.pk('remove', { id: 99 })).toEqual({ ok: false, kind: 'not-found' });
  });

  it('two parallel removals of the last two passkeys without a password leave one', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    await addPasskey(b, device('EdDSA'), 'Phone');
    const answers = await Promise.all([b.pk('remove', { id: 1 }), b.pk('remove', { id: 2 })]);
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    expect(answers.find((answer) => !answer.ok)).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await rows(booted, PASSKEYS_TABLE)).toHaveLength(1);
    expect(await rows(booted, RECOVERY_CODES_TABLE)).toHaveLength(10);
  });

  it('throttles the password of remove() with the one of register()', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    for (let i = 0; i < 5; i++) expect(await b.pk('remove', { id: 1, password: 'wrong' })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.pk('remove', { id: 1, password: 'secret' })).toMatchObject({ ok: false, kind: 'throttled' });
  });

  it('a TOTP factor beside the last passkey makes removing it free of the password', async () => {
    const booted = await boot();
    const { b } = await enrolled(booted);
    const store = booted.application.container.make(TwoFactorStore);
    await store.startSetup(1, 'enc');
    await store.confirm(1, 5, 'enc', null);
    expect(await b.pk('remove', { id: 1 })).toMatchObject({ ok: true });
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
    expect(await validate(PasskeyRemoved, new PasskeyRemoved(ada))).toEqual({ userId: 1 });
    expect(await validate(PasskeyRemoved, { userId: {} })).toBeUndefined();
    expect(await validate(PasskeyCloneSuspected, new PasskeyCloneSuspected(ada, 7))).toEqual({ userId: 1, passkeyId: 7 });
    expect(await validate(PasskeyCloneSuspected, { userId: 1, passkeyId: 'seven' })).toBeUndefined();
    expect(await validate(PasskeySignInFailed, new PasskeySignInFailed(ada, { ip: '203.0.113.9', userAgent: 'x'.repeat(600) }))).toEqual({ userId: 1, ip: '203.0.113.9', userAgent: 'x'.repeat(600).slice(0, 512) });
    expect(await validate(PasskeySignInFailed, { userId: 1, ip: 7, userAgent: null })).toBeUndefined();
  });
});
