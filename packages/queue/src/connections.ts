import type { Cache } from '@marmeon/cache';
import { Application, Clock, EventDispatcher, Logger, Redactor, type Container } from '@marmeon/core';
import { collectDrivers } from '@marmeon/core/internal';
import { QueueConfig } from './config.ts';
import type { FailedJobStore, FailedJobStoreFactory, QueueConnection, QueueDriver, QueueDriverFactory } from './driver.ts';
import { DatabaseFailedJobStore, DatabaseQueueDriver, FAILED_JOBS_TABLE, JOBS_TABLE, type DatabaseQueueConnection } from './drivers/database.ts';
import { NullFailedJobStore } from './drivers/memory.ts';
import { RedisQueueDriver } from './drivers/redis.ts';
import type { JobEvent } from './events.ts';
import type { QueueConnectionOptions } from './queue.ts';
import { JobRegistry, QueueSetupError, timeoutOf } from './registry.ts';
import { JobRunner, type PayloadCipher } from './runner.ts';
import { Worker } from './worker.ts';
import { withCode } from '@marmeon/core/internal';

/** A queue driver's package is missing — what to install, said at startup (the CLI prints it without a stack trace). */
async function importOptional<T>(load: () => Promise<T>, name: string, what: string, install: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (code === 'ERR_MODULE_NOT_FOUND' && typeof message === 'string' && message.includes(name)) {
      throw new QueueSetupError(withCode('Q4', `${what} needs ${name}, which is not installed in this app: ${install}`));
    }
    throw error;
  }
}

/** The names the framework's own drivers answer to — a provider cannot bring a driver under one of them. */
export const BUILT_IN_QUEUE_DRIVERS = ['sync', 'database', 'redis'] as const;
export const BUILT_IN_FAILED_DRIVERS = ['database', 'null'] as const;

export const importDatabase = (what = 'QUEUE_CONNECTION=database') =>
  importOptional(() => import('@marmeon/database'), '@marmeon/database', what, 'pnpm add @marmeon/database');
export const importEncryption = () =>
  importOptional(() => import('@marmeon/encryption'), '@marmeon/encryption', 'An encrypted job (static encrypted)', 'pnpm add @marmeon/encryption');
export const importRedis = () => importOptional(() => import('@marmeon/redis'), '@marmeon/redis', 'QUEUE_CONNECTION=redis', 'pnpm add @marmeon/redis');
export const importCache = () =>
  importOptional(() => import('@marmeon/cache'), '@marmeon/cache', 'Unique jobs, withoutOverlapping and job.once', 'pnpm add @marmeon/cache');

/**
 * The queue's connections, built on first use: a driver per connection, the failed-job store, and workers for
 * `queue:work`. One per application.
 */
export class QueueConnections {
  readonly #container: Container;
  readonly #config: QueueConfig;
  readonly #drivers = new Map<string, QueueDriver>();
  readonly #queueFactories: ReadonlyMap<string, QueueDriverFactory>;
  readonly #failedFactories: ReadonlyMap<string, FailedJobStoreFactory>;
  readonly #custom = new Map<string, QueueConnection>();
  readonly #failures = new Map<string, unknown>();
  #failed: FailedJobStore | undefined;
  #runner: JobRunner | undefined;

  constructor(container: Container, config: QueueConfig) {
    this.#container = container;
    this.#config = config;
    // The drivers that providers bring: a built-in name, a name twice or a malformed one stops the start here.
    const { providers } = container.make(Application);
    this.#queueFactories = collectDrivers<QueueDriverFactory>(providers, 'queueDrivers', BUILT_IN_QUEUE_DRIVERS, 'queue driver');
    this.#failedFactories = collectDrivers<FailedJobStoreFactory>(providers, 'failedJobDrivers', BUILT_IN_FAILED_DRIVERS, 'failed-job store');
  }

  /**
   * Fails the start when `QUEUE_CONNECTION` or `QUEUE_FAILED_DRIVER` names a driver nobody brought (a typo never lands on another
   * driver), and builds what a driver of a provider provides — its factory's errors surface now, not at the first dispatch.
   */
  verify(): void {
    this.options(this.default);
    const failed = this.#config.failed.driver;
    if (!(BUILT_IN_FAILED_DRIVERS as readonly string[]).includes(failed) && !this.#failedFactories.has(failed)) {
      throw new QueueSetupError(withCode('Q4', `QUEUE_FAILED_DRIVER=${failed} is not a failed-job store. Known: ${[...BUILT_IN_FAILED_DRIVERS, ...this.#failedFactories.keys()].join(', ')}.`));
    }
    this.failed();
  }

  get default(): string {
    return this.#config.default;
  }

  names(): string[] {
    return [...Object.keys(this.#config.connections), ...this.#queueFactories.keys()];
  }

  options(name: string): QueueConnectionOptions {
    const options = this.find(name);
    if (!options) throw new QueueSetupError(withCode('Q4', `The queue connection "${name}" is not configured. Known: ${this.names().join(', ')}.`));
    return options;
  }

  /** {@link options}, or `undefined` for a name that is no connection. */
  find(name: string): QueueConnectionOptions | undefined {
    // A `custom` entry of an overridden config names no factory of its own: only a provider's driver is custom.
    const built = Object.hasOwn(this.#config.connections, name) ? this.#config.connections[name] : undefined;
    if (built && built.driver !== 'custom') return built;
    const custom = this.#customConnection(name);
    return custom && { driver: 'custom', queue: custom.queue, retryAfter: custom.retryAfter };
  }

  /**
   * The connection a provider's driver provides — built once, its failure remembered (a factory that throws does not run, and leak,
   * again on every lookup). The result is checked: a driver without a positive `retryAfter` never runs.
   */
  #customConnection(name: string): QueueConnection | undefined {
    const made = this.#custom.get(name);
    if (made) return made;
    if (this.#failures.has(name)) throw this.#failures.get(name);
    const factory = this.#queueFactories.get(name);
    if (!factory) return undefined;
    try {
      const checked = checkConnection(name, factory({ name, container: this.#container, clock: this.#container.make(Clock) }));
      this.#custom.set(name, checked);
      return checked;
    } catch (error) {
      this.#failures.set(name, error);
      throw error;
    }
  }

  /** The driver of a connection that keeps jobs (not `sync`). */
  driver(name: string): QueueDriver {
    let driver = this.#drivers.get(name);
    if (!driver) {
      const options = this.options(name);
      if (options.driver === 'sync') throw new QueueSetupError(withCode('Q4', `The sync queue connection runs each job when it is dispatched — it keeps no jobs to work on.`));
      const clock = this.#container.make(Clock);
      driver =
        options.driver === 'custom'
          ? this.#customConnection(name)!.driver
          : options.driver === 'redis'
          ? new RedisQueueDriver(async () => this.#container.make((await importRedis()).RedisConnections).get(options.connection), { retryAfter: options.retryAfter, clock })
          : new DatabaseQueueDriver(async () => this.#database(options.connection), { retryAfter: options.retryAfter, clock });
      this.#drivers.set(name, driver);
    }
    return driver;
  }

  /** Where failed jobs go (`QUEUE_FAILED_DRIVER`). */
  failed(): FailedJobStore {
    this.#failed ??= this.#failedStore();
    return this.#failed;
  }

  #failedStore(): FailedJobStore {
    const name = this.#config.failed.driver;
    if (name === 'null') return new NullFailedJobStore();
    if (name === 'database') return new DatabaseFailedJobStore(async () => this.#database(this.#config.failed.connection, 'QUEUE_FAILED_DRIVER=database'));
    const factory = this.#failedFactories.get(name);
    if (!factory) throw new QueueSetupError(withCode('Q4', `QUEUE_FAILED_DRIVER=${name} is not a failed-job store. Known: ${[...BUILT_IN_FAILED_DRIVERS, ...this.#failedFactories.keys()].join(', ')}.`));
    const key = `failed:${name}`;
    if (this.#failures.has(key)) throw this.#failures.get(key);
    try {
      const store = factory({ container: this.#container });
      const members = ['record', 'all', 'find', 'forget', 'flush', 'prune'] as const;
      if (members.some((member) => typeof (store as Partial<FailedJobStore> | undefined)?.[member] !== 'function')) {
        throw new QueueSetupError(withCode('Q4', `The failed-job store "${name}" must return a FailedJobStore (${members.join(', ')}).`));
      }
      return store;
    } catch (error) {
      this.#failures.set(key, error);
      throw error;
    }
  }

  runner(): JobRunner {
    this.#runner ??= new JobRunner(this.#container, this.#container.make(JobRegistry), () => this.cipher(), () => this.cache());
    return this.#runner;
  }

  /** The app's cache (@marmeon/cache) — for unique jobs, `withoutOverlapping` and `job.once`. */
  async cache(): Promise<Cache> {
    const { Cache } = await importCache();
    if (!this.#container.has(Cache)) {
      throw new QueueSetupError(withCode('Q4', 'Unique jobs, withoutOverlapping and job.once keep their locks in the app\'s cache — register the CacheServiceProvider of @marmeon/cache (installed packages register it: marmeon discover).'));
    }
    return this.#container.make(Cache);
  }

  /** Dispatches a job event through the app's `EventDispatcher` (listeners built from the root container). */
  readonly events = (event: JobEvent): Promise<void> => this.#container.make(EventDispatcher).dispatch(event);

  /** The app's `Encrypter`, for `static encrypted` jobs. */
  async cipher(): Promise<PayloadCipher> {
    const { Encrypter } = await importEncryption();
    if (!this.#container.has(Encrypter)) throw new QueueSetupError(withCode('Q4', 'An encrypted job (static encrypted) needs the EncryptionServiceProvider of @marmeon/encryption and an APP_KEY.'));
    return this.#container.make(Encrypter);
  }

  /**
   * A worker for `connection`, after checking that every job's timeout fits the connection's `retryAfter`: a job may
   * hold its claim for `timeout` plus `stopTimeout` (the grace before its worker gives up), and must be done before
   * another worker may claim it again.
   */
  worker(connection: string, stopTimeout: number): Worker {
    const options = this.options(connection);
    if (options.driver === 'sync') throw new QueueSetupError(withCode('Q4', 'The sync queue connection runs each job when it is dispatched — there is nothing for a worker to do. Use --connection=database (or redis).'));
    checkTimeouts(this.#container.make(JobRegistry), connection, options.retryAfter, stopTimeout);
    return new Worker({
      driver: this.driver(connection),
      connection,
      runner: this.runner(),
      failed: this.failed(),
      clock: this.#container.make(Clock),
      logger: this.#container.make(Logger).child({ channel: 'queue' }),
      retryAfter: options.retryAfter,
      events: this.events,
      // The app's: the names its packages add (the session's cookie) are masked in failed jobs and their log lines too.
      ...(this.#container.has(Redactor) ? { redactor: this.#container.make(Redactor) } : {}),
    });
  }

  /**
   * Why a worker of a database connection cannot start: the tables still have their old names, `jobs` and `failed_jobs`
   * (the upgrade migration has not run). `undefined` for any other connection, and when `marmeon_jobs` is there.
   * @internal
   */
  async unmigratedTables(name: string): Promise<string | undefined> {
    const options = this.options(name);
    if (options.driver !== 'database') return undefined;
    const { db, sql } = await this.#tables(options.connection);
    // Metadata loads with the first query of the connection.
    await sql`select 1`.execute(db);
    const tables = this.#container.make((await importDatabase()).Connections).metadata(options.connection).kinds;
    if (tables.has(JOBS_TABLE) || !tables.has('jobs')) return undefined;
    return withCode('D6', `The queue tables of the connection "${options.connection}" are still named jobs and failed_jobs, not ${JOBS_TABLE} and ${FAILED_JOBS_TABLE} — run marmeon make:upgrade-migrations, then marmeon migrate.`);
  }

  async #tables(connection: string) {
    const [{ db }, { sql }] = await Promise.all([this.#database(connection), importDatabase()]);
    return { db, sql };
  }

  async #database(connection: string, what?: string): Promise<DatabaseQueueConnection> {
    const { Connections } = await importDatabase(what);
    const connections = this.#container.make(Connections);
    return {
      db: connections.get(connection),
      driver: connections.options(connection).driver,
      inTransaction: () => connections.inTransaction(connection),
      transaction: (work) => connections.transaction(() => work(), { connection }),
    };
  }
}

const DRIVER_MEMBERS = ['push', 'reserve', 'ack', 'release', 'fail', 'size', 'queues'] as const;

/** What a queue driver's factory returned, or why it cannot run: every required member, a queue, a positive `retryAfter`, and no transaction join without `using`. */
function checkConnection(name: string, connection: unknown): QueueConnection {
  const { driver, queue, retryAfter } = (connection ?? {}) as Partial<QueueConnection>;
  if (DRIVER_MEMBERS.some((member) => typeof driver?.[member] !== 'function')) {
    throw new QueueSetupError(withCode('Q4', `The queue driver "${name}" must return { driver, queue, retryAfter } with a QueueDriver (${DRIVER_MEMBERS.join(', ')}).`));
  }
  if (typeof queue !== 'string' || queue === '') throw new QueueSetupError(withCode('Q4', `The queue driver "${name}" returned no default queue name.`));
  if (typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    throw new QueueSetupError(withCode('Q4', `The queue driver "${name}" returned retryAfter ${String(retryAfter)} — it must be a positive number of seconds, or a claim could be taken again at once and run twice.`));
  }
  // A driver that joins the app's transaction writes through it: without `using` a push could land outside and survive a rollback.
  if (typeof driver!.joinsTransaction === 'function' && typeof driver!.using !== 'function') {
    throw new QueueSetupError(withCode('Q4', `The queue driver "${name}" has joinsTransaction() but no using(transaction): a job it pushes inside a transaction could outlive a rollback. Give it both, or neither.`));
  }
  return { driver: driver!, queue, retryAfter };
}

/** Every job must be done (timeout + the worker's grace) before its claim may be taken again (`retryAfter`) — else it runs twice. */
export function checkTimeouts(registry: JobRegistry, connection: string, retryAfter: number, stopTimeout: number): void {
  const offenders = registry.all().filter((job) => timeoutOf(job) + stopTimeout >= retryAfter);
  if (offenders.length === 0) return;
  const list = offenders.map((job) => `${job.job} (timeout ${timeoutOf(job)}s)`).join(', ');
  throw new QueueSetupError(
    withCode(
      'Q4',
      `The queue connection "${connection}" gives a claimed job ${retryAfter}s (retryAfter) before another worker may take it, but ${list} may hold it ` +
        `for its timeout plus the worker's --stop-timeout of ${stopTimeout}s — a second worker would run it while the first still does. ` +
        `Raise retryAfter (e.g. DB_QUEUE_RETRY_AFTER) above timeout + stop timeout, or lower the job's static timeout.`,
    ),
  );
}
