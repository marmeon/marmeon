import { AccountSessions, Auth, AuthServiceProvider, Hasher, PasswordBroker, UserProvider, type AuthUserId, type PasswordHash } from '@marmeon/auth';
import { onPasswordReset } from '@marmeon/auth/internal';
import { CacheServiceProvider } from '@marmeon/cache';
import { ConsoleLogger, createApplication, defineModule, EventDispatcher, type Application, type Container, type ServiceProvider } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { FetchServiceProvider } from '@marmeon/fetch';
import { Controller, defineRoutes, everyone, HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { OAuthServiceProvider } from '../provider.ts';
import { drivers, PGSQL_URL } from '../__fixtures__/databases.ts';
import { definition, providerBringing } from '../test-helpers/app.ts';
import { marked } from '../test-helpers/social-accounts.ts';
import { SocialAccountLinked } from './events.ts';
import { SocialAccountsServiceProvider } from './provider.ts';
import { SocialAccounts } from './social-accounts.ts';
import { SocialAccountStore } from './store.ts';
import { SocialUserProvider } from './users.ts';

// SocialAccounts.link() under the claim of the account, on a booted app with the real Auth: the session key lives in the `users` table,
// so the compare-and-set of the claim is a real statement (on Postgres, one that waits for a lock another transaction holds).

const AUTH_TABLES = new URL('../../../auth/src/__fixtures__/migrations/', import.meta.url);
const STUB = new URL('../../stubs/migrations/', import.meta.url);
const PASSWORD = 'a password that is long enough';

interface Account {
  id: number;
  email: string;
  email_verified_at: Date | null;
  hash: PasswordHash | null;
}

/** The app's users: the rows of `users` hold the session key (a real column), the rest lives in memory. */
class Users {
  readonly accounts = new Map<number, Account>();
  connections!: Connections;

  async #credentials(account: Account | undefined) {
    if (account === undefined) return undefined;
    const found = await sql<{ session_key: string | null }>`select session_key from users where id = ${account.id}`.execute(this.connections.get());
    return { user: { id: account.id, email: account.email, email_verified_at: account.email_verified_at }, passwordHash: account.hash, sessionKey: found.rows[0]?.session_key ?? null };
  }
  async findById(id: number) {
    return this.#credentials(this.accounts.get(id));
  }
  async findForSignIn(email: string) {
    return this.#credentials([...this.accounts.values()].find((account) => account.email === email));
  }
  async updatePasswordHash(id: number, hash: PasswordHash, options: { sessionKey?: string; expected?: PasswordHash } = {}) {
    const account = this.accounts.get(id);
    if (account === undefined) return false;
    account.hash = hash;
    if (options.sessionKey !== undefined) await this.updateSessionKey(id, options.sessionKey, undefined);
    return true;
  }
  /** Compare-and-set on the column: `undefined` writes whatever stands, `null` expects none. The same key as expected writes nothing new and still takes the row's lock. */
  async updateSessionKey(id: number, key: string, expected: string | null | undefined) {
    const db = this.connections.get();
    const written =
      expected === undefined
        ? await sql`update users set session_key = ${key} where id = ${id}`.execute(db)
        : expected === null
          ? await sql`update users set session_key = ${key} where id = ${id} and session_key is null`.execute(db)
          : await sql`update users set session_key = ${key} where id = ${id} and session_key = ${expected}`.execute(db);
    return Number(written.numAffectedRows ?? 0) > 0;
  }
  async updateEverySessionKey() {
    return { accounts: 0, sampleId: undefined };
  }
}

const users = new Users();
const hooks = {
  /** Runs once, at the first `emailConfirmed()` of a link: after the checks of the request, before its transaction. */
  afterFirstCheck: undefined as undefined | (() => Promise<void>),
  /** Runs inside the transaction of a password reset, after the removal of the links and the new key. */
  inReset: undefined as undefined | (() => Promise<void>),
};

class TestAppProvider implements ServiceProvider {
  register(container: Container): void {
    container.bind(UserProvider, () => users as never);
    container.bind(SocialUserProvider, () => ({
      findByEmail: async () => undefined,
      create: async () => ({ ok: false, error: { kind: 'duplicate' } }),
      emailConfirmed: async (user: { email_verified_at: Date | null }) => {
        const hook = hooks.afterFirstCheck;
        hooks.afterFirstCheck = undefined;
        await hook?.();
        return user.email_verified_at !== null;
      },
    }) as never);
    onPasswordReset(container, 'claim-test', async () => {
      await hooks.inReset?.();
    });
  }
}

class Login extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    const signedIn = await this.#auth.attempt('user1@example.com', PASSWORD);
    return { signedIn: signedIn.ok };
  }
}

class Link extends Controller {
  readonly #auth: Auth;
  readonly #accounts: SocialAccounts;
  constructor(auth: Auth, accounts: SocialAccounts) {
    super();
    this.#auth = auth;
    this.#accounts = accounts;
  }
  async handle() {
    const userId = await this.#auth.id();
    const linked = await this.#accounts.link(marked('link', { id: 'gh-1' }, String(userId)));
    return { link: linked.ok ? 'ok' : linked.error.kind, signedIn: await this.#auth.check() };
  }
}

class Status extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { signedIn: await this.#auth.check() };
  }
}

const routes = defineRoutes((Root) => {
  const Route = Root.authorize(everyone);
  Route.post('/login', Login);
  Route.post('/link', Link);
  Route.post('/status', Status);
});

describe.each(drivers)('SocialAccounts.link() under the claim of the account, on a booted app on %s', (driver) => {
  let app: Application;
  let dropDatabase = async () => {};
  let store: SocialAccountStore;
  let kernel: ReturnType<typeof createHttpKernel>;
  let linkedEvents: () => number;

  const db = () => app.container.make(Connections).get<any>();
  const add = async (sessionKey: string | null = 'key-0'): Promise<Account> => {
    const account: Account = { id: 1, email: 'user1@example.com', email_verified_at: new Date(), hash: await app.container.make(Hasher).make(PASSWORD) };
    users.accounts.set(1, account);
    await sql`insert into users (id, session_key) values (1, ${sessionKey})`.execute(db());
    return account;
  };
  const rows = async () => (await db().selectFrom('social_accounts').selectAll().execute()).length;

  /** A browser with its own cookies, signed in with the password (which confirms it). */
  const browser = async () => {
    const jar = new Map<string, string>();
    const send = async <T = Record<string, unknown>>(path: string): Promise<T> => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: 'POST', headers: { cookie, accept: 'application/json', 'content-type': 'application/json' }, body: '{}', redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        jar.set(name, value);
      }
      return (await response.json()) as T;
    };
    expect(await send('/login')).toEqual({ signedIn: true });
    return { send };
  };
  const resetFor = async (account: Account) => {
    const broker = app.container.createScope().make(PasswordBroker);
    const created = await broker.createToken(account.email);
    if (!created.ok) throw new Error('no token');
    return broker.reset(account.email, created.value.token, `${PASSWORD} again`);
  };

  beforeEach(async () => {
    users.accounts.clear();
    hooks.afterFirstCheck = undefined;
    hooks.inReset = undefined;
    let database: Record<string, string> = { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:' };
    if (driver === 'pgsql') {
      const name = `marmeon_oauth_claim_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
    const hub = () =>
      definition({
        label: 'Hub',
        endpoints: { authorizeUrl: 'https://gh.example.com/authorize', tokenUrl: 'https://gh.example.com/token' },
        profile: async () => ({ id: 'gh-1' }),
        mapUser: (raw) => ({ id: (raw as { id: string }).id, email: null, emailVerified: false, name: null, nickname: 'hub', avatar: null }),
      });
    app = await createApplication(
      {
        root: workspaceTempDir('marmeon-oauth-claim-'),
        discover: false,
        providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider, FetchServiceProvider, OAuthServiceProvider, providerBringing('Providers', { gh: hub }), SocialAccountsServiceProvider, TestAppProvider],
        modules: [defineModule({ name: 'auth-claim-test', routes, migrations: AUTH_TABLES })],
      },
      {
        env: { NODE_ENV: 'test', APP_KEY: generateKey(), APP_URL: 'https://app.example.com', OAUTH_GH_CLIENT_ID: 'client', OAUTH_GH_CLIENT_SECRET: 'secret', SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', ...database, HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1', CACHE_DRIVER: 'memory' },
        override: (container: Container) => {
          container.make(CsrfProtection).disable();
        },
      },
    );
    await app.container.make(Migrator).migrate();
    // A second run: the stub's name sorts before the tables it points at, and Postgres checks the foreign key when the table is made.
    await new Migrator({ modules: [{ name: 'oauth', migrations: STUB }], root: '/' } as unknown as Application, app.container.make(Connections)).migrate();
    users.connections = app.container.make(Connections);
    store = app.container.make(SocialAccountStore);
    kernel = createHttpKernel(app);
    const dispatch = vi.spyOn(EventDispatcher.prototype, 'dispatch');
    linkedEvents = () => dispatch.mock.calls.filter(([event]) => event instanceof SocialAccountLinked).length;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app[Symbol.asyncDispose]();
    await dropDatabase();
    dropDatabase = async () => {};
  });

  it('links and dispatches one event when nothing ends the session', async () => {
    await add();
    const b = await browser();
    expect(await b.send('/link')).toEqual({ link: 'ok', signedIn: true });
    expect(await rows()).toBe(1);
    expect(linkedEvents()).toBe(1);
  });

  it('links nothing when AccountSessions.end() lands after the checks and before the transaction, and the request is signed out', async () => {
    await add();
    const b = await browser();
    hooks.afterFirstCheck = async () => {
      expect((await app.container.createScope().make(AccountSessions).end(1 as AuthUserId)).ok).toBe(true);
    };
    expect(await b.send('/link')).toEqual({ link: 'signed-out', signedIn: false });
    expect(await rows()).toBe(0);
    expect(linkedEvents()).toBe(0);
    expect(await b.send('/status')).toEqual({ signedIn: false });
  });

  it('links nothing when a password reset of a now unconfirmed address lands after the checks, and no link survives', async () => {
    const account = await add();
    // A link the reset takes out: the address is unconfirmed when it runs.
    await store.create(1 as AuthUserId, marked('link', { id: 'gl-1', provider: 'gitlab' }, '1'));
    const b = await browser();
    hooks.afterFirstCheck = async () => {
      account.email_verified_at = null;
      expect((await resetFor(account)).ok).toBe(true);
    };
    expect(await b.send('/link')).toEqual({ link: 'signed-out', signedIn: false });
    expect(await rows()).toBe(0);
    expect(linkedEvents()).toBe(0);
    expect(await b.send('/status')).toEqual({ signedIn: false });
  });

  it.runIf(driver === 'pgsql')('waits for a reset that holds the row of the account, then sees the rotated key and links nothing', async () => {
    const account = await add();
    const b = await browser();
    let held!: () => void;
    const reachedHold = new Promise<void>((resolve) => (held = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Inside the reset's transaction, after it wrote the new key: the row of the account stays locked until the gate opens.
    hooks.inReset = async () => {
      held();
      await gate;
    };
    const resetting = resetFor(account);
    await reachedHold;
    hooks.inReset = undefined;

    let settled = false;
    const linking = b.send<{ link: string; signedIn: boolean }>('/link').finally(() => (settled = true));
    let lockSeen = false;
    try {
      // Until a statement is seen waiting for a lock (the claim) or the request is over: state, not a pause.
      const waiting = async () => Number((await sql<{ n: string }>`select count(*) as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`.execute(db())).rows[0]!.n) > 0;
      for (let tries = 0; !settled && !lockSeen && tries < 2000; tries += 1) {
        lockSeen = await waiting();
        if (!lockSeen) await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      // Whatever the checks above did, the reset's transaction ends here.
      release();
    }
    expect((await resetting).ok).toBe(true);
    expect(await linking).toEqual({ link: 'signed-out', signedIn: false });
    expect(lockSeen).toBe(true);
    expect(await rows()).toBe(0);
    expect(linkedEvents()).toBe(0);
  });

  /**
   * Runs `act` at the first read of the account after the link was inserted: with no other read in between, that is the check after the commit
   * (outside the transaction), so the moment needs no timing.
   */
  const afterCommitRead = (act: () => Promise<void>) => {
    let armed = false;
    const read = users.findById.bind(users);
    users.findById = async (id: number) => {
      if (armed) {
        armed = false;
        await act();
      }
      return read(id);
    };
    const create = SocialAccountStore.prototype.create;
    vi.spyOn(SocialAccountStore.prototype, 'create').mockImplementationOnce(async function (this: SocialAccountStore, ...args) {
      const written = await create.apply(this, args);
      armed = true;
      return written;
    });
    return () => {
      users.findById = read;
    };
  };

  it('takes the link out when the check after the commit throws, with the real Auth: no row, no event', async () => {
    await add();
    const b = await browser();
    const restore = afterCommitRead(async () => {
      throw new Error('read failed after the commit');
    });
    try {
      expect(await b.send('/link')).toMatchObject({ message: 'Server Error' });
    } finally {
      restore();
    }
    expect(await rows()).toBe(0);
    expect(linkedEvents()).toBe(0);
  });

  it('takes the link out of an account without a session key when its session ends right after the commit: no event, signed-out', async () => {
    await add(null);
    const b = await browser();
    const restore = afterCommitRead(async () => {
      expect((await app.container.createScope().make(AccountSessions).end(1 as AuthUserId)).ok).toBe(true);
    });
    try {
      expect(await b.send('/link')).toEqual({ link: 'signed-out', signedIn: false });
    } finally {
      restore();
    }
    expect(await rows()).toBe(0);
    expect(linkedEvents()).toBe(0);
    expect(await b.send('/status')).toEqual({ signedIn: false });
  });
});
