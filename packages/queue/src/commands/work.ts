import { environment, Logger } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { QueueConnections } from '../connections.ts';
import { QueueSetupError } from '../registry.ts';

/** Exit code of a worker that had to give up on a job that ignored its timeout (the supervisor restarts it). */
export const EXIT_STUCK = 70;

function number(input: CommandInput, name: string, fallback?: number): number | undefined {
  const raw = input.options[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (typeof raw !== 'string' || !Number.isFinite(value) || value < 0) throw new QueueSetupError(`--${name} must be a number ≥ 0, not ${String(raw)}.`);
  return value;
}

/**
 * `marmeon queue:work`: processes jobs until stopped — one at a time, each in its own container scope. Without `--queue`
 * it takes every queue fairly; `--queue=mail,default` narrows it down, in strict priority order (Laravel's). On
 * SIGTERM/SIGINT the running job may finish for `--stop-timeout` seconds; a job that ignores its timeout ends the worker
 * (code 70) — run workers under a supervisor. See `docs/queues.md#running-workers`.
 */
export class QueueWorkCommand {
  static command = 'queue:work';
  static description = 'Process jobs from the queue';
  static usage = '[--connection=database|redis] [--queue=mail,default] [--max-jobs=N] [--max-time=S] [--sleep=1] [--stop-timeout=10] [--stop-when-empty]';
  static options = {
    connection: { type: 'string' },
    queue: { type: 'string' },
    'max-jobs': { type: 'string' },
    'max-time': { type: 'string' },
    sleep: { type: 'string' },
    'stop-timeout': { type: 'string' },
    'stop-when-empty': { type: 'boolean' },
  } as const;

  readonly #connections: QueueConnections;
  readonly #logger: Logger;

  constructor(connections: QueueConnections, logger: Logger) {
    this.#connections = connections;
    this.#logger = logger;
  }

  async handle(input: CommandInput): Promise<number> {
    const { options, output } = input;
    let setup;
    try {
      setup = this.#setup(input);
    } catch (error) {
      // A configuration problem is a message, not a stack trace.
      if (!(error instanceof QueueSetupError)) throw error;
      output.error(error.message);
      return 1;
    }
    const { connection, stopTimeout, queues, worker, sleep, maxJobs, maxTime } = setup;

    const stop = new AbortController();
    const onSignal = (signal: NodeJS.Signals) => {
      if (stop.signal.aborted) return; // a second signal (Ctrl+C reaches every process of the group, a supervisor may repeat): one shutdown
      this.#logger.info(`${signal} received: no new jobs; the running one has ${stopTimeout}s to finish`);
      stop.abort();
      // A shutdown that hangs anyway (a stuck release) still ends.
      setTimeout(() => process.exit(1), (stopTimeout + 10) * 1000).unref();
    };
    process.on('SIGINT', onSignal).on('SIGTERM', onSignal);

    // A worker as development because a .env says so: a production command — said loudly, not refused.
    const fromDotEnv = environment.dotEnvDevelopmentWarning('queue:work');
    if (fromDotEnv) this.#logger.warn(fromDotEnv);
    // The environment it assumed: `in production (APP_ENV=staging)`, `in production (APP_ENV=production, NODE_ENV unset)`.
    output.line(`Processing jobs of the ${connection} connection: ${describeQueues(queues, this.#connections.options(connection).driver)} — in ${environment.describe()}`);
    try {
      const result = await worker.run({
        ...(queues ? { queues } : {}),
        sleep,
        ...(maxJobs !== undefined ? { maxJobs } : {}),
        ...(maxTime !== undefined ? { maxTime } : {}),
        stopWhenEmpty: options['stop-when-empty'] === true,
        stopTimeout,
        signal: stop.signal,
        onStuck: () => process.exit(EXIT_STUCK),
      });
      this.#logger.info(`Worker stopped (${result.reason}): ${result.processed} processed, ${result.released} released, ${result.failed} failed`);
      // An interrupted job was released but may still hold the process (a hung socket): once the app has shut down, exit anyway — with 0.
      if (result.reason === 'interrupted') setTimeout(() => process.exit(0), 2000).unref();
      return 0;
    } finally {
      process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
    }
  }

  #setup(input: CommandInput) {
    const { options } = input;
    const connection = typeof options.connection === 'string' ? options.connection : this.#connections.default;
    const stopTimeout = number(input, 'stop-timeout', 10)!;
    let queues: string[] | undefined;
    if (options.queue !== undefined) {
      queues = typeof options.queue === 'string' ? options.queue.split(',').map((queue) => queue.trim()).filter(Boolean) : [];
      if (queues.length === 0) throw new QueueSetupError('--queue names no queue — leave it out to take every queue.');
      if (queues.filter((queue) => queue === '*').length > 1) throw new QueueSetupError('--queue names * more than once.');
      // `--queue=*` alone is no list: every queue, the same as without --queue.
      if (queues.length === 1 && queues[0] === '*') queues = undefined;
    }
    const worker = this.#connections.worker(connection, stopTimeout);
    return { connection, stopTimeout, queues, worker, sleep: number(input, 'sleep', 1)!, maxJobs: number(input, 'max-jobs'), maxTime: number(input, 'max-time') };
  }
}

/** The start line's queues: `every queue (oldest first)`, `mail, default` (strict), `mail, every other queue (oldest first)`. */
function describeQueues(queues: readonly string[] | undefined, driver: string): string {
  const how = driver === 'database' ? ' (oldest first)' : driver === 'redis' ? ' (in turn)' : '';
  if (!queues) return `every queue${how}`;
  return queues.map((queue) => (queue === '*' ? `every other queue${how}` : queue)).join(', ');
}
