import { Container, createApplication, defineModule, HealthChecks, listen, Redactor, type ServiceProvider } from '@marmeon/core';
import { CacheServiceProvider, RateLimiter } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider, Migrator, type Migration } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionEndings, SessionServiceProvider, sessionKey, SessionStore } from '@marmeon/session';
import { accountScope } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import { AUTH_SESSION_KEYS } from './auth.ts';
import { defineGuard, type GuardAccountSessions, type GuardAuth } from './define-guard.ts';
import { AccessTokenStore, AccountSessions, Auth, AuthServiceProvider, Hasher, PasswordBroker, SignedIn, SignInStore, UserProvider, type AuthUser } from './index.ts';
import { guardNames } from './guard-names.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const SESSIONS_MIGRATION = new URL('../../session/stubs/migrations/0001_01_01_000000_create_sessions_table.ts', import.meta.url);

interface OfficeUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

// The same id 1 and the same address in both tables: only the guard tells the accounts apart.
const app = new MemoryUsers<AuthUser>();
const office = new MemoryUsers<OfficeUser>();

/** The repository of the package: the container builds it per use, so it hands out the one set of rows the test fills. */
class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return office;
  }
}

const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', settings: { loginAttemptsPerMinute: 60, accountSignInsPerDay: 10 } });
type OfficeAuth = GuardAuth<OfficeUser>;
const OfficeAuth = OfficeGuard.Auth;
type OfficeAccounts = GuardAccountSessions<OfficeUser>;
const OfficeAccounts = OfficeGuard.AccountSessions;

/** Registers the guard of the package, as a package's provider does. */
class OfficeProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
  }
}

class Who {
  static signedIn: string[] = [];
  handle(event: SignedIn) {
    Who.signedIn.push(`${event.user.id}:${event.user.name}`);
  }
}

/** One action of a guard's `Auth`, named by the request: both guards run the same ones, so a test reads the two side by side. */
async function act(auth: GuardAuth<{ readonly id: number }>, accounts: { end(id: number): Promise<{ ok: boolean }> }, ctx: HttpContext): Promise<Record<string, unknown>> {
  const header = (name: string) => ctx.request.headers.get(name) ?? undefined;
  switch (header('x-action')) {
    case 'login':
      return { ok: (await auth.attempt(header('x-email') ?? 'ada@example.com', header('x-password') ?? 'secret', { remember: header('x-remember') === 'yes' })).ok };
    case 'who':
      return { id: (await auth.user())?.id ?? null, viaRemember: auth.viaRemember() };
    case 'logout':
      await auth.signOut();
      return { ok: true };
    case 'confirm':
      return { ok: (await auth.checkPassword('secret')).ok };
    case 'confirmed':
      return { confirmed: auth.passwordRecentlyConfirmed() };
    case 'sign-ins':
      return { ids: (await auth.signIns()).map((signIn) => signIn.id) };
    case 'end-sign-in': {
      const ended = await auth.endSignIn(header('x-id') ?? '');
      return ended.ok ? { ok: true } : { error: ended.error.kind };
    }
    case 'password':
      await auth.updatePassword('new password');
      return { ok: true };
    case 'end':
      return { ok: (await accounts.end(1)).ok };
    default:
      return { error: 'unknown' };
  }
}

class AppController extends Controller {
  readonly #auth: Auth;
  readonly #accounts: AccountSessions;
  constructor(auth: Auth, accounts: AccountSessions) {
    super();
    this.#auth = auth;
    this.#accounts = accounts;
  }
  handle(ctx: HttpContext) {
    return act(this.#auth, this.#accounts, ctx);
  }
}

// The alias and the constant of the same name: the injection reads the type's name and finds the guard's token.
class OfficeController extends Controller {
  readonly #auth: OfficeAuth;
  readonly #accounts: OfficeAccounts;
  constructor(auth: OfficeAuth, accounts: OfficeAccounts) {
    super();
    this.#auth = auth;
    this.#accounts = accounts;
  }
  handle(ctx: HttpContext) {
    return act(this.#auth, this.#accounts, ctx);
  }
}

const routes = openRoutes((Route) => {
  Route.post('/app', AppController);
  Route.post('/office', OfficeController);
});

interface BootOptions {
  readonly env?: Record<string, string>;
  /** `false` registers the guard's provider after `AuthServiceProvider`'s. */
  readonly officeFirst?: boolean;
  readonly sessions?: 'memory' | 'database';
  /** `false` leaves the guard's tables out: the test makes them. */
  readonly officeTables?: boolean;
}

async function boot(options: BootOptions = {}) {
  const { officeFirst = true, sessions = 'memory', officeTables = true } = options;
  Who.signedIn = [];
  app.rows.clear();
  office.rows.clear();
  const application = await createApplication(
    {
      root: import.meta.dirname,
      discover: false,
      providers: [
        EncryptionServiceProvider,
        HttpServiceProvider,
        ServerServiceProvider,
        SessionServiceProvider,
        DatabaseServiceProvider,
        CacheServiceProvider,
        ...(officeFirst ? [OfficeProvider, AuthServiceProvider] : [AuthServiceProvider, OfficeProvider]),
      ],
      modules: [
        defineModule({
          name: 'guards-test',
          routes,
          migrations: new URL('./__fixtures__/migrations/', import.meta.url),
          listeners: [listen(SignedIn, Who)],
        }),
        ...(officeTables ? [defineModule({ name: 'office-test', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) })] : []),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: sessions, SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1', ...options.env },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(UserProvider, app as unknown as UserProvider);
      },
    },
  );
  await application.container.make(Migrator).migrate();
  const connections = application.container.make(Connections);
  if (sessions === 'database') {
    const migration = ((await import(SESSIONS_MIGRATION.href)) as { default: Migration }).default;
    await runMigration(connections, migration);
  }
  const hash = await application.container.make(Hasher).make('secret');
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  const kernel = createHttpKernel(application);
  const store = application.container.make(SessionStore);
  const db = connections.get<any>();
  const rows = async (table: string) => (await db.selectFrom(table).selectAll().execute()) as { id: string; user_id: number }[];

  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (guard: 'app' | 'office', action: string, headers: Record<string, string> = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(`/${guard}`, { method: 'POST', headers: { cookie, accept: 'application/json', 'user-agent': 'Test Browser', 'x-action': action, ...headers } });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return (await response.json()) as Record<string, any>;
    };
    const sessionKeyOf = async () => sessionKey(await application.container.make(Encrypter).decrypt(decodeURIComponent(jar.get('marmeon_session')!), 'cookie:marmeon_session'));
    const stored = async () => JSON.parse((await store.read(await sessionKeyOf()))!.data) as Record<string, unknown>;
    const edit = async (change: (data: Record<string, unknown>) => void) => {
      const key = await sessionKeyOf();
      const read = (await store.read(key))!;
      const data = JSON.parse(read.data) as Record<string, unknown>;
      change(data);
      await store.write(key, JSON.stringify(data), { expectedVersion: read.version, lifetimeSeconds: 7200 });
    };
    return { send, jar, stored, edit };
  };
  return { application, container: application.container, browser, rows, db, connections };
}

const names = guardNames('office');

describe('a package guard next to the app guard, with the same id in both tables', () => {
  it('signs in to one guard only, and the other does not see it', async () => {
    const { browser } = await boot();
    const a = browser();
    await a.send('app', 'login');
    expect(await a.send('app', 'who')).toMatchObject({ id: 1 });
    expect(await a.send('office', 'who')).toMatchObject({ id: null });

    const b = browser();
    await b.send('office', 'login');
    expect(await b.send('office', 'who')).toMatchObject({ id: 1 });
    expect(await b.send('app', 'who'), 'the id 1 of office_users is nobody of the app').toMatchObject({ id: null });
  });

  it('refuses the app guard\'s keys copied under the package guard\'s names, with the app fingerprint and a row the package guard made', async () => {
    const { browser } = await boot();
    const row = browser();
    await row.send('office', 'login');
    const [officeRow] = (await row.send('office', 'sign-ins')).ids as string[];
    const a = browser();
    await a.send('app', 'login');
    await a.edit((data) => {
      for (const field of ['id', 'password', 'signedInAt'] as const) data[names.session[field]] = data[AUTH_SESSION_KEYS[field]];
      data[names.session.signIn] = officeRow;
    });
    expect(await a.send('office', 'who'), 'under the office context the app fingerprint is nobody\'s').toMatchObject({ id: null });
    expect(Object.keys(await a.stored())).not.toContain(names.session.id);
  });

  it('counts the two guards\' passwords apart: a locked office account does not lock the app, and the app\'s success frees nothing', async () => {
    const { browser } = await boot();
    for (let attempt = 0; attempt < 10; attempt++) expect((await browser().send('office', 'login', { 'x-password': 'wrong' })).ok).toBe(false);
    expect((await browser().send('office', 'login')).ok, 'the account is shut at its daily ceiling, the right password included').toBe(false);
    const a = browser();
    expect((await a.send('app', 'login')).ok, 'app account 1 signs in').toBe(true);
    expect((await browser().send('office', 'login')).ok, 'a success of the app does not free office account 1').toBe(false);
  });

  it('does not let a shut app account lock the office\'s account with the same id', async () => {
    const { browser } = await boot({ env: { AUTH_ACCOUNT_SIGN_INS_PER_DAY: '10', AUTH_LOGIN_ATTEMPTS_PER_MINUTE: '60' } });
    for (let attempt = 0; attempt < 10; attempt++) expect((await browser().send('app', 'login', { 'x-password': 'wrong' })).ok).toBe(false);
    expect((await browser().send('app', 'login')).ok, 'the app account is shut').toBe(false);
    expect((await browser().send('office', 'login')).ok, 'office account 1 signs in').toBe(true);
  });

  it('keeps a reset link of the app apart from the package guard\'s: the app\'s link sets no password of the office', async () => {
    const { container } = await boot();
    const appBroker = container.make(PasswordBroker);
    const officeBroker = container.make(OfficeGuard.PasswordBroker);
    const created = await appBroker.createToken('ada@example.com');
    expect(created.ok).toBe(true);
    const token = created.ok ? created.value.token : '';
    const hashBefore = office.rows.get(1)!.hash;
    const reset = await officeBroker.reset('ada@example.com', token, 'new password');
    expect(reset.ok).toBe(false);
    expect(office.rows.get(1)!.hash).toBe(hashBefore);
    // the token still stands for the app
    expect((await appBroker.reset('ada@example.com', token, 'new password')).ok).toBe(true);
  });

  it('ends only its own sessions: the app\'s user 1 keeps the session, the sign-in row and the remember-me token', async () => {
    const { browser, container, rows } = await boot({ sessions: 'database' });
    const heard: string[] = [];
    container.make(SessionEndings).listenAccounts((scope) => void heard.push(scope));
    const a = browser();
    await a.send('app', 'login', { 'x-remember': 'yes' });
    const b = browser();
    await b.send('office', 'login', { 'x-remember': 'yes' });
    const sessionRows = async () =>
      (await container.make(Connections).get<any>().selectFrom('sessions').select('user_id').execute()).map((row: { user_id: unknown }) => String(row.user_id)).sort();
    const before = await sessionRows();
    expect(before, 'the app\'s session is filed under user 1; the office\'s names nobody in this table').toContain('1');

    expect(await browser(b.jar).send('office', 'end')).toEqual({ ok: true });
    expect(await sessionRows(), 'the sessions table is the app\'s: nothing of it is deleted').toEqual(before);
    expect(await a.send('app', 'who')).toMatchObject({ id: 1 });
    expect(await rows('sign_ins')).toHaveLength(1);
    expect(a.jar.has('marmeon_remember')).toBe(true);
    expect(await rows('office_sign_ins'), 'the package guard\'s own rows are gone').toHaveLength(0);
    expect(heard).toEqual([accountScope(1, 'office')]);
    expect(heard).not.toContain(accountScope(1));
    expect(await b.send('office', 'who')).toMatchObject({ id: null });
  });

  it('shuts the live streams of its own account only: the sessions ending announces the guard\'s scope', async () => {
    const { container } = await boot();
    const endings = container.make(SessionEndings);
    const heard: string[] = [];
    endings.listenAccounts((scope) => void heard.push(scope));
    await container.make(OfficeAccounts).end(1);
    expect(heard).toEqual([accountScope(1, 'office')]);
  });

  it('leaves the API tokens of the app\'s user 1 when the office user 1 gets a new password', async () => {
    const { browser, container } = await boot({ env: { AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: 'true' } });
    const tokens = container.make(AccessTokenStore);
    await tokens.create(1, 'cli', { abilities: ['*'], expiresIn: null });
    const b = browser();
    await b.send('office', 'login');
    await b.send('office', 'confirm');
    expect(await b.send('office', 'password')).toEqual({ ok: true });
    expect(await container.make(Connections).get<any>().selectFrom('personal_access_tokens').selectAll().execute()).toHaveLength(1);
    expect(await tokens.revokeAll(1), 'the app\'s token is still there to revoke').toBe(1);
  });

  it('signs the app out with the office\'s sign-out and the office out with the app\'s, the remember-me cookies staying each its own', async () => {
    const { browser } = await boot();
    const b = browser();
    await b.send('app', 'login');
    await b.send('office', 'login', { 'x-remember': 'yes' });
    expect(b.jar.has('marmeon_remember.office')).toBe(true);
    expect(b.jar.has('marmeon_remember')).toBe(false);
    await b.send('app', 'logout');
    expect(await b.send('app', 'who')).toMatchObject({ id: null });
    expect(await b.send('office', 'who'), 'the remember-me cookie of the office signs it in again').toMatchObject({ id: 1, viaRemember: true });
    await b.send('office', 'logout');
    expect(await b.send('app', 'who')).toMatchObject({ id: null });
    expect(b.jar.has('marmeon_remember.office')).toBe(false);
  });

  it('keeps the password confirmation of each guard apart', async () => {
    const { browser } = await boot();
    const b = browser();
    await b.send('app', 'login');
    await b.send('office', 'login');
    expect(await b.send('app', 'confirmed'), 'a password sign-in confirms').toEqual({ confirmed: true });
    expect(await b.send('office', 'confirmed')).toEqual({ confirmed: true });
    await b.edit((data) => void delete data[AUTH_SESSION_KEYS.confirmedAt]);
    expect(await b.send('app', 'confirmed'), 'the app\'s confirmation is gone').toEqual({ confirmed: false });
    expect(await b.send('office', 'confirmed'), 'the office\'s stands: it never read the app\'s key').toEqual({ confirmed: true });
    await b.edit((data) => void delete data[names.session.confirmedAt]);
    await b.send('app', 'confirm');
    expect(await b.send('app', 'confirmed')).toEqual({ confirmed: true });
    expect(await b.send('office', 'confirmed'), 'the app\'s confirmation opens no office route').toEqual({ confirmed: false });
    await b.send('office', 'confirm');
    expect(await b.send('office', 'confirmed')).toEqual({ confirmed: true });
  });

  it('lists the sign-ins of its own table, and a row id of the app\'s is missing', async () => {
    const { browser } = await boot();
    const a = browser();
    await a.send('app', 'login');
    const [appRow] = (await a.send('app', 'sign-ins')).ids as string[];
    const b = browser();
    await b.send('office', 'login');
    const listed = (await b.send('office', 'sign-ins')).ids as string[];
    expect(listed).toHaveLength(1);
    expect(listed).not.toContain(appRow);
    expect(await b.send('office', 'end-sign-in', { 'x-id': appRow! })).toEqual({ error: 'missing' });
    expect(await a.send('app', 'who')).toMatchObject({ id: 1 });
  });

  it('raises no event of the app\'s classes: a listener of the app hears the app\'s sign-in only', async () => {
    const { browser } = await boot();
    await browser().send('office', 'login');
    expect(Who.signedIn).toEqual([]);
    await browser().send('app', 'login');
    expect(Who.signedIn).toEqual(['1:App Ada']);
  });

  it('hands a controller the package guard\'s Auth by the alias and constant of the same name', async () => {
    const { browser, container } = await boot();
    const b = browser();
    await b.send('office', 'login');
    expect(await b.send('office', 'who')).toMatchObject({ id: 1 });
    expect(container.has(OfficeAuth)).toBe(true);
    expect(container.has(Auth)).toBe(true);
    expect(OfficeAuth).not.toBe(Auth);
  });
});

describe('registering a guard', () => {
  it('boots in either order of the providers, and answers each guard its own users', async () => {
    for (const officeFirst of [true, false]) {
      const { browser } = await boot({ officeFirst });
      const b = browser();
      await b.send('office', 'login');
      expect(await b.send('office', 'who')).toMatchObject({ id: 1 });
      expect(await b.send('app', 'who')).toMatchObject({ id: null });
    }
  });

  it('remembers the guard\'s remember-me cookie as a key for the log, with the __Host- form over HTTPS', async () => {
    const plain = await boot();
    expect(plain.container.make(Redactor).isAddedKey('marmeon_remember.office')).toBe(true);
    const secure = await boot({ env: { SESSION_SECURE_COOKIE: 'true' } });
    expect(secure.container.make(Redactor).isAddedKey('__Host-marmeon_remember.office')).toBe(true);
  });

  it('has no endEveryone() for a guard: the type leaves it out and a cast finds it throwing, before any live stream is told', async () => {
    const { container } = await boot();
    const heard: string[] = [];
    container.make(SessionEndings).listenAccounts((scope) => void heard.push(scope));
    const accounts = container.make(OfficeAccounts) as unknown as AccountSessions;
    await expect(accounts.endEveryone({ accessTokens: false })).rejects.toThrow(/not available to the guard 'office'/);
    expect(heard).toEqual([]);
    // @ts-expect-error the guard's service does not have it
    void container.make(OfficeAccounts).endEveryone;
  });

  it('refuses a name, a prefix or a user class that is not valid, with error A8', () => {
    const users = OfficeUsers;
    for (const name of ['', 'Office', 'web', 'api', 'app', 'auth', 'marmeon', 'a'.repeat(33), 'office_x', '-office', 'office-', 'office--x', 1 as never]) {
      expect(() => defineGuard(name, { users, tablePrefix: 'x_' }), String(name)).toThrow(/\[marmeon:A8\]/);
    }
    for (const tablePrefix of ['', 'office', '_', 'Office_', 'a'.repeat(32) + '_', 'office-', 7 as never]) {
      expect(() => defineGuard('office', { users, tablePrefix }), String(tablePrefix)).toThrow(/\[marmeon:A8\]/);
    }
    for (const bad of [undefined, null, {}, new OfficeUsers(), () => new OfficeUsers(), 'OfficeUsers'] as never[]) {
      expect(() => defineGuard('office', { users: bad, tablePrefix: 'office_' })).toThrow(/\[marmeon:A8\]/);
    }
    expect(() => defineGuard('office', { users, tablePrefix: 'office_', settings: { rememberDay: 3 } as never })).toThrow(/\[marmeon:A8\].*settings\.rememberDay/);
    expect(() => defineGuard('office', { users, tablePrefix: 'office_', settings: { constructor: 3 } as never })).toThrow(/\[marmeon:A8\].*settings\.constructor/);
    expect(() => defineGuard('office', { users, tablePrefix: 'office_', settings: { rememberDays: 31 } })).toThrow(/\[marmeon:A8\].*rememberDays/);
    expect(() => defineGuard('office', { users, tablePrefix: 'office_', settings: { loginAttemptsPerMinute: 1.5 } })).toThrow(/\[marmeon:A8\]/);
  });

  it('refuses a second guard of the same name or the same prefix when it is registered, and takes the same guard twice', () => {
    const first = defineGuard('first', { users: OfficeUsers, tablePrefix: 'first_' });
    const sameName = defineGuard('first', { users: OfficeUsers, tablePrefix: 'other_' });
    const samePrefix = defineGuard('second', { users: OfficeUsers, tablePrefix: 'first_' });
    const container = new Container();
    first.register(container);
    first.register(container);
    expect(() => sameName.register(container)).toThrow(/\[marmeon:A8\].*'first'/);
    expect(() => samePrefix.register(container)).toThrow(/\[marmeon:A8\].*prefix 'first_'/);
  });

  it('refuses a setting that a function gives outside its limits at boot, and the app\'s own settings stand for a guard that gives none', async () => {
    const Bad = defineGuard('badsettings', { users: OfficeUsers, tablePrefix: 'bad_', settings: () => ({ sessionMaxHours: 0 }) });
    class BadProvider implements ServiceProvider {
      register(container: Container): void {
        Bad.register(container);
      }
    }
    await expect(
      createApplication(
        { root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider, BadProvider] },
        { env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:' } },
      ),
    ).rejects.toThrow(/\[marmeon:A8\].*sessionMaxHours/);
  });

  it('makes /up/ready red while a table of the guard lacks a column, and green with the migrations', async () => {
    const problems = async (container: Container) => {
      const report = await container.make(HealthChecks).run(container);
      return report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    };
    const complete = await boot();
    expect(await problems(complete.container)).toBe('');

    const { container, connections } = await boot({ officeTables: false });
    expect(await problems(container)).toMatch(/office_password_reset_tokens is missing; office_sign_ins is missing/);
    await runMigration(connections, {
      up: (schema) => {
        schema.create('office_sign_ins', (table) => {
          table.string('id', 22).primary();
          table.bigInteger('user_id');
        });
      },
    } as Migration);
    const lacking = await problems(container);
    expect(lacking).toContain('office_sign_ins');
    expect(lacking).toContain('remember_fingerprint');
  });

  it('asks for a rate limiter when only a package guard is registered, and for none in an app without one', async () => {
    const env = { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:' };
    const without = (providers: unknown[]) =>
      createApplication({ root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, ...providers] as never }, { env });
    await expect(without([OfficeProvider, AuthServiceProvider])).rejects.toThrow(/\[marmeon:A7\]/);
    await expect(without([AuthServiceProvider])).resolves.toBeDefined();
    const container = (await without([CacheServiceProvider, OfficeProvider, AuthServiceProvider])).container;
    expect(container.has(RateLimiter)).toBe(true);
  });

  it('keeps the app guard\'s bindings: the app\'s stores are not the package guard\'s', async () => {
    const { container, rows } = await boot();
    const a = container.make(SignInStore);
    await a.create({ userId: 1, userAgent: undefined });
    expect(await rows('sign_ins')).toHaveLength(1);
    expect(await rows('office_sign_ins')).toHaveLength(0);
  });
});
