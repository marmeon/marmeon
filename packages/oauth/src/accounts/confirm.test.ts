import { Auth, AuthServiceProvider, UserProvider, type AuthUserId, type PasswordHash } from '@marmeon/auth';
import { CacheServiceProvider } from '@marmeon/cache';
import { Clock, ConsoleLogger, createApplication, defineModule, type Application, type Container, type ServiceProvider } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { FetchServiceProvider, HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { Controller, defineRoutes, everyone, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionConfig, sessionCookieName, SessionServiceProvider } from '@marmeon/session';
import { TestClock } from '@marmeon/core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { OAuth } from '../oauth.ts';
import { oidc } from '../oidc.ts';
import { OAuthServiceProvider } from '../provider.ts';
import { gitlab } from '../providers/gitlab.ts';
import { google } from '../providers/google.ts';
import { drivers, migratedConnections, PGSQL_URL } from '../__fixtures__/databases.ts';
import { definition, providerBringing } from '../test-helpers/app.ts';
import { tokenResponse } from '../test-helpers/callback.ts';
import { contextOf, DISCOVERY_URL, discoveryDocument, ISSUER, TOKEN_URL } from '../test-helpers/oidc.ts';
import { marked, world, type World } from '../test-helpers/social-accounts.ts';
import { SocialAccountsServiceProvider } from './provider.ts';
import { SocialAccounts } from './social-accounts.ts';
import { SocialAccountStore } from './store.ts';
import { SocialUserProvider } from './users.ts';

const confirming = (id: string, flowUserId: string | undefined, reauthenticatedAt: number | undefined, provider = 'idp') => marked('confirm', { id, provider }, flowUserId, reauthenticatedAt);

describe.each(drivers)('SocialAccounts.confirm() on %s', (driver) => {
  let close: () => Promise<void>;
  let connections: Connections;
  let w: World;
  const ago = (ms: number) => w.clock.now() - ms;

  beforeAll(async () => {
    ({ connections, close } = await migratedConnections(driver));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<any>().deleteFrom('social_accounts').execute();
    await connections.get<any>().deleteFrom('users').execute();
    w = world(connections, { active: ['idp', 'plain'], oidc: ['idp'] });
    w.clock.freeze(new Date('2030-01-01T12:00:00Z'));
    w.signInAs(await w.add({ id: 1 }));
    await w.add({ id: 2 });
    await w.store.create(1 as AuthUserId, marked('link', { id: 'idp-1', provider: 'idp' }, '1'));
    await w.store.create(2 as AuthUserId, marked('link', { id: 'idp-2', provider: 'idp' }, '2'));
  });

  it('opens the window for a linked account of the signed-in user, and hands the guard the time of the sign-in at the provider', async () => {
    w.clock.travel({ minutes: 1 });
    const at = ago(5_000);
    expect(await w.accounts.confirm(confirming('idp-1', '1', at))).toEqual({ ok: true, value: undefined });
    expect(w.state.proofs).toEqual([{ userId: '1', authenticatedAt: at }]);
    // What the provider reports is stored once the window is open, and no event goes out: the window is no change of the account.
    expect((await w.store.find('idp', 'idp-1'))?.lastUsedAt).toEqual(new Date(w.clock.now()));
    expect(w.state.events).toEqual([]);
  });

  it('answers signed-out for nobody and issues no proof', async () => {
    w.state.signedIn = undefined;
    expect(await w.accounts.confirm(confirming('idp-1', '1', ago(1_000)))).toEqual({ ok: false, error: { kind: 'signed-out' } });
    expect(w.state.proofs).toEqual([]);
  });

  it("answers not-linked for the result of another user's flow, and for a flow of nobody", async () => {
    expect(await w.accounts.confirm(confirming('idp-2', '2', ago(1_000)))).toEqual({ ok: false, error: { kind: 'not-linked' } });
    expect(await w.accounts.confirm(confirming('idp-1', undefined, ago(1_000)))).toEqual({ ok: false, error: { kind: 'not-linked' } });
    expect(w.state.proofs).toEqual([]);
  });

  it('a provider account of another user opens nothing, even in a flow of the signed-in user', async () => {
    const untouched = (await w.store.find('idp', 'idp-2'))?.lastUsedAt;
    w.clock.travel({ minutes: 1 });
    expect(await w.accounts.confirm(confirming('idp-2', '1', ago(1_000)))).toEqual({ ok: false, error: { kind: 'not-linked' } });
    expect(w.state.proofs).toEqual([]);
    expect((await w.store.find('idp', 'idp-2'))?.lastUsedAt).toEqual(untouched);
  });

  it('a provider account that is not linked opens nothing', async () => {
    expect(await w.accounts.confirm(confirming('idp-9', '1', ago(1_000)))).toEqual({ ok: false, error: { kind: 'not-linked' } });
    // The same id at another provider is another account.
    expect(await w.accounts.confirm(confirming('idp-1', '1', ago(1_000), 'other'))).toEqual({ ok: false, error: { kind: 'not-linked' } });
    expect(w.state.proofs).toEqual([]);
  });

  it('a result without the time of a fresh sign-in opens nothing', async () => {
    expect(await w.accounts.confirm(confirming('idp-1', '1', undefined))).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    expect(await w.accounts.confirm(confirming('idp-1', '1', Number.NaN))).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    expect(w.state.proofs).toEqual([]);
  });

  it('a sign-in at the provider that is older than a flow lives, or lies in the future, opens nothing', async () => {
    expect(await w.accounts.confirm(confirming('idp-1', '1', ago(11 * 60_000)))).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    expect(await w.accounts.confirm(confirming('idp-1', '1', w.clock.now() + 60_000))).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    expect(w.state.proofs).toEqual([]);
  });

  it('takes a sign-in at the provider up to the longest a flow and its callback can take, and not a millisecond older', async () => {
    // The 10 minutes of the flow, the 10 seconds the callback allows before the redirect, and 30 seconds for the callback itself.
    expect((await w.accounts.confirm(confirming('idp-1', '1', ago(640_000)))).ok).toBe(true);
    expect(await w.accounts.confirm(confirming('idp-1', '1', ago(640_001)))).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    expect(w.state.proofs).toHaveLength(1);
  });

  it('an id that is not well formed opens nothing and is not looked up', async () => {
    let looked = 0;
    const real = w.store.find.bind(w.store);
    w.store.find = async (...args) => {
      looked += 1;
      return real(...args);
    };
    expect(await w.accounts.confirm(confirming('idp-\ud800', '1', ago(1_000)))).toEqual({ ok: false, error: { kind: 'not-linked' } });
    expect(looked).toBe(0);
    expect(w.state.proofs).toEqual([]);
  });

  it('opens nothing for an account the store answers that is not the one named', async () => {
    // A lookup that is looser than an exact match (a collation, a normalisation) finds the account of the user for another id.
    const real = w.store.find.bind(w.store);
    w.store.find = async () => real('idp', 'idp-1');
    expect(await w.accounts.confirm(confirming('IDP-1', '1', ago(1_000)))).toEqual({ ok: false, error: { kind: 'not-linked' } });
    expect(await w.accounts.confirm(confirming('idp-1', '1', ago(1_000), 'other'))).toEqual({ ok: false, error: { kind: 'not-linked' } });
    expect(w.state.proofs).toEqual([]);
  });

  it('keeps the window open when refreshing the account fails afterwards, and logs the provider and a fixed reason only', async () => {
    w.store.touch = async () => {
      throw new Error('database down: password=hunter2');
    };
    expect(await w.accounts.confirm(confirming('idp-1', '1', ago(1_000)))).toEqual({ ok: true, value: undefined });
    expect(w.state.proofs).toHaveLength(1);
    expect(w.state.logs).toEqual([{ level: 'warn', message: 'Refreshing a linked provider account after a confirmation failed.', context: { provider: 'idp', reason: 'touch' } }]);
  });

  it('answers expired when the guard refuses the proof, and stores nothing', async () => {
    w.state.windowOpens = false;
    const untouched = (await w.store.find('idp', 'idp-1'))?.lastUsedAt;
    w.clock.travel({ minutes: 1 });
    expect(await w.accounts.confirm(confirming('idp-1', '1', ago(1_000)))).toEqual({ ok: false, error: { kind: 'expired' } });
    expect(w.state.proofs).toHaveLength(1);
    expect((await w.store.find('idp', 'idp-1'))?.lastUsedAt).toEqual(untouched);
  });

  it('a sign-in or link result passed to confirm() throws and opens nothing', async () => {
    await expect(w.accounts.confirm(marked('sign-in', { id: 'idp-1', provider: 'idp' }))).rejects.toThrow(TypeError);
    const link = marked('link', { id: 'idp-1', provider: 'idp' }, '1');
    await expect(w.accounts.confirm(link)).rejects.toThrow(TypeError);
    // A result of the wrong intent is not spent: it still links.
    expect((await w.accounts.link(link)).ok).toBe(true);
    // Nothing the flow did not return opens anything either.
    await expect(w.accounts.confirm({ ...confirming('idp-1', '1', ago(1_000)) })).rejects.toThrow(TypeError);
    await expect(w.accounts.confirm(undefined as never)).rejects.toThrow(TypeError);
    expect(w.state.proofs).toEqual([]);
  });

  it('the same SocialUser cannot open the window twice, not even after a refusal', async () => {
    const result = confirming('idp-1', '1', ago(1_000));
    expect((await w.accounts.confirm(result)).ok).toBe(true);
    await expect(w.accounts.confirm(result)).rejects.toThrow(TypeError);
    const refused = confirming('idp-2', '1', ago(1_000));
    expect((await w.accounts.confirm(refused)).ok).toBe(false);
    await expect(w.accounts.confirm(refused)).rejects.toThrow(TypeError);
    expect(w.state.proofs).toHaveLength(1);
  });

  it('spends the result for an early refusal too: signed-out, no fresh sign-in and another user\'s flow', async () => {
    const early = confirming('idp-1', '1', undefined);
    expect(await w.accounts.confirm(early)).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    await expect(w.accounts.confirm(early)).rejects.toThrow(TypeError);
    const foreign = confirming('idp-1', '2', ago(1_000));
    expect((await w.accounts.confirm(foreign)).ok).toBe(false);
    await expect(w.accounts.confirm(foreign)).rejects.toThrow(TypeError);
    const result = confirming('idp-1', '1', ago(1_000));
    const me = w.state.signedIn!;
    w.state.signedIn = undefined;
    expect(await w.accounts.confirm(result)).toEqual({ ok: false, error: { kind: 'signed-out' } });
    w.signInAs(me);
    await expect(w.accounts.confirm(result)).rejects.toThrow(TypeError);
    expect(w.state.proofs).toEqual([]);
  });

  it('two parallel confirms of one result issue one proof', async () => {
    const result = confirming('idp-1', '1', ago(1_000));
    const answers = await Promise.allSettled([w.accounts.confirm(result), w.accounts.confirm(result)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(w.state.proofs).toHaveLength(1);
  });

  it('gives the id to start a confirmation with, for the signed-in user only', async () => {
    expect(await w.accounts.accountId('idp')).toBe('idp-1');
    expect(await w.accounts.accountId('github')).toBeUndefined();
    w.state.signedIn = undefined;
    expect(await w.accounts.accountId('idp')).toBeUndefined();
  });

  it('says in the summary which linked providers can be offered for a confirmation: active oidc() providers only', async () => {
    // `idp` is an active provider `oidc()` built, `plain` is active without it, and `gone` is linked but not registered. Whether a provider sends `auth_time` is not asked here.
    await w.store.create(1 as AuthUserId, marked('link', { id: 'p-1', provider: 'plain' }, '1'));
    await w.store.create(1 as AuthUserId, marked('link', { id: 'g-1', provider: 'gone' }, '1'));
    expect((await w.accounts.list()).map((summary) => [summary.provider, summary.canConfirm])).toEqual([
      ['idp', true],
      ['plain', false],
      ['gone', false],
    ]);
  });

  it('answers canConfirm false for google and gitlab, which cannot prove a fresh sign-in, and true for an own oidc() provider', async () => {
    const own = world(connections, {
      active: ['google', 'gitlab', 'idp'],
      oidc: ['idp'],
      definitions: { google: google(contextOf(() => own.clock, 'google')), gitlab: gitlab(contextOf(() => own.clock, 'gitlab')) },
    });
    for (const name of ['google', 'gitlab', 'idp']) await own.store.create(1 as AuthUserId, marked('link', { id: `${name}-1`, provider: name }, '1'));
    own.state.signedIn = w.state.signedIn;
    const answers = (await own.accounts.list()).map((summary) => [summary.provider, summary.canConfirm]);
    expect(answers).toHaveLength(3);
    expect(answers).toEqual(expect.arrayContaining([['google', false], ['gitlab', false], ['idp', true]]));
  });
});

// The whole flow on a booted app: the real callback, the real guard.

const AUTH_TABLES = new URL('../../../auth/src/__fixtures__/migrations/', import.meta.url);
const STUB = new URL('../../stubs/react/modules/oauth/migrations/', import.meta.url);
const HUB = { authorizeUrl: 'https://gh.example.com/authorize', tokenUrl: 'https://gh.example.com/token' };

interface Account {
  id: number;
  email: string;
  hash: PasswordHash | null;
  key: string | null;
}

/** The app's users, in memory. */
class Users {
  readonly accounts = new Map<number, Account>();
  #credentials(account: Account | undefined) {
    return account && { user: { id: account.id, email: account.email, email_verified_at: new Date() }, passwordHash: account.hash, sessionKey: account.key };
  }
  async findById(id: number) {
    return this.#credentials(this.accounts.get(id));
  }
  async findForSignIn(email: string) {
    return this.#credentials([...this.accounts.values()].find((account) => account.email === email));
  }
  async updatePasswordHash() {
    return false;
  }
  async updateSessionKey() {
    return false;
  }
  async updateEverySessionKey() {
    return { accounts: 0, sampleId: undefined };
  }
}

const users = new Users();
const http = new HttpClientFake();

const T0 = new Date('2030-01-01T12:00:00Z');
const clock = new TestClock();
/** What the app is bound to: the clock, which `waitAfterNextReading()` moves a minute ahead right after the next reading (the proof waits between being issued and being taken). */
let pending = false;
const bound: Clock = {
  now: () => {
    const reading = clock.now();
    if (pending) {
      pending = false;
      clock.travel({ seconds: 61 });
    }
    return reading;
  },
};
const waitAfterNextReading = () => {
  pending = true;
};

class Provides implements ServiceProvider {
  register(container: Container): void {
    container.bind(UserProvider, () => users as never);
    container.bind(SocialUserProvider, () => ({ findByEmail: async () => undefined, create: async () => ({ ok: false, error: { kind: 'duplicate' } }), emailConfirmed: async () => true }) as never);
    container.instance(Clock, bound);
  }
}

class Login extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { id } = (await ctx.input()) as { id: number };
    await this.#auth.signIn({ id, name: 'x', email: `user${id}@example.com` } as never);
    return { ok: true };
  }
}

class Start extends Controller {
  readonly #auth: Auth;
  readonly #oauth: OAuth;
  readonly #accounts: SocialAccounts;
  constructor(auth: Auth, oauth: OAuth, accounts: SocialAccounts) {
    super();
    this.#auth = auth;
    this.#oauth = oauth;
    this.#accounts = accounts;
  }
  async handle(ctx: HttpContext) {
    const { provider, intent, account } = (await ctx.input()) as { provider: string; intent: 'confirm' | 'link'; account?: string };
    const userId = (await this.#auth.id()) as number;
    const redirect =
      intent === 'confirm'
        ? await this.#oauth.redirect(provider, { intent, userId, account: account ?? (await this.#accounts.accountId(provider)) ?? 'none' })
        : await this.#oauth.redirect(provider, { intent, userId });
    return redirect.ok ? { url: redirect.value.href } : { error: redirect.error.kind };
  }
}

class Callback extends Controller {
  readonly #auth: Auth;
  readonly #oauth: OAuth;
  readonly #accounts: SocialAccounts;
  constructor(auth: Auth, oauth: OAuth, accounts: SocialAccounts) {
    super();
    this.#auth = auth;
    this.#oauth = oauth;
    this.#accounts = accounts;
  }
  async handle(ctx: HttpContext) {
    const { provider, query, twice } = (await ctx.input()) as { provider: string; query: string; twice?: boolean };
    const userId = (await this.#auth.id()) as number | undefined;
    const result = await this.#oauth.callback(provider, new URLSearchParams(query), userId === undefined ? {} : { userId });
    if (!result.ok) return { callback: result.error.kind };
    if (result.value.intent === 'link') {
      const linked = await this.#accounts.link(result.value.user);
      return { callback: 'ok', link: linked.ok ? 'ok' : linked.error.kind };
    }
    const confirmed = await this.#accounts.confirm(result.value.user);
    let second: string | undefined;
    if (twice === true) {
      second = await this.#accounts.confirm(result.value.user).then(
        () => 'opened',
        (error: unknown) => (error instanceof TypeError ? 'TypeError' : 'other'),
      );
    }
    return { callback: 'ok', confirm: confirmed.ok ? 'ok' : confirmed.error.kind, ...(second === undefined ? {} : { second }), confirmed: this.#auth.passwordRecentlyConfirmed() };
  }
}

class Unlink extends Controller {
  readonly #accounts: SocialAccounts;
  constructor(accounts: SocialAccounts) {
    super();
    this.#accounts = accounts;
  }
  async handle(ctx: HttpContext) {
    const { provider } = (await ctx.input()) as { provider: string };
    const unlinked = await this.#accounts.unlink(provider);
    return { unlink: unlinked.ok ? 'ok' : unlinked.error.kind, accounts: (await this.#accounts.list()).map((account) => `${account.provider}:${account.canConfirm}`) };
  }
}

class List extends Controller {
  readonly #accounts: SocialAccounts;
  constructor(accounts: SocialAccounts) {
    super();
    this.#accounts = accounts;
  }
  async handle() {
    return { accounts: (await this.#accounts.list()).map((account) => `${account.provider}:${account.canConfirm}`) };
  }
}

class Status extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { confirmed: this.#auth.passwordRecentlyConfirmed() };
  }
}

const routes = defineRoutes((Root) => {
  const Route = Root.authorize(everyone);
  Route.post('/login', Login);
  Route.post('/start', Start);
  Route.post('/callback', Callback);
  Route.post('/unlink', Unlink);
  Route.post('/status', Status);
  Route.post('/list', List);
});

describe.each(drivers)('a confirmation with a provider on a booted app on %s', (driver) => {
  let app: Application;
  let dropDatabase = async () => {};
  let store: SocialAccountStore;
  let kernel: ReturnType<typeof createHttpKernel>;

  beforeAll(async () => {
    let database: Record<string, string> = { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:' };
    if (driver === 'pgsql') {
      const name = `marmeon_oauth_confirm_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
        endpoints: HUB,
        profile: async () => ({ id: 'gh-1' }),
        mapUser: (raw) => ({ id: (raw as { id: string }).id, email: null, emailVerified: false, name: null, nickname: 'hub', avatar: null }),
      });
    app = await createApplication(
      {
        root: workspaceTempDir('marmeon-oauth-confirm-'),
        discover: false,
        providers: [
          EncryptionServiceProvider,
          HttpServiceProvider,
          ServerServiceProvider,
          SessionServiceProvider,
          DatabaseServiceProvider,
          CacheServiceProvider,
          AuthServiceProvider,
          FetchServiceProvider,
          OAuthServiceProvider,
          providerBringing('Providers', { idp: oidc({ issuer: ISSUER, label: 'Identity' }), gh: hub }),
          SocialAccountsServiceProvider,
          Provides,
        ],
        modules: [defineModule({ name: 'auth-confirm-test', routes, migrations: AUTH_TABLES })],
      },
      {
        env: {
          NODE_ENV: 'test',
          APP_KEY: generateKey(),
          APP_URL: 'https://app.example.com',
          OAUTH_IDP_CLIENT_ID: 'client',
          OAUTH_IDP_CLIENT_SECRET: 'secret',
          OAUTH_GH_CLIENT_ID: 'client',
          OAUTH_GH_CLIENT_SECRET: 'secret',
          SESSION_DRIVER: 'memory',
          SESSION_LOTTERY: '0/1',
          LOG_LEVEL: 'silent',
          HASH_ARGON_MEMORY_KB: '1024',
          HASH_ARGON_TIME: '1',
          CACHE_DRIVER: 'memory',
          ...database,
        },
        override: (container: Container) => {
          container.make(CsrfProtection).disable();
          container.instance(HttpClient, http as never);
        },
      },
    );
    await app.container.make(Migrator).migrate();
    // A second run: the stub's name sorts before the tables it points at, and Postgres checks the foreign key when the table is made.
    await new Migrator({ modules: [{ name: 'oauth', migrations: STUB }], root: '/' } as unknown as Application, app.container.make(Connections)).migrate();
    store = app.container.make(SocialAccountStore);
    kernel = createHttpKernel(app);
    http.respond(DISCOVERY_URL, () => Response.json(discoveryDocument()));
  });
  afterAll(async () => {
    await app[Symbol.asyncDispose]();
    await dropDatabase();
  });
  beforeEach(async () => {
    pending = false;
    clock.freeze(T0);
    users.accounts.clear();
    const db = app.container.make(Connections).get<any>();
    await db.deleteFrom('social_accounts').execute();
    await db.deleteFrom('users').execute();
  });

  const add = async (id: number, links: Record<string, string> = {}) => {
    users.accounts.set(id, { id, email: `user${id}@example.com`, hash: null, key: null });
    await app.container.make(Connections).get<any>().insertInto('users').values({ id }).execute();
    for (const [provider, providerId] of Object.entries(links)) await store.create(id as AuthUserId, marked('link', { id: providerId, provider }, String(id)));
  };

  /** A browser with its own cookies. */
  const browser = () => {
    const jar = new Map<string, string>();
    const send = async <T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: 'POST', headers: { cookie, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        jar.set(name, value);
      }
      return (await response.json()) as T;
    };
    return { send, session: () => jar.get(sessionCookieName(app.container.make(SessionConfig))) };
  };
  type Browser = ReturnType<typeof browser>;

  const signedIn = async (id: number) => {
    const b = browser();
    await b.send('/login', { id });
    return b;
  };

  const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  /**
   * Starts a confirmation at `idp` in `b` and answers its callback (in `callbackIn` when given) with an ID token for `sub` whose
   * `auth_time` is `authTime` seconds from now (`null`: none). `query` is the callback query, to be sent again.
   */
  const confirmAt = async (b: Browser, options: { sub?: string; authTime?: number | null; account?: string; callbackIn?: Browser; twice?: boolean } = {}) => {
    const started = await b.send<{ url?: string; error?: string }>('/start', { provider: 'idp', intent: 'confirm', ...(options.account === undefined ? {} : { account: options.account }) });
    if (started.url === undefined) throw new Error(`no flow: ${started.error}`);
    const url = new URL(started.url);
    const nowSeconds = Math.floor(clock.now() / 1000);
    const authTime = options.authTime === undefined ? 0 : options.authTime;
    const claims: Record<string, unknown> = { iss: ISSUER, sub: options.sub ?? 'idp-1', aud: 'client', exp: nowSeconds + 300, iat: nowSeconds - 5, nonce: url.searchParams.get('nonce') };
    if (authTime !== null) claims.auth_time = nowSeconds + authTime;
    const token = [base64url({ alg: 'RS256', typ: 'JWT' }), base64url(claims), 'c2ln'].join('.');
    http.respond(TOKEN_URL, () => tokenResponse({ id_token: token }));
    const query = new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state')! }).toString();
    const answer = await (options.callbackIn ?? b).send<Record<string, unknown>>('/callback', { provider: 'idp', query, ...(options.twice === true ? { twice: true } : {}) });
    return { answer, query, token };
  };
  const confirmed = async (b: Browser) => (await b.send<{ confirmed: boolean }>('/status')).confirmed;

  it('a fresh re-authentication with the linked provider opens the window, under a new session id', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    expect(await confirmed(b)).toBe(false);
    const before = b.session();
    expect(before).toBeDefined();
    const { answer } = await confirmAt(b, { authTime: 0 });
    expect(answer).toMatchObject({ callback: 'ok', confirm: 'ok', confirmed: true });
    expect(await confirmed(b)).toBe(true);
    expect(b.session()).toBeDefined();
    expect(b.session()).not.toBe(before);
  });

  it('a provider without auth_time opens nothing', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    expect((await confirmAt(b, { authTime: null })).answer).toEqual({ callback: 'not-reauthenticated' });
    expect(await confirmed(b)).toBe(false);
  });

  it('an old auth_time opens nothing', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    expect((await confirmAt(b, { authTime: -3600 })).answer).toEqual({ callback: 'not-reauthenticated' });
    expect(await confirmed(b)).toBe(false);
    // Nor does one that lies ahead of the clock.
    expect((await confirmAt(b, { authTime: 3600 })).answer).toEqual({ callback: 'not-reauthenticated' });
    expect(await confirmed(b)).toBe(false);
  });

  it('a sign-in at the provider from before this session signed in opens nothing', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    // Inside the window the callback allows, but earlier than the sign-in of this session: the guard refuses.
    expect((await confirmAt(b, { authTime: -8 })).answer).toMatchObject({ callback: 'ok', confirm: 'expired', confirmed: false });
    expect(await confirmed(b)).toBe(false);
  });

  it('a foreign provider account opens nothing', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    // The person signs in at the provider as somebody else than the linked account.
    expect((await confirmAt(b, { sub: 'somebody-else', authTime: 0 })).answer).toEqual({ callback: 'invalid' });
    expect(await confirmed(b)).toBe(false);
  });

  it('a provider account of another user, or one that is not linked, opens nothing even when the whole flow ran', async () => {
    await add(1, { idp: 'idp-1' });
    await add(2, { idp: 'idp-2' });
    const b = await signedIn(1);
    const untouched = (await store.find('idp', 'idp-2'))?.lastUsedAt;
    // A write would show: the clock stands still otherwise.
    clock.travel({ seconds: 5 });
    expect((await confirmAt(b, { sub: 'idp-2', account: 'idp-2', authTime: 0 })).answer).toMatchObject({ callback: 'ok', confirm: 'not-linked', confirmed: false });
    expect((await confirmAt(b, { sub: 'nobody', account: 'nobody', authTime: 0 })).answer).toMatchObject({ callback: 'ok', confirm: 'not-linked', confirmed: false });
    expect(await confirmed(b)).toBe(false);
    expect((await store.find('idp', 'idp-2'))?.lastUsedAt).toEqual(untouched);
  });

  it('a reused state opens nothing', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    // The first answer fails (no auth_time) and spends the flow; the same state with a good token finds none.
    const first = await confirmAt(b, { authTime: null });
    expect(first.answer).toEqual({ callback: 'not-reauthenticated' });
    const good = await confirmAt(b, { authTime: null });
    http.respond(TOKEN_URL, () => tokenResponse({ id_token: good.token }));
    expect(await b.send('/callback', { provider: 'idp', query: first.query })).toEqual({ callback: 'no-flow' });
    expect(await confirmed(b)).toBe(false);
    // After a good answer the state is spent as well, and the window stays as the first answer made it.
    const ok = await confirmAt(b, { authTime: 0 });
    expect(ok.answer).toMatchObject({ confirm: 'ok', confirmed: true });
    expect(await b.send('/callback', { provider: 'idp', query: ok.query })).toEqual({ callback: 'no-flow' });
  });

  it("the flow of one user does not complete in another user's session, nor in a guest's", async () => {
    await add(1, { idp: 'idp-1' });
    await add(2, { idp: 'idp-2' });
    const owner = await signedIn(1);
    const other = await signedIn(2);
    // The other session holds no flow at all.
    expect((await confirmAt(owner, { callbackIn: other, authTime: 0 })).answer).toEqual({ callback: 'no-flow' });
    expect(await confirmed(other)).toBe(false);
    const guest = browser();
    expect((await confirmAt(owner, { callbackIn: guest, authTime: 0 })).answer).toEqual({ callback: 'no-flow' });
    expect(await confirmed(guest)).toBe(false);
    expect(await confirmed(owner)).toBe(false);
  });

  it('a proof that waited more than a minute opens nothing', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    // Once the accounts have looked the account up, the clock moves a minute and a second on right after the proof was stamped: the proof
    // is older than it may be when the guard takes it.
    const real = store.find.bind(store);
    store.find = async (...args) => {
      const found = await real(...args);
      waitAfterNextReading();
      return found;
    };
    try {
      expect((await confirmAt(b, { authTime: 0 })).answer).toMatchObject({ callback: 'ok', confirm: 'expired', confirmed: false });
    } finally {
      store.find = real;
    }
    expect(await confirmed(b)).toBe(false);
  });

  it('a second whole flow with the same sign-in time at the provider opens nothing more', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    expect((await confirmAt(b, { authTime: 0 })).answer).toMatchObject({ confirm: 'ok', confirmed: true });
    expect((await confirmAt(b, { authTime: 0 })).answer).toMatchObject({ callback: 'ok', confirm: 'expired' });
  });

  it('the same SocialUser cannot open the window twice', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    expect((await confirmAt(b, { authTime: 0, twice: true })).answer).toMatchObject({ confirm: 'ok', second: 'TypeError' });
  });

  it('GitHub-like providers cannot start a confirmation at all', async () => {
    await add(1, { gh: 'gh-1' });
    const b = await signedIn(1);
    expect(await b.send('/start', { provider: 'gh', intent: 'confirm' })).toEqual({ error: 'reauthentication-unsupported' });
    expect(await confirmed(b)).toBe(false);
  });

  it('an account with only an OpenID Connect login confirms, then links GitHub and unlinks it again', async () => {
    await add(1, { idp: 'idp-1' });
    const b = await signedIn(1);
    const link = async () => {
      const started = await b.send<{ url: string }>('/start', { provider: 'gh', intent: 'link' });
      http.respond(HUB.tokenUrl, () => tokenResponse());
      const query = new URLSearchParams({ code: 'c', state: new URL(started.url).searchParams.get('state')! }).toString();
      return b.send('/callback', { provider: 'gh', query });
    };
    // Without the window neither a link nor an unlink goes through.
    expect(await link()).toMatchObject({ callback: 'ok', link: 'confirmation-required' });
    expect(await b.send('/unlink', { provider: 'idp' })).toMatchObject({ unlink: 'confirmation-required' });

    expect((await confirmAt(b, { authTime: 0 })).answer).toMatchObject({ confirm: 'ok', confirmed: true });

    expect(await link()).toMatchObject({ callback: 'ok', link: 'ok' });
    expect(await b.send('/list')).toEqual({ accounts: ['idp:true', 'gh:false'] });
    expect(await b.send('/unlink', { provider: 'gh' })).toMatchObject({ unlink: 'ok', accounts: ['idp:true'] });
    expect(await store.forUser(1 as AuthUserId)).toHaveLength(1);
  });
});
