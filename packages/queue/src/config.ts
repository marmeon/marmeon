import { defineConfig, env, type ConfigOf, type Resolver } from '@marmeon/core';
import type { QueueConnectionOptions } from './queue.ts';

/** A driver's name: what `QUEUE_CONNECTION` and `QUEUE_FAILED_DRIVER` accept besides the built-in ones, once a provider brings it. */
const driverName = () => env.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a driver name: lowercase letters, digits and dashes');

const seconds = (name: string) => env.integer(`${name} must be a number of seconds`).min(1).default(90);

/**
 * The queue connections: `sync` runs a job at once, in the dispatching process; `database` keeps jobs in the `marmeon_jobs`
 * table, `redis` in Redis; a provider can bring more (`static queueDrivers`, `docs/drivers.md#queue-drivers-and-failed-job-stores`). `retryAfter` must be longer
 * than any job's `timeout` plus the worker's `--stop-timeout`, or a second worker would claim a job still running —
 * `queue:work` refuses to start otherwise. See `docs/queues.md#configuration`.
 */
export const QueueConfig = defineConfig('queue', {
  env: env({
    QUEUE_CONNECTION: driverName().default('database'),
    DB_QUEUE_CONNECTION: env.string().default('default'),
    DB_QUEUE: env.string().default('default'),
    DB_QUEUE_RETRY_AFTER: seconds('DB_QUEUE_RETRY_AFTER'),
    REDIS_QUEUE_CONNECTION: env.string().default('default'),
    REDIS_QUEUE: env.string().default('default'),
    REDIS_QUEUE_RETRY_AFTER: seconds('REDIS_QUEUE_RETRY_AFTER'),
    QUEUE_FAILED_DRIVER: driverName().default('database'),
    /** The database connection of `marmeon_failed_jobs` (default: DB_QUEUE_CONNECTION). */
    QUEUE_FAILED_CONNECTION: env.string().optional(),
  }),
  resolve: (e) => {
    const connections: Record<string, QueueConnectionOptions> = {
      sync: { driver: 'sync', queue: 'default' },
      database: { driver: 'database', queue: e.DB_QUEUE, connection: e.DB_QUEUE_CONNECTION, retryAfter: e.DB_QUEUE_RETRY_AFTER },
      redis: { driver: 'redis', queue: e.REDIS_QUEUE, connection: e.REDIS_QUEUE_CONNECTION, retryAfter: e.REDIS_QUEUE_RETRY_AFTER },
    };
    return {
      default: e.QUEUE_CONNECTION,
      connections,
      failed: { driver: e.QUEUE_FAILED_DRIVER, connection: e.QUEUE_FAILED_CONNECTION ?? e.DB_QUEUE_CONNECTION },
    };
  },
});
export type QueueConfig = ConfigOf<typeof QueueConfig>;

/**
 * The connection the queue's tables belong on — for the migration `marmeon make:queue-table` writes (`connection` in
 * `defineMigration`): `DB_QUEUE_CONNECTION`. It creates `marmeon_failed_jobs` there too, so a `QUEUE_FAILED_CONNECTION` of its own (with
 * failed jobs kept in the database) stops the migration with what to do, instead of creating the table where nothing looks.
 */
export function queueTablesConnection(container: Resolver): string {
  const config = container.make(QueueConfig);
  const database = config.connections.database;
  const jobs = database && 'connection' in database ? database.connection : 'default';
  if (config.failed.driver === 'database' && config.failed.connection !== jobs) {
    throw new Error(
      `The migration of make:queue-table creates marmeon_jobs and marmeon_failed_jobs on one connection, DB_QUEUE_CONNECTION (${jobs}) — but QUEUE_FAILED_CONNECTION is ${config.failed.connection}. Split it: this migration keeps marmeon_jobs with connection: '${jobs}', a migration of its own creates marmeon_failed_jobs with connection: '${config.failed.connection}' — or let both use one connection.`,
    );
  }
  return jobs;
}
