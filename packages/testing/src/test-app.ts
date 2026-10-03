import {
  Clock,
  createApplication,
  EventFake,
  EventRegistry,
  loadEnv,
  TestClock,
  type Application,
  type ApplicationOptions,
  type Container,
  type Duration,
  type EventClass,
  type Key,
  type Resolve,
} from '@bespokecore/core';
import { Encrypter } from '@bespokecore/encryption';
import { CookieEncryption, Router, writeAppBrowserRoutes } from '@bespokecore/http';
import {
  ACTION_HEADER,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  REGION_HEADER,
  UPLOAD_HEADER,
  urlFor,
  VALIDATE_HEADER,
  type CheckIslandRouteName,
  type CheckRouteName,
  type CheckUploadField,
  type ControllerOf,
  type FormOf,
  type ParamsOf,
  type UploadToken,
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
import type { NotificationFake } from '@bespokecore/notifications';
import type { QueueFake } from '@bespokecore/queue';
import type { StorageFake } from '@bespokecore/storage';
import type { ScheduleTester } from '@bespokecore/scheduler';
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
   * Jobs are recorded, not queued (default `'fake'`, E101): the `Queue` is a `QueueFake`, available as `app.queue` —
   * `app.queue.assertDispatched(SendWelcomeMailJob, { userId })`, and `await app.queue.work()` runs them for real in the
   * test. `'real'` keeps the configured connection (`QUEUE_CONNECTION`). Needs @bespokecore/queue.
   */
  queue?: 'fake' | 'real';
  /**
   * Notifications are recorded, not delivered (default `'fake'`): `Notifications` is a `NotificationFake`, available as
   * `app.notifications` — `app.notifications.assertSent({ type: 'user', id }, NewSignInNotification)`, and
   * `await app.notifications.deliver()` delivers them for real. `'real'` keeps the real one (a `send` then queues
   * `bespoke.notification` — on the `QueueFake`, unless `queue: 'real'`). Needs @bespokecore/notifications.
   */
  notifications?: 'fake' | 'real';
  /**
   * Disks are in memory (default `'fake'`): `Storage` is a `StorageFake`, available as `app.storage` — every configured
   * disk a memory disk with its name, visibility and URL, empty in each test: `app.storage.disk('public').assertExists(key)`.
   * The app's routes serve them (`/storage/…`, signed temporary URLs). `'real'` keeps the configured disks. Needs
   * @bespokecore/storage.
   */
  storage?: 'fake' | 'real';
  /**
   * Every dispatched event is recorded — `app.events.assertDispatched(Registered)` (W6.7). Its listeners run as usual
   * (default `'real'`), none run or are queued (`'fake'`), or only those of some events are held back
   * (`[Registered]` — Laravel's `Event::fake([…])`).
   */
  events?: 'real' | 'fake' | readonly EventClass[];
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
  /** Sent as it is (bytes, a stream) — e.g. the bytes of an upload. */
  body?: RequestInit['body'];
}

/** A file for `app.upload(…)`: a `File`/`Blob`, or its name and contents. */
export type UploadFile = Blob | { readonly name: string; readonly contents: string | Uint8Array; readonly type?: string };

type Instance<C> = C extends abstract new (...args: never) => infer I ? I : never;

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
  const queue = options.queue === 'real' ? undefined : await importQueue();
  let queueFake: QueueFake | undefined;
  const notifications = options.notifications === 'real' ? undefined : await importNotifications();
  let notificationFake: NotificationFake | undefined;
  const storage = options.storage === 'real' ? undefined : await importStorage();
  let storageFake: StorageFake | undefined;
  let eventFake: EventFake | undefined;
  let env = { ...(definition.env ?? loadEnv(definition.root)), ...options.env };
  const clock = new TestClock();

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
      // The time, movable from the test (E97): app.travel({ minutes: 5 }), app.freeze().
      container.instance(Clock, clock);
      if (session && options.csrf !== true && container.has(session.CsrfProtection)) container.make(session.CsrfProtection).disable();
      if (mail && container.has(mail.Mailer)) {
        mailFake = new mail.MailFake(container.make(mail.MailConfig).from);
        container.instance(mail.Mailer, mailFake);
      }
      if (queue && container.has(queue.Queue)) {
        queueFake = new queue.QueueFake(container);
        container.instance(queue.Queue, queueFake);
      }
      if (notifications && container.has(notifications.Notifications)) {
        notificationFake = new notifications.NotificationFake(container);
        container.instance(notifications.Notifications, notificationFake);
      }
      if (storage && container.has(storage.Storage)) {
        storageFake = new storage.StorageFake(container);
        container.instance(storage.Storage, storageFake);
      }
      eventFake = new EventFake(container.make(EventRegistry), options.events === 'fake' ? 'all' : options.events === undefined || options.events === 'real' ? [] : options.events);
      container.instance(EventFake, eventFake);
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
  const scheduler = await importScheduler();
  const shared: Shared = {
    kernel: createHttpKernel(application, ssr ? { renderer: ssr.renderer } : {}),
    schedule: scheduler && application.container.has(scheduler.Scheduler) ? new scheduler.ScheduleTester(application.container.make(scheduler.Scheduler), clock) : undefined,
    database,
    mail: mailFake,
    queue: queueFake,
    notifications: notificationFake,
    storage: storageFake,
    events: eventFake!,
    clock,
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
  /** The recording queue, unless the app has no queue or the test chose `queue: 'real'`. */
  readonly queue: QueueFake | undefined;
  /** The recording notifications, unless the app has none or the test chose `notifications: 'real'`. */
  readonly notifications: NotificationFake | undefined;
  /** The memory disks, unless the app has no storage or the test chose `storage: 'real'`. */
  readonly storage: StorageFake | undefined;
  /** Every dispatched event. */
  readonly events: EventFake;
  /** The app's `Clock`. */
  readonly clock: TestClock;
  /** The app's schedule, run with the test clock — when the app has @bespokecore/scheduler. */
  readonly schedule: ScheduleTester | undefined;
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
  /**
   * The id of the session `withSession`/`actingAs` start — the same for every request of this view (and the views made from it),
   * written afresh with their data before each: like one browser, so what binds to a session (an upload) carries over.
   */
  readonly sessionId?: { value?: string };
}

/** Access to the app's session store — when the app uses @bespokecore/session (an optional peer). */
export interface SessionAccess {
  readonly cookie: string;
  /** Writes a session holding `data` (under `id`, or a new id) — returns its id. */
  create(data: Readonly<Record<string, unknown>>, id?: string): Promise<string>;
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

/** @bespokecore/queue is an optional peer, like the session. */
async function importQueue(): Promise<typeof import('@bespokecore/queue') | undefined> {
  try {
    return await import('@bespokecore/queue');
  } catch {
    return undefined;
  }
}

/** @bespokecore/storage is an optional peer, like the session. */
async function importStorage(): Promise<typeof import('@bespokecore/storage') | undefined> {
  try {
    return await import('@bespokecore/storage');
  } catch {
    return undefined;
  }
}

/** @bespokecore/notifications is an optional peer, like the session. */
async function importNotifications(): Promise<typeof import('@bespokecore/notifications') | undefined> {
  try {
    return await import('@bespokecore/notifications');
  } catch {
    return undefined;
  }
}

/** @bespokecore/scheduler is an optional peer, like the session. */
async function importScheduler(): Promise<typeof import('@bespokecore/scheduler') | undefined> {
  try {
    return await import('@bespokecore/scheduler');
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
    if (config.driver === 'cookie') throw new Error('Session helpers in tests need a server-side session driver — memory, file, database or redis (set SESSION_DRIVER=memory in .env.test).');
    return container.make(session.SessionStore);
  };
  return {
    cookie: config.cookie,
    create: async (data, given) => {
      const id = given ?? session.createSessionId();
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
   * The jobs the app dispatched — recorded, not queued: `app.queue.assertDispatched(SendWelcomeMailJob, { userId })`;
   * `await app.queue.work()` runs them for real (injection, a scope per attempt, retries). Needs @bespokecore/queue.
   */
  get queue(): QueueFake {
    if (!this.#shared.queue) throw new Error("app.queue needs @bespokecore/queue in the app (and not createTestApp(…, { queue: 'real' })).");
    return this.#shared.queue;
  }

  /**
   * The notifications the app sent — recorded, not delivered: `app.notifications.assertSent({ type: 'user', id: ada.id },
   * NewSignInNotification, { ip })`; `await app.notifications.deliver()` delivers them for real (rows, queued mails).
   * Needs @bespokecore/notifications.
   */
  get notifications(): NotificationFake {
    if (!this.#shared.notifications) throw new Error("app.notifications needs @bespokecore/notifications in the app (and not createTestApp(…, { notifications: 'real' })).");
    return this.#shared.notifications;
  }

  /**
   * The app's disks, in memory: `app.storage.disk('public').assertExists('avatars/7.webp')`, `assertMissing`,
   * `assertCount`, `files()`. Needs @bespokecore/storage.
   */
  get storage(): StorageFake {
    if (!this.#shared.storage) throw new Error("app.storage needs @bespokecore/storage in the app (and not createTestApp(…, { storage: 'real' })).");
    return this.#shared.storage;
  }

  /**
   * The events the app dispatched — `app.events.assertDispatched(Registered, (event) => event.user.id === ada.id)`,
   * `assertListening(Registered, SendEmailVerification)`. Listeners run unless the test fakes them
   * (`createTestApp(…, { events: 'fake' | [Registered] })`).
   */
  get events(): EventFake {
    return this.#shared.events;
  }

  /**
   * The app's schedule (E88), with the test clock: `app.schedule.due('2026-10-04T03:10:00+02:00')` lists the tasks due
   * then, `await app.schedule.run(time)` moves the clock there and runs them (catching up what was missed since the last
   * `run`, like a scheduler), `app.schedule.runTask(name)` runs one now. Needs @bespokecore/scheduler.
   */
  get schedule(): ScheduleTester {
    if (!this.#shared.schedule) throw new Error('app.schedule needs @bespokecore/scheduler in the app.');
    return this.#shared.schedule;
  }

  /**
   * The app's clock (E97) — every service that reads the time through `Clock` (cache expiry, locks, rate limits, …) sees
   * it move. Redis keeps its own time: a key's `PX` expiry does not follow.
   */
  get clock(): TestClock {
    return this.#shared.clock;
  }

  /** Moves the app's time forward (negative parts: back): `app.travel({ minutes: 1, seconds: 1 })`. Returns the new time. */
  travel(duration: Duration): number {
    return this.#shared.clock.travel(duration);
  }

  /** Jumps to a point in time: `app.travelTo(new Date('2026-12-24T18:00:00Z'))`. */
  travelTo(time: Date | number): number {
    return this.#shared.clock.travelTo(time);
  }

  /** Stops the app's time (now, or at `time`) until the next travel — `app.freeze()` returns the frozen time. */
  freeze(time?: Date | number): number {
    return this.#shared.clock.freeze(time);
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
    return this.#with({ session: { ...this.#defaults.session, ...data }, sessionId: {} });
  }

  /**
   * Signed in as `user` — the session holds exactly what a login leaves (Laravel's `actingAs`):
   * `app.actingAs(ada).get('/users/me')`. With `{ guard: 'api' }`, through a real API token instead
   * (`Authorization: Bearer …`, Sanctum's `actingAs`). Needs @bespokecore/auth; the user must exist.
   */
  actingAs(user: AuthUser, options: { guard?: 'web' } | { guard: 'api'; abilities?: readonly string[] } = {}): TestApp {
    if (options.guard === 'api') return this.#with({ token: { user, abilities: options.abilities ?? ['*'] } });
    return this.#with({ user, sessionId: {} });
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

  /**
   * Requests as an action does (E59, `useAction`): `x-bespoke-action` and `Accept: application/json` — answered with its data
   * (`this.json(…)`), a 422 with the field errors, an `exception` status, or — a redirect, not followed — `204` with
   * `x-bespoke-redirect` (`assertActionRedirect`). Never cached (`no-store`).
   */
  acting(): TestApp {
    return this.withHeaders({ [ACTION_HEADER]: 'true', accept: 'application/json' });
  }

  /**
   * Requests as a live validation does (E62, `useForm(…, { validate })`): the form's own request naming the fields to check
   * (`x-bespoke-validate`) — answered `204` (`assertLiveValid()`), `422` with those fields' errors (`assertInvalid`), or a
   * failure (403, 419, 429). The controller never runs. `app.validating('name', 'email').post('/register', { json })`.
   */
  validating(...fields: string[]): TestApp {
    return this.withHeaders({ [VALIDATE_HEADER]: fields.join(','), accept: 'application/json' });
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

  /**
   * Uploads a file for a form field (W6.9) as the browser does — the route's upload target (its middleware and `authorize`
   * run), then the bytes — and returns the token the form sends in the field:
   *
   * ```ts
   * const ada$ = app.actingAs(ada);
   * const token = await ada$.upload('user-profile.avatar.update', 'avatar', new File([png], 'me.png'), { user: ada.id });
   * app.storage.disk('uploads').assertCount(1);
   * await ada$.put(`/users/${ada.id}/avatar`, { json: { avatar: token } }).assertRedirect();
   * ```
   *
   * The upload belongs to this view's session: send the form through the same view (another one is another browser — 422).
   * A target the route refuses (no `upload()` rule: 404, not allowed: 403, too large: 422) fails with the response.
   */
  async upload<const N extends RouteNameInput, const K extends string>(
    name: CheckRouteName<N>,
    field: CheckUploadField<FormOf<Instance<ControllerOf<N>>>, K>,
    file: UploadFile,
    ...[params]: {} extends ParamsOf<N> ? [params?: ParamsOf<N>] : [params: ParamsOf<N>]
  ): Promise<UploadToken> {
    const router = this.make(Router);
    const route = router.findByName(name as string);
    if (!route) throw new Error(`app.upload(): no route "${String(name)}".`);
    const blob = file instanceof Blob ? file : new Blob([typeof file.contents === 'string' ? file.contents : new Uint8Array(file.contents)], { type: file.type ?? '' });
    const fileName = file instanceof File ? file.name : file instanceof Blob ? 'upload' : file.name;
    const url = urlFor(router, name as string, params as Readonly<Record<string, Param>> | undefined);
    const target = await this.withHeaders({ [UPLOAD_HEADER]: field as string, accept: 'application/json' })
      .request(route.methods[0]!, url, { json: { name: fileName, size: blob.size, type: blob.type } });
    if (target.status !== 200) throw new AssertionError({ message: `The upload target of ${String(name)} (${String(field)}) answered ${target.status}: ${target.body.slice(0, 300)}` });
    const { token, upload } = target.json() as { token: UploadToken; upload: { method: 'PUT' | 'POST'; url: string; fields?: Record<string, string> } };
    if (upload.fields) {
      // A presigned POST to S3 (storage: 'real' with an S3 uploads disk): the fields, then the file.
      const form = new FormData();
      for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
      form.append('file', blob, fileName);
      const sent = await fetch(upload.url, { method: 'POST', body: form });
      if (!sent.ok) throw new AssertionError({ message: `The upload to S3 failed: ${sent.status} ${(await sent.text()).slice(0, 300)}` });
      return token;
    }
    const received = await this.withHeaders({ [UPLOAD_HEADER]: 'bytes', 'content-type': 'application/octet-stream' })
      .request(upload.method, upload.url, { body: new Uint8Array(await blob.arrayBuffer()) });
    if (received.status !== 200) throw new AssertionError({ message: `Sending the upload answered ${received.status}: ${received.body.slice(0, 300)}` });
    return token;
  }

  async #init(method: string, { headers = {}, form, multipart, json, body }: RequestOptions): Promise<RequestInit> {
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
      const holder = this.#defaults.sessionId;
      const id = await session.create(data, holder?.value);
      if (holder) holder.value = id;
      testCookies.push({ name: session.cookie, value: id, encrypt: true });
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
    if (body !== undefined) {
      init.body = body;
      // A stream goes out as it is read (Node needs to be told).
      if (body instanceof ReadableStream) (init as { duplex?: 'half' }).duplex = 'half';
    }
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    return init;
  }
}
