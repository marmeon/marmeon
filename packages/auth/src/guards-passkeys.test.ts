import { CacheServiceProvider, RateLimiter } from '@marmeon/cache';
import { Clock, Container, createApplication, defineModule, Logger, type ServiceProvider } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider, SessionStore, sessionKey } from '@marmeon/session';
import { Encrypter } from '@marmeon/encryption';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineGuard, type GuardAuth, type GuardPasskeys, type GuardTwoFactor } from './define-guard.ts';
import { AUTH_SESSION_KEYS } from './auth.ts';
import { Auth, AuthServiceProvider, authenticate, combineFactors, confirmedPassword, Hasher, TwoFactorState, TwoFactorStore, UserProvider, type AuthUser } from './index.ts';
import { GUARD_FEATURE, GUARD_PASSKEYS } from './guard-context.ts';
import { guardNames } from './guard-names.ts';
import { PasskeyConfig, PasskeyServiceProvider, PasskeyStore } from './passkeys/index.ts';
import { Passkeys } from './passkeys/passkeys.ts';
import { softAuthenticator, twoFactorCode } from './testing.ts';
import { TwoFactor } from './two-factor/two-factor.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

interface OfficeUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

const ORIGIN = 'http://localhost:3000';

// The same id 1 and address in both tables: only the guard tells the accounts apart.
const app = new MemoryUsers<AuthUser>();
const office = new MemoryUsers<OfficeUser>();

class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return office;
  }
}

const OfficeGuard = defineGuard('office', {
  users: OfficeUsers,
  tablePrefix: 'office_',
  twoFactor: TwoFactor,
  passkeys: Passkeys,
  settings: { loginAttemptsPerMinute: 60, accountSignInsPerDay: 1000, twoFactorIssuer: 'Back Office' },
});
type OfficeAuth = GuardAuth<OfficeUser>;
const OfficeAuth = OfficeGuard.Auth;
type OfficeTwoFactor = GuardTwoFactor<OfficeUser>;
const OfficeTwoFactor = OfficeGuard.TwoFactor;
type OfficePasskeys = GuardPasskeys<OfficeUser, Passkeys>;
const OfficePasskeys = OfficeGuard.Passkeys;

// The package's provider carries the relying party's configuration: the guard refuses to register without it.
class OfficeProvider implements ServiceProvider {
  static config = [PasskeyConfig];
  register(container: Container): void {
    OfficeGuard.register(container);
  }
}

type Services = { auth: GuardAuth<{ readonly id: number }>; factor: GuardTwoFactor<{ readonly id: number }>; passkeys: GuardPasskeys<{ readonly id: number }, Passkeys> };

const answer = (done: { ok: boolean; value?: unknown; error?: unknown }): Record<string, unknown> => (done.ok ? { ok: true, value: done.value } : { ok: false, ...(done.error as object) });

/** One action of a guard's services, named by the request: both guards run the same ones. */
async function act({ auth, factor, passkeys }: Services, ctx: HttpContext): Promise<unknown> {
  const body = (await ctx.input()) as Record<string, any>;
  switch (ctx.request.headers.get('x-action')) {
    case 'login': {
      const done = await auth.attempt('ada@example.com', 'secret');
      return done.ok ? { ok: true } : { ok: false, kind: done.error.kind };
    }
    case 'who':
      return { id: (await auth.user())?.id ?? null };
    case 'begin':
      return { secret: (await factor.begin()).secret };
    case 'confirm-totp':
      return answer(await factor.confirm(body.code, 'secret'));
    case 'options':
      return passkeys.registrationOptions();
    case 'register':
      return answer(await passkeys.register(body.response, body.name ?? 'Laptop', 'secret'));
    case 'sign-in-options':
      return passkeys.signInOptions();
    case 'sign-in': {
      const done = await passkeys.signIn(body.response);
      return done.ok ? { ok: true, id: done.value.id } : { ok: false, ...done.error };
    }
    case 'challenge-options':
      return answer(await passkeys.challengeOptions());
    case 'challenge': {
      const done = await factor.challenge(body as never);
      return done.ok ? { ok: true, id: done.value.id } : { ok: false, ...done.error };
    }
    case 'step-up-options':
      return answer(await passkeys.stepUpOptions());
    case 'step-up':
      return answer(await factor.stepUp(body as never));
    case 'confirm-options':
      return answer(await passkeys.confirmOptions());
    case 'confirm':
      return answer(await passkeys.confirm(body.response));
    case 'list':
      return passkeys.list();
    case 'remove':
      return answer(await passkeys.remove(body.id, 'secret'));
    case 'status':
      return { ...(await factor.status()) };
    default:
      return { error: 'unknown' };
  }
}

class AppAct extends Controller {
  readonly #services: Services;
  constructor(auth: Auth, factor: TwoFactor, passkeys: Passkeys) {
    super();
    this.#services = { auth, factor, passkeys } as never;
  }
  handle(ctx: HttpContext) {
    return act(this.#services, ctx);
  }
}

// The alias and the constant of the same name: the injection reads the type's name and finds the guard's token.
class OfficeAct extends Controller {
  readonly #services: Services;
  constructor(auth: OfficeAuth, factor: OfficeTwoFactor, passkeys: OfficePasskeys) {
    super();
    this.#services = { auth, factor, passkeys };
  }
  handle(ctx: HttpContext) {
    return act(this.#services, ctx);
  }
}

const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;

const routes = openRoutes((Route) => {
  Route.post('/app', AppAct);
  Route.post('/office', OfficeAct);
  for (const [path, name] of [['/login', 'auth.login'], ['/office-login', 'office.login'], ['/office-home', 'office.home'], ['/office-confirm', 'office.confirm']] as const) {
    Route.get(path, () => name).name(name);
  }
  Route.middleware(authenticate()).middleware(confirmedPassword()).get('/r/app-sudo', () => 'app sudo');
  // The guard's own `authenticate()` first: what the confirmation reads is the guard's user.
  Route.middleware(OfficeGuard.authenticate(OFFICE)).middleware(OfficeGuard.confirmedPassword(OFFICE)).get('/r/office-sudo', () => 'office sudo');
  // A guest of the guard has no `authenticate()` to run: the confirmation fails closed, error A9.
  Route.middleware(OfficeGuard.guest(OFFICE)).middleware(OfficeGuard.confirmedPassword(OFFICE) as never).get('/r/office-guest-sudo', () => 'no user');
});

type Who = 'app' | 'office';

async function boot(options: { appPasskeys?: boolean } = {}) {
  const appPasskeys = options.appPasskeys !== false;
  const failures: string[] = [];
  const logger: Logger = { debug() {}, info() {}, warn() {}, error: (message, context) => void failures.push(`${message} ${JSON.stringify(context)}`), child: () => logger } as Logger;
  app.rows.clear();
  office.rows.clear();
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-guards-passkeys-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, OfficeProvider, AuthServiceProvider, ...(appPasskeys ? [PasskeyServiceProvider] : [])],
      modules: [
        defineModule({ name: 'guards-passkeys-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'office-test', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), APP_NAME: 'Acme', APP_URL: ORIGIN, SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(Logger, logger);
        container.instance(UserProvider, app as unknown as UserProvider);
        container.singleton(TwoFactorState, (c) => (appPasskeys ? combineFactors(c.make(TwoFactorStore), c.make(PasskeyStore)) : combineFactors(c.make(TwoFactorStore))));
        container.scoped(TwoFactor);
      },
    },
  );
  await application.container.make(Migrator).migrate();
  const hash = await application.container.make(Hasher).make('secret');
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  const kernel = createHttpKernel(application);
  const db = application.container.make(Connections).get<any>() as any;

  const browser = () => {
    const jar = new Map<string, string>();
    const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, {
        method,
        headers: { cookie, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Test Browser', ...headers },
        redirect: 'manual',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const send = async (who: Who, action: string, body: unknown = {}) => (await (await call('POST', `/${who}`, { 'x-action': action }, body)).json()) as Record<string, any>;
    const sessionKeyOf = async () => sessionKey(await application.container.make(Encrypter).decrypt(decodeURIComponent(jar.get('marmeon_session')!), 'cookie:marmeon_session'));
    /** Changes what the session stores, as a request of another time would have left it. */
    const edit = async (change: (data: Record<string, unknown>) => void) => {
      const store = application.container.make(SessionStore);
      const key = await sessionKeyOf();
      const read = (await store.read(key))!;
      const data = JSON.parse(read.data) as Record<string, unknown>;
      change(data);
      await store.write(key, JSON.stringify(data), { expectedVersion: read.version, lifetimeSeconds: 7200 });
    };
    return { call, send, edit };
  };
  type Browser = ReturnType<typeof browser>;

  /** Signs `who`'s user 1 in and registers `device` as its first passkey, as a settings page would. */
  const enroll = async (who: Who, device: Device, name = 'Laptop') => {
    const b = browser();
    expect(await b.send(who, 'login')).toEqual({ ok: true });
    const registered = await register(b, who, device, name);
    return { b, ...registered };
  };
  const register = async (b: Browser, who: Who, device: Device, name = 'Laptop') => {
    const options = await b.send(who, 'options');
    expect(options.challenge, JSON.stringify(options)).toBeTypeOf('string');
    const done = await b.send(who, 'register', { response: device.register(options as never), name });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    return { options, recoveryCodes: done.value.recoveryCodes as string[] | null };
  };
  /** A fresh browser that signs in to `who` with `device`, passwordless. */
  const passkeySignIn = async (who: Who, device: Device, overrides: object = {}) => {
    const b = browser();
    const options = await b.send(who, 'sign-in-options');
    const result = await b.send(who, 'sign-in', { response: device.authenticate(options as never, overrides) });
    return { b, result };
  };

  const limiter = application.container.make(RateLimiter);
  return { application, browser, enroll, register, passkeySignIn, db, limiter, failures };
}

type Device = ReturnType<typeof softAuthenticator>;
const device = () => softAuthenticator({ origin: ORIGIN, rpId: 'localhost' });

/** The route fails with error A9: a 500 on its own could be any bug. */
async function expectA9(b: { call(method: string, path: string): Promise<Response> }, failures: string[], path: string): Promise<void> {
  const before = failures.length;
  expect((await b.call('GET', path)).status, path).toBe(500);
  expect(failures.slice(before).join('\n'), path).toContain('A9');
}

// The clock stands still, five seconds into a 30-second code step: a code made "now" and one made "now + 30 s" are always neighbouring steps.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: Math.floor(Date.now() / 30_000) * 30_000 + 5_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000);

describe('passkeys of a package guard', () => {
  it('signs the guard\'s user 1 in with its passkey, and the same response at the app finds no passkey and signs nobody in', async () => {
    const booted = await boot();
    const officeDevice = device();
    await booted.enroll('office', officeDevice);
    const appDevice = device();
    await booted.enroll('app', appDevice);

    const atOffice = await booted.passkeySignIn('office', officeDevice);
    expect(atOffice.result).toEqual({ ok: true, id: 1 });
    expect(await atOffice.b.send('office', 'who')).toEqual({ id: 1 });

    // The office's response, signed for the app's own options: the app's table has no such passkey.
    const appBrowser = booted.browser();
    const options = await appBrowser.send('app', 'sign-in-options');
    expect(await appBrowser.send('app', 'sign-in', { response: officeDevice.authenticate(options as never) })).toEqual({ ok: false, kind: 'invalid' });
    expect(await appBrowser.send('app', 'who'), 'the app\'s user 1 is not signed in').toEqual({ id: null });

    // And the other way round: the app's passkey is none of the office's.
    const officeBrowser = booted.browser();
    const officeOptions = await officeBrowser.send('office', 'sign-in-options');
    expect(await officeBrowser.send('office', 'sign-in', { response: appDevice.authenticate(officeOptions as never) })).toEqual({ ok: false, kind: 'invalid' });
    expect(await officeBrowser.send('office', 'who')).toEqual({ id: null });
  });

  it('keeps its passkeys on the guard\'s table: the app\'s stays empty, and the guard\'s own recovery codes are made', async () => {
    const booted = await boot();
    const { recoveryCodes } = await booted.enroll('office', device());
    expect(recoveryCodes).toHaveLength(10);
    expect(await booted.db.selectFrom('office_passkeys').select('user_id').execute()).toHaveLength(1);
    expect(await booted.db.selectFrom('office_two_factor_recovery_codes').select('user_id').execute()).toHaveLength(10);
    expect(await booted.db.selectFrom('passkeys').select('user_id').execute()).toHaveLength(0);
    expect(await booted.db.selectFrom('two_factor_recovery_codes').select('user_id').execute()).toHaveLength(0);
  });

  it('opens its challenge under a key of its own: options fetched at the app\'s endpoint do not serve the guard\'s sign-in, nor the other way round', async () => {
    const booted = await boot();
    const officeDevice = device();
    await booted.enroll('office', officeDevice);
    const appDevice = device();
    await booted.enroll('app', appDevice);

    const fromApp = booted.browser();
    const appOptions = await fromApp.send('app', 'sign-in-options');
    // A response that would be valid at the guard for the challenge the app issued — only the guard's challenge is looked for.
    expect(await fromApp.send('office', 'sign-in', { response: officeDevice.authenticate(appOptions as never) })).toEqual({ ok: false, kind: 'no-challenge' });
    expect(await fromApp.send('office', 'who')).toEqual({ id: null });

    const fromOffice = booted.browser();
    const officeOptions = await fromOffice.send('office', 'sign-in-options');
    expect(await fromOffice.send('app', 'sign-in', { response: appDevice.authenticate(officeOptions as never) })).toEqual({ ok: false, kind: 'no-challenge' });
    expect(await fromOffice.send('app', 'who')).toEqual({ id: null });

    // Both ceremonies side by side in one session: each finds its own.
    const both = booted.browser();
    const first = await both.send('app', 'sign-in-options');
    const second = await both.send('office', 'sign-in-options');
    expect(await both.send('office', 'sign-in', { response: officeDevice.authenticate(second as never) })).toEqual({ ok: true, id: 1 });
    expect(await both.send('app', 'sign-in', { response: appDevice.authenticate(first as never) })).toEqual({ ok: true, id: 1 });
  });

  it('names the app as the relying party, and the guard\'s issuer stays the authenticator\'s: the passkey dialog reads appName', async () => {
    const booted = await boot();
    const b = booted.browser();
    await b.send('office', 'login');
    const options = await b.send('office', 'options');
    expect(options.rp).toEqual({ id: 'localhost', name: 'Acme' });
    const a = booted.browser();
    await a.send('app', 'login');
    expect((await a.send('app', 'options')).rp).toEqual({ id: 'localhost', name: 'Acme' });
    const begun = booted.browser();
    await begun.send('office', 'login');
    expect(await begun.send('office', 'begin')).toMatchObject({ secret: expect.any(String) });
  });

  it('is a second factor next to the authenticator: either proves the sign-in of the guard\'s user, and the app\'s user 1 is not asked', async () => {
    const booted = await boot();
    const officeDevice = device();
    const b = booted.browser();
    expect(await b.send('office', 'login')).toEqual({ ok: true });
    const { secret } = await b.send('office', 'begin');
    const confirmed = await b.send('office', 'confirm-totp', { code: twoFactorCode(secret) });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    // The proof of the authenticator just given lets this session add the passkey.
    const { recoveryCodes } = await booted.register(b, 'office', officeDevice);
    expect(recoveryCodes, 'the account has its recovery codes already').toBeNull();
    expect((await b.send('office', 'status')).factors).toEqual(expect.arrayContaining(['totp', 'passkey']));

    // With the passkey.
    const byPasskey = booted.browser();
    expect(await byPasskey.send('office', 'login')).toEqual({ ok: false, kind: 'two-factor-required' });
    expect(await byPasskey.send('office', 'who')).toEqual({ id: null });
    const challenge = await byPasskey.send('office', 'challenge-options');
    expect(challenge.ok, JSON.stringify(challenge)).toBe(true);
    expect(await byPasskey.send('office', 'challenge', { passkey: officeDevice.authenticate(challenge.value as never) })).toEqual({ ok: true, id: 1 });
    expect(await byPasskey.send('office', 'who')).toEqual({ id: 1 });

    // With the code of a later step.
    const byCode = booted.browser();
    expect(await byCode.send('office', 'login')).toEqual({ ok: false, kind: 'two-factor-required' });
    expect(await byCode.send('office', 'challenge', { code: twoFactorCode(secret, inSeconds(30)) })).toMatchObject({ ok: true });

    // The app's user 1 has no factor of its own: the guard's passkey asks nothing of it.
    const appUser = booted.browser();
    expect(await appUser.send('app', 'login')).toEqual({ ok: true });
  });

  it('does not take a passkey of the guard as the second factor of the app\'s sign-in', async () => {
    const booted = await boot();
    const officeDevice = device();
    await booted.enroll('office', officeDevice);
    const appDevice = device();
    const enrolled = await booted.enroll('app', appDevice);
    expect(enrolled.recoveryCodes).toHaveLength(10);

    const waiting = booted.browser();
    expect(await waiting.send('app', 'login')).toEqual({ ok: false, kind: 'two-factor-required' });
    const options = await waiting.send('app', 'challenge-options');
    // The app's options allow its own passkeys only; the response is made for them nonetheless, as a client that ignores the list would.
    expect(await waiting.send('app', 'challenge', { passkey: officeDevice.authenticate({ ...options.value, allowCredentials: [] } as never) })).toMatchObject({ ok: false, kind: 'invalid-code' });
    expect(await waiting.send('app', 'who')).toEqual({ id: null });
  });

  it('opens the sudo window of the guard with a passkey, and the app\'s window stays shut', async () => {
    const booted = await boot();
    const officeDevice = device();
    await booted.enroll('office', officeDevice);

    // One browser signed in to both guards: the office by passkey, the app's user 1 (no factor) by password.
    const both = (await booted.passkeySignIn('office', officeDevice)).b;
    expect(await both.send('app', 'login')).toEqual({ ok: true });
    expect(await both.send('app', 'who')).toEqual({ id: 1 });

    // Both windows have run out.
    await both.edit((data) => {
      delete data[guardNames('office').session.confirmedAt];
      delete data[AUTH_SESSION_KEYS.confirmedAt];
    });
    expect((await both.call('GET', '/r/office-sudo')).status).toBe(423);
    expect((await both.call('GET', '/r/app-sudo')).status).toBe(423);

    const options = await both.send('office', 'confirm-options');
    expect(options.ok, JSON.stringify(options)).toBe(true);
    expect(await both.send('office', 'confirm', { response: officeDevice.authenticate(options.value as never) })).toEqual({ ok: true });
    expect((await both.call('GET', '/r/office-sudo')).status).toBe(200);
    expect((await both.call('GET', '/r/app-sudo')).status, 'the guard\'s confirmation opens nothing of the app').toBe(423);
  });

  it('steps up with a passkey of the guard, and the same response starts no step-up of the app', async () => {
    const booted = await boot();
    const officeDevice = device();
    await booted.enroll('office', officeDevice);
    const { b } = await booted.passkeySignIn('office', officeDevice);
    const options = await b.send('office', 'step-up-options');
    expect(options.ok, JSON.stringify(options)).toBe(true);
    const response = officeDevice.authenticate(options.value as never);
    // Posted to the app in the same browser: the app has no open step-up and no user to step up.
    expect(await b.send('app', 'login')).toEqual({ ok: true });
    expect((await b.send('app', 'step-up', { passkey: response })).ok, 'the app\'s user has no passkey to step up with').not.toBe(true);
    // The app's attempt did not spend the guard's open challenge: the guard's step-up still has it.
    expect(await b.send('office', 'step-up', { passkey: response })).toMatchObject({ ok: true });
    expect(await b.send('app', 'who'), 'the app\'s user is its own').toEqual({ id: 1 });
  });

  it('asks the guard\'s own authenticate() before its sudo: a guest route fails closed (A9)', async () => {
    const booted = await boot();
    const officeDevice = device();
    await booted.enroll('office', officeDevice);
    const { b } = await booted.passkeySignIn('office', officeDevice);
    await expectA9(booted.browser(), booted.failures, '/r/office-guest-sudo');
    // Signed in at the guard, the guest route sends the user home before anything else runs.
    expect((await b.call('GET', '/r/office-guest-sudo')).status).toBe(302);
    expect((await b.call('GET', '/r/office-sudo')).status, 'a passkey sign-in is a fresh confirmation').toBe(200);
  });

  it('ends the sessions of the guard\'s user 1 only when its passkey looks copied: the app\'s user 1 stays signed in in another browser', async () => {
    const booted = await boot();
    const officeDevice = device();
    await booted.enroll('office', officeDevice);
    const signedIn = (await booted.passkeySignIn('office', officeDevice)).b;
    // One browser signed in to both: the end of the guard's sign-in ends the browser's session, so the app's user is out there too.
    const shared = (await booted.passkeySignIn('office', officeDevice)).b;
    expect(await shared.send('app', 'login')).toEqual({ ok: true });
    const appOnly = booted.browser();
    expect(await appOnly.send('app', 'login')).toEqual({ ok: true });
    expect(await signedIn.send('office', 'who')).toEqual({ id: 1 });

    // A counter that does not move forward: the copy.
    const copied = await booted.passkeySignIn('office', officeDevice, { signCount: 1 });
    expect(copied.result).toEqual({ ok: false, kind: 'clone-suspected' });
    expect((await booted.db.selectFrom('office_passkeys').select('suspended_at').execute())[0].suspended_at).not.toBeNull();

    expect(await signedIn.send('office', 'who'), 'the guard\'s sessions are over').toEqual({ id: null });
    expect(await appOnly.send('app', 'who'), 'the app\'s user 1 of another browser is signed in still').toEqual({ id: 1 });
    expect(await shared.send('office', 'who')).toEqual({ id: null });
    expect(await shared.send('app', 'who'), 'the guard ended the shared browser session').toEqual({ id: null });
  });

  it('counts a confirmation of the guard\'s user 1 apart from the app\'s user 1', async () => {
    const booted = await boot();
    const officeDevice = device();
    const office1 = await booted.enroll('office', officeDevice);
    const appDevice = device();
    const app1 = await booted.enroll('app', appDevice);
    const counts = async () => [await booted.limiter.attempts(guardNames('office').limiterKey('passkey-confirm:1')), await booted.limiter.attempts('passkey-confirm:1')];
    expect(await counts()).toEqual([0, 0]);

    // Ten answers without an open challenge use the guard's minute up.
    for (let i = 0; i < 10; i++) expect(await office1.b.send('office', 'confirm', { response: { id: 'x' } })).toMatchObject({ ok: false, kind: 'no-challenge' });
    expect(await office1.b.send('office', 'confirm', { response: { id: 'x' } })).toMatchObject({ ok: false, kind: 'throttled' });
    expect(await counts(), 'ten answers and the refused eleventh').toEqual([11, 0]);

    const options = await app1.b.send('app', 'confirm-options');
    expect(await app1.b.send('app', 'confirm', { response: appDevice.authenticate(options.value as never) }), 'the app\'s user 1 has all its attempts').toEqual({ ok: true });
  });

  it('takes the last passkey of the guard\'s user with the guard\'s recovery codes only', async () => {
    const booted = await boot();
    const { b } = await booted.enroll('office', device());
    await booted.enroll('app', device());
    const [mine] = (await b.send('office', 'list')) as unknown as { id: number }[];
    expect(await b.send('office', 'remove', { id: mine!.id })).toEqual({ ok: true });
    expect(await booted.db.selectFrom('office_passkeys').select('id').execute()).toHaveLength(0);
    expect(await booted.db.selectFrom('office_two_factor_recovery_codes').select('id').execute(), 'the guard\'s codes go with its last factor').toHaveLength(0);
    expect(await booted.db.selectFrom('passkeys').select('id').execute(), 'the app\'s passkey stays').toHaveLength(1);
    expect(await booted.db.selectFrom('two_factor_recovery_codes').select('id').execute(), 'the app\'s codes stay').toHaveLength(10);
  });

  it('works for a package whose app has not registered the passkey provider', async () => {
    const booted = await boot({ appPasskeys: false });
    const officeDevice = device();
    await booted.enroll('office', officeDevice);
    expect((await booted.passkeySignIn('office', officeDevice)).result).toEqual({ ok: true, id: 1 });
    expect(await booted.db.selectFrom('office_passkeys').select('id').execute()).toHaveLength(1);
  });
});

describe('defining a guard with passkeys', () => {
  it('refuses a passkeys option that is not the Passkeys class, and passkeys without two-factor authentication (A8)', () => {
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: class Other {} as unknown as typeof Passkeys })).toThrow(/\[marmeon:A8\].*passkeys/);
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: {} as unknown as typeof Passkeys })).toThrow(/\[marmeon:A8\].*passkeys/);
    // The brand alone is not enough: the class has to hand over what the guard builds its store from.
    class Branded {
      static readonly [GUARD_FEATURE] = 'passkeys';
    }
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: Branded as unknown as typeof Passkeys })).toThrow(/\[marmeon:A8\].*passkeys/);
    // A class that says it is Passkeys but whose kit is incomplete never reaches a request.
    class Hollow extends Passkeys {}
    Object.defineProperty(Hollow, GUARD_PASSKEYS, { value: { config: PasskeyConfig, columns: [] } });
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: Hollow })).toThrow(/\[marmeon:A8\].*passkeys/);
    class Fake {
      static readonly [GUARD_FEATURE] = 'passkeys';
      async signIn() {}
    }
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: Fake as unknown as typeof Passkeys })).toThrow(/\[marmeon:A8\].*passkeys/);
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', passkeys: Passkeys } as never)).toThrow(/\[marmeon:A8\].*passkeys needs twoFactor/);
  });

  it('knows the Passkeys class by its brand, not its name: a class of that name without it is refused, a renamed subclass is taken', () => {
    class Impostor {}
    Object.defineProperty(Impostor, 'name', { value: 'Passkeys' });
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: Impostor as unknown as typeof Passkeys })).toThrow(/\[marmeon:A8\].*passkeys/);
    class Renamed extends Passkeys {}
    Object.defineProperty(Renamed, 'name', { value: 'Passkeys$1' });
    expect(() => defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: Renamed })).not.toThrow();
  });

  it('keeps its passkeys in a table named by its prefix, and has none without the option', () => {
    const guard = defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: Passkeys }) as unknown as { tables: { passkeys: string } };
    expect(guard.tables.passkeys).toBe('depot_passkeys');
    const plain = defineGuard('plain', { users: OfficeUsers, tablePrefix: 'plain_', twoFactor: TwoFactor }) as unknown as { tables: { passkeys?: string } };
    expect(plain.tables.passkeys).toBeUndefined();
  });

  describe('the relying party\'s configuration', () => {
    const start = (providers: unknown[], override?: (c: Container) => void, phase: 'run' | 'build' = 'run') =>
      createApplication(
        {
          root: workspaceTempDir('marmeon-guards-passkeys-'),
          discover: false,
          providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, ...providers, AuthServiceProvider] as never,
          modules: [defineModule({ name: 'config-test', migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
        },
        { phase, env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:' }, override: (c: Container) => { c.instance(UserProvider, app as unknown as UserProvider); override?.(c); } },
      );
    class WithoutConfig implements ServiceProvider {
      register(container: Container): void {
        OfficeGuard.register(container);
      }
    }

    it('stops the start (A8) when nothing binds it', async () => {
      await expect(start([WithoutConfig])).rejects.toThrow(/\[marmeon:A8\].*static config = \[PasskeyConfig\]/);
    });

    it('starts when a binding is made in `override`, which runs after the guard registered', async () => {
      await expect(start([WithoutConfig], (c) => c.instance(PasskeyConfig, { relyingParty: () => ({ rpId: 'localhost', origins: [ORIGIN] }) }))).resolves.toBeDefined();
    });

    it('starts when a later provider binds it in its register()', async () => {
      class Later implements ServiceProvider {
        register(container: Container): void {
          container.instance(PasskeyConfig, { relyingParty: () => ({ rpId: 'localhost', origins: [ORIGIN] }) });
        }
      }
      await expect(start([WithoutConfig, Later])).resolves.toBeDefined();
    });

    it('is not checked while the app is built', async () => {
      await expect(start([WithoutConfig], undefined, 'build')).resolves.toBeDefined();
    });
  });

  it('refuses a store from the kit that is not a PasskeyStore, before it counts as a source of factors (A8)', () => {
    class Wrong extends Passkeys {}
    Object.defineProperty(Wrong, GUARD_PASSKEYS, { value: { ...(Passkeys as never as Record<symbol, object>)[GUARD_PASSKEYS], isStore: () => false } });
    const guard = defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: Wrong });
    const container = new Container();
    container.instance(PasskeyConfig, { relyingParty: () => ({ rpId: 'localhost', origins: [ORIGIN] }) });
    container.instance(Connections, {} as never);
    container.instance(Clock, { now: () => 0 } as never);
    guard.register(container);
    expect(() => container.make((guard as unknown as { tokens: { passkeyStore: never } }).tokens.passkeyStore)).toThrow(/\[marmeon:A8\].*not a PasskeyStore/);
  });

  it('makes /up/ready red while the guard\'s passkey table is missing', async () => {
    const { HealthChecks } = await import('@marmeon/core');
    const container = (
      await createApplication(
        {
          root: workspaceTempDir('marmeon-guards-passkeys-'),
          discover: false,
          providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, OfficeProvider, AuthServiceProvider],
          modules: [defineModule({ name: 'no-office-tables', migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
        },
        { env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:' }, override: (c: Container) => void c.instance(UserProvider, app as unknown as UserProvider) },
      )
    ).container;
    await container.make(Migrator).migrate();
    const report = await container.make(HealthChecks).run(container);
    const text = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    expect(text).toContain('office_passkeys');
  });
});
