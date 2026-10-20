import { Application, Clock, EventRegistry, ListenerQueue, Logger, Redactor, type Container, type ServiceProvider } from '@marmeon/core';
import { isQueuedListener } from '@marmeon/core/internal';
import { MakeQueueTableCommand, QueueFailedCommand, QueueFlushCommand, QueueForgetCommand, QueuePruneFailedCommand, QueueRetryCommand, QueueSizeCommand } from './commands/failed.ts';
import { QueueWorkCommand } from './commands/work.ts';
import { QueueConfig } from './config.ts';
import { FAILED_JOBS_COLUMNS, FAILED_JOBS_TABLE, JOBS_COLUMNS, JOBS_TABLE } from './drivers/database.ts';
import { QueueHealthCheck } from './health.ts';
import { importDatabase, importEncryption, importRedis, QueueConnections } from './connections.ts';
import type { FailedJobStoreFactory, QueueDriverFactory } from './driver.ts';
import type { JobClass } from './job.ts';
import { CallQueuedListener, QueuedListeners, QueueListenerDispatcher } from './listeners.ts';
import { Queue, QueueManager } from './queue.ts';
import { FRAMEWORK_PREFIX, JobRegistry, QueueSetupError } from './registry.ts';
import { withCode } from '@marmeon/core/internal';

export { QueueConfig, queueTablesConnection } from './config.ts';
export { QueueHealthCheck } from './health.ts';
export { QueueConnections } from './connections.ts';
export type {
  FailedJob,
  FailedJobStore,
  FailedJobStoreContext,
  FailedJobStoreFactory,
  JobRecord,
  QueueConnection,
  QueueCounts,
  QueueDriver,
  QueueDriverContext,
  QueueDriverFactory,
  QueuedJob,
  QueuedPush,
  ReleaseOptions,
  ReservedJob,
  UniqueRecord,
} from './driver.ts';
export { JobEvent, JobFailed, JobProcessed, JobProcessing, JobQueued, JobReleased } from './events.ts';
export type { JobEvents } from './events.ts';
export type {
  BatchOptions,
  CheckJob,
  DispatchOptions,
  DispatchResult,
  JobClass,
  JobContext,
  JobInput,
  JobInstance,
  JobMiddleware,
  JobMiddlewareContext,
  JobPayload,
  JobStatics,
  UniqueDispatchOptions,
} from './job.ts';
export { JobOnceBusyError, withoutOverlapping } from './locks.ts';
export type { CacheSource, WithoutOverlappingOptions } from './locks.ts';
export { Queue } from './queue.ts';
export type { PendingJobs, QueueConnectionOptions } from './queue.ts';
export { JobRegistry, QueueError, QueueSetupError } from './registry.ts';
export { JobPayloadError, JobRunner } from './runner.ts';
export type { PayloadCipher, Prepared } from './runner.ts';
export { JobStuckError, JobTimeoutError, Worker } from './worker.ts';
export type { WorkerDependencies, WorkOptions, WorkResult } from './worker.ts';
export { MakeQueueTableCommand, QueueFailedCommand, QueueFlushCommand, QueueForgetCommand, QueuePruneFailedCommand, QueueRetryCommand, QueueSizeCommand } from './commands/failed.ts';
export { QueueWorkCommand } from './commands/work.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** The module's jobs — classes with `static job`, `static schema` and `handle()`. A worker runs only registered jobs. */
    readonly jobs?: readonly JobClass[];
  }

  interface ServiceProviderClass {
    /**
     * Queue drivers this provider brings, by name — `QUEUE_CONNECTION=<name>` selects one. A built-in name (`sync`, `database`,
     * `redis`) or a name another provider brings stops the start. See `docs/drivers.md#queue-drivers-and-failed-job-stores`.
     */
    readonly queueDrivers?: Readonly<Record<string, QueueDriverFactory>>;
    /** Failed-job stores this provider brings, by name — `QUEUE_FAILED_DRIVER=<name>` selects one. Same rules as `queueDrivers`. */
    readonly failedJobDrivers?: Readonly<Record<string, FailedJobStoreFactory>>;
  }
}

/**
 * Registers the `Queue` (`QUEUE_CONNECTION`), the modules' jobs and the `queue:*` commands; `marmeon dev` starts a worker
 * alongside the server. Found by `marmeon discover`.
 */
export class QueueServiceProvider implements ServiceProvider {
  static config = [QueueConfig];
  /** The default connection's driver answers, for `/up/ready`. */
  static health = [QueueHealthCheck];
  static commands = [QueueWorkCommand, QueueFailedCommand, QueueRetryCommand, QueueForgetCommand, QueueFlushCommand, QueuePruneFailedCommand, QueueSizeCommand, MakeQueueTableCommand];

  register(container: Container): void {
    container.singleton(JobRegistry, (c) => {
      const registry = new JobRegistry();
      for (const module of c.make(Application).modules) registry.add(module.jobs ?? [], `module ${module.name}`);
      // The framework's own jobs (`marmeon.*`): queued listeners here — when the app has one —, queued mails from
      // @marmeon/mail. (A worker checks every registered job's timeout against retryAfter.)
      if (c.make(EventRegistry).all().some((binding) => isQueuedListener(binding.listener))) registry.add([CallQueuedListener], '@marmeon/queue', { framework: true });
      return registry;
    });
    // Queued listeners: checked at startup, queued by the EventDispatcher through the ListenerQueue, run by a
    // `marmeon.listener` job — built in the job's scope, which then builds the listener.
    container.singleton(QueuedListeners, (c) => new QueuedListeners(c.make(EventRegistry)));
    container.singleton(ListenerQueue, (c) => new QueueListenerDispatcher(() => container.make(Queue), c.make(QueuedListeners)));
    container.bind(CallQueuedListener, (c) => new CallQueuedListener(c, c.make(QueuedListeners)));
    container.singleton(QueueConnections, (c) => new QueueConnections(container, c.make(QueueConfig)));
    container.singleton(Queue, (c) => {
      const config = c.make(QueueConfig);
      const connections = c.make(QueueConnections);
      return new QueueManager({
        connection: (name) => connections.find(name),
        connectionNames: () => connections.names(),
        default: config.default,
        registry: c.make(JobRegistry),
        driver: (name) => connections.driver(name),
        runner: () => connections.runner(),
        cipher: () => connections.cipher(),
        clock: c.make(Clock),
        logger: c.make(Logger),
        cache: () => connections.cache(),
        events: connections.events,
        app: c.make(Application),
        redactor: c.make(Redactor),
      });
    });
  }

  async boot(app: Application): Promise<void> {
    // Two jobs with one name, a job without a name or schema: the start fails, with which module says what.
    const registry = app.container.make(JobRegistry);
    const config = app.container.make(QueueConfig);

    // An unknown driver name, or a built-in name a provider takes, stops the start — with the names there are.
    const connections = app.container.make(QueueConnections);
    connections.verify();
    // A driver whose package is missing fails the start with what to install — not the first dispatch.
    const used = connections.options(config.default);
    const databases = [...(used.driver === 'database' ? [used.connection] : []), ...(config.failed.driver === 'database' ? [config.failed.connection] : [])];
    if (databases.length > 0) {
      const database = await importDatabase(used.driver === 'database' ? 'QUEUE_CONNECTION=database' : 'QUEUE_FAILED_DRIVER=database (set it to null without a database)');
      if (!app.container.has(database.Connections)) {
        throw new QueueSetupError(withCode('Q4', 'The database queue needs the DatabaseServiceProvider of @marmeon/database (installed packages register it: marmeon discover).'));
      }
      // An unknown database connection name fails here, with the known ones.
      for (const connection of databases) app.container.make(database.Connections).options(connection);
      // /up/ready is red until the tables have the new names and every column the drivers write.
      const { SchemaRequirements } = await import('@marmeon/database');
      const requirements = app.container.make(SchemaRequirements);
      if (used.driver === 'database') requirements.require({ connection: used.connection, table: JOBS_TABLE, columns: JOBS_COLUMNS });
      // `sync` runs a job where it is dispatched: no worker, no failed-job table to wait for.
      if (config.failed.driver === 'database' && used.driver !== 'sync') {
        requirements.require({ connection: config.failed.connection, table: FAILED_JOBS_TABLE, columns: FAILED_JOBS_COLUMNS });
      }
    }
    if (used.driver === 'redis') {
      const redis = await importRedis();
      if (!app.container.has(redis.RedisConnections)) {
        throw new QueueSetupError(withCode('Q4', 'QUEUE_CONNECTION=redis needs the RedisServiceProvider of @marmeon/redis (installed packages register it: marmeon discover).'));
      }
      // An unknown Redis connection name fails here, with the known ones; a missing client with what to install.
      const redisConnections = app.container.make(redis.RedisConnections);
      redisConnections.options(used.connection);
      await redisConnections.verify();
    }
    // Every event with a queued listener can be queued, names are unique, `static queue` is sane — or the start fails.
    const queuedListeners = app.container.make(QueuedListeners);
    // Framework jobs need the Encrypter only when they are used (a queued listener here; a queued mail says so itself).
    if (registry.all().some((job) => job.encrypted && !job.job.startsWith(FRAMEWORK_PREFIX)) || queuedListeners.any) {
      const { Encrypter } = await importEncryption();
      if (!app.container.has(Encrypter)) {
        throw new QueueSetupError(withCode('Q4', 'An encrypted job (static encrypted) needs the EncryptionServiceProvider of @marmeon/encryption and an APP_KEY — every queued listener (static queue) is one.'));
      }
    }

    const cli = await import('marmeon').catch(() => undefined);
    // `marmeon dev` runs a worker next to the server — on every queue, like any worker without --queue, unless jobs run at dispatch anyway.
    if (cli && app.container.has(cli.DevProcesses) && config.default !== 'sync') {
      app.container.make(cli.DevProcesses).add({ name: 'queue', args: ['queue:work', '--stop-timeout=5'] });
    }
  }
}
