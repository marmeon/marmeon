import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RateLimiter } from '@marmeon/cache';
import { createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider, Migrator, secret } from '@marmeon/database';
import { AesGcmEncrypter, Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, defineRoutes, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, authenticatedSession, Auth, AuthServiceProvider, Hasher, Login, RecoveryCodesGenerated, RecoveryCodeUsed, RememberTokenStore, TwoFactorChallengeFailed, TwoFactorDisabled, TwoFactorEnabled, TwoFactorState, TwoFactorStore, UserProvider, twoFactorCode, type Credentials, type PasswordHash } from '../index.ts';
import { TWO_FACTOR_TABLE, RECOVERY_CODES_TABLE, type RecoveryCodeTable, type TwoFactorTable } from './store.ts';
import { twoFactor } from './middleware.ts';
import { TwoFactor, type ConfirmError } from './two-factor.ts';

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

class LoginAsController extends Controller {
  readonly #auth: Auth;
  readonly #users: UserProvider;
  constructor(auth: Auth, users: UserProvider) {
    super();
    this.#auth = auth;
    this.#users = users;
  }
  async handle(ctx: HttpContext) {
    const { id } = (await ctx.input()) as { id: number };
    return { result: await this.#auth.login((await this.#users.findById(id as never))!.user) };
  }
}

/** One controller for every `TwoFactor` call: `/tf/<method>` with the arguments as JSON. */
class TwoFactorController extends Controller {
  readonly #twoFactor: TwoFactor;
  readonly #auth: Auth;
  constructor(twoFactor: TwoFactor, auth: Auth) {
    super();
    this.#twoFactor = twoFactor;
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { method } = ctx.params as { method: string };
    const body = (await ctx.input()) as Record<string, any>;
    try {
      switch (method) {
        case 'challenge': {
          const done = await this.#twoFactor.challenge(body as never);
          return done.ok ? { ok: true, id: done.value.id } : { ok: false, ...done.error };
        }
        case 'confirm': {
          const done = await this.#twoFactor.confirm(body.code, body.password ?? 'secret');
          return done.ok ? { ok: true, ...done.value } : { ok: false, ...done.error };
        }
        case 'begin':
          return await this.#twoFactor.begin();
        case 'setup':
          return (await this.#twoFactor.setup()) ?? null;
        case 'step-up':
          return await this.#twoFactor.stepUp(body as never).then((done) => (done.ok ? { ok: true } : { ok: false, ...done.error }));
        case 'status':
          return await this.#twoFactor.status();
        case 'regenerate':
          return { codes: await this.#twoFactor.regenerateRecoveryCodes() };
        case 'disable':
          return { disabled: await this.#twoFactor.disable(body.password) };
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

/** Writes whatever the request says into the session's proof of the second factor — to see how the middleware reads bad data. */
class SetProof extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  async handle(ctx: HttpContext) {
    this.#session.put('_auth_two_factor_at', ((await ctx.input()) as { value: unknown }).value as never);
    return { set: true };
  }
}

class Page extends Controller {
  handle() {
    return { page: true };
  }
}

const routes = defineRoutes((Route) => {
  Route.post('/login', LoginController).name('auth.login');
  // Pages for the middleware: the one it sends people to, and areas behind it (the second one asks again after a minute).
  Route.post('/set-proof', SetProof);
  Route.get('/account/two-factor', Page).name('test.setup');
  Route.get('/account/verify', Page).name('test.verify');
  const signedIn = Route.middleware(authenticate());
  signedIn.middleware(twoFactor({ setup: 'test.setup', verify: 'test.verify' })).get('/area', Page);
  signedIn.middleware(twoFactor({ setup: 'test.setup', verify: 'test.verify' })).post('/area', Page);
  signedIn.middleware(twoFactor({ setup: 'test.setup', verify: 'test.verify', maxAge: 60 })).get('/area-fresh', Page);
  // Without authenticate() before it, which the types ask for: whoever is not signed in must still be refused.
  Route.middleware(twoFactor({ setup: 'test.setup', verify: 'test.verify' }) as never).get('/area-bare', Page);
  Route.post('/login-as', LoginAsController);
  Route.post('/tf/:method', TwoFactorController);
});

const ada: TestUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const bob: TestUser = { id: 2, name: 'Bob', email: 'bob@example.com' };
const CHEAP = { HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' };

async function boot(env: Record<string, string> = {}, options: { state?: 'unbound' | TwoFactorState } = {}) {
  const users = new MemoryUsers();
  const appKey = env.APP_KEY ?? generateKey();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: appKey, APP_NAME: 'Acme', SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', CACHE_DRIVER: 'memory', ...CHEAP, ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [
      defineModule({
        name: 'two-factor-test',
        routes,
        migrations: new URL('../__fixtures__/migrations/', import.meta.url),
        listeners: [Login, TwoFactorEnabled, TwoFactorDisabled, RecoveryCodesGenerated, RecoveryCodeUsed, TwoFactorChallengeFailed].map((event) => listen(event as never, RecordEvent)),
      }),
    ],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
      if (options.state === undefined) container.bind(TwoFactorState, TwoFactorStore);
      else if (options.state !== 'unbound') container.instance(TwoFactorState, options.state);
      container.scoped(TwoFactor);
    },
  });
  await application.container.make(Migrator).migrate();
  const kernel = createHttpKernel(application);
  const hasher = application.container.make(Hasher);
  for (const user of [ada, bob]) users.rows.set(user.id, { user, hash: await hasher.make('secret') });

  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (path: string, json: unknown = {}) => {
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
      return (await response.json()) as Record<string, any>;
    };
    /** A GET that is not followed: the status, where it points, and the JSON answer when the client asked for it. */
    const visit = async (path: string, { json = false, headers = {} }: { json?: boolean; headers?: Record<string, string> } = {}) => {
      const response = await kernel.request(path, { headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), ...(json ? { accept: 'application/json' } : {}), ...headers } });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      const body = json || response.status === 200 ? ((await response.json().catch(() => undefined)) as Record<string, any> | undefined) : undefined;
      return { status: response.status, location: response.headers.get('location'), body };
    };
    const tf = (method: string, json: unknown = {}) => send(`/tf/${method}`, json);
    const login = (email = ada.email, password = 'secret', remember = false) => send('/login', { email, password, remember });
    return { send, tf, login, visit, jar };
  };

  const connections = application.container.make(Connections);
  return { application, users, browser, connections, store: application.container.make(TwoFactorStore), appKey };
}

type Booted = Awaited<ReturnType<typeof boot>>;
type Browser = ReturnType<Booted['browser']>;
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000);

/** Signs `email` in and turns the authenticator on, as a settings page would. */
async function enable(booted: Booted, email = ada.email, remember = false) {
  const b = booted.browser();
  await b.login(email, 'secret', remember);
  const setup = await b.tf('begin');
  const confirmed = await b.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' });
  expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
  return { b, secret: setup.secret as string, recoveryCodes: confirmed.recoveryCodes as string[] };
}

/** A fresh browser that typed the password and now waits for the factor. */
async function waiting(booted: Booted, email = ada.email, password = 'secret'): Promise<Browser> {
  const b = booted.browser();
  const answer = await b.login(email, password);
  expect(answer).toMatchObject({ signedIn: false, error: { kind: 'two-factor-required' } });
  return b;
}

afterEach(() => {
  vi.useRealTimers();
  events.length = 0;
});

describe('TwoFactor: setting up', () => {
  it('begins with a key, an otpauth URI for the app\'s name and a QR path — nothing is in force yet', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const setup = await b.tf('begin');
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.uri).toBe(`otpauth://totp/Acme:ada%40example.com?secret=${setup.secret}&issuer=Acme&algorithm=SHA1&digits=6&period=30`);
    expect(setup.qr).toMatchObject({ size: expect.any(Number), path: expect.stringMatching(/^M\d/) });
    expect(await b.tf('setup')).toEqual(setup); // a reloaded page shows the same key
    expect(await b.tf('status')).toEqual({ factors: [], settingUpTotp: true, recoveryCodesLeft: 0 });
  });

  it('stores the key encrypted and bound to the account — never in clear', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const { secret: key } = await b.tf('begin');
    const [row] = await booted.connections.get<{ [TWO_FACTOR_TABLE]: TwoFactorTable }>().selectFrom(TWO_FACTOR_TABLE).select((eb) => [secret(eb, 'secret')]).execute();
    expect(row!.secret).not.toContain(key);
    expect(await booted.application.container.make(Encrypter).decrypt(row!.secret, 'marmeon-auth:two-factor:1')).toBe(key);
  });

  it('needs a recently typed password to begin, to show the key again and to make new recovery codes', async () => {
    const booted = await boot();
    const { b } = await enable(booted);
    vi.useFakeTimers({ toFake: ['Date'], now: inSeconds(901) });
    for (const method of ['begin', 'setup', 'regenerate']) {
      expect(await b.tf(method), method).toMatchObject({ thrown: expect.stringContaining('recently typed password') });
    }
    expect(await b.tf('confirm-password', { password: 'secret' })).toEqual({ confirmed: true });
    expect(await b.tf('regenerate')).toMatchObject({ codes: expect.any(Array) });
  });

  it('an unconfirmed setup changes nothing about signing in', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    await b.tf('begin');
    const other = booted.browser();
    expect(await other.login()).toEqual({ signedIn: true });
  });

  it('confirms with the first code: the factor is on, ten recovery codes are shown once, this session counts as having proven it', async () => {
    const booted = await boot();
    const { b, recoveryCodes } = await enable(booted);
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(await b.tf('status')).toEqual({ factors: ['totp'], settingUpTotp: false, recoveryCodesLeft: 10 });
    expect(events.some((event) => event instanceof TwoFactorEnabled && event.factor === 'totp')).toBe(true);
    expect(events.some((event) => event instanceof RecoveryCodesGenerated)).toBe(true);
    expect(await booted.store.remainingRecoveryCodes(1)).toBe(10);
  });

  it('refuses a wrong code and a confirmation nobody began; the factor stays off', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    expect(await b.tf('confirm', { code: '123456', password: 'secret' })).toEqual({ ok: false, kind: 'not-started' });
    const { secret: key } = await b.tf('begin');
    const wrong = twoFactorCode(key) === '000000' ? '111111' : '000000';
    expect(await b.tf('confirm', { code: wrong, password: 'secret' })).toEqual({ ok: false, kind: 'invalid-code' });
    expect(await b.tf('status')).toMatchObject({ factors: [], settingUpTotp: true });
  });

  it('refuses to begin when an authenticator is already on', async () => {
    const booted = await boot();
    const { b } = await enable(booted);
    expect(await b.tf('begin')).toMatchObject({ thrown: expect.stringContaining('already on') });
  });

  it('new recovery codes replace all the old ones', async () => {
    const booted = await boot();
    const { b, recoveryCodes } = await enable(booted);
    const { codes } = await b.tf('regenerate');
    expect(codes).toHaveLength(10);
    const second = await waiting(booted);
    expect(await second.tf('challenge', { recoveryCode: recoveryCodes[0] })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await second.tf('challenge', { recoveryCode: codes[0] })).toEqual({ ok: true, id: 1 });
  });

  it('a remember-me token another device got before two-factor was turned on no longer signs in', async () => {
    const booted = await boot();
    const otherDevice = booted.browser();
    await otherDevice.login(ada.email, 'secret', true); // made before the factor existed
    const thisDevice = booted.browser();
    await thisDevice.login(ada.email, 'secret', true);
    const setup = await thisDevice.tf('begin');
    await thisDevice.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' });
    const cookie = (b: Browser) => new Map([['remember_web', b.jar.get('remember_web')!]]);
    // The other device comes back with only its remember-me cookie: it signs nobody in.
    expect(await booted.browser(cookie(otherDevice)).tf('who')).toEqual({ id: null });
    // A token made before the factor proved none, this device's own included: signing in again with the code makes a new one.
    expect(await booted.browser(cookie(thisDevice)).tf('who')).toEqual({ id: null });
  });

  it('a remember-me token made between signing out the other devices and switching the factor on is refused by its date', async () => {
    const booted = await boot();
    const { secret: key } = await (async () => {
      const b = booted.browser();
      await b.login();
      const setup = await b.tf('begin');
      // Another device signs in with "remember me" at the worst moment: after the old tokens went, before the factor is on.
      const confirm = booted.store.confirm.bind(booted.store);
      let raced: string | undefined;
      vi.spyOn(booted.store, 'confirm').mockImplementation(async (...args) => {
        raced = await booted.application.container.make(RememberTokenStore).create(1, new Date(Date.now() + 86_400_000));
        await new Promise((resolve) => setTimeout(resolve, 10));
        return confirm(...args);
      });
      expect((await b.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' })).ok).toBe(true);
      expect(raced).toBeDefined();
      expect(await booted.browser(new Map([['remember_web', raced!]])).tf('who')).toEqual({ id: null });
      return setup;
    })();
    expect(key).toBeDefined();
  });

  it('a remember-me token made in the very millisecond the factor was confirmed is refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const setup = await b.tf('begin');
    const confirm = booted.store.confirm.bind(booted.store);
    let raced: string | undefined;
    vi.spyOn(booted.store, 'confirm').mockImplementation(async (...args) => {
      raced = await booted.application.container.make(RememberTokenStore).create(1, new Date(Date.now() + 86_400_000));
      return confirm(...args); // the clock is frozen: created_at and confirmed_at are the same instant
    });
    expect((await b.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' })).ok).toBe(true);
    const since = await booted.store.enabledSince(1);
    expect(since!.getTime()).toBe(Date.now());
    expect(await booted.browser(new Map([['remember_web', raced!]])).tf('who')).toEqual({ id: null });
  });

  it('turning it on signs out the other sessions of the account and keeps this one', async () => {
    const booted = await boot();
    const other = booted.browser();
    await other.login();
    expect(await other.tf('who')).toEqual({ id: 1 });
    const thisDevice = booted.browser();
    await thisDevice.login();
    const setup = await thisDevice.tf('begin');
    expect((await thisDevice.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' })).ok).toBe(true);
    expect(await other.tf('who')).toEqual({ id: null });
    expect(await thisDevice.tf('who')).toEqual({ id: 1 });
  });

  it('a wrong password with the right code changes nothing and does not use the code up', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const other = booted.browser();
    await other.login();
    const setup = await b.tf('begin');
    const code = twoFactorCode(setup.secret);
    expect(await b.tf('confirm', { code, password: 'wrong' })).toEqual({ ok: false, kind: 'invalid-password' });
    expect(await b.tf('status')).toMatchObject({ factors: [], settingUpTotp: true });
    expect(await other.tf('who')).toEqual({ id: 1 }); // not signed out
    expect((await booted.store.find(1))?.lastUsedStep).toBeNull();
    expect((await b.tf('confirm', { code, password: 'secret' })).ok).toBe(true); // the same code still works
  });

  it('begin() throws for an account without a password', async () => {
    const booted = await boot();
    booted.users.rows.set(1, { user: ada, hash: null });
    const b = booted.browser();
    expect(await b.send('/login-as', { id: 1 })).toEqual({ result: 'signed-in' }); // signed in by the app, as such accounts are
    expect(await b.tf('begin')).toMatchObject({ thrown: expect.stringContaining('with a password') });
  });

  it('begin() throws where no source of factors is bound, and confirm() rolls back a state that does not report the factor', async () => {
    const unbound = await boot({}, { state: 'unbound' });
    const a = unbound.browser();
    await a.login();
    expect(await a.tf('begin')).toMatchObject({ thrown: expect.stringContaining('source of factors') });

    const deaf = await boot({}, { state: { factors: async () => [], enabledSince: async () => undefined } });
    const b = deaf.browser();
    await b.login();
    const setup = await b.tf('begin');
    expect(await b.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' })).toMatchObject({ thrown: expect.stringContaining('rolled back') });
    expect(await deaf.store.find(1)).toBeUndefined();
    expect(await deaf.store.remainingRecoveryCodes(1)).toBe(0);
  });
});

describe('TwoFactor: setting up, when it goes wrong', () => {
  it('a sign-in with the password between signing out and the commit is signed out again after it', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const setup = await b.tf('begin');
    const racer = booted.browser();
    const confirm = booted.store.confirm.bind(booted.store);
    vi.spyOn(booted.store, 'confirm').mockImplementation(async (...args) => {
      // The factor is not committed yet: this sign-in, with "remember me", reads "no factor" and is signed in.
      expect(await racer.login(ada.email, 'secret', true)).toEqual({ signedIn: true });
      expect(await racer.tf('who')).toEqual({ id: 1 });
      return confirm(...args);
    });
    expect((await b.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' })).ok).toBe(true);
    expect(await racer.tf('who')).toEqual({ id: null }); // the session
    expect(await booted.browser(new Map([['remember_web', racer.jar.get('remember_web')!]])).tf('who')).toEqual({ id: null }); // and the token
  });

  it('a sign-in that read "no factor" but finishes after the commit is taken back, token and cookie included', async () => {
    let reads = 0;
    const state: TwoFactorState = { factors: async () => (reads++ === 0 ? [] : ['totp']), enabledSince: async () => undefined };
    const booted = await boot({}, { state });
    const b = booted.browser();
    events.length = 0;
    expect(await b.login(ada.email, 'secret', true)).toMatchObject({ signedIn: false, error: { kind: 'two-factor-required', factors: ['totp'] } });
    expect(events.filter((event) => event instanceof Login)).toEqual([]); // no listener sees a sign-in that is taken back
    expect(await b.tf('who')).toEqual({ id: null });
    expect(b.jar.has('remember_web')).toBe(false);
    expect(await booted.application.container.make(RememberTokenStore).prune()).toBe(0);
    const rows = await booted.connections.get<any>().selectFrom('remember_tokens').select('id').execute();
    expect(rows).toEqual([]);
  });

  it('fails closed when the second read of the factors throws: nobody stays signed in, no cookie, no token', async () => {
    let reads = 0;
    const state: TwoFactorState = {
      factors: async () => {
        if (reads++ === 0) return [];
        throw new Error('the database went away');
      },
      enabledSince: async () => undefined,
    };
    const booted = await boot({}, { state });
    const b = booted.browser();
    await b.login(ada.email, 'secret', true); // answers 500
    expect(b.jar.has('remember_web')).toBe(false);
    expect(await b.tf('who')).toEqual({ id: null });
    expect(await booted.connections.get<any>().selectFrom('remember_tokens').select('id').execute()).toEqual([]);
  });

  it('fails closed when forgetting the token throws: nobody stays signed in, and the token signs nobody in', async () => {
    let reads = 0;
    const factorSince = new Date(Date.now() + 60_000); // the commit that the second read saw, later than the token
    const state: TwoFactorState = { factors: async () => (reads++ === 0 ? [] : ['totp']), enabledSince: async () => (reads > 1 ? factorSince : undefined) };
    const booted = await boot({}, { state });
    const tokens = booted.application.container.make(RememberTokenStore);
    let token: string | undefined;
    const create = tokens.create.bind(tokens);
    vi.spyOn(tokens, 'create').mockImplementation(async (...args) => (token = await create(...args)));
    vi.spyOn(tokens, 'forget').mockRejectedValue(new Error('the database went away'));
    const b = booted.browser();
    await b.login(ada.email, 'secret', true); // answers 500
    expect(b.jar.has('remember_web')).toBe(false);
    expect(await b.tf('who')).toEqual({ id: null });
    expect(token).toBeDefined();
    expect(await booted.browser(new Map([['remember_web', token!]])).tf('who')).toEqual({ id: null }); // refused by its date
  });

  it('logs and rethrows when the second sign-out after the commit fails — the factor stays on', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const setup = await b.tf('begin');
    const tokens = booted.application.container.make(RememberTokenStore);
    const forgetUser = tokens.forgetUser.bind(tokens);
    let calls = 0;
    vi.spyOn(tokens, 'forgetUser').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('the database went away');
      return forgetUser(...args);
    });
    expect(await b.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' })).toMatchObject({ thrown: 'the database went away' });
    expect(await booted.store.factors(1)).toEqual(['totp']);
  });

  it('login() takes a sign-in back the same way', async () => {
    let reads = 0;
    const state: TwoFactorState = { factors: async () => (reads++ === 0 ? [] : ['totp']), enabledSince: async () => undefined };
    const booted = await boot({}, { state });
    const b = booted.browser();
    events.length = 0;
    expect(await b.send('/login-as', { id: 1 })).toEqual({ result: 'two-factor-required' });
    expect(events.filter((event) => event instanceof Login)).toEqual([]);
    expect(await b.tf('who')).toEqual({ id: null });
  });

  it('ends the other devices\' remember-me tokens even when storing the confirmation fails afterwards', async () => {
    const booted = await boot();
    const otherDevice = booted.browser();
    await otherDevice.login(ada.email, 'secret', true);
    const thisDevice = booted.browser();
    await thisDevice.login();
    const setup = await thisDevice.tf('begin');
    vi.spyOn(booted.store, 'confirm').mockRejectedValue(new Error('the database went away'));
    expect(await thisDevice.tf('confirm', { code: twoFactorCode(setup.secret), password: 'secret' })).toMatchObject({ thrown: 'the database went away' });
    expect(await booted.browser(new Map([['remember_web', otherDevice.jar.get('remember_web')!]])).tf('who')).toEqual({ id: null });
  });

  it('checks the app name before storing anything', async () => {
    const booted = await boot({ APP_NAME: '' });
    const b = booted.browser();
    await b.login();
    expect(await b.tf('begin')).toMatchObject({ thrown: expect.stringContaining('APP_NAME') });
    expect(await b.tf('status')).toMatchObject({ settingUpTotp: false });
  });
});

describe('TwoFactor: the errors of confirm()', () => {
  it('names every kind', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const kinds = new Set<ConfirmError['kind']>(['not-started', 'invalid-password', 'invalid-code', 'throttled']);
    const kindOf = (error: ConfirmError): string => {
      switch (error.kind) {
        case 'not-started':
        case 'invalid-password':
        case 'invalid-code':
        case 'throttled':
          return error.kind;
        default:
          return error satisfies never;
      }
    };
    expect([...kinds].map((kind) => kindOf({ kind, retryAfter: 1 } as ConfirmError))).toEqual([...kinds]);
    expect(await b.tf('confirm', { code: '123456', password: 'secret' })).toMatchObject({ kind: 'not-started' });
  });
});

describe('TwoFactor: signing in', () => {
  it('a correct password then a code signs in, in a new session, with one Login event', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    const b = await waiting(booted);
    events.length = 0;
    expect(await b.tf('who')).toEqual({ id: null });
    expect(await b.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toEqual({ ok: true, id: 1 });
    expect(await b.tf('who')).toEqual({ id: 1 });
    expect(events.filter((event) => event instanceof Login)).toHaveLength(1);
  });

  it('answers no-challenge without a waiting sign-in', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    expect(await booted.browser().tf('challenge', { code: twoFactorCode(key) })).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('a wrong code counts down, tells the owner (event), and signs nobody in', async () => {
    const booted = await boot();
    await enable(booted);
    const b = await waiting(booted);
    events.length = 0;
    expect(await b.tf('challenge', { code: 'abcdef' })).toEqual({ ok: false, kind: 'invalid-code', attemptsLeft: 4 });
    expect(await b.tf('challenge', { code: '' })).toEqual({ ok: false, kind: 'invalid-code', attemptsLeft: 3 });
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed)).toHaveLength(2);
    expect(await b.tf('who')).toEqual({ id: null });
  });

  it('five wrong codes end the waiting sign-in: even the right code then finds nothing', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    const b = await waiting(booted);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await b.tf('challenge', { code: '000000' }));
    expect(results.map((r) => r.attemptsLeft)).toEqual([4, 3, 2, 1, 0]);
    expect(await b.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('throttles per account: the sixth try within a minute is refused before the code is looked at', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    for (let round = 0; round < 1; round++) {
      const b = await waiting(booted);
      for (let i = 0; i < 5; i++) await b.tf('challenge', { code: '000000' });
    }
    // The enabling confirm() counted too and was cleared with its success; five wrong codes used this minute's five.
    const again = await waiting(booted);
    const refused = await again.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) });
    expect(refused).toMatchObject({ ok: false, kind: 'throttled', retryAfter: expect.any(Number) });
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(await again.tf('who')).toEqual({ id: null });
  });

  it('throttles per account: the 21st try within an hour is refused, however spread out', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    const start = Date.now();
    for (let round = 0; round < 4; round++) {
      vi.useFakeTimers({ toFake: ['Date'], now: start + round * 61_000 });
      const b = await waiting(booted);
      // The confirmation that turned the factor on counted as the first try of the hour.
      for (let i = 0; i < (round === 3 ? 4 : 5); i++) expect(await b.tf('challenge', { code: '000000' })).toMatchObject({ kind: 'invalid-code' });
    }
    vi.useFakeTimers({ toFake: ['Date'], now: start + 4 * 61_000 });
    const b = await waiting(booted);
    expect(await b.tf('challenge', { code: twoFactorCode(key, new Date(start + 4 * 61_000 + 30_000)) })).toMatchObject({ ok: false, kind: 'throttled' });
  });

  it('a code works once — also for sign-ins waiting at the same moment', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    const browsers = await Promise.all([1, 2, 3, 4].map(() => waiting(booted)));
    const code = twoFactorCode(key, inSeconds(30));
    const results = await Promise.all(browsers.map((b) => b.tf('challenge', { code })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.kind === 'invalid-code')).toBe(true);
  });

  it('the code that confirmed the setup does not sign in afterwards, and no older code after a newer one', async () => {
    const booted = await boot();
    const b0 = booted.browser();
    await b0.login();
    const { secret: key } = await b0.tf('begin');
    await b0.tf('confirm', { code: twoFactorCode(key), password: 'secret' });
    const first = await waiting(booted);
    expect(await first.tf('challenge', { code: twoFactorCode(key) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await first.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toEqual({ ok: true, id: 1 });
    const second = await waiting(booted);
    expect(await second.tf('challenge', { code: twoFactorCode(key, inSeconds(-30)) })).toMatchObject({ ok: false, kind: 'invalid-code' });
  });

  it('a recovery code signs in once and tells how many are left; the second use is refused', async () => {
    const booted = await boot();
    const { recoveryCodes } = await enable(booted);
    const first = await waiting(booted);
    events.length = 0;
    expect(await first.tf('challenge', { recoveryCode: recoveryCodes[3]!.toLowerCase().replaceAll('-', ' ') })).toEqual({ ok: true, id: 1 });
    expect(events.find((event) => event instanceof RecoveryCodeUsed)).toMatchObject({ remaining: 9 });
    const second = await waiting(booted);
    expect(await second.tf('challenge', { recoveryCode: recoveryCodes[3] })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await second.tf('challenge', { recoveryCode: recoveryCodes[4] })).toEqual({ ok: true, id: 1 });
  });

  it('a password changed between password and factor ends the waiting sign-in — whatever is sent, nothing is used up', async () => {
    const booted = await boot();
    const { secret: key, recoveryCodes } = await enable(booted);
    const b = await waiting(booted);
    booted.users.rows.get(1)!.hash = await booted.application.container.make(Hasher).make('another');
    const stepAfterEnable = (await booted.store.find(1))?.lastUsedStep;
    events.length = 0;
    expect(await b.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toEqual({ ok: false, kind: 'expired' });
    expect(await b.tf('who')).toEqual({ id: null });
    const second = await waiting(booted, ada.email, 'another');
    booted.users.rows.get(1)!.hash = await booted.application.container.make(Hasher).make('a third');
    expect(await second.tf('challenge', { code: '000000' })).toEqual({ ok: false, kind: 'expired' }); // a wrong code too, and it is not counted as a failure
    const third = await waiting(booted, ada.email, 'a third');
    booted.users.rows.get(1)!.hash = await booted.application.container.make(Hasher).make('a fourth');
    expect(await third.tf('challenge', { recoveryCode: recoveryCodes[0] })).toEqual({ ok: false, kind: 'expired' });
    expect(await booted.store.remainingRecoveryCodes(1)).toBe(10); // the recovery code is still good
    expect(events.filter((event) => event instanceof TwoFactorChallengeFailed || event instanceof RecoveryCodeUsed)).toEqual([]);
    expect((await booted.store.find(1))?.lastUsedStep).toBe(stepAfterEnable); // the code sent above was not used
  });

  it('a factor turned off on another device while a sign-in waits: neither the code nor a recovery code from before works, and nobody is signed in', async () => {
    const booted = await boot();
    const { b: device, secret: key, recoveryCodes } = await enable(booted);
    const waitingDevice = await waiting(booted);
    expect(await device.tf('disable', { password: 'secret' })).toEqual({ disabled: true });
    expect(await waitingDevice.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await waitingDevice.tf('challenge', { recoveryCode: recoveryCodes[0] })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await waitingDevice.tf('who')).toEqual({ id: null });
  });

  it('a factor of one account never finishes the waiting sign-in of another', async () => {
    const booted = await boot();
    const ada2 = await enable(booted, ada.email);
    await enable(booted, bob.email);
    const b = await waiting(booted, bob.email);
    // Ada's code against Bob's waiting sign-in: it is checked against Bob's own secret and fails.
    expect(await b.tf('challenge', { code: twoFactorCode(ada2.secret, inSeconds(30)) })).toMatchObject({ ok: false, kind: 'invalid-code' });
  });

  it('a secret row copied to another account (another AAD) does not decrypt there', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    const db = booted.connections.get<{ [TWO_FACTOR_TABLE]: TwoFactorTable }>();
    const [row] = await db.selectFrom(TWO_FACTOR_TABLE).select((eb) => [secret(eb, 'secret')]).execute();
    await db.insertInto(TWO_FACTOR_TABLE).values({ user_id: 2, secret: row!.secret, confirmed_at: new Date(), last_used_step: null, created_at: new Date(), updated_at: new Date() }).execute();
    const b = await waiting(booted, bob.email);
    expect(await b.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toMatchObject({ ok: false, kind: 'invalid-code' });
  });

  it('recovery codes work when the secret cannot be decrypted', async () => {
    const booted = await boot();
    const { recoveryCodes } = await enable(booted);
    await booted.connections.get<any>().updateTable(TWO_FACTOR_TABLE).set({ secret: 'garbage' }).execute();
    const b = await waiting(booted);
    expect(await b.tf('challenge', { code: '123456' })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await b.tf('challenge', { recoveryCode: recoveryCodes[0] })).toEqual({ ok: true, id: 1 });
  });

  it('a secret made with an earlier key still works and is encrypted with the current one afterwards', async () => {
    const oldKey = generateKey();
    const newKey = generateKey();
    const booted = await boot({ APP_KEY: newKey, APP_PREVIOUS_KEYS: oldKey });
    const { secret: key } = await enable(booted);
    const decode = (k: string) => Buffer.from(k.replace('base64:', ''), 'base64');
    const old = new AesGcmEncrypter(decode(oldKey));
    const db = booted.connections.get<{ [TWO_FACTOR_TABLE]: TwoFactorTable }>();
    await db.updateTable(TWO_FACTOR_TABLE).set({ secret: await old.encrypt(key, 'marmeon-auth:two-factor:1'), last_used_step: null }).execute();
    const b = await waiting(booted);
    expect(await b.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toEqual({ ok: true, id: 1 });
    const [row] = await db.selectFrom(TWO_FACTOR_TABLE).select((eb) => [secret(eb, 'secret')]).execute();
    expect(await new AesGcmEncrypter(decode(newKey)).decrypt(row!.secret, 'marmeon-auth:two-factor:1')).toBe(key);
    await expect(old.decrypt(row!.secret, 'marmeon-auth:two-factor:1')).rejects.toThrow();
  });

  it('a sign-in held for the factor makes no remember-me token', async () => {
    const booted = await boot();
    await enable(booted);
    const b = booted.browser();
    await b.login(ada.email, 'secret', true);
    expect(b.jar.has('remember_web')).toBe(false);
  });
});

/** The cache key a counter of the package uses: the counter's name and the account. */
function counterKey(_booted: Booted, name: string, userId = 1) {
  return `${name}:${userId}`;
}

describe('TwoFactor: the budget of code attempts', () => {
  it('counts per account in three windows and clears only the minute counter on a success', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    const limiter = booted.application.container.make(RateLimiter);
    const b = await waiting(booted);
    await b.tf('challenge', { code: '000000' });
    expect(await limiter.attempts(await counterKey(booted, 'two-factor-day'))).toBe(2); // the confirmation counted too
    const c = await waiting(booted);
    expect(await c.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toEqual({ ok: true, id: 1 });
    expect(await limiter.attempts(await counterKey(booted, 'two-factor-minute'))).toBe(0);
    expect(await limiter.attempts(await counterKey(booted, 'two-factor-hour'))).toBeGreaterThan(0);
    expect(await limiter.attempts(await counterKey(booted, 'two-factor-day'))).toBeGreaterThan(0);
  });

  it('refuses a code once the day\'s fifty are used, while a recovery code still works', async () => {
    const booted = await boot();
    const { secret: key, recoveryCodes } = await enable(booted);
    const limiter = booted.application.container.make(RateLimiter);
    for (let i = 0; i < 50; i++) await limiter.hit(await counterKey(booted, 'two-factor-day'), 86_400);
    const b = await waiting(booted);
    expect(await b.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toMatchObject({ ok: false, kind: 'throttled' });
    const c = await waiting(booted);
    expect(await c.tf('challenge', { recoveryCode: recoveryCodes[0] })).toEqual({ ok: true, id: 1 });
  });

  it('a password reset gives no fresh code attempts', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    const limiter = booted.application.container.make(RateLimiter);
    for (let i = 0; i < 60; i++) await limiter.hit(await counterKey(booted, 'two-factor-day'), 86_400);
    booted.users.rows.get(1)!.hash = await booted.application.container.make(Hasher).make('another'); // whoever took the mailbox resets the password
    const b = await waiting(booted, ada.email, 'another');
    expect(await b.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toMatchObject({ ok: false, kind: 'throttled' });
  });

  it('limits recovery code attempts to ten a minute, on a counter of their own', async () => {
    const booted = await boot();
    await enable(booted);
    const limiter = booted.application.container.make(RateLimiter);
    for (let i = 0; i < 10; i++) await limiter.hit(await counterKey(booted, 'two-factor-recovery'), 60);
    const b = await waiting(booted);
    expect(await b.tf('challenge', { recoveryCode: 'AAAA-AAAA-AAAA-AAAA' })).toMatchObject({ ok: false, kind: 'throttled' });
    expect(await b.tf('challenge', { code: '000000' })).toMatchObject({ ok: false, kind: 'invalid-code' }); // the code counter is separate
  });
});

describe('TwoFactor: turning off', () => {
  it('a wrong password changes nothing; the right one turns the factor and the recovery codes off', async () => {
    const booted = await boot();
    const { b } = await enable(booted);
    events.length = 0;
    expect(await b.tf('disable', { password: 'wrong' })).toEqual({ disabled: false });
    expect(await b.tf('status')).toEqual({ factors: ['totp'], settingUpTotp: false, recoveryCodesLeft: 10 });
    expect(await b.tf('disable', { password: 'secret' })).toEqual({ disabled: true });
    expect(await b.tf('status')).toEqual({ factors: [], settingUpTotp: false, recoveryCodesLeft: 0 });
    expect(events.find((event) => event instanceof TwoFactorDisabled)).toMatchObject({ via: 'user' });
    expect(await booted.browser().login()).toEqual({ signedIn: true });
  });

  it('with the right password it removes an unfinished setup and answers true', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    await b.tf('begin');
    events.length = 0;
    expect(await b.tf('disable', { password: 'wrong' })).toEqual({ disabled: false });
    expect(await b.tf('status')).toMatchObject({ settingUpTotp: true });
    expect(await b.tf('disable', { password: 'secret' })).toEqual({ disabled: true });
    expect(await b.tf('status')).toEqual({ factors: [], settingUpTotp: false, recoveryCodesLeft: 0 });
    expect(events.some((event) => event instanceof TwoFactorDisabled)).toBe(false); // nothing was in force
  });

  it('needs a signed-in user', async () => {
    const booted = await boot();
    expect(await booted.browser().tf('disable', { password: 'secret' })).toMatchObject({ thrown: expect.stringContaining('signed-in user') });
  });
});

describe('TwoFactor: rows', () => {
  it('keeps recovery codes only as hashes', async () => {
    const booted = await boot();
    const { recoveryCodes } = await enable(booted);
    const rows = await booted.connections.get<{ [RECOVERY_CODES_TABLE]: RecoveryCodeTable }>().selectFrom(RECOVERY_CODES_TABLE).select((eb) => [secret(eb, 'code_hash')]).execute();
    expect(rows).toHaveLength(10);
    for (const code of recoveryCodes) expect(JSON.stringify(rows)).not.toContain(code.replaceAll('-', ''));
  });
});

describe('twoFactor() middleware', () => {
  const KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

  /** Gives the account a confirmed authenticator behind the back of its open sessions, so that they hold a factor they never proved. */
  async function addFactorQuietly(booted: Booted, id = 1) {
    const encrypted = await booted.application.container.make(Encrypter).encrypt(KEY, `marmeon-auth:two-factor:${id}`);
    await booted.store.startSetup(id, encrypted);
    expect(await booted.store.confirm(id, 0, encrypted, null)).toBe(true);
  }

  it('sends a user without a factor to set one up; JSON gets 403 two_factor_required', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    expect(await b.visit('/area')).toMatchObject({ status: 302, location: '/account/two-factor' });
    expect(await b.visit('/area', { json: true })).toMatchObject({ status: 403, body: { error: 'two_factor_required' } });
    expect(await b.send('/area')).toEqual({ error: 'two_factor_required' }); // a POST is refused the same way
  });

  it('sends a session that has not proven the factor to verify; JSON gets 403 two_factor_unverified', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    await addFactorQuietly(booted);
    expect(await b.visit('/area')).toMatchObject({ status: 302, location: '/account/verify' });
    expect(await b.visit('/area', { json: true })).toMatchObject({ status: 403, body: { error: 'two_factor_unverified' } });
    expect(await b.send('/area')).toEqual({ error: 'two_factor_unverified' });
    // Typing the password again (sudo mode) proves nothing about the second factor.
    expect(await b.tf('confirm-password', { password: 'secret' })).toEqual({ confirmed: true });
    expect(await b.visit('/area')).toMatchObject({ status: 302, location: '/account/verify' });
  });

  it('lets a session through once stepUp() accepts a code — in a new session id — and refuses a wrong one meanwhile', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    const again = booted.browser();
    await again.login();
    await addFactorQuietly(booted);
    const before = b.jar.get('marmeon_session');
    expect(await b.tf('step-up', { code: '000000' })).toEqual({ ok: false, kind: 'invalid-code', attemptsLeft: 4 });
    expect(events.find((event) => event instanceof TwoFactorChallengeFailed)).toMatchObject({ during: 'step-up' });
    expect(await b.visit('/area')).toMatchObject({ status: 302, location: '/account/verify' }); // a wrong code proves nothing, and the session survives it
    expect(await b.tf('step-up', { code: twoFactorCode(KEY) })).toEqual({ ok: true });
    expect(b.jar.get('marmeon_session')).not.toBe(before);
    expect(await b.visit('/area')).toMatchObject({ status: 200, body: { page: true } });
    // The code was used up: it proves nothing again, in another session either.
    expect(await again.tf('step-up', { code: twoFactorCode(KEY) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await again.visit('/area')).toMatchObject({ status: 302, location: '/account/verify' });
  });

  it('stepUp() takes a recovery code, throttles like a challenge, and has nothing to prove without a factor', async () => {
    const booted = await boot();
    const { b, recoveryCodes } = await enable(booted);
    const fresh = booted.browser();
    await fresh.login(); // only a waiting sign-in: nobody is signed in, so there is no one to step up
    expect(await fresh.tf('step-up', { code: '123456' })).toMatchObject({ thrown: expect.stringContaining('signed-in user') });
    for (let i = 0; i < 5; i++) await b.tf('step-up', { code: '000000' });
    expect(await b.tf('step-up', { code: '000000' })).toMatchObject({ ok: false, kind: 'throttled' });
    expect(await b.tf('step-up', { recoveryCode: recoveryCodes[0] })).toEqual({ ok: true });
    expect(await b.tf('step-up', { recoveryCode: recoveryCodes[0] })).toMatchObject({ ok: false, kind: 'invalid-code' }); // spent

    const plain = booted.browser();
    await plain.login(bob.email);
    expect(await plain.tf('step-up', { code: '123456' })).toEqual({ ok: false, kind: 'no-challenge' });
  });

  it('asks again after maxAge', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const booted = await boot();
    const { b, secret: key } = await enable(booted);
    expect(await b.visit('/area-fresh')).toMatchObject({ status: 200 }); // enabling counts as a proof
    vi.setSystemTime(inSeconds(59));
    expect(await b.visit('/area-fresh')).toMatchObject({ status: 200 });
    vi.setSystemTime(inSeconds(61));
    expect(await b.visit('/area-fresh')).toMatchObject({ status: 302, location: '/account/verify' });
    expect(await b.visit('/area')).toMatchObject({ status: 200 }); // an area without maxAge keeps the proof for the session
    expect(await b.tf('step-up', { code: twoFactorCode(key, new Date(Date.now() + 30_000)) })).toEqual({ ok: true });
    expect(await b.visit('/area-fresh')).toMatchObject({ status: 200 });
  });

  it('lets a sign-in with the factor through, also one made with a remember-me cookie', async () => {
    const booted = await boot();
    const { secret: key } = await enable(booted);
    const login = booted.browser();
    expect(await login.login(ada.email, 'secret', true)).toMatchObject({ signedIn: false });
    expect(await login.visit('/area', { json: true })).toMatchObject({ status: 401 }); // waiting for the factor is no sign-in
    expect(await login.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) })).toMatchObject({ ok: true });
    expect(await login.visit('/area')).toMatchObject({ status: 200 });
    const returning = booted.browser(new Map([['remember_web', login.jar.get('remember_web')!]]));
    expect(await returning.visit('/area')).toMatchObject({ status: 200 });
  });

  it('a remember-me sign-in does not satisfy maxAge: the proof is as old as the token', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const booted = await boot();
    const { secret: key } = await enable(booted);
    vi.setSystemTime(inSeconds(1)); // the clock is frozen: a token made in the very instant the factor was confirmed is refused
    const login = booted.browser();
    await login.login(ada.email, 'secret', true);
    await login.tf('challenge', { code: twoFactorCode(key, inSeconds(30)) });
    vi.setSystemTime(inSeconds(61));
    const stolen = booted.browser(new Map([['remember_web', login.jar.get('remember_web')!]]));
    expect(await stolen.visit('/area-fresh')).toMatchObject({ status: 302, location: '/account/verify' });
    expect(await stolen.visit('/area')).toMatchObject({ status: 200 }); // without maxAge a remember-me sign-in goes through
    // Rotation of the cookie keeps the age of the proof.
    const again = booted.browser(new Map([['remember_web', stolen.jar.get('remember_web') ?? login.jar.get('remember_web')!]]));
    expect(await again.visit('/area-fresh')).toMatchObject({ status: 302, location: '/account/verify' });
  });

  it.each([
    ['a string', '1700000000'],
    ['null', null],
    ['a time in the future', Math.floor(Date.now() / 1000) + 60],
  ])('refuses a proof that is %s', async (_name, value) => {
    const booted = await boot();
    const b = booted.browser();
    await b.login();
    await addFactorQuietly(booted);
    await b.send('/set-proof', { value });
    expect(await b.visit('/area')).toMatchObject({ status: 302, location: '/account/verify' });
    expect(await b.visit('/area', { json: true })).toMatchObject({ status: 403, body: { error: 'two_factor_unverified' } });
  });

  it('answers a request without a user with 401 or the login page, never a pass — a bearer token included', async () => {
    const booted = await boot();
    const guest = booted.browser();
    expect(await guest.visit('/area-bare', { json: true })).toMatchObject({ status: 401 });
    expect(await guest.visit('/area-bare')).toMatchObject({ status: 302, location: '/login' });
    expect(await guest.visit('/area-bare', { json: true, headers: { authorization: 'Bearer not-a-session' } })).toMatchObject({ status: 401 });
    const b = booted.browser();
    await b.login();
    await addFactorQuietly(booted);
    expect(await b.visit('/area-bare', { json: true })).toMatchObject({ status: 403, body: { error: 'two_factor_unverified' } });
  });

  it('actingAs() sessions carry the proof only for an account that has a factor', async () => {
    const booted = await boot();
    expect(await authenticatedSession(booted.application.container, ada)).not.toHaveProperty('_auth_two_factor_at');
    await addFactorQuietly(booted);
    expect(await authenticatedSession(booted.application.container, ada)).toHaveProperty('_auth_two_factor_at');
    expect(await authenticatedSession(booted.application.container, bob)).not.toHaveProperty('_auth_two_factor_at');
  });

  it('takes only a positive maxAge', () => {
    for (const maxAge of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => twoFactor({ setup: 'a', verify: 'b', maxAge })).toThrow('seconds above zero');
  });

  it('is installed nowhere by the framework: neither the package nor its starter kit mention it outside docs and tests', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.type-test\./.test(name)) files.push(path);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'stubs'));
    const users = files.filter((file) => /\btwoFactor\(\s*\{/.test(readFileSync(file, 'utf8')));
    expect(users.map((file) => file.slice(root.length))).toEqual(['src/two-factor/middleware.ts']);
  });
});
