import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { CacheServiceProvider } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider, Migrator, type Migration } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { RedisServiceProvider } from '@marmeon/redis';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionConfig, SessionServiceProvider, SessionStore } from '@marmeon/session';
import { afterAll, describe, expect, it } from 'vitest';
import { drivers as databaseDrivers, freshPgsqlDatabase, migratedConnections, PGSQL_URL } from './__fixtures__/databases.ts';
import { READ_PENDING } from './auth.ts';
import {
  AccessTokenStore,
  AccountSessions,
  Auth,
  authenticate,
  AuthServiceProvider,
  DatabaseSignIns,
  EverySessionEnded,
  PasswordResetTokenStore,
  SignInStore,
  TwoFactorState,
  UserProvider,
  type AuthUser,
  type Credentials,
} from './index.ts';
import { SIGN_INS_TABLE } from './sign-ins.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { twoFactorState } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;
const SESSIONS_MIGRATION = new URL('../../session/stubs/migrations/0001_01_01_000000_create_sessions_table.ts', import.meta.url);

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const bob: AuthUser = { id: 2, name: 'Bob', email: 'bob@example.com' };
const cy: AuthUser = { id: 3, name: 'Cy', email: 'cy@example.com' };

/** Accounts in memory, with a session key that one call writes for all of them. */
class Users extends MemoryUsers<AuthUser> {
  constructor() {
    super();
    for (const user of [ada, bob, cy]) this.add(user);
  }
}

class KeylessUsers extends Users {
  // @ts-expect-error — a provider that cannot write every key has no such method
  override updateEverySessionKey = undefined;
}

/** Writes the key but does not hand it back from `findById()` (a column it forgets to select, or a cache). */
class ForgetfulUsers extends Users {
  override async findById(id: number): Promise<Credentials | undefined> {
    const found = await super.findById(id);
    return found && { ...found, sessionKey: null };
  }
}

class SignInController extends Controller {
  readonly #auth: Auth;
  readonly #users: UserProvider;
  constructor(auth: Auth, users: UserProvider) {
    super();
    this.#auth = auth;
    this.#users = users;
  }
  async handle(ctx: { params: { id: string } }) {
    const found = await this.#users.findById(Number(ctx.params.id) as never);
    return { result: await this.#auth.signIn(found!.user, { remember: true }) };
  }
}

class WhoController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { id: (await this.#auth.user())?.id ?? null };
  }
}

/** Whether a sign-in still waits for its second factor: the state the code entry reads first. */
class WaitingController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    const pending = await this.#auth[READ_PENDING]();
    return { state: typeof pending === 'object' ? 'waiting' : (pending ?? 'none') };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/as/:id', SignInController);
  Route.get('/login', () => 'login').name('auth.login');
  Route.get('/who', WhoController);
  Route.get('/waiting', WaitingController);
  Route.middleware(authenticate()).get('/me', (ctx) => ({ id: ctx.user.id }));
});

const events: EverySessionEnded[] = [];
class RecordEvent {
  handle(event: EverySessionEnded) {
    events.push(event);
  }
}
class FailingListener {
  handle(): never {
    throw new Error('the listener is broken');
  }
}

interface Driver {
  readonly name: string;
  /** The class of the store the app ends up with — the driver really is the one named. */
  readonly store: string;
  readonly env: () => Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }>;
  readonly providers?: readonly (typeof RedisServiceProvider)[];
  readonly sessionsTable?: boolean;
}

const drivers: Driver[] = [
  { name: 'memory', store: 'MemorySessionStore', env: async () => ({ env: { SESSION_DRIVER: 'memory' }, cleanup: async () => {} }) },
  {
    name: 'file',
    store: 'FileSessionStore',
    env: async () => {
      const directory = mkdtempSync(join(tmpdir(), 'marmeon-every-session-'));
      return { env: { SESSION_DRIVER: 'file', SESSION_FILES: directory }, cleanup: async () => rmSync(directory, { recursive: true, force: true }) };
    },
  },
  { name: 'database (sqlite)', store: 'DatabaseSessionStore', sessionsTable: true, env: async () => ({ env: { SESSION_DRIVER: 'database' }, cleanup: async () => {} }) },
  ...(PGSQL_URL
    ? [
        {
          name: 'database (pgsql)',
          store: 'DatabaseSessionStore',
          sessionsTable: true,
          env: async () => {
            const fresh = await freshPgsqlDatabase();
            return { env: { SESSION_DRIVER: 'database', DB_DRIVER: 'pgsql', DB_URL: fresh.url }, cleanup: fresh.drop };
          },
        },
      ]
    : []),
  ...(REDIS_URL
    ? [
        {
          name: 'redis',
          store: 'RedisSessionStore',
          providers: [RedisServiceProvider],
          env: async () => ({ env: { SESSION_DRIVER: 'redis', REDIS_URL: REDIS_URL, REDIS_PREFIX: `every-session-${crypto.randomUUID().slice(0, 8)}:` }, cleanup: async () => {} }),
        },
      ]
    : []),
];
const memory = drivers[0]!;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function boot(driver: Driver, users: UserProvider, options: { signIns?: new (...args: never[]) => SignInStore; override?: (container: Container) => void; failingListener?: boolean } = {}) {
  events.length = 0;
  const { env, cleanup } = await driver.env();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, ...(driver.providers ?? []), CacheServiceProvider, AuthServiceProvider],
    modules: [
      defineModule({
        name: 'every-session-test',
        routes,
        migrations: new URL('./__fixtures__/migrations/', import.meta.url),
        listeners: [listen(EverySessionEnded as never, RecordEvent), ...(options.failingListener ? [listen(EverySessionEnded as never, FailingListener)] : [])],
      }),
    ],
  }, {
    env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', ...env },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users);
      // Cy has a second factor: signing Cy in leaves a sign-in that waits for it.
      container.instance(TwoFactorState, twoFactorState({ factors: async (id) => (Number(id) === cy.id ? ['totp' as const] : []), enabledSince: async () => new Date(0) }));
      if (options.signIns) container.singleton(SignInStore, options.signIns as never);
      options.override?.(container);
    },
  });
  cleanups.push(async () => {
    await application.shutdown?.();
    await cleanup();
  });
  await application.container.make(Migrator).migrate();
  const connections = application.container.make(Connections);
  if (driver.sessionsTable) {
    const migration = ((await import(SESSIONS_MIGRATION.href)) as { default: Migration }).default;
    await runMigration(connections, migration);
  }
  expect(application.container.make(SessionConfig).driver).toBe(env.SESSION_DRIVER);
  expect(application.container.make(SessionStore).constructor.name, driver.name).toBe(driver.store);
  if (driver.name.includes('pgsql')) expect(connections.options('default').driver).toBe('pgsql');
  const kernel = createHttpKernel(application);
  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (path: string, init: { method?: string } = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: init.method ?? 'GET', headers: { cookie, accept: 'application/json' } });
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
  const count = async (table: string) => (await connections.get<any>().selectFrom(table).selectAll().execute()).length as number;
  return { browser, accounts: application.container.make(AccountSessions), connections, count, container: application.container };
}

const rememberWho = async (browser: Awaited<ReturnType<typeof boot>>['browser'], cookie: string) =>
  (await (await browser(new Map([['marmeon_remember', cookie]])).send('/who')).json()) as { id: number | null };

describe.each(drivers)('AccountSessions.endEveryone() with SESSION_DRIVER=$name', (driver) => {
  it('ends every session of every account, a waiting second-factor step and every remember-me cookie; a new sign-in works', async () => {
    const users = new Users();
    const { browser, accounts, count } = await boot(driver, users);
    const a = browser();
    const b1 = browser();
    const b2 = browser();
    const waiting = browser();
    await a.send('/as/1', { method: 'POST' });
    await b1.send('/as/2', { method: 'POST' });
    await b2.send('/as/2', { method: 'POST' });
    expect(await (await waiting.send('/as/3', { method: 'POST' })).json()).toEqual({ result: 'two-factor-required' });
    const cookies = [a, b1, b2].map((b) => b.jar.get('marmeon_remember')!);
    expect(cookies.every(Boolean)).toBe(true);
    for (const b of [a, b1, b2]) expect((await b.send('/me')).status, 'before').toBe(200);
    expect(await (await waiting.send('/waiting')).json(), 'before').toEqual({ state: 'waiting' });

    expect(await accounts.endEveryone()).toEqual({ accounts: 3, resetTokens: 0, accessTokens: 0, signIns: 3 });
    for (const b of [a, b1, b2]) expect((await b.send('/me')).status).toBe(401);
    for (const cookie of cookies) expect(await rememberWho(browser, cookie)).toEqual({ id: null });
    expect(await (await waiting.send('/waiting')).json(), 'the code entry is expired').toEqual({ state: 'expired' });
    expect(await count(SIGN_INS_TABLE)).toBe(0);

    const again = browser();
    await again.send('/as/1', { method: 'POST' });
    expect((await again.send('/me')).status, 'a sign-in after the call').toBe(200);
  });

  it('dispatches the event once, with the numbers', async () => {
    const { browser, accounts } = await boot(driver, new Users());
    await browser().send('/as/1', { method: 'POST' });
    await accounts.endEveryone();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accounts: 3, resetTokens: 0, accessTokens: 0, signIns: 1 });
    expect(events[0]!.at).toBeInstanceOf(Date);
  });
});

describe('AccountSessions.endEveryone()', () => {
  it('deletes the sign-ins, their remember-me tokens with them', async () => {
    const withRows = await boot(memory, new Users());
    const laptop = withRows.browser();
    await laptop.send('/as/1', { method: 'POST' });
    await withRows.browser().send('/as/2', { method: 'POST' });
    expect(await withRows.count(SIGN_INS_TABLE)).toBe(2);
    expect(await withRows.accounts.endEveryone()).toMatchObject({ signIns: 2 });
    expect(await withRows.count(SIGN_INS_TABLE)).toBe(0);
    expect((await laptop.send('/me')).status).toBe(401);
    expect(await withRows.accounts.endEveryone(), 'nothing left to end').toMatchObject({ signIns: 0 });
  });

  it('revokes every API token by default, and keeps them when asked', async () => {
    const { accounts, container } = await boot(memory, new Users());
    const tokens = container.make(AccessTokenStore);
    const first = await tokens.create(1, 'ci', { abilities: ['*'], expiresIn: null });
    const second = await tokens.create(2, 'cli', { abilities: ['*'], expiresIn: null });

    expect(await accounts.endEveryone({ accessTokens: false })).toMatchObject({ accessTokens: 0 });
    expect(await tokens.find(first.plainText), 'kept when asked').toBeDefined();

    expect(await accounts.endEveryone()).toMatchObject({ accessTokens: 2 });
    expect(await tokens.find(first.plainText)).toBeUndefined();
    expect(await tokens.find(second.plainText)).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ accessTokens: 2 });
  });

  it('keeps password-reset tokens when asked', async () => {
    const { accounts, container } = await boot(memory, new Users());
    const resets = container.make(PasswordResetTokenStore);
    const kept = await resets.create(ada.email, 0);
    expect(await accounts.endEveryone({ resetTokens: false })).toMatchObject({ resetTokens: 0 });
    expect((await resets.consume(ada.email, kept.ok ? kept.value : '', 3600)).ok, 'kept when asked').toBe(true);
  });

  it('deletes every password-reset token by default: a link mailed before does not work after', async () => {
    const { accounts, container } = await boot(memory, new Users());
    const resets = container.make(PasswordResetTokenStore);
    const made = await resets.create(ada.email, 0);
    await resets.create(bob.email, 0);
    expect(made.ok).toBe(true);

    expect(await accounts.endEveryone()).toMatchObject({ resetTokens: 2 });
    expect((await resets.consume(ada.email, made.ok ? made.value : '', 3600)).ok).toBe(false);
  });

  it('throws before it deletes anything when the provider cannot write every key', async () => {
    const { browser, accounts, count } = await boot(memory, new KeylessUsers() as never);
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    const cookie = laptop.jar.get('marmeon_remember')!;
    await expect(accounts.endEveryone()).rejects.toThrow(/\[marmeon:A5\].*updateEverySessionKey\(key\).*session_key/s);
    expect(await count(SIGN_INS_TABLE), 'the sign-ins stay').toBe(1);
    expect((await laptop.send('/me')).status, 'the session stays').toBe(200);
    expect(await rememberWho(browser, cookie)).toEqual({ id: 1 });
    expect(events).toHaveLength(0);
  });

  it('refuses before it deletes anything when a store it needs has no forgetEveryone()/revokeEveryone()', async () => {
    const users = new Users();
    const { browser, accounts, count } = await boot(memory, users, {
      override: (c) => {
        const real = c.make(PasswordResetTokenStore);
        c.instance(PasswordResetTokenStore, { create: (...args) => real.create(...args), consume: (...args) => real.consume(...args), forget: (email) => real.forget(email), prune: (age) => real.prune(age) } satisfies Omit<PasswordResetTokenStore, 'forgetEveryone'> as never);
      },
    });
    await browser().send('/as/1', { method: 'POST' });
    await expect(accounts.endEveryone()).rejects.toThrow(/^\[marmeon:A6\] .*PasswordResetTokenStore\.forgetEveryone\(\).*--keep-reset-tokens.*Nothing was changed/s);
    expect(await count(SIGN_INS_TABLE), 'the sign-ins stay').toBe(1);
    expect([...users.rows.values()].map((row) => row.key)).toEqual([null, null, null]);
    expect(await accounts.endEveryone({ resetTokens: false }), 'kept: the store is not needed').toMatchObject({ accounts: 3 });
  });

  it('refuses an API-token store without revokeEveryone() unless the API tokens are kept', async () => {
    const users = new Users();
    const { browser, accounts, count } = await boot(memory, users, {
      override: (c) => {
        const real = c.make(AccessTokenStore);
        c.instance(AccessTokenStore, { create: (...args) => real.create(...args), find: (t) => real.find(t), touch: (t) => real.touch(t), list: (id) => real.list(id), revoke: (u, id) => real.revoke(u, id), revokeAll: (id) => real.revokeAll(id), prune: (g) => real.prune(g) } satisfies Omit<AccessTokenStore, 'revokeEveryone'> as never);
      },
    });
    await browser().send('/as/1', { method: 'POST' });
    await expect(accounts.endEveryone()).rejects.toThrow(/^\[marmeon:A6\] .*AccessTokenStore\.revokeEveryone\(\).*--keep-api-tokens.*Nothing was changed/s);
    expect(await count(SIGN_INS_TABLE)).toBe(1);
    expect(await accounts.endEveryone({ accessTokens: false }), 'kept: the store is not needed').toMatchObject({ accounts: 3 });
  });

  it('fails closed when the sample account cannot be read back', async () => {
    class Vanishing extends Users {
      override async updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number }> {
        await super.updateEverySessionKey(key);
        return { accounts: 3, sampleId: 99 };
      }
    }
    const { accounts } = await boot(memory, new Vanishing());
    await expect(accounts.endEveryone()).rejects.toThrow(/failed at "session keys"/);
    await expect(accounts.endEveryone()).rejects.toMatchObject({ cause: { message: expect.stringContaining('cannot confirm the new key') } });
    expect(events).toHaveLength(0);
  });

  it('throws inside a database transaction, before it deletes anything', async () => {
    const users = new Users();
    const { browser, accounts, connections, count } = await boot(memory, users);
    await browser().send('/as/1', { method: 'POST' });
    await expect(connections.transaction(() => accounts.endEveryone())).rejects.toThrow(/outside a database transaction/);
    expect(await count(SIGN_INS_TABLE)).toBe(1);
    expect([...users.rows.values()].map((row) => row.key)).toEqual([null, null, null]);
  });

  it('throws when the provider does not answer with a count', async () => {
    class Silent extends Users {
      override async updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number }> {
        await super.updateEverySessionKey(key);
        return undefined as never;
      }
    }
    const { accounts } = await boot(memory, new Silent());
    await expect(accounts.endEveryone()).rejects.toThrow(/failed at "session keys"/);
    expect(events).toHaveLength(0);
  });

  it.each([Number.NaN, -1, 1.5])('throws when the provider counts %s accounts', async (count) => {
    class Counting extends Users {
      override async updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number | undefined }> {
        const written = await super.updateEverySessionKey(key);
        return { ...written, accounts: count };
      }
    }
    const { accounts } = await boot(memory, new Counting());
    await expect(accounts.endEveryone()).rejects.toMatchObject({ cause: { message: expect.stringMatching(/^\[marmeon:A5\] .*as a count/) } });
    expect(events).toHaveLength(0);
  });

  it('throws loudly when findById() does not hand the new key back: every session would stay live', async () => {
    const { browser, accounts } = await boot(memory, new ForgetfulUsers());
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    await expect(accounts.endEveryone()).rejects.toThrow(/written but could not be confirmed/);
    expect(events, 'nothing is announced').toHaveLength(0);
  });

  it('a reset-token store that cannot be emptied does not keep a session alive: the keys are rotated, the error names the missing steps', async () => {
    class FailingResets {
      forgetEveryone = async () => {
        throw new Error('no such table: password_reset_tokens');
      };
    }
    const { browser, accounts, count } = await boot(memory, new Users(), { override: (container) => container.instance(PasswordResetTokenStore, new FailingResets() as never) });
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    await expect(accounts.endEveryone({ resetTokens: true })).rejects.toThrow(/failed at "password-reset tokens".*signIns 1, accounts 3.*every session is already ended; still missing: resetTokens/s);
    expect(await count(SIGN_INS_TABLE)).toBe(0);
    expect((await laptop.send('/me')).status, 'the keys did their work').toBe(401);
  });

  it('a reset or API token step that fails names the way to keep those tokens', async () => {
    const reset = await boot(memory, new Users(), {
      override: (c) => {
        const real = c.make(PasswordResetTokenStore);
        c.instance(PasswordResetTokenStore, { ...real, create: (...a: [never, never]) => real.create(...a), consume: (...a: [never, never, never]) => real.consume(...a), forget: (e: never) => real.forget(e), prune: (g: never) => real.prune(g), forgetEveryone: async () => Promise.reject(new Error('no table')) } as never);
      },
    });
    await expect(reset.accounts.endEveryone()).rejects.toThrow(/failed at "password-reset tokens".*--keep-reset-tokens/s);
    const api = await boot(memory, new Users(), {
      override: (c) => {
        const real = c.make(AccessTokenStore);
        c.instance(AccessTokenStore, { create: (...a: [never, never, never]) => real.create(...a), find: (t: never) => real.find(t), touch: (t: never) => real.touch(t), list: (i: never) => real.list(i), revoke: (u: never, i: never) => real.revoke(u, i), revokeAll: (i: never) => real.revokeAll(i), prune: (g: never) => real.prune(g), revokeEveryone: async () => Promise.reject(new Error('no table')) } as never);
      },
    });
    await expect(api.accounts.endEveryone()).rejects.toThrow(/failed at "API tokens".*--keep-api-tokens/s);
  });

  it('a failure before the keys are written says they are NOT rotated, and a second call finishes', async () => {
    let failing = true;
    class FailingSignIns extends DatabaseSignIns {
      override async endEveryone(): Promise<number> {
        if (failing) throw new Error('the table is locked');
        return super.endEveryone();
      }
    }
    const users = new Users();
    const { browser, accounts } = await boot(memory, users, { signIns: FailingSignIns });
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    await expect(accounts.endEveryone()).rejects.toThrow(/failed at "sign-ins".*NOT rotated.*every session is still live.*run it again/s);
    expect((await laptop.send('/me')).status).toBe(200);
    failing = false;
    await accounts.endEveryone();
    expect((await laptop.send('/me')).status).toBe(401);
  });

  it('refuses a provider that returns no sampleId, saying the keys were written but could not be confirmed', async () => {
    class NoSample extends Users {
      override async updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number }> {
        const { accounts } = await super.updateEverySessionKey(key);
        return { accounts } as never;
      }
    }
    const { accounts } = await boot(memory, new NoSample());
    await expect(accounts.endEveryone()).rejects.toThrow(/failed at "session keys".*written but could not be confirmed/s);
    await expect(accounts.endEveryone()).rejects.toMatchObject({ cause: { message: expect.stringContaining('sampleId') } });
  });

  it('a listener that fails after the work is done does not fail the call', async () => {
    const { accounts } = await boot(memory, new Users(), { failingListener: true });
    await expect(accounts.endEveryone()).resolves.toMatchObject({ accounts: 3 });
  });

  it('a remember-me sign-in that read the account before the call stays a guest', async () => {
    const users = new Users();
    const { browser, accounts } = await boot(memory, users);
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    const cookie = laptop.jar.get('marmeon_remember')!;
    // The sign-in has read the account (the old key) when another request ends everything.
    users.after = () => accounts.endEveryone();
    const reopened = browser(new Map([['marmeon_remember', cookie]]));
    expect(await (await reopened.send('/who')).json()).toEqual({ id: null });
    expect((await reopened.send('/me')).status).toBe(401);
    expect(reopened.jar.has('marmeon_remember')).toBe(false);
  });
});

describe.each(databaseDrivers)('DatabaseSignIns.endEveryone() on %s', (driver) => {
  it('deletes every sign-in, even one that lives on in the future, which a time condition would keep', async () => {
    const { connections, close } = await migratedConnections(driver);
    try {
      const clock = new TestClock();
      clock.freeze(Date.parse('2026-10-05T10:00:00Z'));
      const store = new DatabaseSignIns(connections, clock);
      await store.issueToken(1, await store.create({ userId: 1, userAgent: undefined }), { until: new Date(clock.now() + 86_400_000), fingerprint: 'fingerprint' });
      const future = new Date(clock.now() + 30 * 86_400_000);
      await connections
        .get<any>()
        .insertInto(SIGN_INS_TABLE)
        .values({ id: 'f'.repeat(22), user_id: 2, remember_selector: 'e'.repeat(22), remember_validator_hash: 'x'.repeat(43), remember_until: future, signed_in_at: future, last_seen_at: future, created_at: future, updated_at: future })
        .execute();
      expect(await store.endEveryone()).toBe(2);
      expect(await connections.get<any>().selectFrom(SIGN_INS_TABLE).selectAll().execute()).toEqual([]);
    } finally {
      await close();
    }
  });
});
