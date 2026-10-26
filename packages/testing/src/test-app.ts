import { Application, Clock, createApplication, EventRegistry, type ApplicationDefinition, type Container, type Duration, type EventClass, type Key, type Resolve } from '@marmeon/core';
import { loadEnv } from '@marmeon/core/internal';
import { EventFake, TestClock } from '@marmeon/core/testing';
import { Encrypter } from '@marmeon/encryption';
import { CookieEncryption, Router } from '@marmeon/http';
import { protocolHeaders, writeAppBrowserRoutes, browserRoutes, CONNECTION_HEADER, LIVE_PATH } from '@marmeon/http/internal';
import {
  urlFor,
  type CheckIslandRouteName,
  type CheckPageRouteName,
  type CheckRouteName,
  type CheckUploadField,
  type ControllerOf,
  type FormOf,
  type InstantProp,
  type ParamsOf,
  type UploadToken,
  type CheckLayerRouteName,
  type Param,
  type Query,
  type RouteArgs,
  type RouteNameInput,
} from '@marmeon/http/page';
import {
  ACTION_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  REGION_HEADER,
  UPLOAD_HEADER,
  VALIDATE_HEADER,
  type LiveSubscription,
  type PageObject,
} from '@marmeon/http/protocol';
import { createHttpKernel, type HttpKernel } from '@marmeon/server';
import { DevRequestRecorder, importRequestRecorder } from '@marmeon/server/internal';
import { AssertionError } from 'node:assert';
import { stripVTControlCharacters } from 'node:util';
import type { AuthUser } from '@marmeon/auth';
import type { MailFake } from '@marmeon/mail/testing';
import type { NotificationFake } from '@marmeon/notifications/testing';
import type { BroadcastTester, LiveStreamReader } from '@marmeon/live/testing';
import type { QueueFake } from '@marmeon/queue/testing';
import type { StorageFake } from '@marmeon/storage/testing';
import type { DevtoolsTester } from '@marmeon/devtools/testing';
import type { ScheduleTester } from '@marmeon/scheduler/testing';
import type { FactoryDefinition, PendingFactory, RowOf, Tables } from '@marmeon/database';
import { prepareWorkerDatabase, workerDatabase, type WorkerDatabase } from './database.ts';
import { TestMarkup } from './markup.ts';
import { PendingTestResponse } from './pending.ts';
import { checkSsrServer, SSR_TEST_HEADER, TestSsr, type SsrServer } from './ssr.ts';
import { TestResponse, type PageNameOf, type PageSource, type PropsOf } from './response.ts';

export interface TestAppOptions {
  /** Extra environment on top of `.env` and `.env.test`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Replace bindings before the app boots — even singletons see these. */
  override?: (container: Container) => void;
  /**
   * Verify CSRF (default: false) — for a test of the protection itself: `Sec-Fetch-Site: same-origin` or the app's own
   * `Origin` pass, another site's is 403; without either header send `_token` or the `X-XSRF-TOKEN` header yourself.
   */
  csrf?: boolean;
  /**
   * `'refresh'`: a real database, reset for every test. Each test worker gets its own database, migrated once; every test
   * app runs inside one transaction that is rolled back when the test ends. Needs @marmeon/database.
   */
  database?: 'refresh';
  /** With `database: 'refresh'`: run the modules' seeders for every test (inside its transaction). */
  seed?: boolean;
  /**
   * Mail is recorded, never sent (default `'fake'`): the `Mailer` is a `MailFake`, available as `app.mail`. `'real'` keeps
   * the configured transport.
   */
  mail?: 'fake' | 'real';
  /**
   * Jobs are recorded, not queued (default `'fake'`): the `Queue` is a `QueueFake`, available as `app.queue` —
   * `app.queue.assertDispatched(SendWelcomeMailJob, { userId })`, and `await app.queue.work()` runs them for real in the
   * test. `'real'` keeps the configured connection (`QUEUE_DRIVER`). Needs @marmeon/queue.
   */
  queue?: 'fake' | 'real';
  /**
   * Notifications are recorded, not delivered (default `'fake'`): `Notifications` is a `NotificationFake`, available as
   * `app.notifications` — `app.notifications.assertSent({ type: 'user', id }, NewSignInNotification)`, and
   * `await app.notifications.deliver()` delivers them for real. `'real'` keeps the real one (a `send` then queues
   * `marmeon.notification` — on the `QueueFake`, unless `queue: 'real'`). Needs @marmeon/notifications.
   */
  notifications?: 'fake' | 'real';
  /**
   * Disks are in memory (default `'fake'`): `Storage` is a `StorageFake`, available as `app.storage` — every configured
   * disk a memory disk with its name, visibility and URL, empty in each test: `app.storage.disk('public').assertExists(key)`.
   * The app's routes serve them (`/storage/…`, signed temporary URLs). `'real'` keeps the configured disks. Needs
   * @marmeon/storage.
   */
  storage?: 'fake' | 'real';
  /**
   * Every dispatched event is recorded — `app.events.assertDispatched(Registered)`. Its listeners run as usual
   * (default `'real'`), none run or are queued (`'fake'`), or only those of some events are held back
   * (`[Registered]`).
   */
  events?: 'real' | 'fake' | readonly EventClass[];
  /**
   * Render pages on the server, through the app's Vite setup (`vite.config.ts`, as `marmeon dev` does) — so the markup
   * and `<Head>` are testable (`assertSee`, `assertServerRendered`, `assertHydrates`). Off by default: responses carry
   * the page object only (fast, no Vite). Every page renders completely, as for a bot — islands included.
   * `'stream'`: as for a browser — the shell first, islands and deferred props streamed into the same response
   * (`app.stream(path)` gives the raw response, to read it as it arrives).
   */
  ssr?: boolean | 'stream';
  /**
   * Render through this Vite server instead of starting one for the app — `await startSsrServer(application)` in `beforeAll`.
   * Needs `ssr`. See docs/testing-pages.md#one-vite-server-per-file.
   */
  ssrServer?: SsrServer;
  /**
   * Development error handling, as `marmeon dev` has it: a page request that fails with a 5xx gets the development
   * error page (code, request, route, queries and log of the request, solutions), JSON errors carry the exception and a
   * `solution`. Off by default — tests see the error page production shows.
   */
  debug?: boolean;
  /**
   * Record what the app does, as the devtools do in development — into memory, available as `app.devtools`:
   * `app.devtools.assertRecorded('query', (query) => query.sql.includes('from "users"'))`, `app.devtools.entries('request')`.
   * The only way to run them outside `NODE_ENV=development` (never in production). Without it they are off in every test —
   * also one that runs as development (`env: { NODE_ENV: 'development' }`). Needs @marmeon/devtools.
   */
  devtools?: boolean;
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
export async function createTestApp(definition: ApplicationDefinition, options: TestAppOptions = {}): Promise<TestApp> {
  const watch = await watchTest();
  if (options.ssrServer) {
    if (!options.ssr) throw new Error("createTestApp(…, { ssrServer }) needs ssr: true (or ssr: 'stream').");
    checkSsrServer(options.ssrServer, definition.root);
  }
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
  const live = await importLive();
  let broadcast: BroadcastTester | undefined;
  const devtools = options.devtools ? await importDevtools() : undefined;
  let devtoolsTester: DevtoolsTester | undefined;
  let eventFake: EventFake | undefined;
  // The devtools record in a test only when it opts in (into memory) — never into the app's storage/framework/devtools, also
  // not in a test that runs as development (`env: { NODE_ENV: 'development' }`, for Server-Timing or the error page).
  // A test app is a test (NODE_ENV=test) unless its environment names another: an `env` option without NODE_ENV would
  // otherwise count as protected, like production.
  let env = { NODE_ENV: 'test', ...loadEnv(definition.root), ...options.env, ...(options.devtools ? {} : { DEVTOOLS_ENABLED: 'false' }) };
  const clock = new TestClock();

  let worker: WorkerDatabase | undefined;
  if (options.database === 'refresh') {
    if (!database) throw new Error("createTestApp(…, { database: 'refresh' }) needs @marmeon/database installed.");
    if (openRefreshed.size > 0) {
      // Two open transactions on the worker's database: SQLite has one writer, so the second app would
      // wait for the first one's lock (5 s, then "database is locked"). One database app per test.
      throw new Error(
        "Another test app with database: 'refresh' is still open. Close it first (await app.close()) — " +
          'each test works in one transaction of one app.',
      );
    }
    worker = await workerDatabase(definition.root, env);
    env = { ...env, ...worker.env };
  } else if (options.seed) {
    throw new Error("createTestApp(…, { seed: true }) seeds a refreshed database: add database: 'refresh'.");
  }

  const application = await createApplication(definition, {
    env,
    override: (container) => {
      // The time, movable from the test: app.travel({ minutes: 5 }), app.freeze().
      container.instance(Clock, clock);
      if (session && options.csrf !== true && container.has(session.CsrfProtection)) container.make(session.CsrfProtection).disable();
      if (mail && container.has(mail.Mailer)) {
        mailFake = new mail.MailFake(container.make(mail.MailConfig).from, container.make(Application));
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
      // Live hints are sent as in production (the streams of `app.live()` get them) — and recorded: `app.broadcast`.
      if (live && container.has(live.Broadcaster)) {
        broadcast = new live.BroadcastTester();
        container.instance(live.BroadcastTester, broadcast);
      }
      eventFake = new EventFake(container.make(EventRegistry), options.events === 'fake' ? 'all' : options.events === undefined || options.events === 'real' ? [] : options.events);
      container.instance(EventFake, eventFake);
      // The devtools' opt-in: a memory store, recorded from the boot on.
      if (devtools) devtoolsTester = devtools.enableDevtoolsForTests(container);
      options.override?.(container);
    },
  });

  if (devtools && !application.container.has(devtools.Recorder)) {
    await application.shutdown();
    throw new Error("createTestApp(…, { devtools: true }): the app does not register @marmeon/devtools — add it to the app's package.json (pnpm add -D @marmeon/devtools), so discovery finds its provider.");
  }

  let ssr: TestSsr | undefined;
  try {
    if (options.ssr) {
      // The SSR entry imports `virtual:marmeon/routes`, which `marmeon route:types` writes — maybe never yet in this checkout.
      writeAppBrowserRoutes(application);
      ssr = await TestSsr.start(definition.root, { stream: options.ssr === 'stream', ...(options.ssrServer ? { server: options.ssrServer } : {}) });
    }
  } catch (error) {
    await application.shutdown();
    throw error;
  }
  const scheduler = await importScheduler();
  // The error page's recorder, as the server's provider binds it in development — until the app closes.
  const recorder = options.debug && !application.container.has(DevRequestRecorder) ? (await importRequestRecorder()).createRequestRecorder(application) : undefined;
  if (recorder) application.container.instance(DevRequestRecorder, recorder);
  const shared: Shared = {
    kernel: createHttpKernel(application, { ...(ssr ? { renderer: ssr.renderer } : {}), ...(options.debug === undefined ? {} : { debug: options.debug }) }),
    schedule: scheduler && application.container.has(scheduler.Scheduler) ? new scheduler.ScheduleTester(application.container.make(scheduler.Scheduler), clock) : undefined,
    database,
    mail: mailFake,
    queue: queueFake,
    notifications: notificationFake,
    storage: storageFake,
    broadcast,
    live,
    events: eventFake!,
    devtools: devtoolsTester,
    clock,
    ssr,
    cleanups: [...(ssr ? [() => ssr.close()] : []), ...(recorder ? [async () => recorder.close()] : [])],
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
      // No await since it counts as open: a late app is closed before it seeds, and the cleanup above frees the worker's database.
      if (watch.ended) throw lateApp();
      if (options.seed) await application.container.make(database.Seeding).run();
    } catch (error) {
      await app.close();
      throw error;
    }
  }
  await closeWhenTheTestEnds(app, watch);
  return app;
}

/** Refreshed test apps not closed yet — at most one at a time (see createTestApp). */
const openRefreshed = new Set<TestApp>();

/** Where the test that called {@link createTestApp} stands: `ended` turns true when it is over. */
interface TestWatch {
  insideTest: boolean;
  ended: boolean;
  onTestFinished: typeof import('vitest').onTestFinished | undefined;
}

async function watchTest(): Promise<TestWatch> {
  const watch: TestWatch = { insideTest: false, ended: false, onTestFinished: undefined };
  try {
    const { onTestFinished } = await import('vitest');
    onTestFinished(() => {
      watch.ended = true;
    });
    watch.insideTest = true;
    watch.onTestFinished = onTestFinished;
  } catch {
    // Not inside a Vitest test.
  }
  return watch;
}

const lateApp = () => new Error('The test ended (or its hook timed out) before this test app was ready; the app was closed again.');

/**
 * Inside a Vitest test (or its `beforeEach`), the app closes when the test ends — its transaction is
 * rolled back, its connections closed. Elsewhere: `app.close()` or `await using`.
 *
 * A hook that timed out while the app was still starting has nothing to close it when the app is ready at last: its test is
 * over, and the open app would make every following test fail with "Another test app … is still open". Such an app closes at once.
 */
async function closeWhenTheTestEnds(app: TestApp, watch: TestWatch): Promise<void> {
  if (!watch.onTestFinished) return;
  if (!watch.ended) {
    watch.onTestFinished(() => app.close());
    return;
  }
  await app.close();
  throw lateApp();
}

interface Shared {
  readonly kernel: HttpKernel;
  readonly database: DatabaseModule | undefined;
  /** The recording mailer, unless the app has no mail or the test chose `mail: 'real'`. */
  readonly mail: MailFake | undefined;
  /** The recording queue, unless the app has no queue or the test chose `queue: 'real'`. */
  readonly queue: QueueFake | undefined;
  /** The recording notifications, unless the app has none or the test chose `notifications: 'real'`. */
  readonly notifications: NotificationFake | undefined;
  /** The memory disks, unless the app has no storage or the test chose `storage: 'real'`. */
  readonly storage: StorageFake | undefined;
  /** What the devtools recorded, with `createTestApp(…, { devtools: true })`. */
  readonly devtools: DevtoolsTester | undefined;
  /** What the app's Broadcaster sent — when it has @marmeon/live. */
  readonly broadcast: BroadcastTester | undefined;
  readonly live: LiveModule | undefined;
  /** Every dispatched event. */
  readonly events: EventFake;
  /** The app's `Clock`. */
  readonly clock: TestClock;
  /** The app's schedule, run with the test clock — when the app has @marmeon/scheduler. */
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

/** Access to the app's session store — when the app uses @marmeon/session (an optional peer). */
export interface SessionAccess {
  readonly cookie: string;
  /** Writes a session holding `data` (under `id`, or a new id) — returns its id. */
  create(data: Readonly<Record<string, unknown>>, id?: string): Promise<string>;
  read(id: string): Promise<Record<string, unknown> | undefined>;
}

type DatabaseModule = typeof import('@marmeon/database');

/** @marmeon/database is an optional peer, like the session. */
async function importDatabase(): Promise<DatabaseModule | undefined> {
  try {
    return await import('@marmeon/database');
  } catch {
    return undefined;
  }
}

/** @marmeon/mail is an optional peer, like the session. */
async function importMail(): Promise<(typeof import('@marmeon/mail') & typeof import('@marmeon/mail/testing')) | undefined> {
  try {
    return { ...(await import('@marmeon/mail')), ...(await import('@marmeon/mail/testing')) };
  } catch {
    return undefined;
  }
}

/** @marmeon/queue is an optional peer, like the session. */
async function importQueue(): Promise<(typeof import('@marmeon/queue') & typeof import('@marmeon/queue/testing')) | undefined> {
  try {
    return { ...(await import('@marmeon/queue')), ...(await import('@marmeon/queue/testing')) };
  } catch {
    return undefined;
  }
}

/** @marmeon/devtools is an optional peer (a dev dependency of the app) — needed only with `devtools: true`. */
async function importDevtools(): Promise<typeof import('@marmeon/devtools/internal')> {
  try {
    return await import('@marmeon/devtools/internal');
  } catch (error) {
    throw new Error('createTestApp(…, { devtools: true }) needs @marmeon/devtools (pnpm add -D @marmeon/devtools).', { cause: error });
  }
}

/** @marmeon/storage is an optional peer, like the session. */
async function importStorage(): Promise<(typeof import('@marmeon/storage') & typeof import('@marmeon/storage/testing')) | undefined> {
  try {
    return { ...(await import('@marmeon/storage')), ...(await import('@marmeon/storage/testing')) };
  } catch {
    return undefined;
  }
}

type LiveModule = typeof import('@marmeon/live') & typeof import('@marmeon/live/testing');

/** @marmeon/live is an optional peer, like the session. */
async function importLive(): Promise<LiveModule | undefined> {
  try {
    return { ...(await import('@marmeon/live')), ...(await import('@marmeon/live/testing')) };
  } catch {
    return undefined;
  }
}

/** @marmeon/notifications is an optional peer, like the session. */
async function importNotifications(): Promise<(typeof import('@marmeon/notifications') & typeof import('@marmeon/notifications/testing')) | undefined> {
  try {
    return { ...(await import('@marmeon/notifications')), ...(await import('@marmeon/notifications/testing')) };
  } catch {
    return undefined;
  }
}

/** @marmeon/scheduler is an optional peer, like the session. */
async function importScheduler(): Promise<(typeof import('@marmeon/scheduler') & typeof import('@marmeon/scheduler/testing')) | undefined> {
  try {
    return { ...(await import('@marmeon/scheduler')), ...(await import('@marmeon/scheduler/testing')) };
  } catch {
    return undefined;
  }
}

/** `marmeon` is an optional peer, like the session. */
async function importCli(): Promise<typeof import('marmeon') & typeof import('marmeon/internal')> {
  try {
    return { ...(await import('marmeon')), ...(await import('marmeon/internal')) };
  } catch (error) {
    throw new Error('app.command() needs marmeon in the app (pnpm add marmeon).', { cause: error });
  }
}

/** The options of `app.command()` as the flags `marmeon` takes: `true` is a bare flag, `false` and `undefined` leave it out, an array repeats it. */
function commandFlags(options: CommandRunOptions['options'] = {}): string[] {
  const flags: string[] = [];
  for (const [name, value] of Object.entries(options)) {
    // `marmeon` takes `--no-interaction` itself; here nothing is asked anyway.
    if (name === 'no-interaction') continue;
    for (const each of Array.isArray(value) ? value : [value]) {
      if (each === undefined || each === false) continue;
      flags.push(each === true ? `--${name}` : `--${name}=${each}`);
    }
  }
  return flags;
}

/** @marmeon/auth is an optional peer, like the session. */
async function importAuth(): Promise<typeof import('@marmeon/auth/testing') | undefined> {
  try {
    return await import('@marmeon/auth/testing');
  } catch {
    return undefined;
  }
}

/** @marmeon/session is an optional peer: only apps that use it have it installed. */
async function importSession(): Promise<(typeof import('@marmeon/session') & typeof import('@marmeon/session/internal')) | undefined> {
  try {
    return { ...(await import('@marmeon/session')), ...(await import('@marmeon/session/internal')) };
  } catch {
    return undefined;
  }
}

async function sessionAccess(container: Container): Promise<SessionAccess | undefined> {
  const session = await importSession();
  if (!session || !container.has(session.SessionConfig)) return undefined;
  const config = container.make(session.SessionConfig);
  const store = () => container.make(session.SessionStore);
  // Like the session itself: stored under the id's hash, the payload through the app's codec (SESSION_ENCRYPT).
  const codec = () => container.make(session.SessionCodec);
  return {
    cookie: session.sessionCookieName(config),
    create: async (data, given) => {
      const id = given ?? session.createSessionId();
      const key = session.sessionKey(id);
      const token = crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
      const json = session.sealPayload({ _token: token, ...data });
      const user = data[session.SESSION_USER_KEY];
      const userId = typeof user === 'string' || typeof user === 'number' ? String(user) : null;
      const sealed = await codec().seal(json, key);
      // The same id again (one browser): written over what is there — never removed first (a request of the same view may be
      // reading it right now).
      for (;;) {
        const current = await store().read(key);
        const written = await store().write(key, sealed, { expectedVersion: current?.version, lifetimeSeconds: config.lifetime * 60, userId });
        if (written === 'written') break;
        if (!current && written === 'conflict') await store().destroy(key); // an expired session under the key
      }
      return id;
    },
    read: async (id) => {
      if (!session.SESSION_ID.test(id)) return undefined;
      const key = session.sessionKey(id);
      const stored = await store().read(key);
      const json = stored ? await codec().open(stored.data, key) : undefined;
      if (json === undefined) return undefined;
      const opened = session.openPayload(json);
      return opened.kind === 'ok' ? opened.data : undefined;
    },
  };
}

/** How the app encrypts cookies — so tests can send and read plain values. */
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

/** What `app.command()` takes besides the command's name. */
export interface CommandRunOptions {
  /** The directory the command runs in, and where a command it starts runs. Without it the app's root, and a command may not start another `marmeon`. */
  readonly root?: string;
  /** The positional arguments after the name. */
  readonly args?: readonly string[];
  /** The command's flags by name: `true` is a bare `--name`, a string or number is `--name=value`, an array repeats the flag, `false` leaves it out. */
  readonly options?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>>;
}

/** What `app.command()` resolves with. */
export interface CommandRun {
  /** The exit code `marmeon` would end with. */
  readonly code: number;
  /** Everything the command printed, line by line, errors included, without colours. */
  readonly lines: readonly string[];
}

export class TestApp {
  readonly application: Application;
  readonly #shared: Shared;
  readonly #defaults: Defaults;
  readonly #crypto: CookieCrypto;
  readonly #session: Promise<SessionAccess | undefined>;

  /**
   * Use `createTestApp()`.
   *
   * @internal
   */
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
   * Needs @marmeon/mail in the app.
   */
  get mail(): MailFake {
    if (!this.#shared.mail) throw new Error("app.mail needs @marmeon/mail in the app (and not createTestApp(…, { mail: 'real' })).");
    return this.#shared.mail;
  }

  /**
   * The jobs the app dispatched — recorded, not queued: `app.queue.assertDispatched(SendWelcomeMailJob, { userId })`;
   * `await app.queue.work()` runs them for real (injection, a scope per attempt, retries). Needs @marmeon/queue.
   */
  get queue(): QueueFake {
    if (!this.#shared.queue) throw new Error("app.queue needs @marmeon/queue in the app (and not createTestApp(…, { queue: 'real' })).");
    return this.#shared.queue;
  }

  /**
   * The notifications the app sent — recorded, not delivered: `app.notifications.assertSent({ type: 'user', id: ada.id },
   * NewSignInNotification, { ip })`; `await app.notifications.deliver()` delivers them for real (rows, queued mails).
   * Needs @marmeon/notifications.
   */
  get notifications(): NotificationFake {
    if (!this.#shared.notifications) throw new Error("app.notifications needs @marmeon/notifications in the app (and not createTestApp(…, { notifications: 'real' })).");
    return this.#shared.notifications;
  }

  /**
   * The app's disks, in memory: `app.storage.disk('public').assertExists('avatars/7.webp')`, `assertMissing`,
   * `assertCount`, `files()`. Needs @marmeon/storage.
   */
  get storage(): StorageFake {
    if (!this.#shared.storage) throw new Error("app.storage needs @marmeon/storage in the app (and not createTestApp(…, { storage: 'real' })).");
    return this.#shared.storage;
  }

  /**
   * What the app's `Broadcaster` sent — every refresh once it went out (after its commit): `app.broadcast.assertRefreshed(
   * \`users.${ada.id}\`, { only: ['profile'] })`, `assertNotRefreshed`, `assertNothingRefreshed`. The hints reach the streams as in
   * production (`app.live(path)`). Needs @marmeon/live.
   */
  get broadcast(): BroadcastTester {
    if (!this.#shared.broadcast) throw new Error('app.broadcast needs @marmeon/live in the app.');
    return this.#shared.broadcast;
  }

  /**
   * Opens a live stream as a tab does — for the channels the page at `path` follows (signed for this view's session), or for
   * those given (`(await app.island(…)).page()?.live`) — and reads it as it arrives: `hello()`, `waitFor(n)`, `hints`. Signing
   * out through the same view ends it; it closes with the app or `stream.close()`. `connection` is the tab's id
   * (`x-marmeon-connection`, default `test-tab-0001`). See `docs/fakes.md#live-updates`.
   */
  async live(
    target: string | readonly LiveSubscription[],
    { connection = 'test-tab-0001', lastEventId }: { connection?: string; lastEventId?: string } = {},
  ): Promise<LiveStreamReader> {
    const module = this.#shared.live;
    if (!module) throw new Error('app.live() needs @marmeon/live in the app.');
    let subscriptions = target;
    if (typeof target === 'string') {
      const answer = await this.navigating().get(target);
      const page = answer.status === 200 ? (answer.json() as PageObject) : undefined;
      if (!page?.live?.length) throw new AssertionError({ message: `app.live(${JSON.stringify(target)}): the page answered ${answer.status} and follows no live channel (.live()).` });
      subscriptions = page.live;
    }
    const query = new URLSearchParams({ connection });
    const channels = new Map((subscriptions as readonly LiveSubscription[]).map((subscription) => [subscription.channel, subscription.token]));
    for (const [channel, token] of channels) query.append('c', `${token}.${channel}`);
    const response = await this.stream(`${LIVE_PATH}?${query}`, {
      headers: { accept: 'text/event-stream', ...protocolHeaders(), [CONNECTION_HEADER]: connection, ...(lastEventId === undefined ? {} : { 'last-event-id': lastEventId }) },
    });
    const reader = new module.LiveStreamReader(response);
    this.#shared.cleanups.push(() => reader.close());
    return reader;
  }

  /**
   * What the devtools recorded — with `createTestApp(App, { devtools: true })`: `app.devtools.entries('request')`,
   * `app.devtools.assertRecorded('mail', (mail) => mail.to.includes('ada@example.com'))`.
   */
  get devtools(): DevtoolsTester {
    if (!this.#shared.devtools) throw new Error('app.devtools needs createTestApp(…, { devtools: true }) (and @marmeon/devtools in the app).');
    return this.#shared.devtools;
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
   * The app's schedule, with the test clock: `app.schedule.due('2026-10-04T03:10:00+02:00')` lists the tasks due
   * then, `await app.schedule.run(time)` moves the clock there and runs them (catching up what was missed since the last
   * `run`, like a scheduler), `app.schedule.runTask(name)` runs one now. Needs @marmeon/scheduler.
   */
  get schedule(): ScheduleTester {
    if (!this.#shared.schedule) throw new Error('app.schedule needs @marmeon/scheduler in the app.');
    return this.#shared.schedule;
  }

  /**
   * The app's clock — every service that reads the time through `Clock` (cache expiry, locks, rate limits, …) sees
   * it move. Redis keeps its own time: a key's `PX` expiry does not follow.
   */
  get clock(): TestClock {
    return this.#shared.clock;
  }

  /** Moves the app's time forward (negative parts: back; a number is seconds): `app.travel({ minutes: 1, seconds: 1 })`. Returns the new time. */
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
   * Rows from a factory, in this app's database:
   * `await app.factory(UserFactory).count(3).create()`. Needs @marmeon/database.
   */
  factory<T extends keyof DB & string, DB, S extends string>(definition: FactoryDefinition<T, DB, S>): PendingFactory<T, DB, false, S> {
    return this.application.container.make(this.#requireDatabase('app.factory()').Factories).for(definition);
  }

  // --- Database assertions -----------------------------------------------------------

  /** A row in `table` matches every given column value. */
  async assertDatabaseHas<T extends keyof DB & string, DB = Tables>(table: T, where: Partial<RowOf<DB[T]>>): Promise<this> {
    const { matching, sample } = await this.#rows(table, where as Record<string, unknown>);
    if (matching === 0) {
      throw new AssertionError({
        message: `Expected a row in "${table}" matching ${JSON.stringify(where)} — found none.\n  ${sample}`,
      });
    }
    return this;
  }

  /** No row in `table` matches the given column values. */
  async assertDatabaseMissing<T extends keyof DB & string, DB = Tables>(table: T, where: Partial<RowOf<DB[T]>>): Promise<this> {
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
    if (!this.#shared.database) throw new Error(`${feature} needs @marmeon/database installed.`);
    return this.#shared.database;
  }

  /** Resolves a service from the app, e.g. to inspect state after a request. */
  make<K extends Key<any>>(key: K): Resolve<K> {
    return this.application.container.make(key as never) as Resolve<K>;
  }

  /**
   * Runs a console command by its name, against this app's own container, config and database: `await app.command('cache:clear')`,
   * `app.command('uploads:prune', { options: { hours: 2, force: true } })`. Flags are parsed and checked as `marmeon <name>` does, and
   * nothing is asked (`--no-interaction`). Resolves with the exit code and the lines the command printed (errors included, no colours);
   * a non-zero exit does not throw. An unknown command or wrong flags exit with 2, a command that throws with 1. A command that starts
   * another `marmeon` (`make:auth`) needs `root` to run it in. Needs marmeon. See `docs/testing.md#running-commands`.
   */
  async command(name: string, { args = [], options, root }: CommandRunOptions = {}): Promise<CommandRun> {
    const cli = await importCli();
    const lines: string[] = [];
    const push = (text: string) => void lines.push(...stripVTControlCharacters(text).replace(/\n$/, '').split('\n'));
    const output = Object.assign(new cli.Output(), {
      line: (text = '') => push(text),
      warn: (text: string) => push(`! ${text}`),
      error: (text: string) => push(`✗ ${text}`),
    });
    const container = this.application.container;
    if (!container.has(cli.CommandRegistry)) {
      throw new Error('app.command() needs the CLI provider in the app: register CliServiceProvider of marmeon (installed packages register it: marmeon discover).');
    }
    const registry = container.make(cli.CommandRegistry);
    const Command = registry.get(name);
    if (!Command) {
      output.error(`Command "${name}" is not defined. Run "marmeon list" to see all commands.`);
      return { code: 2, lines };
    }
    if (options?.help === true && !Command.options?.help) {
      cli.printCommandHelp({ output }, Command);
      return { code: 0, lines };
    }
    const argv = [...commandFlags(options), ...(args.some((arg) => arg.startsWith('-')) ? ['--'] : []), ...args];
    const scope = container.createScope();
    if (!scope.has(cli.CommandRegistry)) scope.instance(cli.CommandRegistry, registry);
    const where = root ?? this.application.root;
    const spawn = async (...spawned: string[]): Promise<number> => {
      if (root === undefined) {
        output.error('A sub-command runs as its own marmeon process; pass `root` (a temporary directory) to let it run there.');
        return 1;
      }
      return await cli.spawnMarmeon(root, spawned, true, push);
    };
    try {
      const code = await cli.runCommand(scope, Command, argv, { output, root: where, spawn });
      return { code, lines };
    } catch (error) {
      if (error instanceof cli.CommandArgumentsError) {
        output.error(error.message);
        return { code: 2, lines };
      }
      cli.printError(output, error);
      return { code: 1, lines };
    }
  }

  // --- Request defaults (each returns a new view of the same app) -------------------

  withHeaders(headers: Record<string, string>): TestApp {
    return this.#with({ headers: { ...this.#defaults.headers, ...headers } });
  }

  /** Sends a cookie, encrypted like the app encrypts its own. */
  withCookie(name: string, value: string): TestApp {
    return this.#with({ cookies: [...this.#defaults.cookies, { name, value, encrypt: true }] });
  }

  /**
   * Starts the request with a session holding `data`:
   * `app.withSession({ cart: [42] }).get('/checkout')` — to sign someone in, use `actingAs(user)`.
   */
  withSession(data: Record<string, unknown>): TestApp {
    return this.#with({ session: { ...this.#defaults.session, ...data }, sessionId: {} });
  }

  /**
   * Signed in as `user` — the session holds exactly what a login leaves: `app.actingAs(ada).get('/users/me')`. With
   * `{ guard: 'api' }`, through a real API token instead (`Authorization: Bearer …`). Needs @marmeon/auth; the user must exist.
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
    return this.withHeaders(protocolHeaders());
  }

  /** Requests as a prefetch (`<Link prefetch>`): a client-side navigation with `Purpose: prefetch` — see `isPrefetch`. */
  prefetching(): TestApp {
    return this.withHeaders({ ...protocolHeaders(), [PURPOSE_HEADER]: 'prefetch' });
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
      ...protocolHeaders(),
      [PARTIAL_COMPONENT_HEADER]: component,
      ...(only ? { [PARTIAL_DATA_HEADER]: only.join(',') } : {}),
      ...(except.length > 0 ? { [PARTIAL_EXCEPT_HEADER]: except.join(',') } : {}),
    });
  }

  /**
   * Requests as an `<Island route>` does: a client-side request with `x-marmeon-region: island` — answered with the
   * island's region object, or (redirect, 401, 403) with its outcome. For a partial reload of the island, chain
   * `reloading(component, { only })`.
   */
  islanding(): TestApp {
    return this.withHeaders({ ...protocolHeaders(), [REGION_HEADER]: 'island' });
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
   * Requests as a layer does — opening one (`<Link layer>`), or a visit or form inside one: a client-side request
   * with `x-marmeon-region: layer`. A layer route answers with its page object (`assertLayer`), `closeLayer()` with "close"
   * (`assertLayerClosed`), a page route with its page.
   */
  layering(): TestApp {
    return this.withHeaders({ ...protocolHeaders(), [REGION_HEADER]: 'layer' });
  }

  /** Opens a layer by route name — what `<Link route params layer>` sends: `app.layer('user-profile.edit', { user: ada.id })`. */
  layer<const N extends RouteNameInput>(name: CheckLayerRouteName<N>, ...[params, query]: RouteArgs<N>): PendingTestResponse {
    const path = urlFor(this.make(Router), name, params as Readonly<Record<string, Param>> | undefined, query as Query | undefined);
    return this.layering().get(path);
  }

  /**
   * Renders the placeholder of the page a route shows — what `<Link route instant>` puts on screen before the answer — in its layouts:
   * `(await app.placeholder('notes.show', { title })).assertSee(title)`. `instant` is what the controller's `declare readonly instant: {…}`
   * names, as the link passes it. The view is the one the controller writes out once (`this.view('notes/Show', …)`: it is in
   * `.marmeon/routes.json`). Needs `createTestApp(…, { ssr: true })`. See `docs/testing-pages.md#instant-visits`.
   */
  async placeholder<const N extends RouteNameInput>(
    route: CheckPageRouteName<N>,
    ...[instant]: true extends InstantProp<N> ? [instant?: InstantProp<N>] : [instant: InstantProp<N>]
  ): Promise<TestMarkup> {
    const name: string = route;
    const fail = (message: string): never => {
      throw new AssertionError({ message: `app.placeholder('${name}'): ${message}` });
    };
    const { ssr } = this.#shared;
    if (!ssr) return fail('it needs server rendering in the test: createTestApp(app, { ssr: true })');
    const found = browserRoutes(this.make(Router).routes, this.application.definition.clientRoutes).routes[name];
    if (!found) return fail('no such route, or the browser does not learn it (an `.internal()` or API route, or `clientRoutes.except`).');
    if (!found.view) {
      return fail("the route does not name its view once, so there is none to look up — write it out in the controller (`this.view('notes/Show', …)`), not computed.");
    }
    try {
      return new TestMarkup(await ssr.placeholder(found.view, instant === true || instant === undefined ? {} : (instant as unknown as Readonly<Record<string, unknown>>), found.path));
    } catch (error) {
      const reason = error instanceof Error ? (error.stack ?? error.message) : String(error);
      return fail(error instanceof Error && error.message.includes('has no placeholder') ? error.message : `the placeholder did not render: ${reason}`);
    }
  }

  /**
   * Requests as an action does (`useAction`): `x-marmeon-action` and `Accept: application/json` — answered with its data
   * (`this.json(…)`), a 422 with the field errors, an `exception` status, or — a redirect, not followed — `204` with
   * `x-marmeon-redirect` (`assertActionRedirect`). Never cached (`no-store`).
   */
  acting(): TestApp {
    return this.withHeaders({ ...protocolHeaders(), [ACTION_HEADER]: 'true', accept: 'application/json' });
  }

  /**
   * Requests as a live validation does (`useForm(…, { validate })`): the form's own request naming the fields to check
   * (`x-marmeon-validate`) — answered `204` (`assertLiveValid()`), `422` with those fields' errors (`assertInvalid`), or a
   * failure (403, 419, 429). The controller never runs. `app.validating('name', 'email').post('/register', { json })`.
   */
  validating(...fields: string[]): TestApp {
    return this.withHeaders({ ...protocolHeaders(), [VALIDATE_HEADER]: fields.join(','), accept: 'application/json' });
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
        await this.#shared.kernel.settle(); // terminate hooks ran
        await this.#shared.devtools?.settled(); // the request's entries are written (an exception's solutions looked up)
        return response;
      });
    return new PendingTestResponse(response);
  }

  /**
   * Uploads a file for a form field as the browser does — the route's upload target (its middleware and `authorize` run),
   * then the bytes — and returns the token the form sends in the field. The upload belongs to this view's session: send the
   * form through the same view (another one is another browser — 422). A target the route refuses fails with the response.
   * See `docs/http-tests.md#uploads`.
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
    const target = await this.withHeaders({ ...protocolHeaders(), [UPLOAD_HEADER]: field as string, accept: 'application/json' })
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
    const received = await this.withHeaders({ ...protocolHeaders(), [UPLOAD_HEADER]: 'bytes', 'content-type': 'application/octet-stream' })
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
      if (!auth) throw new Error("actingAs(…, { guard: 'api' }) needs @marmeon/auth in the app.");
      const { user, abilities } = this.#defaults.token;
      tokenHeader.authorization = `Bearer ${await auth.authenticatedToken(this.application.container, user, abilities)}`;
    }
    if (this.#defaults.user !== undefined) {
      const auth = await importAuth();
      if (!auth) throw new Error('actingAs() needs @marmeon/auth in the app.');
      data = { ...data, ...(await auth.authenticatedSession(this.application.container, this.#defaults.user)) };
    }
    if (data) {
      const session = await this.#session;
      if (!session) throw new Error('withSession() and actingAs() need @marmeon/session in the app.');
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
