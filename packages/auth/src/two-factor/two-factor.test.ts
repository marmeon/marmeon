import { createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider, Migrator, secret } from '@marmeon/database';
import { AesGcmEncrypter, Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, defineRoutes, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth, AuthServiceProvider, Hasher, Login, RecoveryCodesGenerated, RecoveryCodeUsed, RememberTokenStore, TwoFactorChallengeFailed, TwoFactorDisabled, TwoFactorEnabled, TwoFactorState, TwoFactorStore, UserProvider, twoFactorCode, type Credentials, type PasswordHash } from '../index.ts';
import { TWO_FACTOR_TABLE, RECOVERY_CODES_TABLE, type RecoveryCodeTable, type TwoFactorTable } from './store.ts';
import { TwoFactor } from './two-factor.ts';

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
          const done = await this.#twoFactor.confirm(body.code);
          return done.ok ? { ok: true, ...done.value } : { ok: false, ...done.error };
        }
        case 'begin':
          return await this.#twoFactor.begin();
        case 'setup':
          return (await this.#twoFactor.setup()) ?? null;
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

const routes = defineRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.post('/tf/:method', TwoFactorController);
});

const ada: TestUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const bob: TestUser = { id: 2, name: 'Bob', email: 'bob@example.com' };
const CHEAP = { HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' };

async function boot(env: Record<string, string> = {}) {
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
      container.bind(TwoFactorState, TwoFactorStore);
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
    const tf = (method: string, json: unknown = {}) => send(`/tf/${method}`, json);
    const login = (email = ada.email, password = 'secret', remember = false) => send('/login', { email, password, remember });
    return { send, tf, login, jar };
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
  const confirmed = await b.tf('confirm', { code: twoFactorCode(setup.secret) });
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
    expect(await b.tf('confirm', { code: '123456' })).toEqual({ ok: false, kind: 'not-started' });
    const { secret: key } = await b.tf('begin');
    const wrong = twoFactorCode(key) === '000000' ? '111111' : '000000';
    expect(await b.tf('confirm', { code: wrong })).toEqual({ ok: false, kind: 'invalid-code' });
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
    await thisDevice.tf('confirm', { code: twoFactorCode(setup.secret) });
    const cookie = (b: Browser) => new Map([['remember_web', b.jar.get('remember_web')!]]);
    // The other device comes back with only its remember-me cookie: it signs nobody in.
    expect(await booted.browser(cookie(otherDevice)).tf('who')).toEqual({ id: null });
    // This device keeps its token.
    expect(await booted.browser(cookie(thisDevice)).tf('who')).toEqual({ id: 1 });
    expect(await booted.application.container.make(RememberTokenStore).prune()).toBe(0);
  });
});

describe('TwoFactor: setting up, when it goes wrong', () => {
  it('ends the other devices\' remember-me tokens even when storing the confirmation fails afterwards', async () => {
    const booted = await boot();
    const otherDevice = booted.browser();
    await otherDevice.login(ada.email, 'secret', true);
    const thisDevice = booted.browser();
    await thisDevice.login();
    const setup = await thisDevice.tf('begin');
    vi.spyOn(booted.store, 'confirm').mockRejectedValue(new Error('the database went away'));
    expect(await thisDevice.tf('confirm', { code: twoFactorCode(setup.secret) })).toMatchObject({ thrown: 'the database went away' });
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
      for (let i = 0; i < 5; i++) expect(await b.tf('challenge', { code: '000000' })).toMatchObject({ kind: 'invalid-code' });
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
    await b0.tf('confirm', { code: twoFactorCode(key) });
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
