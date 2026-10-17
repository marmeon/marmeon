import type { CommandInput } from 'marmeon';
import { Clock, environment, Logger, Redactor } from '@marmeon/core';
import { ScheduleError } from '../cron.ts';
import { Scheduler, type TaskResult } from '../scheduler.ts';
import { formatMinute, isoMinute } from '../time.ts';
import { ScheduleWorker } from '../worker.ts';

function describe(result: TaskResult): string {
  if (result.outcome === 'ran') return `ran (${result.ms} ms)`;
  if (result.outcome === 'failed') return `failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`;
  const why = { filter: 'when()/skip() said no', 'other-server': 'another server runs it', overlapping: 'its previous run has not finished', 'job-waiting': 'the job queued last time still waits' };
  return `skipped — ${why[result.skipped!]}`;
}

/**
 * A scheduler that cannot start (no cache, a missing command …) says so, without a stack trace. One that starts with
 * locks in a cache that is not shared says that too — and starts.
 */
async function checked(scheduler: Scheduler, output: CommandInput['output'], options: { warn?: boolean } = {}): Promise<boolean> {
  try {
    await scheduler.checkProcess();
  } catch (error) {
    if (!(error instanceof ScheduleError)) throw error;
    output.error(error.message);
    return false;
  }
  const warning = options.warn === false ? undefined : scheduler.lockWarning();
  if (warning) output.warn(warning);
  return true;
}

/**
 * `marmeon schedule:work`: the scheduler as a process of its own — a tick at the start of every minute, until
 * stopped. `marmeon dev` starts it next to the server; in production run one per server under a supervisor (or
 * `schedule:run` from cron). SIGTERM/SIGINT: no new tick; runs still going get `--stop-timeout` seconds, then the process
 * ends and frees their overlap locks.
 */
export class ScheduleWorkCommand {
  static command = 'schedule:work';
  static description = 'Run the scheduled tasks every minute, until stopped';
  static usage = '[--stop-timeout=30]';
  static options = { 'stop-timeout': { type: 'string' } } as const;

  readonly #scheduler: Scheduler;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #redactor: Redactor;

  constructor(scheduler: Scheduler, clock: Clock, logger: Logger, redactor: Redactor) {
    this.#scheduler = scheduler;
    this.#clock = clock;
    this.#logger = logger.child({ channel: 'schedule' });
    this.#redactor = redactor;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const stopTimeout = options['stop-timeout'] === undefined ? 30 : Number(options['stop-timeout']);
    if (!Number.isFinite(stopTimeout) || stopTimeout < 0) {
      output.error(`--stop-timeout must be a number of seconds ≥ 0, not ${String(options['stop-timeout'])}.`);
      return 1;
    }
    if (!(await checked(this.#scheduler, output))) return 1;

    const stop = new AbortController();
    const onSignal = (signal: NodeJS.Signals) => {
      if (stop.signal.aborted) return; // Ctrl+C arrives twice (terminal + launcher): one shutdown
      this.#logger.info(`${signal} received: no new runs; those still going have ${stopTimeout}s to finish`);
      stop.abort();
      setTimeout(() => process.exit(1), (stopTimeout + 10) * 1000).unref();
    };
    process.on('SIGINT', onSignal).on('SIGTERM', onSignal);

    const tasks = this.#scheduler.tasks;
    // A scheduler as development because a .env says so: a production command — said loudly, not refused.
    const fromDotEnv = environment.dotEnvDevelopmentWarning('schedule:work');
    if (fromDotEnv) this.#logger.warn(fromDotEnv);
    // The environment it assumed — `.environments(…)` compares against its APP_ENV (`local`, `testing`, `production` by default).
    output.line(
      `Running the schedule every minute: ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}${tasks.length > 0 ? ` (${tasks.map((task) => task.name).join(', ')})` : ''} — in ${environment.describe()}`,
    );
    const worker = new ScheduleWorker(this.#scheduler, this.#clock, this.#logger, this.#redactor);
    try {
      await worker.run({ signal: stop.signal });
      if (!(await worker.drain(stopTimeout))) {
        this.#logger.warn(`${worker.running} ${worker.running === 1 ? 'run' : 'runs'} did not finish within ${stopTimeout}s and end with the process`);
        await this.#scheduler.releaseHeld();
        setTimeout(() => process.exit(0), 2000).unref();
      }
      this.#logger.info('Scheduler stopped');
      return 0;
    } finally {
      process.off('SIGINT', onSignal).off('SIGTERM', onSignal);
    }
  }
}

/**
 * `marmeon schedule:run`: one tick, for the current minute — for a system cron that calls it every minute
 * (`* * * * * cd /app && marmeon schedule:run`). Waits for the runs, then exits (1 if one failed). Missed minutes are
 * caught up like in `schedule:work`.
 */
export class ScheduleRunCommand {
  static command = 'schedule:run';
  static description = 'Run the scheduled tasks that are due now (for a system cron, every minute)';

  readonly #scheduler: Scheduler;
  readonly #clock: Clock;

  constructor(scheduler: Scheduler, clock: Clock) {
    this.#scheduler = scheduler;
    this.#clock = clock;
  }

  async handle({ output }: CommandInput): Promise<number> {
    if (!(await checked(this.#scheduler, output))) return 1;
    const runs = await this.#scheduler.tick(this.#clock.now());
    if (runs.length === 0) {
      output.line('No scheduled tasks are due.');
      return 0;
    }
    const results = await Promise.all(runs.map((run) => run.done));
    for (const result of results) output.line(`${result.task}${result.reason === 'catch-up' ? ' (missed earlier)' : ''}: ${describe(result)}`);
    return results.some((result) => result.outcome === 'failed') ? 1 : 0;
  }
}

/** `marmeon schedule:list`: every task, when it runs (in its time zone), when next, and its options. `--json` prints them as a document. */
export class ScheduleListCommand {
  static command = 'schedule:list';
  static description = 'List the scheduled tasks';
  static usage = '[--json]';
  static options = { json: { type: 'boolean' } } as const;

  readonly #scheduler: Scheduler;
  readonly #clock: Clock;
  readonly #redactor: Redactor;

  constructor(scheduler: Scheduler, clock: Clock, redactor: Redactor) {
    this.#scheduler = scheduler;
    this.#clock = clock;
    this.#redactor = redactor;
  }

  handle({ options, output }: CommandInput): number {
    const tasks = this.#scheduler.tasks;
    const json = options.json === true;
    // The same warning schedule:work and schedule:run start with.
    const warning = this.#scheduler.lockWarning();
    if (tasks.length === 0 && !json) {
      output.line('No scheduled tasks. Add a schedule to a module: defineModule({ schedule: defineSchedule((s) => { … }) }).');
      return 0;
    }
    const now = this.#clock.now();
    const listed = tasks.map((task) => {
      const { definition } = task;
      return {
        task,
        // A job's payload and a command's arguments are part of both: masked like a log line.
        name: this.#redactor.text(task.name),
        does: this.#redactor.text(task.summary),
        next: this.#scheduler.next(task, now),
        options: {
          oneServer: definition.onOneServer,
          overlapMinutes: definition.overlapMinutes ?? null,
          catchUp: definition.catchUp,
          environments: definition.environments ? [...definition.environments] : null,
          filtered: definition.when.length + definition.skip.length > 0,
        },
      };
    });
    if (json) {
      output.json({
        format: 1,
        tasks: listed.map(({ task, name, does, next, options: taskOptions }) => ({
          name,
          expression: task.expression.source,
          timeZone: task.timeZone,
          next: next === undefined ? null : isoMinute(next, task.timeZone),
          does,
          options: taskOptions,
        })),
        warnings: warning ? [warning] : [],
      });
      return 0;
    }
    output.table(
      ['Task', 'Schedule', 'Next run', 'Does', 'Options'],
      listed.map(({ task, name, does, next, options: o }) => {
        const labels = [
          o.oneServer ? 'one server' : '',
          o.overlapMinutes !== null ? 'no overlap' : '',
          o.catchUp === 'skip' ? 'no catch-up' : '',
          o.environments ? `only ${o.environments.join('/')}` : '',
          o.filtered ? 'filtered' : '',
        ].filter(Boolean);
        return [name, `${task.expression.source} (${task.timeZone})`, next === undefined ? '—' : formatMinute(next, task.timeZone), does, labels.join(', ')];
      }),
    );
    if (warning) output.warn(warning);
    return 0;
  }
}

/** `marmeon schedule:test <name>`: runs one task now — whatever its frequency, filters and environments say. */
export class ScheduleTestCommand {
  static command = 'schedule:test';
  static description = 'Run one scheduled task now';
  static usage = '<name>';

  readonly #scheduler: Scheduler;

  constructor(scheduler: Scheduler) {
    this.#scheduler = scheduler;
  }

  async handle({ args, output }: CommandInput): Promise<number> {
    const name = args.join(' ').trim();
    if (name === '') {
      output.error(`Which task? marmeon schedule:test <name> — one of: ${this.#scheduler.tasks.map((task) => task.name).join(', ') || '(none)'}`);
      return 1;
    }
    // A test run ignores onOneServer(): no word about where its lock lives.
    if (!(await checked(this.#scheduler, output, { warn: false }))) return 1;
    let task;
    try {
      task = this.#scheduler.task(name);
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      output.error(error.message);
      return 1;
    }
    const result = await this.#scheduler.runNow(task).done;
    (result.outcome === 'failed' ? output.error.bind(output) : output.success.bind(output))(`${task.name}: ${describe(result)}`);
    return result.outcome === 'failed' ? 1 : 0;
  }
}
