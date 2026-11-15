import { AuthServiceProvider, authenticate, TwoFactorState, TwoFactorStore, defineGuard, defineGuardSlot, Hasher, UserProvider, type AuthUser, type GuardAuth, type GuardTwoFactor } from '@marmeon/auth';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { authenticatedSession, cookieNames, twoFactorCode } from '@marmeon/auth/testing';
import { CacheServiceProvider } from '@marmeon/cache';
import { defineModule, type Container, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/memory-users.ts';

interface OfficeUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

// The same id 1 in both tables: only the guard tells the accounts apart.
const appUsers = new MemoryUsers<AuthUser & { readonly id: number; readonly email: string }>();
const officeUsers = new MemoryUsers<OfficeUser>();

class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return officeUsers;
  }
}

const plainUsers = new MemoryUsers<OfficeUser>();

class PlainUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return plainUsers;
  }
}

// A guard without two-factor authentication.
const PlainGuard = defineGuard('plain', { users: PlainUsers, tablePrefix: 'plain_' });
const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor, settings: { rememberDays: 5 } });
const StaffSlot = defineGuardSlot<OfficeUser>('staff');
const MemberSlot = defineGuardSlot<OfficeUser>('member');
const UnboundSlot = defineGuardSlot<OfficeUser>('unbound');
type OfficeAuth = GuardAuth<OfficeUser>;

class OfficeProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
    PlainGuard.register(container);
    StaffSlot.bind(container, OfficeGuard);
    MemberSlot.bind(container, 'web');
  }
}

/** Enrols an authenticator for the app's user. */
class AppAct extends Controller {
  static readonly inject = [TwoFactor] as const;
  readonly #factor: TwoFactor;
  constructor(factor: TwoFactor) {
    super();
    this.#factor = factor;
  }
  async handle(ctx: HttpContext) {
    const body = (await ctx.input()) as Record<string, string>;
    if (ctx.request.headers.get('x-action') === 'begin') return { secret: (await this.#factor.begin()).secret };
    return { ok: (await this.#factor.confirm(body.code!, 'secret')).ok };
  }
}

/** Says who each guard sees, and enrols an authenticator for the office user. */
class OfficeAct extends Controller {
  static readonly inject = [OfficeGuard.Auth, OfficeGuard.TwoFactor] as const;
  readonly #auth: OfficeAuth;
  readonly #factor: GuardTwoFactor<OfficeUser>;
  constructor(auth: OfficeAuth, factor: GuardTwoFactor<OfficeUser>) {
    super();
    this.#auth = auth;
    this.#factor = factor;
  }
  async handle(ctx: HttpContext) {
    const body = (await ctx.input()) as Record<string, string>;
    switch (ctx.request.headers.get('x-action')) {
      case 'out':
        await this.#auth.signOut();
        return { out: true };
      case 'begin':
        return { secret: (await this.#factor.begin()).secret };
      case 'confirm':
        return { ok: (await this.#factor.confirm(body.code!, 'secret')).ok };
      default:
        return { id: (await this.#auth.user())?.id ?? null };
    }
  }
}

const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;

const routes = openRoutes((Route) => {
  Route.get('/login', () => 'app login').name('auth.login');
  Route.get('/office-login', () => 'office login').name('office.login');
  Route.get('/office-confirm', () => 'office confirm').name('office.confirm');
  Route.get('/office-verify', () => 'office verify').name('office.verify');
  const officeOnly = Route.middleware(OfficeGuard.authenticate(OFFICE));
  officeOnly.get('/office', (ctx) => ({ id: (ctx as unknown as { user: OfficeUser }).user.id }));
  officeOnly.post('/office/act', OfficeAct);
  officeOnly.middleware(OfficeGuard.confirmedPassword(OFFICE)).get('/office/sudo', () => 'sudo');
  officeOnly.middleware(OfficeGuard.confirmedSecondFactor({ verify: 'office.verify' })).get('/office/factors', () => 'factors');
  Route.middleware(authenticate()).post('/app/act', AppAct);
  officeOnly.get('/office/echo', (ctx) => ({ authorization: ctx.request.headers.get('authorization') }));
  Route.middleware(authenticate()).get('/app', () => 'app page');
  Route.middleware(StaffSlot.authenticate({ loginRoute: 'office.login' })).get('/staff', () => 'staff page');
  Route.middleware(MemberSlot.authenticate({ loginRoute: 'auth.login' })).get('/member', () => 'member page');
});

async function boot() {
  appUsers.rows.clear();
  officeUsers.rows.clear();
  plainUsers.rows.clear();
  const app = await createTestApp(
    {
      root: workspaceTempDir('marmeon-acting-as-guard-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, OfficeProvider, AuthServiceProvider],
      modules: [
        defineModule({ name: 'acting-as-guard-test', routes, migrations: new URL('../../auth/src/__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'office-test', migrations: new URL('../../auth/src/__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { APP_KEY: generateKey(), APP_NAME: 'Acme', SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', CACHE_DRIVER: 'memory', LOG_LEVEL: 'silent', DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(UserProvider, appUsers as unknown as UserProvider);
        container.bind(TwoFactorState, TwoFactorStore);
        container.scoped(TwoFactor);
      },
    },
  );
  await app.container.make(Migrator).migrate();
  const hash = await app.container.make(Hasher).make('secret');
  const appAda = appUsers.add({ id: 1, name: 'App Ada', email: 'ada@example.com' } as never, hash);
  const officeAda = officeUsers.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  const plainAda = plainUsers.add({ id: 1, name: 'Plain Ada', email: 'ada@example.com' }, hash);
  const officeBob = officeUsers.add({ id: 2, name: 'Office Bob', email: 'bob@example.com' }, hash);
  return { app, appAda, officeAda, officeBob, plainAda };
}

/** Enrols an authenticator for `user` of the office guard, as the guard's settings page would. */
async function enrol(app: Awaited<ReturnType<typeof boot>>['app'], user: OfficeUser): Promise<void> {
  // Starting an authenticator asks for a recent password: the test dates it.
  const acting = app.actingAs(user, { guard: OfficeGuard, confirmedAt: new Date(app.clock.now()) });
  const begun = (await acting.post('/office/act', { headers: { 'x-action': 'begin' } })).json() as { secret: string };
  const confirmed = await acting.post('/office/act', { headers: { 'x-action': 'confirm' }, json: { code: twoFactorCode(begun.secret, new Date(app.clock.now())) } });
  expect(confirmed.json()).toEqual({ ok: true });
}

describe('actingAs() as a user of a package guard', () => {
  it('opens the guard\'s routes and leaves the app\'s routes closed', async () => {
    const { app, officeAda } = await boot();
    const acting = app.actingAs(officeAda, { guard: OfficeGuard });
    (await acting.get('/office')).assertOk();
    expect((await acting.get('/office')).json()).toEqual({ id: 1 });
    (await acting.get('/app')).assertRedirect('/login');
  });

  it('does not sign in the app\'s user of the same id as a user of the guard, nor the guard\'s user as the app\'s', async () => {
    const { app, appAda, officeAda } = await boot();
    (await app.actingAs(appAda).get('/office')).assertRedirect('/office-login');
    (await app.actingAs(appAda).get('/app')).assertOk();
    // Without `guard` the helper signs in the app's account 1, never the guard's.
    (await app.actingAs(officeAda as never).get('/office')).assertRedirect('/office-login');
    (await app.actingAs(officeAda, { guard: OfficeGuard }).get('/app')).assertRedirect('/login');
  });

  it('keeps the guard\'s sign-in under the guard\'s own session keys, and the app\'s under the app\'s', async () => {
    const { app, appAda, officeAda } = await boot();
    const office = await authenticatedSession(app.container, officeAda, OfficeGuard);
    expect(Object.keys(office).sort()).toEqual(['_auth:office:id', '_auth:office:password']);
    expect(Object.keys(await authenticatedSession(app.container, appAda)).sort()).toEqual(['_auth_id', '_auth_password']);
  });

  it('refuses a user that does not exist in the guard\'s own table, though the app has one with that id', async () => {
    const { app } = await boot();
    officeUsers.rows.delete(2);
    appUsers.add({ id: 2, name: 'App Bob', email: 'bob@example.com' } as never);
    await expect(app.actingAs({ id: 2, name: 'Office Bob', email: 'bob@example.com' }, { guard: OfficeGuard }).get('/office')).rejects.toThrow(/there is no user 2 of the guard 'office'/);
  });

  it('refuses a guard that is not one, a guard nobody registered and a slot nobody bound', async () => {
    const { app, officeAda } = await boot();
    await expect(app.actingAs(officeAda, { guard: {} as never }).get('/office')).rejects.toThrow(/leave `guard` out for the app's own users/);
    const other = defineGuard('other', { users: OfficeUsers, tablePrefix: 'other_' });
    await expect(app.actingAs(officeAda, { guard: other }).get('/office')).rejects.toThrow(/guard 'other' is not registered/);
    await expect(app.actingAs(officeAda, { guard: UnboundSlot }).get('/office')).rejects.toThrow(/A8/);
  });

  it('signs in through a slot as its bound guard\'s user', async () => {
    const { app, appAda, officeAda } = await boot();
    (await app.actingAs(officeAda, { guard: StaffSlot }).get('/staff')).assertOk();
    (await app.actingAs(officeAda, { guard: StaffSlot }).get('/app')).assertRedirect('/login');
    // A slot bound to the app's users signs in the app's user, not the guard's.
    (await app.actingAs(appAda as never, { guard: MemberSlot }).get('/member')).assertOk();
    (await app.actingAs(appAda as never, { guard: MemberSlot }).get('/office')).assertRedirect('/office-login');
  });

  it('a later actingAs() replaces the earlier one', async () => {
    const { app, appAda, officeAda } = await boot();
    const acting = app.actingAs(officeAda, { guard: OfficeGuard }).actingAs(appAda);
    (await acting.get('/office')).assertRedirect('/office-login');
    (await acting.get('/app')).assertOk();
  });
  it('keeps a token set with guard api beside a guard session, in either order', async () => {
    const { app, appAda, officeAda } = await boot();
    for (const acting of [app.actingAs(officeAda, { guard: OfficeGuard }).actingAs(appAda, { guard: 'api' }), app.actingAs(appAda, { guard: 'api' }).actingAs(officeAda, { guard: OfficeGuard })]) {
      const echoed = await acting.get('/office/echo');
      echoed.assertOk();
      expect((echoed.json() as { authorization: string }).authorization).toMatch(/^Bearer .+/);
    }
  });

  it('refuses a guard passed as undefined instead of signing in the app\'s user of that id', async () => {
    const { app, officeAda } = await boot();
    await expect(authenticatedSession(app.container, officeAda, undefined as never)).rejects.toThrow(/leave `guard` out for the app's own users/);
    expect(() => cookieNames(app, undefined as never)).toThrow(/leave `guard` out for the app's own users/);
    expect(() => app.actingAs(officeAda, { guard: 'office' as never })).toThrow(/'web', 'api', a guard made by defineGuard/);
  });

  it('keeps an untyped { guard: undefined } the app\'s, and refuses it with dates', async () => {
    const { app, appAda } = await boot();
    (await app.actingAs(appAda, { guard: undefined }).get('/app')).assertOk();
    expect(() => app.actingAs(appAda as never, { guard: undefined, confirmedAt: new Date() } as never)).toThrow(/need a `guard`/);
    expect(() => app.actingAs(appAda as never, { guard: undefined, twoFactorAt: new Date() } as never)).toThrow(/need a `guard`/);
  });
});

describe('the proofs of actingAs() as a guard\'s user', () => {
  it('opens a password window only when the test dates the confirmation', async () => {
    const { app, officeAda } = await boot();
    const now = new Date(app.clock.now());
    (await app.actingAs(officeAda, { guard: OfficeGuard }).get('/office/sudo')).assertRedirect('/office-confirm');
    (await app.actingAs(officeAda, { guard: OfficeGuard, confirmedAt: now }).get('/office/sudo')).assertOk();
    (await app.actingAs(officeAda, { guard: OfficeGuard, confirmedAt: new Date(now.getTime() - 4 * 3_600_000) }).get('/office/sudo')).assertRedirect('/office-confirm');
  });

  it('counts an account with a factor of the guard as proven, and an account without one needs no proof', async () => {
    const { app, officeAda, officeBob } = await boot();
    await enrol(app, officeAda);
    (await app.actingAs(officeAda, { guard: OfficeGuard }).get('/office/factors')).assertOk();
    (await app.actingAs(officeBob, { guard: OfficeGuard }).get('/office/factors')).assertOk();
  });

  it('dates the second factor on request: a stale proof is sent to verify, a fresh one passes', async () => {
    const { app, officeAda } = await boot();
    await enrol(app, officeAda);
    const now = new Date(app.clock.now());
    const stale = new Date(now.getTime() - 3_600_000);
    (await app.actingAs(officeAda, { guard: OfficeGuard, twoFactorAt: stale }).get('/office/factors')).assertRedirect('/office-verify');
    (await app.actingAs(officeAda, { guard: OfficeGuard, twoFactorAt: now }).get('/office/factors')).assertOk();
  });

  it('takes the proof from the guard\'s own factors only', async () => {
    const { app, appAda, officeAda, officeBob } = await boot();
    await enrol(app, officeAda);
    // The guard's user 1 has a factor and the app's user 1 has none: each session follows its own guard's table.
    expect(await authenticatedSession(app.container, officeAda, OfficeGuard)).toHaveProperty('_auth:office:two_factor_at');
    expect(await authenticatedSession(app.container, appAda)).not.toHaveProperty('_auth_two_factor_at');
    expect(await authenticatedSession(app.container, appAda)).not.toHaveProperty('_auth:office:two_factor_at');
    expect(await authenticatedSession(app.container, officeBob, OfficeGuard)).not.toHaveProperty('_auth:office:two_factor_at');
  });

  it('a confirmation dated in the future opens no window and dates the sign-in now', async () => {
    const { app, officeAda } = await boot();
    const future = new Date(app.clock.now() + 3_600_000);
    const session = await authenticatedSession(app.container, officeAda, OfficeGuard, { confirmedAt: future });
    expect(session['_auth:office:signed_in_at']).toBe(Math.floor(app.clock.now() / 1000));
    (await app.actingAs(officeAda, { guard: OfficeGuard, confirmedAt: future }).get('/office/sudo')).assertRedirect('/office-confirm');
  });

  it('gives the guard\'s user no proof for a factor of the app\'s user of the same id', async () => {
    const { app, appAda, officeAda } = await boot();
    // The slot bound to 'web' signs in the app's user, here with a recent password, which starting an authenticator asks for.
    const acting = app.actingAs(appAda as never, { guard: MemberSlot, confirmedAt: new Date(app.clock.now()) });
    const begun = (await acting.post('/app/act', { headers: { 'x-action': 'begin' } })).json() as { secret: string };
    const confirmed = await acting.post('/app/act', { headers: { 'x-action': 'confirm' }, json: { code: twoFactorCode(begun.secret, new Date(app.clock.now())) } });
    expect(confirmed.json()).toEqual({ ok: true });
    expect(await authenticatedSession(app.container, appAda)).toHaveProperty('_auth_two_factor_at');
    expect(await authenticatedSession(app.container, officeAda, OfficeGuard)).not.toHaveProperty('_auth:office:two_factor_at');
  });

  it('signs in to a guard without two-factor authentication with no proof, though the app\'s user of that id has a factor', async () => {
    const { app, appAda, plainAda } = await boot();
    const acting = app.actingAs(appAda as never, { guard: MemberSlot, confirmedAt: new Date(app.clock.now()) });
    const begun = (await acting.post('/app/act', { headers: { 'x-action': 'begin' } })).json() as { secret: string };
    expect((await acting.post('/app/act', { headers: { 'x-action': 'confirm' }, json: { code: twoFactorCode(begun.secret, new Date(app.clock.now())) } })).json()).toEqual({ ok: true });
    expect(await authenticatedSession(app.container, appAda)).toHaveProperty('_auth_two_factor_at');
    expect(Object.keys(await authenticatedSession(app.container, plainAda, PlainGuard)).sort()).toEqual(['_auth:plain:id', '_auth:plain:password']);
  });

  it('refuses a date that is not one', async () => {
    const { app, officeAda } = await boot();
    await expect(app.actingAs(officeAda, { guard: OfficeGuard, confirmedAt: 'now' as never }).get('/office')).rejects.toThrow(/`confirmedAt` takes a valid Date/);
    await expect(app.actingAs(officeAda, { guard: OfficeGuard, twoFactorAt: new Date(Number.NaN) }).get('/office')).rejects.toThrow(/`twoFactorAt` takes a valid Date/);
  });
});

describe('assertAuthenticated() and assertGuest() for a guard', () => {
  it('sees the guard\'s user as signed in only when asked about the guard, and as a guest of the app', async () => {
    const { app, officeAda } = await boot();
    const response = await app.actingAs(officeAda, { guard: OfficeGuard }).get('/office');
    response.assertAuthenticated(officeAda, { guard: OfficeGuard }).assertAuthenticated(officeAda, { guard: StaffSlot }).assertGuest();
    expect(() => response.assertGuest({ guard: OfficeGuard })).toThrow(/Expected a guest, but the session is signed in as user 1/);
    expect(() => response.assertAuthenticated()).toThrow(/is a guest/);
    expect(() => response.assertAuthenticated({ id: 2, name: 'x', email: 'x' }, { guard: OfficeGuard })).toThrow(/another user/);
  });

  it('sees the guard as a guest after its sign-out, and chains on a pending request', async () => {
    const { app, officeAda } = await boot();
    const acting = app.actingAs(officeAda, { guard: OfficeGuard });
    await acting.post('/office/act', { headers: { 'x-action': 'who' } }).assertAuthenticated(officeAda, { guard: OfficeGuard }).assertGuest();
    await acting.post('/office/act', { headers: { 'x-action': 'out' } }).assertGuest({ guard: OfficeGuard }).assertGuest({ guard: StaffSlot });
    const out = await acting.post('/office/act', { headers: { 'x-action': 'out' } });
    expect(() => out.assertAuthenticated(undefined, { guard: OfficeGuard })).toThrow(/is a guest/);
  });

  it('leaves the app\'s assertions to the app\'s session, and the guard\'s to the guard\'s', async () => {
    const { app, appAda } = await boot();
    const response = await app.actingAs(appAda).get('/app');
    response.assertAuthenticated(appAda).assertGuest({ guard: OfficeGuard });
    expect(() => response.assertAuthenticated(undefined, { guard: OfficeGuard })).toThrow(/is a guest/);
    // The slot bound to 'web' asks about the app's own session.
    response.assertAuthenticated(appAda as never, { guard: MemberSlot });
  });

  it('refuses a guard that is undefined or missing, and a guard that is not one', async () => {
    const { app, officeAda } = await boot();
    const response = await app.actingAs(officeAda, { guard: OfficeGuard }).get('/office');
    expect(() => response.assertGuest(undefined as never)).toThrow(/leave the options out/);
    expect(() => response.assertGuest({ guard: undefined } as never)).toThrow(/leave the options out/);
    expect(() => response.assertAuthenticated(officeAda, undefined as never)).toThrow(/leave the options out/);
    expect(() => response.assertGuest({ guard: 'office' } as never)).toThrow(/leave `guard` out/);
    expect(() => response.assertGuest({ guard: UnboundSlot })).toThrow(/A8/);
  });
});

describe('cookieNames() for a guard', () => {
  it('names the guard\'s remember-me cookie, and the session cookie every guard shares', async () => {
    const { app } = await boot();
    const web = cookieNames(app);
    const office = cookieNames(app, OfficeGuard);
    expect(office.session).toBe(web.session);
    expect(office.remember).toBe(`${web.remember}.office`);
    expect(cookieNames(app, StaffSlot).remember).toBe(office.remember);
    expect(cookieNames(app, MemberSlot).remember).toBe(web.remember);
    expect(() => cookieNames(app, undefined as never)).toThrow(/leave `guard` out/);
  });
});
