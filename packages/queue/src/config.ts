import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';
import type { QueueConnectionOptions } from './queue.ts';

const seconds = (name: string) => v.pipe(v.string(), v.transform(Number), v.number(`${name} must be a number of seconds`), v.integer(), v.minValue(1));

/**
 * The queue connections (E83): `sync` runs a job at once, in the dispatching process (scripts, tests); `database` keeps
 * jobs in the `jobs` table for `bespoke queue:work` (`bespoke make:queue-table`). `redis` follows in W6 step 4.
 *
 * ```sh
 * QUEUE_CONNECTION=database       # the default connection (default: database)
 * DB_QUEUE_CONNECTION=default     # the database connection of the jobs table
 * DB_QUEUE=default                # the default queue
 * DB_QUEUE_RETRY_AFTER=90         # seconds before a claimed job whose worker died is claimed again
 * QUEUE_FAILED_DRIVER=database    # failed jobs: database (failed_jobs) | null (only logged)
 * ```
 *
 * `retryAfter` must be longer than any job's `timeout` plus the worker's `--stop-timeout`, or a job still running would be
 * claimed by a second worker — `queue:work` refuses to start otherwise.
 */
export const QueueConfig = defineConfig('queue', {
  env: v.object({
    QUEUE_CONNECTION: v.optional(v.picklist(['sync', 'database']), 'database'),
    DB_QUEUE_CONNECTION: v.optional(v.string(), 'default'),
    DB_QUEUE: v.optional(v.pipe(v.string(), v.nonEmpty()), 'default'),
    DB_QUEUE_RETRY_AFTER: v.optional(seconds('DB_QUEUE_RETRY_AFTER'), '90'),
    QUEUE_FAILED_DRIVER: v.optional(v.picklist(['database', 'null']), 'database'),
    /** The database connection of `failed_jobs` (default: DB_QUEUE_CONNECTION). */
    QUEUE_FAILED_CONNECTION: v.optional(v.string()),
  }),
  resolve: (env) => {
    const connections: Record<string, QueueConnectionOptions> = {
      sync: { driver: 'sync', queue: 'default' },
      database: { driver: 'database', queue: env.DB_QUEUE, connection: env.DB_QUEUE_CONNECTION, retryAfter: env.DB_QUEUE_RETRY_AFTER },
    };
    return {
      default: env.QUEUE_CONNECTION as string,
      connections,
      failed: { driver: env.QUEUE_FAILED_DRIVER, connection: env.QUEUE_FAILED_CONNECTION ?? env.DB_QUEUE_CONNECTION },
    };
  },
});
export type QueueConfig = ConfigOf<typeof QueueConfig>;
