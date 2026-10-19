import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, defineModule, type Container } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider, Migrator, type Migration } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { RedisServiceProvider } from '@marmeon/redis';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionConfig, SessionServiceProvider, SessionStore } from '@marmeon/session';
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import { freshPgsqlDatabase, PGSQL_URL } from './__fixtures__/databases.ts';
import { AccountSessions, Auth, authenticate, AuthServiceProvider, Hasher, UserProvider, type AuthUser, type Credentials, type PasswordHash } from './index.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;
const SESSIONS_MIGRATION = new URL('../../session/stubs/migrations/0001_01_01_000000_create_sessions_table.ts', import.meta.url);

/** Accounts in memory, with a session key each — what an app's repository keeps in a `session_key` column. */
class KeyedUsers extends MemoryUsers<AuthUser> {
  /** Runs once, right after the next write of a hash or a key — a request of another device landing in the middle of a change. */
  afterWrite: (() => Promise<unknown>) | undefined;
  async #written() {
    const hook = this.afterWrite;
    this.afterWrite = undefined;
    await hook?.();
  }
  /** Runs once, between a request's sign-in check and the action it then takes — another request landing at that moment. */
  between: (() => Promise<unknown>) | undefined;

  override async updatePasswordHash(id: number, hash: PasswordHash, options: { readonly expected?: PasswordHash; readonly sessionKey?: string } = {}): Promise<boolean> {
    const wrote = await super.updatePasswordHash(id, hash, options);
    if (wrote) await this.#written();
    return wrote;
  }
  override async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    const wrote = await super.updateSessionKey(id, key, expected);
    if (wrote) await this.#written();
    return wrote;
  }
}

/** A provider that cannot store a key (JavaScript, or a cast): a TypeScript provider cannot leave `updateSessionKey()` out. */
function plainUsers(): UserProvider {
  const users = new KeyedUsers();
  users.rows.set(2, { user: { id: 2, name: 'Link', email: 'link@example.com' }, hash: null, key: null });
  return Object.assign(users, { updateSessionKey: undefined }) as never;
}

class SignInController extends Controller {
  readonly #auth: Auth;
  readonly #users: UserProvider;
  constructor(auth: Auth, users: UserProvider) {
    super();
    this.#auth = auth;
    this.#users = users;
  }
  async handle(ctx: HttpContext<{}, { id: string }>) {
    // A passwordless sign-in — the app checked a link or an OAuth answer before.
    const found = await this.#users.findById(Number(ctx.params.id) as never);
    await this.#auth.login(found!.user, { remember: ctx.request.headers.get('x-remember') === 'yes' });
    return { ok: true };
  }
}

class EndOtherSessionsController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    try {
      return { done: await this.#auth.updateSessionKey() };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
}

class LoginController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { email, password } = (await ctx.input()) as { email: string; password: string };
    try {
      const signedIn = await this.#auth.attempt(email, password);
      return { user: signedIn.ok ? signedIn.value.id : null };
    } catch (error) {
      return { error: (error as Error).message };
    }
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

/** Checks the sign-in, lets `users.between` run (a request of the account landing now), then takes `action`. */
class RacingController extends Controller {
  readonly #auth: Auth;
  readonly #users: KeyedUsers;
  constructor(auth: Auth, users: UserProvider) {
    super();
    this.#auth = auth;
    this.#users = users as KeyedUsers;
  }
  async handle(ctx: HttpContext<{}, { action: string }>) {
    await this.#auth.user();
    const between = this.#users.between;
    this.#users.between = undefined;
    await between?.();
    if (ctx.params.action === 'key') return { result: await this.#auth.updateSessionKey() };
    if (ctx.params.action === 'password') return { result: await this.#auth.updatePassword('a new password') };
    return { result: (await this.#auth.checkPassword('secret')).ok && (await this.#auth.updateSessionKey()) };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/race/:action', RacingController);
  Route.post('/as/:id', SignInController);
  Route.get('/login', () => 'login').name('auth.login');
  Route.get('/who', WhoController);
  Route.post('/login', LoginController);
  const signedIn = Route.middleware(authenticate());
  signedIn.get('/me', (ctx) => ({ id: ctx.user.id }));
  signedIn.post('/end-other-sessions', EndOtherSessionsController);
});

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
      const directory = mkdtempSync(join(tmpdir(), 'marmeon-auth-sessions-'));
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
            return { env: { SESSION_DRIVER: 'database', DB_CONNECTION: 'pgsql', DB_URL: fresh.url }, cleanup: fresh.drop };
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
          env: async () => ({ env: { SESSION_DRIVER: 'redis', REDIS_URL: REDIS_URL, REDIS_PREFIX: `auth-key-${crypto.randomUUID().slice(0, 8)}:` }, cleanup: async () => {} }),
        },
      ]
    : []),
];

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function boot(driver: Driver, users: UserProvider) {
  const { env, cleanup } = await driver.env();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, ...(driver.providers ?? []), CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'session-key-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { APP_KEY: generateKey(), SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', ...env },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users);
    },
  });
  cleanups.push(async () => {
    await application.shutdown?.();
    await cleanup();
  });
  await application.container.make(Migrator).migrate();
  if (driver.sessionsTable) {
    const connections = application.container.make(Connections);
    const migration = ((await import(SESSIONS_MIGRATION.href)) as { default: Migration }).default;
    await runMigration(connections, migration);
  }
  expect(application.container.make(SessionConfig).driver).toBe(env.SESSION_DRIVER);
  expect(application.container.make(SessionStore).constructor.name, driver.name).toBe(driver.store);
  if (driver.name.includes('pgsql')) expect(application.container.make(Connections).options('default').driver).toBe('pgsql');
  const kernel = createHttpKernel(application);
  /** A tiny browser: keeps its cookies between requests. */
  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (path: string, init: { method?: string; headers?: Record<string, string>; json?: unknown } = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, {
        method: init.method ?? 'GET',
        headers: { cookie, accept: 'application/json', ...(init.json ? { 'content-type': 'application/json' } : {}), ...init.headers },
        ...(init.json ? { body: JSON.stringify(init.json) } : {}),
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
  return { browser, hasher: application.container.make(Hasher), accounts: application.container.make(AccountSessions) };
}

const link: AuthUser = { id: 2, name: 'Link', email: 'link@example.com' };
const zelda: AuthUser = { id: 3, name: 'Zelda', email: 'zelda@example.com' };

const fingerprints = new SessionFingerprints({ key: new Uint8Array(32).fill(1), previousKeys: [] });

describe('the fingerprint of an account', () => {
  it('differs between two accounts without a password, and changes with the session key — not with the hash', () => {
    const of = (user: AuthUser, passwordHash: PasswordHash | null, sessionKey: string | null = null) => fingerprints.of({ user, passwordHash, sessionKey });
    expect(of(link, null), 'two passwordless accounts').not.toBe(of(zelda, null));
    expect(of(link, null, 'key-1')).not.toBe(of(link, null, 'key-2'));
    expect(of(link, null, 'key-1')).not.toBe(of(link, null));
    // A rehash (another hash, the same key) leaves it as it is; the key never goes into the session as it is.
    expect(of(link, '$argon2id$a' as PasswordHash, 'key-1')).toBe(of(link, '$argon2id$b' as PasswordHash, 'key-1'));
    expect(of(link, '$argon2id$a' as PasswordHash)).toBe(of(link, null));
    expect(of(link, null, 'key-1')).not.toContain('key-1');
    expect(of(link, null)).toBe(of(link, null, null));
  });

  it('types: the session key and updateSessionKey are required — a provider without them is none', () => {
    expectTypeOf<{ user: AuthUser; passwordHash: null; sessionKey: null }>().toMatchTypeOf<Credentials>();
    // @ts-expect-error — the account has to hand its session key back
    expectTypeOf<{ user: AuthUser; passwordHash: null }>().toMatchTypeOf<Credentials>();
    expectTypeOf<KeyedUsers>().toMatchTypeOf<UserProvider>();
    expectTypeOf<Credentials['sessionKey']>().toEqualTypeOf<string | null>();
    class WrongKey extends KeyedUsers {
      // @ts-expect-error — the key is a string
      override async updateSessionKey(_id: number, _key: number, _expected: string | null | undefined): Promise<boolean> {
        return true;
      }
    }
    expectTypeOf<WrongKey>().not.toBeNever();
  });
});

describe.each(drivers)('auth.updateSessionKey() with SESSION_DRIVER=$name', (driver) => {
  it('ends every other session of the account — this one stays, other accounts stay, the other devices’ remember-me tokens stop working', async () => {
    const users = new KeyedUsers();
    users.rows.set(2, { user: link, hash: null, key: null });
    users.rows.set(3, { user: zelda, hash: null, key: null });
    const { browser } = await boot(driver, users);
    const laptop = browser();
    const phone = browser();
    const other = browser();
    await laptop.send('/as/2', { method: 'POST' });
    await phone.send('/as/2', { method: 'POST', headers: { 'x-remember': 'yes' } });
    await other.send('/as/3', { method: 'POST' });
    const phoneRemember = phone.jar.get('marmeon_remember');
    expect(phoneRemember, 'the phone has a remember-me cookie').toBeDefined();
    expect((await phone.send('/me')).status).toBe(200);

    expect(await (await laptop.send('/end-other-sessions', { method: 'POST' })).json()).toEqual({ done: true });
    expect(users.rows.get(2)!.key, 'a new key is stored').toMatch(/^[\w-]{43}$/);
    expect((await laptop.send('/me')).status, 'this session').toBe(200);
    expect((await phone.send('/me')).status, 'the other session').toBe(401);
    expect(await (await browser(new Map([['marmeon_remember', phoneRemember!]])).send('/who')).json(), "the other device's remember-me token").toEqual({ id: null });
    expect((await other.send('/me')).status, "another account's session").toBe(200);

    // Again: the key changes every time.
    const first = users.rows.get(2)!.key;
    await laptop.send('/end-other-sessions', { method: 'POST' });
    expect(users.rows.get(2)!.key).not.toBe(first);
    expect((await laptop.send('/me')).status).toBe(200);
  });
});

describe('a password sign-in after a new session key', () => {
  it('fails loudly when findForLogin() leaves out the key that findById() returns — a provider contract violation, not a failed login', async () => {
    class KeylessLogin extends KeyedUsers {
      override async findForLogin(email: string): Promise<Credentials | undefined> {
        const found = await super.findForLogin(email);
        return found && ({ user: found.user, passwordHash: found.passwordHash } as never);
      }
    }
    const users = new KeylessLogin();
    const { browser, hasher } = await boot(drivers[0]!, users);
    users.rows.set(4, { user: { id: 4, name: 'Ada', email: 'ada@example.com' }, hash: await hasher.make('secret'), key: 'a-rotated-key' });
    const laptop = browser();
    const body = await (await laptop.send('/login', { method: 'POST', json: { email: 'ada@example.com', password: 'secret' } })).json();
    expect(body, JSON.stringify(body)).toMatchObject({ error: expect.stringMatching(/KeylessLogin\.findForLogin\(\) returned no sessionKey/) });
    expect((await laptop.send('/me')).status).toBe(401);
  });

  it('fails loudly too when findById() leaves out the key that findForLogin() returns', async () => {
    class KeylessById extends KeyedUsers {
      override async findById(id: number): Promise<Credentials | undefined> {
        const found = await super.findById(id);
        return found && ({ user: found.user, passwordHash: found.passwordHash } as never);
      }
    }
    const users = new KeylessById();
    const { browser, hasher } = await boot(drivers[0]!, users);
    users.rows.set(4, { user: { id: 4, name: 'Ada', email: 'ada@example.com' }, hash: await hasher.make('secret'), key: 'a-rotated-key' });
    const body = await (await browser().send('/login', { method: 'POST', json: { email: 'ada@example.com', password: 'secret' } })).json();
    expect(body, JSON.stringify(body)).toMatchObject({ error: expect.stringMatching(/KeylessById\.findById\(\) returned no sessionKey/) });
  });

  it('treats a key that shows up on the second read as a change during the check, not as a broken provider', async () => {
    class LateKey extends KeyedUsers {
      reads = 0;
      override async findForLogin(email: string): Promise<Credentials | undefined> {
        const found = await super.findForLogin(email);
        return found && (this.reads++ === 0 ? ({ user: found.user, passwordHash: found.passwordHash } as never) : found);
      }
    }
    const users = new LateKey();
    const { browser, hasher } = await boot(drivers[0]!, users);
    users.rows.set(4, { user: { id: 4, name: 'Ada', email: 'ada@example.com' }, hash: await hasher.make('secret'), key: 'a-rotated-key' });
    expect(await (await browser().send('/login', { method: 'POST', json: { email: 'ada@example.com', password: 'secret' } })).json()).toEqual({ user: null });
  });

  it('signs in with a provider that hands the key back from findForLogin()', async () => {
    const users = new KeyedUsers();
    const { browser, hasher } = await boot(drivers[0]!, users);
    users.rows.set(4, { user: { id: 4, name: 'Ada', email: 'ada@example.com' }, hash: await hasher.make('secret'), key: 'a-rotated-key' });
    const laptop = browser();
    expect(await (await laptop.send('/login', { method: 'POST', json: { email: 'ada@example.com', password: 'secret' } })).json()).toEqual({ user: 4 });
    expect((await laptop.send('/me')).status, 'the next request after the sign-in').toBe(200);
  });
});

describe('auth.updateSessionKey() fails loudly', () => {
  it('when the UserProvider cannot store a key — naming what to implement', async () => {
    const { browser } = await boot(drivers[0]!, plainUsers());
    const laptop = browser();
    await laptop.send('/as/2', { method: 'POST' });
    const body = await (await laptop.send('/end-other-sessions', { method: 'POST' })).json();
    expect(body, JSON.stringify(body)).toMatchObject({ error: expect.stringMatching(/\[marmeon:A5\].*updateSessionKey\(id, key, expected\)/) });
    expect((await laptop.send('/me')).status).toBe(200);
  });

  it('when findById() does not hand the stored key back as sessionKey', async () => {
    class ForgetfulUsers extends KeyedUsers {
      override async findById(id: number): Promise<Credentials | undefined> {
        const found = await super.findById(id);
        return found && ({ user: found.user, passwordHash: found.passwordHash } as never);
      }
    }
    const users = new ForgetfulUsers();
    users.rows.set(2, { user: link, hash: null, key: null });
    const { browser } = await boot(drivers[0]!, users);
    const laptop = browser();
    await laptop.send('/as/2', { method: 'POST' });
    const body = await (await laptop.send('/end-other-sessions', { method: 'POST' })).json();
    expect(body, JSON.stringify(body)).toMatchObject({ error: expect.stringMatching(/does not hand it back as sessionKey/) });
  });
});

describe('a request that checked its session before AccountSessions.end() ran', () => {
  const ada = { id: 4, name: 'Ada', email: 'ada@example.com' };
  async function racing(action: 'key' | 'password' | 'others') {
    const users = new KeyedUsers();
    const { browser, hasher, accounts } = await boot(drivers[0]!, users);
    users.rows.set(4, { user: ada, hash: await hasher.make('secret'), key: null });
    const laptop = browser();
    await laptop.send('/login', { method: 'POST', json: { email: ada.email, password: 'secret' } });
    expect((await laptop.send('/me')).status, 'signed in').toBe(200);
    users.between = async () => {
      await accounts.end(4);
    };
    const response = await laptop.send(`/race/${action}`, { method: 'POST', json: {} });
    return { users, laptop, response };
  }

  it('auth.updateSessionKey() answers false and signs the request out — it does not bind itself to the new key', async () => {
    const { users, laptop, response } = await racing('key');
    expect(await response.json()).toEqual({ result: false });
    const stored = users.rows.get(4)!.key;
    expect(stored).toMatch(/^[\w-]{43}$/);
    expect((await laptop.send('/me')).status).toBe(401);
    expect(users.rows.get(4)!.key, 'the key of end() stays').toBe(stored);
  });

  it('updatePassword() does not bind the session to the state it did not check', async () => {
    const { laptop } = await racing('password');
    expect((await laptop.send('/me')).status).toBe(401);
  });

  it('signing out the other devices does not bind the session to the state it did not check', async () => {
    const { laptop } = await racing('others');
    expect((await laptop.send('/me')).status).toBe(401);
  });
});

describe('the compare-and-set contract of updateSessionKey', () => {
  it('a provider that answers with nothing (the old contract) is refused, with the remedy', async () => {
    class OldContract extends KeyedUsers {
      override async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
        await super.updateSessionKey(id, key, expected);
        return undefined as never;
      }
    }
    const users = new OldContract();
    users.rows.set(2, { user: link, hash: null, key: null });
    const { browser } = await boot(drivers[0]!, users);
    const laptop = browser();
    await laptop.send('/as/2', { method: 'POST' });
    const body = await (await laptop.send('/end-other-sessions', { method: 'POST' })).json();
    expect(body, JSON.stringify(body)).toMatchObject({ error: expect.stringMatching(/must return whether it stored the key/) });
  });
});

describe('a remember-me sign-in that is running while the account changes', () => {
  const ada = { id: 4, name: 'Ada', email: 'ada@example.com' };
  it.each(['key', 'password', 'others'] as const)('stays a guest when the change is %s: the tokens are gone before the new hash or key is written', async (action) => {
    const users = new KeyedUsers();
    const { browser, hasher } = await boot(drivers[0]!, users);
    users.rows.set(4, { user: ada, hash: await hasher.make('secret'), key: null });
    const laptop = browser();
    await laptop.send('/login', { method: 'POST', json: { email: ada.email, password: 'secret' } });
    const phone = browser();
    await phone.send('/as/4', { method: 'POST', headers: { 'x-remember': 'yes' } });
    const cookie = phone.jar.get('marmeon_remember')!;
    expect(cookie).toBeDefined();
    let who: unknown;
    // The phone's sign-in lands right after the new hash or key was written: it reads the new state.
    users.afterWrite = async () => {
      who = await (await browser(new Map([['marmeon_remember', cookie]])).send('/who')).json();
    };
    await laptop.send(`/race/${action}`, { method: 'POST', json: {} });
    expect(who).toEqual({ id: null });
  });
});

describe('what a provider answers after the key was written', () => {
  it('a compare-and-set that says true without writing is refused', async () => {
    class Liar extends KeyedUsers {
      override async updateSessionKey(): Promise<boolean> {
        return true;
      }
    }
    const users = new Liar();
    users.rows.set(2, { user: link, hash: null, key: 'k'.repeat(40) });
    const { browser } = await boot(drivers[0]!, users);
    const laptop = browser();
    await laptop.send('/as/2', { method: 'POST' });
    const body = await (await laptop.send('/end-other-sessions', { method: 'POST' })).json();
    expect(body, JSON.stringify(body)).toMatchObject({ error: expect.stringMatching(/does not hand it back as sessionKey/) });
  });

  it('a conflict whose stored key the provider does not hand back is an error, not a silent sign-out', async () => {
    class Hiding extends KeyedUsers {
      override async findById(id: number): Promise<Credentials | undefined> {
        const found = await super.findById(id);
        return found && { user: found.user, passwordHash: found.passwordHash, sessionKey: found.sessionKey };
      }
      override async updateSessionKey(): Promise<boolean> {
        return false;
      }
    }
    const users = new Hiding();
    users.rows.set(2, { user: link, hash: null, key: null });
    const { browser } = await boot(drivers[0]!, users);
    const laptop = browser();
    await laptop.send('/as/2', { method: 'POST' });
    const body = await (await laptop.send('/end-other-sessions', { method: 'POST' })).json();
    expect(body, JSON.stringify(body)).toMatchObject({ error: expect.stringMatching(/does not hand it back as sessionKey/) });
  });
});
