import { AuthServiceProvider, PasswordBroker, UserProvider, type AuthUserId, type PasswordHash } from '@marmeon/auth';
import { onPasswordReset } from '@marmeon/auth/internal';
import { CacheServiceProvider } from '@marmeon/cache';
import { ConsoleLogger, createApplication, type Application, type Container, type ServiceProvider } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { drivers, PGSQL_URL } from '../__fixtures__/databases.ts';
import { marked } from '../test-helpers/social-accounts.ts';
import { SocialAccountsServiceProvider } from './provider.ts';
import { SocialAccountStore } from './store.ts';

// The migrations of the auth package's own tests (its tables) and the stub of this one.
const AUTH_TABLES = new URL('../../../auth/src/__fixtures__/migrations/', import.meta.url);
const STUB = new URL('../../stubs/react/modules/oauth/migrations/', import.meta.url);

interface Account {
  id: number;
  email: string;
  email_verified_at: Date | null;
  hash: PasswordHash | null;
  key: string | null;
}

/** The app's users, in memory: the rows of `users` the links point at are inserted next to them. */
class Users {
  readonly accounts = new Map<number, Account>();
  /** What a write of the hash also does to the account: an app whose reset writes confirm the address. */
  confirmOnWrite = false;

  #credentials(account: Account | undefined) {
    return account && { user: { id: account.id, email: account.email, email_verified_at: account.email_verified_at }, passwordHash: account.hash, sessionKey: account.key };
  }
  async findById(id: number) {
    return this.#credentials(this.accounts.get(id));
  }
  async findForSignIn(email: string) {
    return this.#credentials([...this.accounts.values()].find((account) => account.email === email));
  }
  async updatePasswordHash(id: number, hash: PasswordHash, options: { sessionKey?: string } = {}) {
    const account = this.accounts.get(id);
    if (account === undefined) return false;
    account.hash = hash;
    if (options.sessionKey !== undefined) account.key = options.sessionKey;
    if (this.confirmOnWrite) account.email_verified_at = new Date();
    return true;
  }
  async updateSessionKey() {
    return false;
  }
  async updateEverySessionKey() {
    return { accounts: 0, sampleId: undefined };
  }
}

const users = new Users();
const hooks = { later: undefined as undefined | (() => Promise<void>), ran: [] as string[] };

/** Binds the app's users, and claims a second hook after the one of the oauth provider (providers register in the order listed). */
class TestAppProvider implements ServiceProvider {
  register(container: Container): void {
    container.bind(UserProvider, () => users as never);
    onPasswordReset(container, 'later', async () => {
      hooks.ran.push('later');
      await hooks.later?.();
    });
  }
}

describe.each(drivers)('a password reset on a booted app on %s removes the linked provider accounts of an unconfirmed account', (driver) => {
  let app: Application;
  let dropDatabase = async () => {};
  let store: SocialAccountStore;
  const add = async (account: Partial<Account> & { id: number }) => {
    const full: Account = { email: `user${account.id}@example.com`, email_verified_at: null, hash: null, key: null, ...account };
    users.accounts.set(full.id, full);
    await app.container.make(Connections).get<any>().insertInto('users').values({ id: full.id }).execute();
    await store.create(full.id as AuthUserId, marked('link', { id: `gh-${full.id}`, email: full.email }));
    return full;
  };
  const resetFor = async (account: Account) => {
    const broker = app.container.createScope().make(PasswordBroker);
    const created = await broker.createToken(account.email);
    if (!created.ok) throw new Error('no token');
    return broker.reset(account.email, created.value.token, 'a new password that is long enough');
  };
  const linked = async (id: number) => (await store.forUser(id as AuthUserId)).length;

  beforeEach(async () => {
    users.accounts.clear();
    users.confirmOnWrite = false;
    hooks.later = undefined;
    hooks.ran.length = 0;
    // Postgres: a database of its own per run and the pool of the app, so the removal has to join the transaction of the reset to roll back with it.
    let database: Record<string, string> = { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:' };
    if (driver === 'pgsql') {
      const name = `marmeon_oauth_reset_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: new ConsoleLogger() });
      await sql`create database ${sql.id(name)}`.execute(admin.get());
      const url = new URL(PGSQL_URL!);
      url.pathname = `/${name}`;
      database = { DB_DRIVER: 'pgsql', DB_URL: url.href };
      dropDatabase = async () => {
        await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
        await admin.destroy();
      };
    }
    app = await createApplication(
      {
        root: workspaceTempDir('marmeon-oauth-reset-'),
        discover: false,
        providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider, SocialAccountsServiceProvider, TestAppProvider],
        modules: [{ name: 'auth', migrations: AUTH_TABLES }],
      },
      { env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', ...database, HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1', CACHE_DRIVER: 'memory' } },
    );
    await app.container.make(Migrator).migrate();
    // A second run: the stub's name sorts before the tables it points at, and Postgres checks the foreign key when the table is made.
    await new Migrator({ modules: [{ name: 'oauth', migrations: STUB }], root: '/' } as unknown as Application, app.container.make(Connections)).migrate();
    store = app.container.make(SocialAccountStore);
  });
  afterEach(async () => {
    await app[Symbol.asyncDispose]();
    await dropDatabase();
    dropDatabase = async () => {};
  });

  it('removes the links when the address is not confirmed, in the reset of the public PasswordBroker', async () => {
    const squatter = await add({ id: 1, email_verified_at: null });
    expect(await linked(1)).toBe(1);
    expect((await resetFor(squatter)).ok).toBe(true);
    expect(await linked(1)).toBe(0);
    expect(hooks.ran).toEqual(['later']);
  });

  it('keeps the links when the address is confirmed', async () => {
    const owner = await add({ id: 1, email_verified_at: new Date() });
    expect((await resetFor(owner)).ok).toBe(true);
    expect(await linked(1)).toBe(1);
  });

  it('removes the links when the write of the new password is what confirms the address', async () => {
    users.confirmOnWrite = true;
    const squatter = await add({ id: 1, email_verified_at: null });
    expect((await resetFor(squatter)).ok).toBe(true);
    expect(users.accounts.get(1)!.email_verified_at).not.toBeNull();
    expect(await linked(1)).toBe(0);
  });

  it('fails the reset and keeps the links when a hook after the removal throws', async () => {
    const squatter = await add({ id: 1, email_verified_at: null });
    hooks.later = async () => {
      throw new Error('second hook failed');
    };
    await expect(resetFor(squatter)).rejects.toThrow('second hook failed');
    // The removal ran first and was rolled back with the rest of the reset.
    expect(await linked(1)).toBe(1);
  });
});
