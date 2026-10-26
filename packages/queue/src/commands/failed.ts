import { Application, Clock, CommandArgumentsError } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { QueueConnections } from '../connections.ts';
import type { FailedJob } from '../driver.ts';
import { parseRecord } from '../runner.ts';

/** The migration `make:queue-table` copies — a real file, so the driver tests run exactly what apps get. */
export const QUEUE_MIGRATION = new URL('../../stubs/migrations/0001_01_01_000000_create_jobs_table.ts', import.meta.url);

/** `marmeon make:queue-table [--module=system]`: the migration of `jobs` and `failed_jobs` into an app module. */
export class MakeQueueTableCommand {
  static command = 'make:queue-table';
  static description = 'Create the migration for the database queue (jobs, failed_jobs)';
  static usage = '[--module=system]';
  static options = { module: { type: 'string', short: 'm' } } as const;

  readonly #app: Application;

  constructor(app: Application) {
    this.#app = app;
  }

  async handle(input: CommandInput): Promise<number> {
    const [{ publishOwnMigrations }, { QueueServiceProvider }] = await Promise.all([import('@marmeon/database/internal'), import('../index.ts')]);
    return publishOwnMigrations(input, new URL('../../', import.meta.url), QueueServiceProvider, this.#app.providers);
  }
}

/** The first line of a stored error, for listings. */
function headline(job: FailedJob): string {
  const line = job.exception.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** `marmeon queue:failed`: the failed jobs, newest first. */
export class QueueFailedCommand {
  static command = 'queue:failed';
  static description = 'List the failed jobs';

  readonly #connections: QueueConnections;

  constructor(connections: QueueConnections) {
    this.#connections = connections;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const jobs = await this.#connections.failed().all();
    if (jobs.length === 0) {
      output.line('No failed jobs.');
      return 0;
    }
    for (const job of jobs) {
      output.line(`${new Date(job.failedAt).toISOString()}  ${job.uuid}  ${job.job}  (${job.connection}/${job.queue})`);
      output.line(`    ${headline(job)}`);
    }
    output.line(`${jobs.length} failed ${jobs.length === 1 ? 'job' : 'jobs'} — marmeon queue:retry <id|all>, queue:forget <id>`);
    return 0;
  }
}

/** `marmeon queue:retry <id…|all>`: puts failed jobs back on their queue — same job id, attempts from zero. */
export class QueueRetryCommand {
  static command = 'queue:retry';
  static description = 'Put failed jobs back on their queue';
  static usage = '<id…|all>';

  readonly #connections: QueueConnections;
  readonly #clock: Clock;

  constructor(connections: QueueConnections, clock: Clock) {
    this.#connections = connections;
    this.#clock = clock;
  }

  async handle({ args, output }: CommandInput): Promise<number> {
    if (args.length === 0) {
      throw new CommandArgumentsError('Pass the ids of the failed jobs (marmeon queue:failed lists them), or all.');
    }
    const store = this.#connections.failed();
    // `all`: oldest first, so the queue keeps their order.
    const jobs = args.includes('all') ? (await store.all()).toReversed() : await Promise.all(args.map(async (id) => (await store.find(id)) ?? id));
    let code = 0;
    for (const job of jobs) {
      if (typeof job === 'string') {
        output.error(`No failed job with the id ${job}.`);
        code = 1;
        continue;
      }
      // Its connection, if it still keeps jobs — else the default one; a connection that no longer exists at all is no place to guess.
      const named = this.#connections.find(job.connection);
      if (!named) {
        output.error(`The failed job ${job.uuid} came from the queue connection "${job.connection}", which is not configured. Known: ${this.#connections.names().join(', ')}.`);
        code = 1;
        continue;
      }
      // A record no release will run (no version, a broken chain): queued again it would only fail again.
      const parsed = parseRecord(job.payload);
      if (parsed.kind === 'invalid') {
        output.error(`The failed job ${job.uuid} cannot be retried: ${parsed.reason}`);
        code = 1;
        continue;
      }
      const connection = named.driver !== 'sync' ? job.connection : this.#connections.default;
      // Claimable from now: a worker that cannot read it yet counts the time it is held from here, not from the first dispatch.
      const payload = JSON.stringify({ ...(JSON.parse(job.payload) as object), availableAt: this.#clock.now() });
      await this.#connections.driver(connection).push(job.queue, payload, 0);
      await store.forget(job.uuid);
      output.success(`Queued ${job.job} (${job.uuid}) again on ${connection}/${job.queue}`);
    }
    return code;
  }
}

/** `marmeon queue:forget <id>`: deletes a failed job. */
export class QueueForgetCommand {
  static command = 'queue:forget';
  static description = 'Delete a failed job';
  static usage = '<id>';

  readonly #connections: QueueConnections;

  constructor(connections: QueueConnections) {
    this.#connections = connections;
  }

  async handle({ args, output }: CommandInput): Promise<number> {
    const [id] = args;
    if (!id) {
      throw new CommandArgumentsError('Pass the id of the failed job (marmeon queue:failed lists them).');
    }
    if (!(await this.#connections.failed().forget(id))) {
      output.error(`No failed job with the id ${id}.`);
      return 1;
    }
    output.success(`Deleted the failed job ${id}.`);
    return 0;
  }
}

/** `marmeon queue:flush`: deletes every failed job. */
export class QueueFlushCommand {
  static command = 'queue:flush';
  static description = 'Delete all failed jobs';

  readonly #connections: QueueConnections;

  constructor(connections: QueueConnections) {
    this.#connections = connections;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const removed = await this.#connections.failed().flush();
    output.success(`Deleted ${removed} failed ${removed === 1 ? 'job' : 'jobs'}.`);
    return 0;
  }
}

/** `marmeon queue:prune-failed [--hours=168]`: deletes failed jobs older than the given hours — for the scheduler. */
export class QueuePruneFailedCommand {
  static command = 'queue:prune-failed';
  static description = 'Delete failed jobs older than --hours (default 168)';
  static usage = '[--hours=168]';
  static options = { hours: { type: 'string' } } as const;

  readonly #connections: QueueConnections;
  readonly #clock: Clock;

  constructor(connections: QueueConnections, clock: Clock) {
    this.#connections = connections;
    this.#clock = clock;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const hours = options.hours === undefined ? 168 : Number(options.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new CommandArgumentsError('--hours must be a number ≥ 0.');
    }
    const removed = await this.#connections.failed().prune(this.#clock.now() - hours * 3_600_000);
    output.success(`Pruned ${removed} failed ${removed === 1 ? 'job' : 'jobs'} older than ${hours} hours.`);
    return 0;
  }
}

/** `marmeon queue:size [queue…] [--connection=…]`: how many jobs wait (or run) per queue. */
export class QueueSizeCommand {
  static command = 'queue:size';
  static description = 'Show how many jobs each queue holds';
  static usage = '[queue…] [--connection=database|redis]';
  static options = { connection: { type: 'string' } } as const;

  readonly #connections: QueueConnections;

  constructor(connections: QueueConnections) {
    this.#connections = connections;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    const connection = typeof options.connection === 'string' ? options.connection : this.#connections.default;
    const settings = this.#connections.options(connection);
    if (settings.driver === 'sync') {
      output.line('The sync connection keeps no jobs: each runs when it is dispatched.');
      return 0;
    }
    const driver = this.#connections.driver(connection);
    // Without names: every queue that holds jobs — and the default one, also when it is empty.
    const queues = args.length > 0 ? args : [...new Set([settings.queue, ...(await driver.queues())])];
    for (const queue of queues) output.line(`${connection}/${queue}: ${await driver.size(queue)}`);
    return 0;
  }
}
