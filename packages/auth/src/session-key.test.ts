import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, defineModule, type Container } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, Schema } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { RedisServiceProvider } from '@marmeon/redis';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionConfig, SessionServiceProvider, SessionStore } from '@marmeon/session';
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import { freshPgsqlDatabase, PGSQL_URL } from './__fixtures__/databases.ts';
import { Auth, authenticate, AuthServiceProvider, Hasher, sessionFingerprint, UserProvider, type AuthUser, type Credentials, type PasswordHash } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;
const SESSIONS_MIGRATION = new URL('../../session/stubs/migrations/create_sessions_table.ts', import.meta.url);

/** Accounts in memory, with a session key each — what an app's repository keeps in a `session_key` column. */
class KeyedUsers implements UserProvider {
  readonly rows = new Map<number, { user: AuthUser; hash: PasswordHash | null; key: string | null }>();

  async findById(id: number): Promise<Credentials | undefined> {
    const row = this.rows.get(id);
    return row && { user: row.user, passwordHash: row.hash, sessionKey: row.key };
  }
  async findForLogin(email: string): Promise<Credentials | undefined> {
    for (const row of this.rows.values()) if (row.user.email === email) return { user: row.user, passwordHash: row.hash, sessionKey: row.key };
    return undefined;
  }
  async updatePasswordHash(id: number, hash: PasswordHash): Promise<void> {
    this.rows.get(id)!.hash = hash;
  }
  async updateSessionKey(id: number, key: string): Promise<void> {
    this.rows.get(id)!.key = key;
  }
}

/** Accounts without a session key — the provider an app had before it wanted passwordless sign-out. */
class PlainUsers implements UserProvider {
  readonly rows = new Map<number, AuthUser>();
  async findById(id: number): Promise<Credentials | undefined> {
    const user = this.rows.get(id);
    return user && { user, passwordHash: null };
  }
  async findForLogin(): Promise<Credentials | undefined> {
    return undefined;
  }
  async updatePasswordHash(): Promise<void> {}
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
      await this.#auth.updateSessionKey();
      return { done: true };
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
    const signedIn = await this.#auth.attempt(email, password);
    return { user: signedIn.ok ? signedIn.value.id : null };
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

const routes = openRoutes((Route) => {
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
  /** The class of the store the app ends up with — the driver really is the one named (the cookie store exists per request only). */
  readonly store?: string;
  readonly env: () => Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }>;
  readonly providers?: readonly (typeof RedisServiceProvider)[];
  readonly sessionsTable?: boolean;
}

const drivers: Driver[] = [
  { name: 'memory', store: 'MemorySessionStore', env: async () => ({ env: { SESSION_DRIVER: 'memory' }, cleanup: async () => {} }) },
  { name: 'cookie', env: async () => ({ env: { SESSION_DRIVER: 'cookie' }, cleanup: async () => {} }) },
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
    env: { APP_KEY: generateKey(), SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, ...(driver.providers ?? []), AuthServiceProvider],
    modules: [defineModule({ name: 'session-key-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
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
    const migration = ((await import(SESSIONS_MIGRATION.href)) as { default: { up(schema: Schema): Promise<void> } }).default;
    await migration.up(new Schema(connections.get(), connections.options('default').driver));
  }
  expect(application.container.make(SessionConfig).driver).toBe(env.SESSION_DRIVER);
  if (driver.store) expect(application.container.make(SessionStore).constructor.name, driver.name).toBe(driver.store);
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
  return { browser, hasher: application.container.make(Hasher) };
}

const link: AuthUser = { id: 2, name: 'Link', email: 'link@example.com' };
const zelda: AuthUser = { id: 3, name: 'Zelda', email: 'zelda@example.com' };

describe('the fingerprint of an account', () => {
  it('differs between two accounts without a password, and changes with the session key or the hash', () => {
    const of = (user: AuthUser, passwordHash: PasswordHash | null, sessionKey?: string | null) => sessionFingerprint({ user, passwordHash, sessionKey });
    expect(of(link, null), 'two passwordless accounts').not.toBe(of(zelda, null));
    expect(of(link, null, 'key-1')).not.toBe(of(link, null, 'key-2'));
    expect(of(link, null, 'key-1')).not.toBe(of(link, null));
    expect(of(link, '$argon2id$a' as PasswordHash)).not.toBe(of(link, '$argon2id$b' as PasswordHash));
    // No key and an empty one are the same account state; the hash never goes into the session as it is.
    expect(of(link, null)).toBe(of(link, null, null));
    expect(of(link, '$argon2id$a' as PasswordHash)).not.toContain('argon2');
  });

  it('types: the session key and updateSessionKey are optional — a provider without them still is one', () => {
    expectTypeOf<{ user: AuthUser; passwordHash: null }>().toMatchTypeOf<Credentials>();
    expectTypeOf<PlainUsers>().toMatchTypeOf<UserProvider>();
    expectTypeOf<Credentials['sessionKey']>().toEqualTypeOf<string | null | undefined>();
    class WrongKey extends PlainUsers {
      async updateSessionKey(_id: number, _key: number): Promise<void> {}
    }
    // @ts-expect-error — the key is a string
    expectTypeOf<WrongKey>().toMatchTypeOf<UserProvider>();
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
    const phoneRemember = phone.jar.get('remember_web');
    expect(phoneRemember, 'the phone has a remember-me cookie').toBeDefined();
    expect((await phone.send('/me')).status).toBe(200);

    expect(await (await laptop.send('/end-other-sessions', { method: 'POST' })).json()).toEqual({ done: true });
    expect(users.rows.get(2)!.key, 'a new key is stored').toMatch(/^[\w-]{43}$/);
    expect((await laptop.send('/me')).status, 'this session').toBe(200);
    expect((await phone.send('/me')).status, 'the other session').toBe(401);
    expect(await (await browser(new Map([['remember_web', phoneRemember!]])).send('/who')).json(), "the other device's remember-me token").toEqual({ id: null });
    expect((await other.send('/me')).status, "another account's session").toBe(200);

    // Again: the key changes every time.
    const first = users.rows.get(2)!.key;
    await laptop.send('/end-other-sessions', { method: 'POST' });
    expect(users.rows.get(2)!.key).not.toBe(first);
    expect((await laptop.send('/me')).status).toBe(200);
  });
});

describe('a password sign-in after a new session key', () => {
  it('stamps the fingerprint from findById(), as login() does — a provider that leaves the key out of findForLogin() keeps its sign-ins', async () => {
    class KeylessLogin extends KeyedUsers {
      override async findForLogin(email: string): Promise<Credentials | undefined> {
        const found = await super.findForLogin(email);
        return found && { user: found.user, passwordHash: found.passwordHash };
      }
    }
    const users = new KeylessLogin();
    const { browser, hasher } = await boot(drivers[0]!, users);
    users.rows.set(4, { user: { id: 4, name: 'Ada', email: 'ada@example.com' }, hash: await hasher.make('secret'), key: 'a-rotated-key' });
    const laptop = browser();
    expect(await (await laptop.send('/login', { method: 'POST', json: { email: 'ada@example.com', password: 'secret' } })).json()).toEqual({ user: 4 });
    expect((await laptop.send('/me')).status, 'the next request after the sign-in').toBe(200);
  });
});

describe('auth.updateSessionKey() fails loudly', () => {
  it('when the UserProvider cannot store a key — naming what to implement', async () => {
    const users = new PlainUsers();
    users.rows.set(2, link);
    const { browser } = await boot(drivers[0]!, users);
    const laptop = browser();
    await laptop.send('/as/2', { method: 'POST' });
    const body = await (await laptop.send('/end-other-sessions', { method: 'POST' })).json();
    expect(body, JSON.stringify(body)).toMatchObject({ error: expect.stringMatching(/updateSessionKey\(id, key\)/) });
    expect((await laptop.send('/me')).status).toBe(200);
  });

  it('when findById() does not hand the stored key back as sessionKey', async () => {
    class ForgetfulUsers extends KeyedUsers {
      override async findById(id: number): Promise<Credentials | undefined> {
        const found = await super.findById(id);
        return found && { user: found.user, passwordHash: found.passwordHash };
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
