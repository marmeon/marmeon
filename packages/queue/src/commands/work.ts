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
 * `marmeon queue:work`: processes jobs until stopped — one at a time, each in its own container scope (E84).
 *
 * - **Queues:** `--queue=mail,default` in priority order; `*` stands for every other queue that holds jobs
 *   (`--queue=*`, `--queue=mail,*`). Default: the connection's queue.
 *
 * - **SIGTERM/SIGINT:** no new claim; the running job may finish for `--stop-timeout` seconds, then it is released and the
 *   worker exits with 0. Later signals do not cut that short.
 * - **A job past its timeout:** `job.signal` aborts; if it has not stopped `--stop-timeout` seconds later, the worker exits
 *   (code 70) — Node cannot cancel a promise. Run workers under a supervisor (systemd, Docker, Kubernetes) that
 *   restarts them; the job returns after `retryAfter`.
 */
export class QueueWorkCommand {
  static command = 'queue:work';
  static description = 'Process jobs from the queue';
  static usage = '[--connection=database|redis] [--queue=mail,default|*] [--max-jobs=N] [--max-time=S] [--sleep=1] [--stop-timeout=10] [--stop-when-empty]';
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

    // A worker as development because a .env says so (E170): a production command — said loudly, not refused.
    const fromDotEnv = environment.dotEnvDevelopmentWarning('queue:work');
    if (fromDotEnv) this.#logger.warn(fromDotEnv);
    // The environment it assumed (E139): `in staging (protected)`, `in unset NODE_ENV (protected, like production)`.
    output.line(`Processing jobs of the ${connection} connection: ${queues.map((queue) => (queue === '*' ? '* (every queue)' : queue)).join(', ')} — in ${environment.describe()}`);
    try {
      const result = await worker.run({
        queues,
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
    const queues =
      typeof options.queue === 'string'
        ? options.queue.split(',').map((queue) => queue.trim()).filter(Boolean)
        : [this.#connections.options(connection).queue];
    if (queues.length === 0) throw new QueueSetupError('--queue names no queue.');
    if (queues.includes('*') && this.#connections.options(connection).driver === 'sync') throw new QueueSetupError('--queue=* needs a connection that keeps jobs.');
    const worker = this.#connections.worker(connection, stopTimeout);
    return { connection, stopTimeout, queues, worker, sleep: number(input, 'sleep', 1)!, maxJobs: number(input, 'max-jobs'), maxTime: number(input, 'max-time') };
  }
}
