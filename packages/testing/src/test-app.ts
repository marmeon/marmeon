import {
  createApplication,
  loadEnv,
  type Application,
  type ApplicationOptions,
  type Container,
  type Key,
  type Resolve,
} from '@bespokecore/core';
import { Encrypter } from '@bespokecore/encryption';
import { CookieEncryption, Router, writeAppBrowserRoutes } from '@bespokecore/http';
import {
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  REGION_HEADER,
  urlFor,
  type CheckIslandRouteName,
  type CheckLayerRouteName,
  type Param,
  type Query,
  type RouteArgs,
  type RouteNameInput,
} from '@bespokecore/http/page';
import { createHttpKernel } from '@bespokecore/server';
import { AssertionError } from 'node:assert';
import type { AuthUser } from '@bespokecore/auth';
import type { MailFake } from '@bespokecore/mail';
import type { FactoryDefinition, PendingFactory, Selectable, Tables } from '@bespokecore/database';
import { prepareWorkerDatabase, workerDatabase, type WorkerDatabase } from './database.ts';
import { PendingTestResponse } from './pending.ts';
import { SSR_TEST_HEADER, TestSsr } from './ssr.ts';
import { TestResponse, type PageNameOf, type PageSource, type PropsOf } from './response.ts';

export interface TestAppOptions {
  /** Extra environment on top of `.env` and `.env.test`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Replace bindings before the app boots — even singletons see these. */
  override?: (container: Container) => void;
  /**
   * Verify CSRF tokens (default: false). Like Laravel, tests skip CSRF protection
   * unless they test it — then send `_token` or the `X-XSRF-TOKEN` header yourself.
   */
  csrf?: boolean;
  /**
   * `'refresh'`: a real database, reset for every test (Laravel's `RefreshDatabase`, E21). Each test
   * worker gets its own database, migrated once; every test app runs inside one transaction that is
   * rolled back when the test ends. Needs @bespokecore/database.
   */
  database?: 'refresh';
  /** With `database: 'refresh'`: run the modules' seeders for every test (inside its transaction). */
  seed?: boolean;
  /**
   * Mail is recorded, never sent (default `'fake'`): the `Mailer` is a `MailFake`, available as `app.mail`
   * (Laravel's `Mail::fake()`, on by default). `'real'` keeps the configured transport.
   */
  mail?: 'fake' | 'real';
  /**
   * Render pages on the server, through the app's Vite setup (`vite.config.ts`, as `bespoke dev` does) — so the markup
   * and `<Head>` are testable (`assertSee`, `assertServerRendered`, `assertHydrates`). Off by default: responses carry
   * the page object only (fast, no Vite). Every page renders completely, as for a bot — islands included (E49).
   * `'stream'`: as for a browser — the shell first, islands and deferred props streamed into the same response
   * (`app.stream(path)` gives the raw response, to read it as it arrives).
   */
  ssr?: boolean | 'stream';
}

type FormValue = string | readonly string[];
type MultipartValue = string | Blob | readonly (string | Blob)[];

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Sent as `application/x-www-form-urlencoded`, like an HTML form. Arrays repeat the field. */
  form?: Record<string, FormValue>;
  /** Sent as `multipart/form-data` — for file uploads: `{ avatar: new File([...], 'a.png') }`. */
  multipart?: Record<string, MultipartValue>;
  /** Sent as JSON. */
  json?: unknown;
}

/**
 * Boots a fresh application from its definition — the default export of
 * `bootstrap/app.ts` — and wraps it for HTTP tests.
 *
 * ```ts
 * const app = await createTestApp(application, { override: (c) => c.instance(Mailer, new FakeMailer()) });
 * await app.get('/users/1').assertOk().assertPage('user-profile/Show');
 * ```
 */
export async function createTestApp(definition: ApplicationOptions, options: TestAppOptions = {}): Promise<TestApp> {
  const session = await importSession();
  const database = await importDatabase();
  const mail = options.mail === 'real' ? undefined : await importMail();
  let mailFake: MailFake | undefined;
  let env = { ...(definition.env ?? loadEnv(definition.root)), ...options.env };

  let worker: WorkerDatabase | undefined;
  if (options.database === 'refresh') {
    if (!database) throw new Error("createTestApp(…, { database: 'refresh' }) needs @bespokecore/database installed.");
    if (openRefreshed.size > 0) {
      // Two open transactions on the worker's database: SQLite has one writer, so the second app would
      // wait for the first one's lock (5 s, then "database is locked"). One database app per test.
      throw new Error(
        "Another test app with database: 'refresh' is still open. Close it first (await app.close()) — " +
          'each test works in one transaction of one app.',
      );
    }
    worker = await workerDatabase(database, definition.root, env);
    env = { ...env, ...worker.env };
  } else if (options.seed) {
    throw new Error("createTestApp(…, { seed: true }) seeds a refreshed database: add database: 'refresh'.");
  }

  const application = await createApplication({
    ...definition,
    env,
    override: (container) => {
      if (session && options.csrf !== true && container.has(session.CsrfProtection)) container.make(session.CsrfProtection).disable();
      if (mail && container.has(mail.Mailer)) {
        mailFake = new mail.MailFake(container.make(mail.MailConfig).from);
        container.instance(mail.Mailer, mailFake);
      }
      definition.override?.(container);
      options.override?.(container);
    },
  });

  let ssr: TestSsr | undefined;
  try {
    if (options.ssr) {
      // The SSR entry imports `virtual:bespoke/routes`, which `bespoke route:types` writes — maybe never yet in this checkout.
      writeAppBrowserRoutes(application);
      ssr = await TestSsr.start(definition.root, { stream: options.ssr === 'stream' });
    }
  } catch (error) {
    await application.shutdown();
    throw error;
  }
  const shared: Shared = {
    kernel: createHttpKernel(application, ssr ? { renderer: ssr.renderer } : {}),
    database,
    mail: mailFake,
    ssr,
    cleanups: ssr ? [() => ssr.close()] : [],
    closing: undefined,
  };
  const app = new TestApp(application, shared, { headers: {}, cookies: [], session: undefined });
  if (database && worker) {
    try {
      await prepareWorkerDatabase(database, application, worker);
      const isolation = await application.container.make(database.Connections).isolate();
      openRefreshed.add(app);
      shared.cleanups.push(async () => {
        openRefreshed.delete(app);
        await isolation.rollback();
      });
      if (options.seed) await application.container.make(database.Seeding).run();
    } catch (error) {
      await app.close();
      throw error;
    }
  }
  await closeWhenTheTestEnds(app);
  return app;
}

/** Refreshed test apps not closed yet — at most one at a time (see createTestApp). */
const openRefreshed = new Set<TestApp>();

/**
 * Inside a Vitest test (or its `beforeEach`), the app closes when the test ends — its transaction is
 * rolled back, its connections closed — like Laravel's tearDown. Elsewhere: `app.close()` or `await using`.
 */
async function closeWhenTheTestEnds(app: TestApp): Promise<void> {
  try {
    const { onTestFinished } = await import('vitest');
    onTestFinished(() => app.close());
  } catch {
    // Not inside a Vitest test.
  }
}

interface Shared {
  readonly kernel: ReturnType<typeof createHttpKernel>;
  readonly database: DatabaseModule | undefined;
  /** The recording mailer, unless the app has no mail or the test chose `mail: 'real'`. */
  readonly mail: MailFake | undefined;
  /** Server rendering, with `ssr: true`. */
  readonly ssr: TestSsr | undefined;
  /** Run before the app shuts down, e.g. rolling back the test's transaction. */
  readonly cleanups: (() => Promise<void>)[];
  closing: Promise<void> | undefined;
}

interface TestCookie {
  readonly name: string;
  readonly value: string;
  /** Encrypted like the app would (when the app encrypts this cookie at all). */
  readonly encrypt: boolean;
}

interface Defaults {
  readonly headers: Readonly<Record<string, string>>;
  readonly cookies: readonly TestCookie[];
  /** Data for a session created before the request (`withSession`). */
  readonly session: Readonly<Record<string, unknown>> | undefined;
  /** Signed in as this user (`actingAs`). */
  readonly user?: AuthUser;
  /** Signed in through an API token with these abilities instead of the session (`actingAs(user, { guard: 'api' })`). */
  readonly token?: { readonly user: AuthUser; readonly abilities: readonly string[] };
}

/** Access to the app's session store — when the app uses @bespokecore/session (an optional peer). */
export interface SessionAccess {
  readonly cookie: string;
  create(data: Readonly<Record<string, unknown>>): Promise<string>;
  read(id: string): Promise<Record<string, unknown> | undefined>;
}

type DatabaseModule = typeof import('@bespokecore/database');

/** @bespokecore/database is an optional peer, like the session. */
async function importDatabase(): Promise<DatabaseModule | undefined> {
  try {
    return await import('@bespokecore/database');
  } catch {
    return undefined;
  }
}

/** @bespokecore/mail is an optional peer, like the session. */
async function importMail(): Promise<typeof import('@bespokecore/mail') | undefined> {
  try {
    return await import('@bespokecore/mail');
  } catch {
    return undefined;
  }
}

/** @bespokecore/auth is an optional peer, like the session. */
async function importAuth(): Promise<typeof import('@bespokecore/auth') | undefined> {
  try {
    return await import('@bespokecore/auth');
  } catch {
    return undefined;
  }
}

/** @bespokecore/session is an optional peer: only apps that use it have it installed. */
async function importSession(): Promise<typeof import('@bespokecore/session') | undefined> {
  try {
    return await import('@bespokecore/session');
  } catch {
    return undefined;
  }
}

async function sessionAccess(container: Container): Promise<SessionAccess | undefined> {
  const session = await importSession();
  if (!session || !container.has(session.SessionConfig)) return undefined;
  const config = container.make(session.SessionConfig);
  const store = () => {
    if (config.driver === 'cookie') throw new Error('Session helpers in tests need the memory or file driver (set SESSION_DRIVER=memory in .env.test).');
    return container.make(session.SessionStore);
  };
  return {
    cookie: config.cookie,
    create: async (data) => {
      const id = session.createSessionId();
      const token = crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
      await store().write(id, { _token: token, ...data }, config.lifetime * 60);
      return id;
    },
    read: (id) => store().read(id),
  };
}

/** How the app encrypts cookies — so tests can send and read plain values, like Laravel's. */
export interface CookieCrypto {
  encrypt(name: string, value: string): Promise<string>;
  /** The plain value, or the raw one if it is not encrypted (or not decryptable). */
  decrypt(name: string, value: string): Promise<string>;
}

function cookieCrypto(container: Container): CookieCrypto {
  const encrypted = (name: string) =>
    container.has(Encrypter) && (!container.has(CookieEncryption) || container.make(CookieEncryption).isEncrypted(name));
  return {
    encrypt: async (name, value) => (encrypted(name) ? container.make(Encrypter).encrypt(value, `cookie:${name}`) : value),
    decrypt: async (name, value) => {
      if (!encrypted(name) || value === '') return value;
      try {
        return await container.make(Encrypter).decrypt(value, `cookie:${name}`);
      } catch {
        return value;
      }
    },
  };
}

export class TestApp {
  readonly application: Application;
  readonly #shared: Shared;
  readonly #defaults: Defaults;
  readonly #crypto: CookieCrypto;
  readonly #session: Promise<SessionAccess | undefined>;

  constructor(application: Application, shared: Shared, defaults: Defaults) {
    this.application = application;
    this.#shared = shared;
    this.#defaults = defaults;
    this.#crypto = cookieCrypto(application.container);
    this.#session = sessionAccess(application.container);
  }

  get container(): Container {
    return this.application.container;
  }

  /**
   * The mail the app sent — recorded, not delivered: `app.mail.assertSent(ResetPasswordMail, (mail, message) => …)`.
   * Needs @bespokecore/mail in the app.
   */
  get mail(): MailFake {
    if (!this.#shared.mail) throw new Error("app.mail needs @bespokecore/mail in the app (and not createTestApp(…, { mail: 'real' })).");
    return this.#shared.mail;
  }

  /**
   * Waits for pending `terminate` hooks, then shuts the app down (closes database pools and
   * the like). `await using app = await createTestApp(…)` does this at the end of the block.
   */
  close(): Promise<void> {
    this.#shared.closing ??= (async () => {
      await this.#shared.kernel.settle();
      try {
        for (const cleanup of this.#shared.cleanups) await cleanup();
      } finally {
        await this.application.shutdown();
      }
    })();
    return this.#shared.closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Rows from a factory, in this app's database (Laravel's `User::factory()`):
   * `await app.factory(UserFactory).count(3).create()`. Needs @bespokecore/database.
   */
  factory<T extends keyof DB & string, DB, S extends string>(definition: FactoryDefinition<T, DB, S>): PendingFactory<T, DB, false, S> {
    return this.application.container.make(this.#requireDatabase('app.factory()').Factories).for(definition);
  }

  // --- Database assertions (Laravel's assertDatabaseHas & co.) -----------------------

  /** A row in `table` matches every given column value. */
  async assertDatabaseHas<T extends keyof DB & string, DB = Tables>(table: T, where: Partial<Selectable<DB[T]>>): Promise<this> {
    const { matching, sample } = await this.#rows(table, where as Record<string, unknown>);
    if (matching === 0) {
      throw new AssertionError({
        message: `Expected a row in "${table}" matching ${JSON.stringify(where)} — found none.\n  ${sample}`,
      });
    }
    return this;
  }

  /** No row in `table` matches the given column values. */
  async assertDatabaseMissing<T extends keyof DB & string, DB = Tables>(table: T, where: Partial<Selectable<DB[T]>>): Promise<this> {
    const { matching } = await this.#rows(table, where as Record<string, unknown>);
    if (matching > 0) throw new AssertionError({ message: `Expected no row in "${table}" matching ${JSON.stringify(where)} — found ${matching}.` });
    return this;
  }

  /** `table` holds exactly `count` rows. */
  async assertDatabaseCount<T extends keyof DB & string, DB = Tables>(table: T, count: number): Promise<this> {
    const { total } = await this.#rows(table, {});
    if (total !== count) throw new AssertionError({ message: `Expected ${count} rows in "${table}" — found ${total}.`, actual: total, expected: count });
    return this;
  }

  async #rows(table: string, where: Record<string, unknown>): Promise<{ matching: number; total: number; sample: string }> {
    const db = this.application.container.make(this.#requireDatabase('Database assertions').Connections).get<any>();
    let query = db.selectFrom(table).selectAll();
    for (const [column, value] of Object.entries(where)) query = value === null ? query.where(column, 'is', null) : query.where(column, '=', value);
    const matching = (await query.execute()).length;
    const rows = await db.selectFrom(table).selectAll().limit(5).execute();
    const counted = (await db.selectFrom(table).select((eb: any) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow()) as { count: number | string };
    const total = Number(counted.count);
    const sample = rows.length ? `The table has ${total} rows, e.g.:\n    ${rows.map((row: unknown) => JSON.stringify(row)).join('\n    ')}` : 'The table is empty.';
    return { matching, total, sample };
  }

  #requireDatabase(feature: string): DatabaseModule {
    if (!this.#shared.database) throw new Error(`${feature} needs @bespokecore/database installed.`);
    return this.#shared.database;
  }

  /** Resolves a service from the app, e.g. to inspect state after a request. */
  make<K extends Key<any>>(key: K): Resolve<K> {
    return this.application.container.make(key as never) as Resolve<K>;
  }

  // --- Request defaults (each returns a new view of the same app) -------------------

  withHeaders(headers: Record<string, string>): TestApp {
    return this.#with({ headers: { ...this.#defaults.headers, ...headers } });
  }

  /** Sends a cookie, encrypted like the app encrypts its own (Laravel's `withCookie`). */
  withCookie(name: string, value: string): TestApp {
    return this.#with({ cookies: [...this.#defaults.cookies, { name, value, encrypt: true }] });
  }

  /**
   * Starts the request with a session holding `data` (Laravel's `withSession`):
   * `app.withSession({ cart: [42] }).get('/checkout')` — to sign someone in, use `actingAs(user)`.
   */
  withSession(data: Record<string, unknown>): TestApp {
    return this.#with({ session: { ...this.#defaults.session, ...data } });
  }

  /**
   * Signed in as `user` — the session holds exactly what a login leaves (Laravel's `actingAs`):
   * `app.actingAs(ada).get('/users/me')`. With `{ guard: 'api' }`, through a real API token instead
   * (`Authorization: Bearer …`, Sanctum's `actingAs`). Needs @bespokecore/auth; the user must exist.
   */
  actingAs(user: AuthUser, options: { guard?: 'web' } | { guard: 'api'; abilities?: readonly string[] } = {}): TestApp {
    if (options.guard === 'api') return this.#with({ token: { user, abilities: options.abilities ?? ['*'] } });
    return this.#with({ user });
  }

  /** Sends a cookie exactly as given — e.g. to prove that forged values are ignored. */
  withUnencryptedCookie(name: string, value: string): TestApp {
    return this.#with({ cookies: [...this.#defaults.cookies, { name, value, encrypt: false }] });
  }

  #with(defaults: Partial<Defaults>): TestApp {
    return new TestApp(this.application, this.#shared, { ...this.#defaults, ...defaults });
  }

  /** Requests as a client-side navigation: answered with the page object as JSON. */
  navigating(): TestApp {
    return this.withHeaders({ [PAGE_HEADER]: 'true' });
  }

  /** Requests as a prefetch (`<Link prefetch>`): a client-side navigation with `Purpose: prefetch` — see `isPrefetch`. */
  prefetching(): TestApp {
    return this.withHeaders({ [PAGE_HEADER]: 'true', [PURPOSE_HEADER]: 'prefetch' });
  }

  /**
   * Requests as a partial reload of `component` (the page on screen) — like `router.reload({ only })`:
   * `app.reloading<ShowUserProfileController>('user-profile/Show', { only: ['stats'] }).get('/users/1')`.
   */
  reloading<TSource extends PageSource = PageSource, const V extends string = string>(
    component: PageNameOf<TSource, V>,
    { only, except = [] }: { only?: readonly (keyof PropsOf<TSource> & string)[]; except?: readonly (keyof PropsOf<TSource> & string)[] },
  ): TestApp {
    return this.withHeaders({
      [PAGE_HEADER]: 'true',
      [PARTIAL_COMPONENT_HEADER]: component,
      ...(only ? { [PARTIAL_DATA_HEADER]: only.join(',') } : {}),
      ...(except.length > 0 ? { [PARTIAL_EXCEPT_HEADER]: except.join(',') } : {}),
    });
  }

  /**
   * Requests as an `<Island route>` does (E48): a client-side request with `x-bespoke-region: island` — answered with the
   * island's region object, or (redirect, 401, 403) with its outcome. For a partial reload of the island, chain
   * `reloading(component, { only })`.
   */
  islanding(): TestApp {
    return this.withHeaders({ [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island' });
  }

  /**
   * An island's request by route name — what `<Island route params query>` sends: `app.island('dashboard.sign-ins', {}, { limit: 10 })`.
   * Then `assertIsland<C>(component, props)` or `assertIslandStatus('unauthorized')`.
   */
  island<const N extends RouteNameInput>(name: CheckIslandRouteName<N>, ...[params, query]: RouteArgs<N>): PendingTestResponse {
    const path = urlFor(this.make(Router), name, params as Readonly<Record<string, Param>> | undefined, query as Query | undefined);
    return this.islanding().get(path);
  }

  /**
   * Requests as a layer does (E53) — opening one (`<Link layer>`), or a visit or form inside one: a client-side request
   * with `x-bespoke-region: layer`. A layer route answers with its page object (`assertLayer`), `closeLayer()` with "close"
   * (`assertLayerClosed`), a page route with its page.
   */
  layering(): TestApp {
    return this.withHeaders({ [PAGE_HEADER]: 'true', [REGION_HEADER]: 'layer' });
  }

  /** Opens a layer by route name — what `<Link route params layer>` sends: `app.layer('user-profile.edit', { user: ada.id })`. */
  layer<const N extends RouteNameInput>(name: CheckLayerRouteName<N>, ...[params, query]: RouteArgs<N>): PendingTestResponse {
    const path = urlFor(this.make(Router), name, params as Readonly<Record<string, Param>> | undefined, query as Query | undefined);
    return this.layering().get(path);
  }

  /** Requests as an API client. */
  expectingJson(): TestApp {
    return this.withHeaders({ accept: 'application/json' });
  }

  // --- Requests -----------------------------------------------------------------

  get(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('GET', path, options);
  }

  /**
   * A GET as the browser sends it, answered with the raw response — its body unread, to follow a server-rendered page as
   * it streams (`createTestApp(app, { ssr: 'stream' })`): when the headers came, when an island arrived.
   */
  async stream(path: string, options: RequestOptions = {}): Promise<Response> {
    return this.#shared.kernel.request(path, await this.#init('GET', options));
  }
  post(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('POST', path, options);
  }
  put(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('PUT', path, options);
  }
  patch(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('PATCH', path, options);
  }
  delete(path: string, options?: RequestOptions): PendingTestResponse {
    return this.request('DELETE', path, options);
  }

  request(method: string, path: string, options: RequestOptions = {}): PendingTestResponse {
    const label = `${method} ${path}`;
    const { ssr } = this.#shared;
    const render = ssr?.begin();
    const response = this.#init(method, options)
      .then((init) => this.#shared.kernel.request(path, render === undefined ? init : { ...init, headers: { ...(init.headers as Record<string, string>), [SSR_TEST_HEADER]: render } }))
      .then(async (res) => {
        const response = await TestResponse.from(res, label, this.#crypto, await this.#session, async (page) =>
          render === undefined ? undefined : ssr!.finish(render, new URL(path, 'http://localhost').href, page),
        );
        await this.#shared.kernel.settle(); // terminate hooks ran — like Laravel's test helpers call terminate()
        return response;
      });
    return new PendingTestResponse(response);
  }

  async #init(method: string, { headers = {}, form, multipart, json }: RequestOptions): Promise<RequestInit> {
    const testCookies = [...this.#defaults.cookies];
    let data = this.#defaults.session;
    const tokenHeader: Record<string, string> = {};
    if (this.#defaults.token) {
      const auth = await importAuth();
      if (!auth) throw new Error("actingAs(…, { guard: 'api' }) needs @bespokecore/auth in the app.");
      const { user, abilities } = this.#defaults.token;
      tokenHeader.authorization = `Bearer ${await auth.authenticatedToken(this.application.container, user, abilities)}`;
    }
    if (this.#defaults.user !== undefined) {
      const auth = await importAuth();
      if (!auth) throw new Error('actingAs() needs @bespokecore/auth in the app.');
      data = { ...data, ...(await auth.authenticatedSession(this.application.container, this.#defaults.user)) };
    }
    if (data) {
      const session = await this.#session;
      if (!session) throw new Error('withSession() and actingAs() need @bespokecore/session in the app.');
      testCookies.push({ name: session.cookie, value: await session.create(data), encrypt: true });
    }
    const cookies = await Promise.all(
      testCookies.map(
        async ({ name, value, encrypt }) => `${name}=${encodeURIComponent(encrypt ? await this.#crypto.encrypt(name, value) : value)}`,
      ),
    );
    const cookie = [this.#defaults.headers.cookie, ...cookies].filter(Boolean).join('; ');
    const init: RequestInit = { method, headers: { ...this.#defaults.headers, ...tokenHeader, ...(cookie ? { cookie } : {}), ...headers } };
    if (form) {
      const body = new URLSearchParams();
      for (const [name, value] of Object.entries(form)) for (const item of [value].flat()) body.append(name, item);
      init.body = body;
    }
    if (multipart) {
      const body = new FormData();
      for (const [name, value] of Object.entries(multipart)) for (const item of [value].flat()) body.append(name, item);
      init.body = body;
    }
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    return init;
  }
}
