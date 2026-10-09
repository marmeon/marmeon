import { defineConfig, env, type ConfigOf, type Resolver } from '@marmeon/core';
import type { QueueConnectionOptions } from './queue.ts';

const seconds = (name: string) => env.integer(`${name} must be a number of seconds`).min(1).default(90);

/**
 * The queue connections (E83): `sync` runs a job at once, in the dispatching process (scripts, tests); `database` keeps
 * jobs in the `jobs` table for `marmeon queue:work` (`marmeon make:queue-table`); `redis` keeps them in Redis lists
 * (needs @marmeon/redis — it brings redis).
 *
 * ```sh
 * QUEUE_CONNECTION=database       # the default connection: database (default) | redis | sync
 * DB_QUEUE_CONNECTION=default     # the database connection of the jobs table
 * DB_QUEUE=default                # the default queue
 * DB_QUEUE_RETRY_AFTER=90         # seconds before a claimed job whose worker died is claimed again
 * REDIS_QUEUE_CONNECTION=default  # the Redis connection of the redis queue (REDIS_URL)
 * REDIS_QUEUE=default
 * REDIS_QUEUE_RETRY_AFTER=90
 * QUEUE_FAILED_DRIVER=database    # failed jobs: database (failed_jobs) | null (only logged)
 * ```
 *
 * `retryAfter` must be longer than any job's `timeout` plus the worker's `--stop-timeout`, or a job still running would be
 * claimed by a second worker — `queue:work` refuses to start otherwise.
 */
export const QueueConfig = defineConfig('queue', {
  env: env({
    QUEUE_CONNECTION: env.in(['sync', 'database', 'redis']).default('database'),
    DB_QUEUE_CONNECTION: env.string().default('default'),
    DB_QUEUE: env.string().default('default'),
    DB_QUEUE_RETRY_AFTER: seconds('DB_QUEUE_RETRY_AFTER'),
    REDIS_QUEUE_CONNECTION: env.string().default('default'),
    REDIS_QUEUE: env.string().default('default'),
    REDIS_QUEUE_RETRY_AFTER: seconds('REDIS_QUEUE_RETRY_AFTER'),
    QUEUE_FAILED_DRIVER: env.in(['database', 'null']).default('database'),
    /** The database connection of `failed_jobs` (default: DB_QUEUE_CONNECTION). */
    QUEUE_FAILED_CONNECTION: env.string().optional(),
  }),
  resolve: (e) => {
    const connections: Record<string, QueueConnectionOptions> = {
      sync: { driver: 'sync', queue: 'default' },
      database: { driver: 'database', queue: e.DB_QUEUE, connection: e.DB_QUEUE_CONNECTION, retryAfter: e.DB_QUEUE_RETRY_AFTER },
      redis: { driver: 'redis', queue: e.REDIS_QUEUE, connection: e.REDIS_QUEUE_CONNECTION, retryAfter: e.REDIS_QUEUE_RETRY_AFTER },
    };
    return {
      default: e.QUEUE_CONNECTION as string,
      connections,
      failed: { driver: e.QUEUE_FAILED_DRIVER, connection: e.QUEUE_FAILED_CONNECTION ?? e.DB_QUEUE_CONNECTION },
    };
  },
});
export type QueueConfig = ConfigOf<typeof QueueConfig>;

/**
 * The connection the queue's tables belong on — for the migration `marmeon make:queue-table` writes (`connection` in
 * `defineMigration`): `DB_QUEUE_CONNECTION`. It creates `failed_jobs` there too, so a `QUEUE_FAILED_CONNECTION` of its own (with
 * failed jobs kept in the database) stops the migration with what to do, instead of creating the table where nothing looks.
 */
export function queueTablesConnection(container: Resolver): string {
  const config = container.make(QueueConfig);
  const database = config.connections.database;
  const jobs = database && 'connection' in database ? database.connection : 'default';
  if (config.failed.driver === 'database' && config.failed.connection !== jobs) {
    throw new Error(
      `The migration of make:queue-table creates jobs and failed_jobs on one connection, DB_QUEUE_CONNECTION (${jobs}) — but QUEUE_FAILED_CONNECTION is ${config.failed.connection}. Move the failed_jobs part into a migration of its own with connection: '${config.failed.connection}', or let both use one connection.`,
    );
  }
  return jobs;
}
