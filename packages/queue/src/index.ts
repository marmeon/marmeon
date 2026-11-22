import { Application, Clock, EventRegistry, ListenerQueue, Logger, Redactor, type Container, type ServiceProvider, type ServiceProviderClass } from '@marmeon/core';
import type { ProviderMigrations } from '@marmeon/database';
import { isQueuedListener } from '@marmeon/core/internal';
import type { CommandClass } from 'marmeon';
import { MakeQueueTableCommand, QueueFailedCommand, QueueFlushCommand, QueueForgetCommand, QueuePruneFailedCommand, QueueRetryCommand, QueueSizeCommand } from './commands/failed.ts';
import { QueueWorkCommand } from './commands/work.ts';
import { QueueConfig } from './config.ts';
import { queueNameProblem } from './drivers/redis.ts';
import { DATABASE_QUEUE_DRIVERS, FAILED_DATABASE_DRIVER, FAILED_JOBS_COLUMNS, FAILED_JOBS_TABLE, JOBS_COLUMNS, JOBS_TABLE, QUEUE_DATABASE_DRIVER } from './drivers/database.ts';
import { QueueHealthCheck } from './health.ts';
import { importDatabase, importEncryption, importRedis, QueueConnections } from './connections.ts';
import type { FailedJobStoreFactory, QueueDriverFactory } from './driver.ts';
import type { JobClass } from './job.ts';
import { CallQueuedListener, QueuedListeners, QueueListenerDispatcher } from './listeners.ts';
import { Queue, QueueManager } from './queue.ts';
import { FRAMEWORK_PREFIX, JobRegistry, kindOf, nameOf, QueueSetupError } from './registry.ts';
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
export type { WithoutOverlappingOptions } from './locks.ts';
export { Queue } from './queue.ts';
export type { PendingJobs, QueueConnectionOptions } from './queue.ts';
export { JobRegistry, QueueError, QueueSetupError } from './registry.ts';
export { JobPayloadError } from './runner.ts';
export { JobStuckError, JobTimeoutError, Worker } from './worker.ts';
export type { WorkOptions, WorkResult } from './worker.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** The module's jobs — classes with `static job`, `static schema` and `handle()`. A worker runs only registered jobs. */
    readonly jobs?: readonly JobClass[];
  }

  interface ServiceProviderClass {
    /**
     * The jobs this provider brings: none by default, and a worker runs them like a module's. A value that is no list of job classes,
     * a name another class has, or one under `marmeon.` stops the start. See `docs/package-development.md#jobs`.
     */
    readonly jobs?: readonly JobClass[];
    /**
     * Queue drivers this provider brings, by name — `QUEUE_DRIVER=<name>` selects one. A built-in name (`sync`, `database`,
     * `redis`) or a name another provider brings stops the start. See `docs/drivers.md#queue-drivers-and-failed-job-stores`.
     */
    readonly queueDrivers?: Readonly<Record<string, QueueDriverFactory>>;
    /** Failed-job stores this provider brings, by name — `QUEUE_FAILED_DRIVER=<name>` selects one. Same rules as `queueDrivers`. */
    readonly failedJobDrivers?: Readonly<Record<string, FailedJobStoreFactory>>;
  }
}

/** The jobs of a provider's `static jobs`: none when it has no such static, a Q4 when it is not a list of classes. */
function providerJobs(Provider: ServiceProviderClass): readonly JobClass[] {
  const { jobs } = Provider;
  if (jobs === undefined) return [];
  const provider = nameOf(Provider, '(unnamed)');
  const hint = 'Write static jobs = [ProcessMediaJob]; a static of your own needs another name.';
  if (!Array.isArray(jobs)) throw new QueueSetupError(withCode('Q4', `${provider} has a static jobs that is not a list of job classes. ${hint}`));
  // A counter over the iterator, so a hole in the list is an entry (undefined) too.
  let index = 0;
  for (const entry of jobs as readonly unknown[]) {
    if (typeof entry !== 'function') {
      throw new QueueSetupError(withCode('Q4', `${provider} lists a value of type ${kindOf(entry)} at static jobs[${index}], which is not a job class. ${hint}`));
    }
    index++;
  }
  return jobs;
}

/**
 * Registers the `Queue` (`QUEUE_DRIVER`), the jobs of the modules and of the providers (`static jobs`) and the `queue:*` commands; `marmeon dev` starts a worker
 * alongside the server. Found by `marmeon discover`.
 */
export class QueueServiceProvider implements ServiceProvider {
  static config = [QueueConfig];
  /** The default connection's driver answers, for `/up/ready`. */
  static health = [QueueHealthCheck];
  static commands: readonly CommandClass[] = [QueueWorkCommand, QueueFailedCommand, QueueRetryCommand, QueueForgetCommand, QueueFlushCommand, QueuePruneFailedCommand, QueueSizeCommand, MakeQueueTableCommand];
  /** The migrations for the jobs tables, which `marmeon publish` and the `make:*-table` command copy into the app. */
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'system' } satisfies ProviderMigrations;

  register(container: Container): void {
    container.singleton(JobRegistry, (c) => {
      const registry = new JobRegistry();
      const app = c.make(Application);
      for (const module of app.modules) registry.add(module.jobs ?? [], `module ${module.name}`);
      // A provider's static is added like a module's list — never with options, so `marmeon.*` names stay the framework's.
      for (const Provider of app.providers) registry.add(providerJobs(Provider), `provider ${nameOf(Provider, '(unnamed)')}`);
      // The framework's own jobs (`marmeon.*`): queued listeners here — when the app has one —, queued mails from
      // @marmeon/mail. (A worker checks every registered job's timeout against retryAfterSeconds.)
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
      const database = await importDatabase(used.driver === 'database' ? 'QUEUE_DRIVER=database' : 'QUEUE_FAILED_DRIVER=database (set it to null without a database)');
      if (!app.container.has(database.Connections)) {
        throw new QueueSetupError(withCode('Q4', 'The database queue needs the DatabaseServiceProvider of @marmeon/database (installed packages register it: marmeon discover).'));
      }
      // An unknown database connection name fails here, with the known ones; so does a driver the stores have no SQL for (D29),
      // for the connections a store will really use (the failed-job store of a `sync` queue is judged on first use).
      for (const connection of databases) app.container.make(database.Connections).options(connection);
      const { requireDriver } = await import('@marmeon/database/internal');
      if (used.driver === 'database') requireDriver(app.container.make(database.Connections).options(used.connection).driver, DATABASE_QUEUE_DRIVERS, QUEUE_DATABASE_DRIVER);
      if (config.failed.driver === 'database' && used.driver !== 'sync') {
        requireDriver(app.container.make(database.Connections).options(config.failed.connection).driver, DATABASE_QUEUE_DRIVERS, FAILED_DATABASE_DRIVER);
      }
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
      const problem = queueNameProblem(used.queue);
      if (problem !== undefined) throw new QueueSetupError(withCode('Q4', `${problem} Set QUEUE_REDIS_QUEUE to another name.`));
      const redis = await importRedis();
      if (!app.container.has(redis.RedisConnections)) {
        throw new QueueSetupError(withCode('Q4', 'QUEUE_DRIVER=redis needs the RedisServiceProvider of @marmeon/redis (installed packages register it: marmeon discover).'));
      }
      // An unknown Redis connection name fails here, with the known ones; a missing client with what to install.
      const redisConnections = app.container.make(redis.RedisConnections);
      redisConnections.options(used.connection);
      await redisConnections.verify();
    }
    // Every event with a queued listener can be queued, names are unique, `static queue` is sane — or the start fails.
    const queuedListeners = app.container.make(QueuedListeners);
    // Framework jobs need the Encrypter only when they are used (a queued listener here; a queued mail says so itself).
    const encrypted = registry.all().find((job) => job.encrypted && !job.job.startsWith(FRAMEWORK_PREFIX));
    if (encrypted || queuedListeners.any) {
      const offender = encrypted && `${nameOf(encrypted)} (${encrypted.job}, ${registry.sourceOf(encrypted)})`;
      const { Encrypter } = await importEncryption(offender && `${offender}, an encrypted job (static encrypted),`);
      if (!app.container.has(Encrypter)) {
        const which = offender ? ` ${offender} is one.` : ' every queued listener (static queue) is one.';
        throw new QueueSetupError(withCode('Q4', `An encrypted job (static encrypted) needs the EncryptionServiceProvider of @marmeon/encryption and an APP_KEY —${which}`));
      }
    }

    const cli = await import('marmeon').catch(() => undefined);
    // `marmeon dev` runs a worker next to the server — on every queue, like any worker without --queue, unless jobs run at dispatch anyway.
    if (cli && app.container.has(cli.DevProcesses) && config.default !== 'sync') {
      app.container.make(cli.DevProcesses).add({ name: 'queue', args: ['queue:work', '--stop-timeout=5'] });
    }
  }
}
