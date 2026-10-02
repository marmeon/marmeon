import { Application, Clock, Logger, type Container, type ServiceProvider } from '@bespokecore/core';
import { MakeQueueTableCommand, QueueFailedCommand, QueueFlushCommand, QueueForgetCommand, QueuePruneFailedCommand, QueueRetryCommand, QueueSizeCommand } from './commands/failed.ts';
import { QueueWorkCommand } from './commands/work.ts';
import { QueueConfig } from './config.ts';
import { importDatabase, importEncryption, QueueConnections } from './connections.ts';
import type { JobClass } from './job.ts';
import { Queue, QueueManager } from './queue.ts';
import { JobRegistry, QueueSetupError } from './registry.ts';

// The queue (E83–E85): jobs as injectable classes with a stable name and a payload schema, drivers behind one contract
// (sync, database; redis in W6 step 4), a worker with a scope per job, retries, failed jobs — and a fake for tests.
export { QueueConfig } from './config.ts';
export { checkTimeouts, QueueConnections } from './connections.ts';
export { backoffDelay } from './driver.ts';
export type { FailedJob, FailedJobStore, JobRecord, QueueDriver, QueuedJob, ReservedJob } from './driver.ts';
export { DatabaseFailedJobStore, DatabaseQueueDriver, FAILED_JOBS_TABLE, JOBS_TABLE } from './drivers/database.ts';
export type { DatabaseQueueConnection } from './drivers/database.ts';
export { MemoryFailedJobStore, MemoryQueueDriver, NullFailedJobStore } from './drivers/memory.ts';
export type { CheckJob, DispatchOptions, JobClass, JobContext, JobInput, JobInstance, JobPayload, JobStatics, PendingJob } from './job.ts';
export { prepareRecord, Queue, QueueManager } from './queue.ts';
export type { PendingJobs, QueueConnectionOptions, QueueManagerDependencies } from './queue.ts';
export { checkJobClass, DEFAULT_TIMEOUT, FRAMEWORK_PREFIX, JobRegistry, QueueError, QueueSetupError } from './registry.ts';
export { cipherContext, describeIssues, JobPayloadError, JobRunner, parseRecord } from './runner.ts';
export type { PayloadCipher, Prepared } from './runner.ts';
export { JobStuckError, JobTimeoutError, Worker } from './worker.ts';
export type { WorkerDependencies, WorkOptions, WorkResult } from './worker.ts';
export { QueueFake } from './fake.ts';
export type { DispatchedJob, DispatchMatch } from './fake.ts';
export { EXIT_STUCK, QueueWorkCommand } from './commands/work.ts';
export { MakeQueueTableCommand, QUEUE_MIGRATION, QueueFailedCommand, QueueFlushCommand, QueueForgetCommand, QueuePruneFailedCommand, QueueRetryCommand, QueueSizeCommand } from './commands/failed.ts';

declare module '@bespokecore/core' {
  interface ModuleDefinition {
    /** The module's jobs — classes with `static job`, `static schema` and `handle()`. A worker runs only registered jobs. */
    readonly jobs?: readonly JobClass[];
  }
}

/**
 * Registers the `Queue` (`QUEUE_CONNECTION`), the modules' jobs and the `queue:*` commands; `bespoke dev` starts a worker
 * alongside the server (E101). Found by `bespoke discover`.
 */
export class QueueServiceProvider implements ServiceProvider {
  static config = [QueueConfig];

  register(container: Container): void {
    container.singleton(JobRegistry, (c) => {
      const registry = new JobRegistry();
      for (const module of c.make(Application).modules) registry.add(module.jobs ?? [], `module ${module.name}`);
      return registry;
    });
    container.singleton(QueueConnections, (c) => new QueueConnections(container, c.make(QueueConfig)));
    container.singleton(Queue, (c) => {
      const config = c.make(QueueConfig);
      const connections = c.make(QueueConnections);
      return new QueueManager({
        connections: config.connections,
        default: config.default,
        registry: c.make(JobRegistry),
        driver: (name) => connections.driver(name),
        runner: () => connections.runner(),
        cipher: () => connections.cipher(),
        clock: c.make(Clock),
        logger: c.make(Logger),
      });
    });
  }

  async boot(app: Application): Promise<void> {
    // Two jobs with one name, a job without a name or schema: the start fails, with which module says what.
    const registry = app.container.make(JobRegistry);
    const config = app.container.make(QueueConfig);

    // A driver whose package is missing fails the start with what to install — not the first dispatch.
    const used = config.connections[config.default];
    if (!used) throw new QueueSetupError(`QUEUE_CONNECTION=${config.default} is not a configured queue connection.`);
    const databases = [...(used.driver === 'database' ? [used.connection] : []), ...(config.failed.driver === 'database' ? [config.failed.connection] : [])];
    if (databases.length > 0) {
      const database = await importDatabase(used.driver === 'database' ? 'QUEUE_CONNECTION=database' : 'QUEUE_FAILED_DRIVER=database (set it to null without a database)');
      if (!app.container.has(database.Connections)) {
        throw new QueueSetupError('The database queue needs the DatabaseServiceProvider of @bespokecore/database (installed packages register it: bespoke discover).');
      }
      // An unknown database connection name fails here, with the known ones.
      for (const connection of databases) app.container.make(database.Connections).options(connection);
    }
    if (registry.all().some((job) => job.encrypted)) {
      const { Encrypter } = await importEncryption();
      if (!app.container.has(Encrypter)) throw new QueueSetupError('An encrypted job (static encrypted) needs the EncryptionServiceProvider of @bespokecore/encryption and an APP_KEY.');
    }

    const cli = await import('@bespokecore/cli').catch(() => undefined);
    if (cli && app.container.has(cli.CommandRegistry)) {
      app.container
        .make(cli.CommandRegistry)
        .add([QueueWorkCommand, QueueFailedCommand, QueueRetryCommand, QueueForgetCommand, QueueFlushCommand, QueuePruneFailedCommand, QueueSizeCommand, MakeQueueTableCommand]);
    }
    // `bespoke dev` runs a worker next to the server (E101) — unless jobs run at dispatch anyway.
    if (cli && app.container.has(cli.DevProcesses) && config.default !== 'sync') {
      app.container.make(cli.DevProcesses).add({ name: 'queue', args: ['queue:work', '--stop-timeout=5'] });
    }
  }
}
