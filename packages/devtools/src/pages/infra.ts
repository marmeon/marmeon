import { outsideTransaction, type Application, type Redactor } from '@marmeon/core';

/**
 * The queue and the scheduler as they are now (Horizon's idea, development only, read-only) — read through their own
 * APIs: `QueueConnections` (the queue's own connections, never a transaction of the app: every read runs outside of one)
 * and the `Scheduler`. Both packages are optional: an app without them gets a note. Nothing here writes; retrying or
 * forgetting a failed job is a command to copy.
 */

export interface QueueView {
  readonly connection: string;
  readonly driver: string;
  readonly queues: readonly { readonly name: string; readonly size: number; readonly ready?: number; readonly delayed?: number; readonly reserved?: number }[];
  /** Reading this connection failed (Redis down, the `jobs` table missing). */
  readonly error?: string;
}

export interface FailedJobView {
  readonly id: string;
  readonly job: string;
  readonly connection: string;
  readonly queue: string;
  readonly failedAt: number;
  /** The stored error, redacted. */
  readonly exception: string;
  /** The job's data, redacted — an encrypted job's only as `[encrypted]`. */
  readonly payload: unknown;
  /** The request that dispatched it. */
  readonly requestId?: string;
  readonly retry: string;
  readonly forget: string;
}

export type QueueSnapshot =
  | {
      readonly available: true;
      readonly default: string;
      readonly connections: readonly QueueView[];
      /** The newest failed jobs (at most 50). */
      readonly failed: readonly FailedJobView[];
      readonly failedTotal: number;
      readonly failedError?: string;
    }
  | { readonly available: false; readonly reason: string };

export interface TaskView {
  readonly name: string;
  readonly expression: string;
  readonly timeZone: string;
  readonly summary: string;
  /** When it is due next (epoch ms). */
  readonly next?: number;
  readonly options: readonly string[];
  readonly test: string;
}

export type ScheduleSnapshot =
  | { readonly available: true; readonly tasks: readonly TaskView[]; readonly warning?: string }
  | { readonly available: false; readonly reason: string };

const MAX_FAILED = 50;
const READ_TIMEOUT_MS = 2000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `work`, or its error after {@link READ_TIMEOUT_MS} — an unreachable Redis does not hang the page. */
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      outsideTransaction(work),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${READ_TIMEOUT_MS} ms`)), READ_TIMEOUT_MS))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function optional<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch {
    return undefined;
  }
}

/** The queues of every connection that keeps jobs, and the failed jobs. */
export async function queueSnapshot(app: Application, redactor: Redactor): Promise<QueueSnapshot> {
  const module = await optional(() => import('@marmeon/queue'));
  if (!module || !app.container.has(module.QueueConnections)) return { available: false, reason: 'The app has no queue (@marmeon/queue).' };
  const connections = app.container.make(module.QueueConnections);
  const views: QueueView[] = [];
  for (const name of connections.names()) {
    const options = connections.options(name);
    if (options.driver === 'sync') continue;
    try {
      const driver = connections.driver(name);
      const queues = await bounded(async () => {
        const names = [...new Set([options.queue, ...(await driver.queues())])].sort();
        return Promise.all(
          names.map(async (queue) => {
            const size = await driver.size(queue);
            const counts = driver.counts ? await driver.counts(queue) : undefined;
            return { name: queue, size, ...counts };
          }),
        );
      });
      views.push({ connection: name, driver: options.driver, queues });
    } catch (error) {
      views.push({ connection: name, driver: options.driver, queues: [], error: redactor.text(messageOf(error)) });
    }
  }

  let failed: FailedJobView[] = [];
  let failedTotal = 0;
  let failedError: string | undefined;
  try {
    const all = await bounded(() => connections.failed().all());
    failedTotal = all.length;
    failed = all.slice(0, MAX_FAILED).map((job) => {
      let record: { data?: unknown; encrypted?: boolean; requestId?: string } = {};
      try {
        record = JSON.parse(job.payload) as typeof record;
      } catch {
        // A payload that is no record: shown as nothing.
      }
      const exception = job.exception.split('\n').slice(0, 30).join('\n');
      return {
        id: job.uuid,
        job: job.job,
        connection: job.connection,
        queue: job.queue,
        failedAt: job.failedAt,
        exception: redactor.text(exception),
        payload: redactor.fit(redactor.payload(record.data, record.encrypted === true), 16 * 1024),
        ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
        retry: `marmeon queue:retry ${job.uuid}`,
        forget: `marmeon queue:forget ${job.uuid}`,
      };
    });
  } catch (error) {
    failedError = redactor.text(messageOf(error));
  }
  return { available: true, default: connections.default, connections: views, failed, failedTotal, ...(failedError === undefined ? {} : { failedError }) };
}

/** The scheduled tasks — when each is due next (the logic of `schedule:list`) — and the lock warning. */
export async function scheduleSnapshot(app: Application): Promise<ScheduleSnapshot> {
  const module = await optional(() => import('@marmeon/scheduler'));
  if (!module || !app.container.has(module.Scheduler)) return { available: false, reason: 'The app has no scheduler (@marmeon/scheduler).' };
  const scheduler = app.container.make(module.Scheduler);
  const tasks = scheduler.tasks.map((task): TaskView => {
    const { definition } = task;
    const next = scheduler.next(task);
    const options = [
      definition.onOneServer ? 'one server' : '',
      definition.overlapMinutes !== undefined ? 'no overlap' : '',
      definition.catchUp === 'skip' ? 'no catch-up' : '',
      definition.environments ? `only ${definition.environments.join('/')}` : '',
      definition.when.length + definition.skip.length > 0 ? 'filtered' : '',
    ].filter(Boolean);
    return { name: task.name, expression: task.expression.source, timeZone: task.timeZone, summary: task.summary, ...(next === undefined ? {} : { next }), options, test: `marmeon schedule:test ${task.name}` };
  });
  const warning = scheduler.lockWarning();
  return { available: true, tasks, ...(warning ? { warning } : {}) };
}
