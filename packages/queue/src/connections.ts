import type { Cache } from '@bespokecore/cache';
import { Clock, EventDispatcher, Logger, type Container } from '@bespokecore/core';
import { QueueConfig } from './config.ts';
import type { FailedJobStore, QueueDriver } from './driver.ts';
import { DatabaseFailedJobStore, DatabaseQueueDriver, type DatabaseQueueConnection } from './drivers/database.ts';
import { NullFailedJobStore } from './drivers/memory.ts';
import { RedisQueueDriver } from './drivers/redis.ts';
import type { JobEvent } from './events.ts';
import type { QueueConnectionOptions } from './queue.ts';
import { JobRegistry, QueueSetupError, timeoutOf } from './registry.ts';
import { JobRunner, type PayloadCipher } from './runner.ts';
import { Worker } from './worker.ts';

/** A queue driver's package is missing — what to install, said at startup (the CLI prints it without a stack trace). */
async function importOptional<T>(load: () => Promise<T>, name: string, what: string, install: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (code === 'ERR_MODULE_NOT_FOUND' && typeof message === 'string' && message.includes(name)) {
      throw new QueueSetupError(`${what} needs ${name}, which is not installed in this app: ${install}`);
    }
    throw error;
  }
}

export const importDatabase = (what = 'QUEUE_CONNECTION=database') =>
  importOptional(() => import('@bespokecore/database'), '@bespokecore/database', what, 'pnpm add @bespokecore/database');
export const importEncryption = () =>
  importOptional(() => import('@bespokecore/encryption'), '@bespokecore/encryption', 'An encrypted job (static encrypted)', 'pnpm add @bespokecore/encryption');
export const importRedis = () => importOptional(() => import('@bespokecore/redis'), '@bespokecore/redis', 'QUEUE_CONNECTION=redis', 'pnpm add @bespokecore/redis redis');
export const importCache = () =>
  importOptional(() => import('@bespokecore/cache'), '@bespokecore/cache', 'Unique jobs, withoutOverlapping and job.once', 'pnpm add @bespokecore/cache');

/**
 * The queue's connections, built on first use: a driver per connection, the failed-job store, and workers for
 * `queue:work`. One per application.
 */
export class QueueConnections {
  readonly #container: Container;
  readonly #config: QueueConfig;
  readonly #drivers = new Map<string, QueueDriver>();
  #failed: FailedJobStore | undefined;
  #runner: JobRunner | undefined;

  constructor(container: Container, config: QueueConfig) {
    this.#container = container;
    this.#config = config;
  }

  get default(): string {
    return this.#config.default;
  }

  names(): string[] {
    return Object.keys(this.#config.connections);
  }

  options(name: string): QueueConnectionOptions {
    const options = this.#config.connections[name];
    if (!options) throw new QueueSetupError(`The queue connection "${name}" is not configured. Known: ${this.names().join(', ')}.`);
    return options;
  }

  /** The driver of a connection that keeps jobs (not `sync`). */
  driver(name: string): QueueDriver {
    let driver = this.#drivers.get(name);
    if (!driver) {
      const options = this.options(name);
      if (options.driver === 'sync') throw new QueueSetupError(`The sync queue connection runs each job when it is dispatched — it keeps no jobs to work on.`);
      const clock = this.#container.make(Clock);
      driver =
        options.driver === 'redis'
          ? new RedisQueueDriver(async () => this.#container.make((await importRedis()).RedisConnections).get(options.connection), { retryAfter: options.retryAfter, clock })
          : new DatabaseQueueDriver(async () => this.#database(options.connection), { retryAfter: options.retryAfter, clock });
      this.#drivers.set(name, driver);
    }
    return driver;
  }

  /** Where failed jobs go (`QUEUE_FAILED_DRIVER`). */
  failed(): FailedJobStore {
    this.#failed ??=
      this.#config.failed.driver === 'null'
        ? new NullFailedJobStore()
        : new DatabaseFailedJobStore(async () => this.#database(this.#config.failed.connection, 'QUEUE_FAILED_DRIVER=database'));
    return this.#failed;
  }

  runner(): JobRunner {
    this.#runner ??= new JobRunner(this.#container, this.#container.make(JobRegistry), () => this.cipher(), () => this.cache());
    return this.#runner;
  }

  /** The app's cache (@bespokecore/cache) — for unique jobs, `withoutOverlapping` and `job.once`. */
  async cache(): Promise<Cache> {
    const { Cache } = await importCache();
    if (!this.#container.has(Cache)) {
      throw new QueueSetupError('Unique jobs, withoutOverlapping and job.once keep their locks in the app\'s cache — register the CacheServiceProvider of @bespokecore/cache (installed packages register it: bespoke discover).');
    }
    return this.#container.make(Cache);
  }

  /** Dispatches a job event through the app's `EventDispatcher` (listeners built from the root container). */
  readonly events = (event: JobEvent): Promise<void> => this.#container.make(EventDispatcher).dispatch(event);

  /** The app's `Encrypter`, for `static encrypted` jobs (E105). */
  async cipher(): Promise<PayloadCipher> {
    const { Encrypter } = await importEncryption();
    if (!this.#container.has(Encrypter)) throw new QueueSetupError('An encrypted job (static encrypted) needs the EncryptionServiceProvider of @bespokecore/encryption and an APP_KEY.');
    return this.#container.make(Encrypter);
  }

  /**
   * A worker for `connection`, after checking that every job's timeout fits the connection's `retryAfter`: a job may
   * hold its claim for `timeout` plus `stopTimeout` (the grace before its worker gives up), and must be done before
   * another worker may claim it again.
   */
  worker(connection: string, stopTimeout: number): Worker {
    const options = this.options(connection);
    if (options.driver === 'sync') throw new QueueSetupError('The sync queue connection runs each job when it is dispatched — there is nothing for a worker to do. Use --connection=database (or redis).');
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
    });
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

/** Every job must be done (timeout + the worker's grace) before its claim may be taken again (`retryAfter`) — else it runs twice. */
export function checkTimeouts(registry: JobRegistry, connection: string, retryAfter: number, stopTimeout: number): void {
  const offenders = registry.all().filter((job) => timeoutOf(job) + stopTimeout >= retryAfter);
  if (offenders.length === 0) return;
  const list = offenders.map((job) => `${job.job} (timeout ${timeoutOf(job)}s)`).join(', ');
  throw new QueueSetupError(
    `The queue connection "${connection}" gives a claimed job ${retryAfter}s (retryAfter) before another worker may take it, but ${list} may hold it ` +
      `for its timeout plus the worker's --stop-timeout of ${stopTimeout}s — a second worker would run it while the first still does. ` +
      `Raise retryAfter (e.g. DB_QUEUE_RETRY_AFTER) above timeout + stop timeout, or lower the job's static timeout.`,
  );
}
