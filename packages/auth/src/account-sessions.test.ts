import { createApplication, defineModule, err, ok, type Container } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator, Connections, Schema } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AccountSessions, Auth, authenticate, AuthServiceProvider, UserProvider, type AuthUser, type Credentials } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const SESSIONS_MIGRATION = new URL('../../session/stubs/migrations/create_sessions_table.ts', import.meta.url);

/** Accounts in memory, with a session key; `KeylessUsers` cannot store one. */
class Users implements UserProvider {
  readonly rows = new Map<number, { user: AuthUser; key: string | null }>();
  /** Runs once, after the next `findById()` has read its row — a request of another process landing at that moment. */
  after: (() => Promise<unknown>) | undefined;

  async findById(id: number): Promise<Credentials | undefined> {
    const row = this.rows.get(id);
    const found = row && { user: row.user, passwordHash: null, sessionKey: row.key };
    const hook = this.after;
    this.after = undefined;
    await hook?.();
    return found;
  }
  async findForLogin(): Promise<Credentials | undefined> {
    return undefined;
  }
  async updatePasswordHash(): Promise<void> {}
  async updateSessionKey(id: number, key: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.key = key;
  }
}

class KeylessUsers extends Users {
  // @ts-expect-error — a provider that cannot store a key has no such method
  override updateSessionKey = undefined;
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
    await this.#auth.login(found!.user, { remember: true });
    return { ok: true };
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
  Route.middleware(authenticate()).get('/me', (ctx) => ({ id: ctx.user.id }));
});

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

async function boot(users: UserProvider, driver: 'memory' | 'database' = 'memory') {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: driver, SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'account-sessions-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users);
    },
  });
  await application.container.make(Migrator).migrate();
  if (driver === 'database') {
    const connections = application.container.make(Connections);
    const migration = ((await import(SESSIONS_MIGRATION.href)) as { default: { up(schema: Schema): Promise<void> } }).default;
    await migration.up(new Schema(connections.get(), connections.options('default').driver));
  }
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
  return { browser, accounts: application.container.make(AccountSessions), connections: application.container.make(Connections) };
}

const rememberWho = async (browser: Awaited<ReturnType<typeof boot>>['browser'], cookie: string) =>
  (await (await browser(new Map([['remember_web', cookie]])).send('/who')).json()) as { id: number | null };

describe('AccountSessions.end()', () => {
  it('ends every session of the account and its remember-me cookies, and spares other accounts', async () => {
    const users = new Users();
    users.rows.set(1, { user: ada, key: null });
    users.rows.set(2, { user: { id: 2, name: 'Bob', email: 'bob@example.com' }, key: null });
    const { browser, accounts } = await boot(users);
    const laptop = browser();
    const phone = browser();
    const bob = browser();
    await laptop.send('/as/1', { method: 'POST' });
    await phone.send('/as/1', { method: 'POST' });
    await bob.send('/as/2', { method: 'POST' });
    const cookie = laptop.jar.get('remember_web')!;
    const other = phone.jar.get('remember_web')!;
    expect(cookie).toBeDefined();
    expect((await laptop.send('/me')).status, 'before').toBe(200);

    expect(await accounts.end(1)).toEqual(ok({ removed: 0 }));
    expect((await laptop.send('/me')).status).toBe(401);
    expect((await phone.send('/me')).status).toBe(401);
    expect(await rememberWho(browser, cookie)).toEqual({ id: null });
    expect(await rememberWho(browser, other)).toEqual({ id: null });
    expect((await bob.send('/me')).status).toBe(200);
  });

  it('deletes the rows at once with the database driver', async () => {
    const users = new Users();
    users.rows.set(1, { user: ada, key: null });
    const { browser, accounts } = await boot(users, 'database');
    await browser().send('/as/1', { method: 'POST' });
    await browser().send('/as/1', { method: 'POST' });
    expect(await accounts.end(1)).toEqual(ok({ removed: 2 }));
  });

  it('answers missing for an id that is no account, and writes nothing', async () => {
    const users = new Users();
    users.rows.set(1, { user: ada, key: null });
    const { browser, accounts } = await boot(users);
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    const cookie = laptop.jar.get('remember_web')!;
    for (const id of [Number.NaN, '', Number.MAX_SAFE_INTEGER + 2, 1.5, 99]) {
      expect(await accounts.end(id as never), String(id)).toEqual(err({ kind: 'missing' }));
    }
    expect(users.rows.get(1)!.key, 'no key written').toBeNull();
    expect((await laptop.send('/me')).status).toBe(200);
    expect(await rememberWho(browser, cookie), 'the tokens stay').toEqual({ id: 1 });
  });

  it('throws inside a database transaction, before it writes anything', async () => {
    const users = new Users();
    users.rows.set(1, { user: ada, key: null });
    const { browser, accounts, connections } = await boot(users);
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    const cookie = laptop.jar.get('remember_web')!;
    await expect(connections.transaction(() => accounts.end(1))).rejects.toThrow(/outside a database transaction/);
    expect(users.rows.get(1)!.key).toBeNull();
    expect(await rememberWho(browser, cookie), 'the tokens stay').toEqual({ id: 1 });
  });

  it('throws before it writes anything when the provider cannot store a session key', async () => {
    const users = new KeylessUsers();
    users.rows.set(1, { user: ada, key: null });
    const { browser, accounts } = await boot(users, 'database');
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    const cookie = laptop.jar.get('remember_web')!;
    await expect(accounts.end(1)).rejects.toThrow(/updateSessionKey\(id, key\).*session_key/s);
    expect((await laptop.send('/me')).status, 'the session stays').toBe(200);
    expect(await rememberWho(browser, cookie), 'the tokens stay').toEqual({ id: 1 });
  });

  it('deletes the remember-me tokens before it touches the key: when the key cannot be replaced, no cookie signs in', async () => {
    class ForgetfulUsers extends Users {
      override async findById(id: number): Promise<Credentials | undefined> {
        const found = await super.findById(id);
        return found && { ...found, sessionKey: null };
      }
    }
    const users = new ForgetfulUsers();
    users.rows.set(1, { user: ada, key: null });
    const { browser, accounts } = await boot(users);
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    const cookie = laptop.jar.get('remember_web')!;
    await expect(accounts.end(1)).rejects.toThrow(/does not hand it back as sessionKey/);
    expect(await rememberWho(browser, cookie)).toEqual({ id: null });
  });

  it('a remember-me sign-in that is running when the account is ended stays a guest', async () => {
    const users = new Users();
    users.rows.set(1, { user: ada, key: null });
    const { browser, accounts } = await boot(users);
    const laptop = browser();
    await laptop.send('/as/1', { method: 'POST' });
    const cookie = laptop.jar.get('remember_web')!;
    // The sign-in has read the account (the old key) when another request ends everything.
    users.after = () => accounts.end(1);
    const reopened = browser(new Map([['remember_web', cookie]]));
    expect(await (await reopened.send('/who')).json()).toEqual({ id: null });
    expect((await reopened.send('/me')).status).toBe(401);
    expect(reopened.jar.has('remember_web')).toBe(false);
  });
});
