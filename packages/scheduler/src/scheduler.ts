import { hostname } from 'node:os';
import { Cache, CacheConfig, type Lock } from '@marmeon/cache';
import type { CommandClass } from 'marmeon';
import { Application, Clock, ErrorReports, EventDispatcher, Logger, outsideTransaction, Redactor, type Container } from '@marmeon/core';
import { messageBase, runWithTask, trace } from '@marmeon/core/internal';
import { channels, type ScheduleTaskMessage } from '@marmeon/core/diagnostics';
import type { JobClass } from '@marmeon/queue';
import { ScheduleConfig } from './config.ts';
import { CronExpression, ScheduleError } from './cron.ts';
import { ScheduledTaskFailed, ScheduledTaskFinished, ScheduledTaskSkipped, ScheduledTaskStarting, type ScheduledTaskEvent } from './events.ts';
import { collectTasks, type ScheduleDefinition } from './schedule.ts';
import type { CallableTaskClass, TaskDefinition } from './task.ts';
import { checkTimeZone, isDue, lastDue, MINUTE, minuteOf, nextDue } from './time.ts';
import { withCode, withoutCode } from '@marmeon/core/internal';

/** How far back a scheduler that was down looks for missed runs (`catchUp('once')`). */
export const CATCH_UP_DAYS = 7;
/** Seconds the `onOneServer()` lock of a minute is kept — longer than any two servers' clocks or ticks lie apart. */
export const ONE_SERVER_SECONDS = 3600;
/**
 * Seconds a job queued by `s.job()` stays unique beyond the task's next due time — after that, a job lost on its way
 * (deleted, flushed) no longer blocks new ones.
 */
export const JOB_UNIQUE_FOR = 3600;

const runs = channels.tracing('schedule.task');

/** A task of the schedule, ready to run. */
export interface Task {
  /** Unique in the app: the job's name, the command line, the class name — or `name()`. */
  readonly name: string;
  readonly definition: TaskDefinition;
  readonly expression: CronExpression;
  readonly timeZone: string;
  /** What it does, for `schedule:list`: `job auth.prune`, `command session:prune`, `call PruneUploads`. */
  readonly summary: string;
}

/** Why a task ran: it was due, it was missed while the scheduler was down (`catchUp('once')`), or `schedule:test`. */
export type RunReason = 'due' | 'catch-up' | 'test';

/** Why a due task did not run. */
export type SkipReason = 'filter' | 'other-server' | 'overlapping' | 'job-waiting';

/** What became of one run. */
export interface TaskResult {
  readonly task: string;
  /** The time it was due (for a catch-up: the last time it was missed). */
  readonly dueAt: number;
  readonly reason: RunReason;
  readonly outcome: 'ran' | 'skipped' | 'failed';
  readonly skipped?: SkipReason;
  readonly error?: unknown;
  readonly ms: number;
}

/** @internal A run that started: its task, and its result once done (never rejects). */
export interface TaskRun {
  readonly task: Task;
  readonly dueAt: number;
  readonly reason: RunReason;
  readonly done: Promise<TaskResult>;
}

/** The output of a scheduled command goes to the log, as the task's. */
type OutputLike = { line(text?: string): void; info(text: string): void; success(text: string): void; warn(text: string): void; error(text: string): void; json(document: { readonly format: number; readonly [key: string]: unknown }): void; table(header: readonly string[], rows: readonly (readonly string[])[]): void };

async function importQueue() {
  try {
    return await import('@marmeon/queue');
  } catch {
    throw new ScheduleError(withCode('Q5', 's.job() queues jobs — it needs @marmeon/queue in the app: pnpm add @marmeon/queue'));
  }
}

async function importCli() {
  try {
    return { ...(await import('marmeon')), ...(await import('marmeon/internal')) };
  } catch {
    throw new ScheduleError(withCode('Q5', 's.command() runs console commands — it needs marmeon in the app: pnpm add -D marmeon'));
  }
}

/** "Did you mean …?" — the closest of `known`, if close enough. */
export function didYouMean(name: string, known: readonly string[]): string {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const current = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = current;
      }
    }
    return row[b.length]!;
  };
  const best = known.map((candidate) => ({ candidate, d: distance(name, candidate) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(2, Math.floor(name.length / 3)) ? ` Did you mean "${best.candidate}"?` : '';
}

function nameOf(definition: TaskDefinition): string {
  if (definition.name) return definition.name;
  switch (definition.kind) {
    case 'job':
      return (definition.target as JobClass).job;
    case 'command': {
      const command = typeof definition.target === 'string' ? definition.target.trim() : (definition.target as CommandClass).command;
      return [command, ...definition.args].join(' ');
    }
    case 'call':
      return (definition.target as CallableTaskClass).name;
  }
}

function summaryOf(definition: TaskDefinition): string {
  switch (definition.kind) {
    case 'job':
      return `job ${(definition.target as JobClass).job}${definition.payload && Object.keys(definition.payload).length > 0 ? ` ${JSON.stringify(definition.payload)}` : ''}`;
    case 'command':
      return `command ${[typeof definition.target === 'string' ? definition.target.trim() : (definition.target as CommandClass).command, ...definition.args].join(' ')}`;
    case 'call':
      return `call ${(definition.target as CallableTaskClass).name}`;
  }
}

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** The module's scheduled tasks — `defineSchedule((s) => { s.command('auth:prune-tokens').daily(); })`. */
    readonly schedule?: ScheduleDefinition;
  }
}

/**
 * The app's schedule: the tasks of every module's `schedule`, and what runs when. `marmeon schedule:work` calls
 * {@link tick} at every minute, `marmeon schedule:run` once (system cron); tests use `app.schedule`.
 *
 * Every run is a boundary like a request or a job: outside any transaction, in a container scope of its own, with
 * `{ task }` in its log entries. Runs never wait for each other — a slow task does not hold up the next tick.
 */
export class Scheduler {
  readonly #container: Container;
  readonly #app: Application;
  readonly #config: ScheduleConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;
  /** What a failure's text is masked with in the log: the app's (the names its packages add — the session cookie — count too). */
  readonly #redactor: Redactor;
  #tasks: readonly Task[] | undefined;
  /** Overlap locks of runs in progress — freed when the process must stop before they end. */
  readonly #held = new Set<Lock>();

  /** @internal Built by the container. */
  constructor(container: Container, app: Application, config: ScheduleConfig, clock: Clock, logger: Logger) {
    this.#container = container;
    this.#app = app;
    this.#config = config;
    this.#clock = clock;
    this.#logger = logger.child({ channel: 'schedule' });
    this.#redactor = container.has(Redactor) ? container.make(Redactor) : new Redactor();
  }

  /** Every task of the app's modules, checked: a frequency each, valid expressions and time zones, unique names. */
  get tasks(): readonly Task[] {
    this.#tasks ??= this.#build();
    return this.#tasks;
  }

  /** The task called `name` — or an error listing the names (and the closest one). */
  task(name: string): Task {
    const task = this.tasks.find((candidate) => candidate.name === name);
    if (task) return task;
    const names = this.tasks.map((candidate) => candidate.name);
    throw new ScheduleError(
      withCode(
        'Q5',
        names.length === 0 ? `There is no scheduled task "${name}" — the app's modules schedule none.` : `There is no scheduled task "${name}".${didYouMean(name, names)} Tasks: ${names.join(', ')}.`,
      ),
    );
  }

  /** @internal Whether a task runs the command `name` — e.g. the session asks for `session:prune` (then its lottery stays off). */
  schedules(command: string): boolean {
    return this.tasks.some(
      (task) => task.definition.kind === 'command' && (typeof task.definition.target === 'string' ? task.definition.target.trim() : (task.definition.target as CommandClass).command) === command,
    );
  }

  /** @internal The tasks due in the minute of `time` (in this environment) — before their `when`/`skip` filters, which are asked when they run. */
  due(time: number): Task[] {
    const minute = minuteOf(time);
    return this.tasks.filter((task) => this.#inEnvironment(task) && isDue(task.expression, minute, task.timeZone));
  }

  /** When `task` is due next after `time`. */
  next(task: Task, time = this.#clock.now()): number | undefined {
    return nextDue(task.expression, time, task.timeZone);
  }

  /**
   * @internal One tick, for the minute of `time`: starts every task due then — and, for a task with `catchUp('once')` (the
   * default), one run if it was due while the scheduler was down (since its last tick, at most {@link CATCH_UP_DAYS}
   * back), however many times it was missed. Resolves once the runs started; each run's `done` resolves when it ends.
   *
   * The last tick is kept in the cache: `schedule:last-tick` for tasks that run on one server (any server's tick counts),
   * `schedule:last-tick:<host>` for the others.
   */
  async tick(time: number): Promise<TaskRun[]> {
    const minute = minuteOf(time);
    const cache = this.#cache();
    const hostKey = `schedule:last-tick:${hostname()}`;
    const [shared, local] = await Promise.all([cache.get<number>('schedule:last-tick'), cache.get<number>(hostKey)]);
    const runs: TaskRun[] = [];
    for (const task of this.tasks) {
      if (!this.#inEnvironment(task)) continue;
      if (isDue(task.expression, minute, task.timeZone)) {
        runs.push(this.#start(task, minute, 'due'));
        continue;
      }
      if (task.definition.catchUp !== 'once') continue;
      const previous = task.definition.onOneServer ? shared : local;
      if (typeof previous !== 'number' || previous >= minute - MINUTE) continue;
      // Missed while the scheduler was down: once, for the last time it was due — not once per missed time.
      const from = Math.max(previous + MINUTE, minute - CATCH_UP_DAYS * 24 * 60 * MINUTE);
      const missed = lastDue(task.expression, from, minute - MINUTE, task.timeZone);
      if (missed !== undefined) runs.push(this.#start(task, missed, 'catch-up'));
    }
    const ttl = (CATCH_UP_DAYS + 1) * 86_400;
    await Promise.all([
      typeof shared === 'number' && shared >= minute ? undefined : cache.put('schedule:last-tick', minute, ttl),
      typeof local === 'number' && local >= minute ? undefined : cache.put(hostKey, minute, ttl),
    ]);
    return runs;
  }

  /** @internal Runs `task` now (`schedule:test`): without its frequency, filters, environments and `onOneServer` — its overlap lock still counts. */
  runNow(task: Task): TaskRun {
    return this.#start(task, minuteOf(this.#clock.now()), 'test');
  }

  /**
   * @internal What a scheduler process checks before its first tick (`schedule:work`, `schedule:run`), on top of the checks at
   * boot: the app has a cache (`ScheduleError` without one), every `s.command()` names a known command, every `s.job()` a
   * registered job. Locks in a cache that is not shared are no error — see {@link lockWarning}.
   */
  async checkProcess(): Promise<void> {
    const tasks = this.tasks;
    if (!this.#container.has(Cache)) {
      throw new ScheduleError(withCode('Q5', 'The scheduler keeps its locks and its last tick in the app\'s cache — register the CacheServiceProvider of @marmeon/cache (installed packages register it: marmeon discover).'));
    }
    // A command limited to other environments is never run here — and may not exist here (`devtools:prune` locally:
    // its package is a dev dependency, absent in a production install).
    const commands = tasks.filter((task) => task.definition.kind === 'command' && typeof task.definition.target === 'string' && this.#inEnvironment(task));
    if (commands.length > 0) {
      const cli = await importCli();
      const registry = this.#container.has(cli.CommandRegistry) ? this.#container.make(cli.CommandRegistry) : new cli.CommandRegistry();
      const known = registry.all().map((command) => command.command);
      for (const task of commands) {
        const name = (task.definition.target as string).trim();
        if (!registry.get(name)) throw new ScheduleError(withCode('Q5', `The schedule of module ${task.definition.module} runs the command "${name}", which the app does not have.${didYouMean(name, known)}`));
      }
    }
    const jobs = tasks.filter((task) => task.definition.kind === 'job');
    if (jobs.length > 0) {
      const queue = await importQueue();
      if (!this.#container.has(queue.Queue)) throw new ScheduleError(withCode('Q5', 's.job() queues jobs — register the QueueServiceProvider of @marmeon/queue (installed packages register it: marmeon discover).'));
      if (this.#container.has(queue.JobRegistry)) {
        const registry = this.#container.make(queue.JobRegistry);
        for (const task of jobs) {
          const job = task.definition.target as JobClass;
          if (!registry.get(job.job)) throw new ScheduleError(withCode('Q5', `The schedule of module ${task.definition.module} queues ${job.name} ("${job.job}"), which is no module's job — add it to jobs: [...] of its module, or no worker can run it.`));
        }
      }
    }
  }

  /**
   * @internal The warning a scheduler shows at its start, in every environment, when tasks lock with
   * `onOneServer()` or `withoutOverlapping()` in a cache that is not shared: `file` locks hold on this machine only, `memory`
   * locks in this process only. A single scheduler runs correctly with them — a production with one instance included —
   * so it is a warning, not an error. `undefined` when there is nothing to warn about. `schedule:list` shows it too.
   */
  lockWarning(): string | undefined {
    if (!this.#container.has(CacheConfig)) return undefined;
    const { driver } = this.#container.make(CacheConfig);
    if (driver !== 'file' && driver !== 'memory') return undefined;
    const locking = this.tasks.filter((task) => task.definition.onOneServer || task.definition.overlapSeconds !== undefined);
    if (locking.length === 0) return undefined;
    const kinds = [
      locking.some((task) => task.definition.onOneServer) ? 'onOneServer()' : '',
      locking.some((task) => task.definition.overlapSeconds !== undefined) ? 'withoutOverlapping()' : '',
    ].filter(Boolean);
    const scope =
      driver === 'file'
        ? 'locks only hold on this machine. With more than one scheduler instance (more servers), use CACHE_DRIVER=database (marmeon make:cache-table) or redis.'
        : 'locks only hold in this process — a second schedule:work, even on this machine, runs the tasks again. Use CACHE_DRIVER=file for one machine, database (marmeon make:cache-table) or redis for more.';
    return `${kinds.join('/')} ${kinds.length === 1 ? 'locks' : 'lock'} in CACHE_DRIVER=${driver}: ${scope} Tasks: ${locking.map((task) => task.name).join(', ')}`;
  }

  /** @internal Frees the overlap locks of runs still going — when the process stops before they end (they end with it). */
  async releaseHeld(): Promise<void> {
    const locks = [...this.#held];
    this.#held.clear();
    await Promise.all(locks.map((lock) => lock.release().catch(() => false)));
  }

  #build(): Task[] {
    const tasks: Task[] = [];
    for (const module of this.#app.modules) {
      if (module.schedule === undefined) continue;
      for (const definition of collectTasks(module.schedule, module.name)) {
        const name = nameOf(definition);
        const where = `The task "${name}" (schedule of module ${module.name})`;
        const source = definition.expression ?? definition.fields?.join(' ');
        if (source === undefined) throw new ScheduleError(withCode('Q5', `${where} has no frequency — add one: .daily(), .everyFifteenMinutes(), .cron('…').`));
        let expression: CronExpression;
        try {
          expression = new CronExpression(source);
        } catch (error) {
          throw new ScheduleError(withCode('Q5', `${where}: ${withoutCode((error as Error).message)}`));
        }
        const timeZone = checkTimeZone(definition.timeZone ?? this.#config.timeZone, where);
        const existing = tasks.find((task) => task.name === name);
        if (existing) {
          throw new ScheduleError(
            withCode(
              'Q5',
              `Two scheduled tasks are named "${name}" (modules ${existing.definition.module} and ${module.name}) — the name keys their locks: give one a name of its own with .name('…').`,
            ),
          );
        }
        tasks.push({ name, definition, expression, timeZone, summary: summaryOf(definition) });
      }
    }
    return tasks;
  }

  #inEnvironment(task: Task): boolean {
    return task.definition.environments === undefined || task.definition.environments.includes(this.#config.environment);
  }

  #cache(): Cache {
    if (!this.#container.has(Cache)) throw new ScheduleError(withCode('Q5', 'The scheduler keeps its locks and its last tick in the app\'s cache — register the CacheServiceProvider of @marmeon/cache.'));
    return this.#container.make(Cache);
  }

  #start(task: Task, dueAt: number, reason: RunReason): TaskRun {
    return { task, dueAt, reason, done: this.#execute(task, dueAt, reason) };
  }

  /** One run — never rejects: a failure is logged and reported in the result, the scheduler goes on. Traced on `schedule.task` while something listens. */
  #execute(task: Task, dueAt: number, reason: RunReason): Promise<TaskResult> {
    if (!runs.hasSubscribers) return this.#run(task, dueAt, reason);
    const message: ScheduleTaskMessage = { ...messageBase(this.#app), task: task.name, dueAt, reason };
    return trace(runs, message, () => this.#run(task, dueAt, reason), (ended, result) => {
      ended.outcome = result.outcome;
      if (result.skipped) ended.skipped = result.skipped;
      if (result.outcome === 'failed') ended.error = result.error;
    });
  }

  async #run(task: Task, dueAt: number, reason: RunReason): Promise<TaskResult> {
    const started = performance.now();
    const result = (outcome: TaskResult['outcome'], extra: Partial<TaskResult> = {}): TaskResult => ({
      task: task.name,
      dueAt,
      reason,
      outcome,
      ms: Math.round(performance.now() - started),
      ...extra,
    });
    // A run is a boundary: never inside a transaction of whoever ticked, in a scope of its own (like a request or a job).
    return outsideTransaction(() =>
      runWithTask({ task: task.name }, async () => {
        const scope = this.#container.createScope();
        const logger = this.#logger.child({ task: task.name });
        const about = { task: task.name, dueAt, reason };
        // The events go through the app's dispatcher; a listener's error is logged, never the run's.
        const emit = async (event: ScheduledTaskEvent) => {
          try {
            await scope.make(EventDispatcher).dispatch(event);
          } catch (error) {
            logger.warn(`A listener of ${event.constructor.name} failed: ${this.#redactor.text(error instanceof Error ? error.message : String(error))}`);
          }
        };
        const skip = async (skipped: SkipReason) => {
          await emit(new ScheduledTaskSkipped({ ...about, skipped }));
          return result('skipped', { skipped });
        };
        let outcome: TaskResult;
        try {
          if (reason !== 'test' && !(await this.#passes(task, scope))) {
            logger.debug(`Skipped ${task.name}: its when()/skip() said no`);
            return await skip('filter');
          }
          const cache = this.#cache();
          if (reason !== 'test' && task.definition.onOneServer) {
            const lock = cache.lock(`schedule:${task.name}:${new Date(dueAt).toISOString().slice(0, 16)}`, ONE_SERVER_SECONDS);
            if (!(await lock.get())) {
              logger.debug(`Skipped ${task.name}: another server runs it`);
              return await skip('other-server');
            }
          }
          let overlap: Lock | undefined;
          if (task.definition.overlapSeconds !== undefined) {
            overlap = cache.lock(`schedule:overlap:${task.name}`, task.definition.overlapSeconds);
            if (!(await overlap.get())) {
              logger.info(`Skipped ${task.name}: its previous run has not finished (withoutOverlapping)`);
              return await skip('overlapping');
            }
            this.#held.add(overlap);
          }
          try {
            logger.info(reason === 'catch-up' ? `Running ${task.name} — missed while the scheduler was down` : `Running ${task.name}`);
            await emit(new ScheduledTaskStarting(about));
            const queued = await this.#perform(task, dueAt, scope, logger);
            if (queued === false) {
              logger.info(`Skipped ${task.name}: the job queued last time still waits for a worker`);
              outcome = result('skipped', { skipped: 'job-waiting' });
            } else {
              outcome = result('ran');
              logger.info(`Done: ${task.name}`, { ms: outcome.ms });
            }
          } finally {
            if (overlap) {
              this.#held.delete(overlap);
              await overlap.release();
            }
          }
        } catch (error) {
          const exception = this.#redactor.text(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
          if (this.#container.has(ErrorReports)) {
            this.#container.make(ErrorReports).report(error, { source: 'schedule', context: { task: task.name }, log: { message: `Failed: ${task.name}`, fields: { channel: 'schedule', task: task.name, exception } } });
          } else {
            logger.error(`Failed: ${task.name}`, { exception });
          }
          const failed = result('failed', { error });
          await emit(new ScheduledTaskFailed({ ...about, error, ms: failed.ms }));
          return failed;
        }
        if (outcome.outcome === 'skipped') await emit(new ScheduledTaskSkipped({ ...about, skipped: outcome.skipped! }));
        else await emit(new ScheduledTaskFinished({ ...about, ms: outcome.ms }));
        return outcome;
      }),
    );
  }

  async #passes(task: Task, scope: Container): Promise<boolean> {
    for (const filter of task.definition.when) if (!(await filter(scope))) return false;
    for (const filter of task.definition.skip) if (await filter(scope)) return false;
    return true;
  }

  /** Does the work; `false` when a job was not queued because the last one still waits. */
  async #perform(task: Task, dueAt: number, scope: Container, logger: Logger): Promise<boolean | void> {
    const { definition } = task;
    switch (definition.kind) {
      case 'job': {
        const { Queue } = await importQueue();
        // Unique until a worker starts it: while the last one still waits, no second one — workers that are behind
        // or down find one waiting job, not one per tick. The lock outlives the next due time (by JOB_UNIQUE_FOR), so a
        // job lost on its way never blocks the task for longer than that.
        const next = nextDue(task.expression, dueAt, task.timeZone);
        const id = await scope.make(Queue).dispatch(definition.target as JobClass, definition.payload as never, {
          unique: `schedule:${task.name}`,
          uniqueUntil: 'processing',
          uniqueFor: (next === undefined ? 0 : (next - dueAt) / 1000) + JOB_UNIQUE_FOR,
        });
        return id !== undefined;
      }
      case 'command': {
        const cli = await importCli();
        const Command =
          typeof definition.target === 'string'
            ? (this.#container.has(cli.CommandRegistry) ? this.#container.make(cli.CommandRegistry).get(definition.target.trim()) : undefined)
            : (definition.target as CommandClass);
        if (!Command) throw new ScheduleError(`The command "${String(definition.target)}" does not exist.`);
        const output = taskOutput(cli.Output, logger);
        const code = await cli.runCommand(scope, Command, definition.args, { output, root: this.#app.root, spawn: (...args) => cli.spawnMarmeon(this.#app.root, args) });
        if (code !== 0) throw new ScheduleError(`marmeon ${[Command.command, ...definition.args].join(' ')} exited with code ${code}.`);
        return;
      }
      case 'call': {
        const instance = scope.make(definition.target as never) as { handle?: () => unknown };
        if (typeof instance.handle !== 'function') throw new ScheduleError(`${(definition.target as CallableTaskClass).name} has no handle() — s.call() runs callable task classes.`);
        await instance.handle();
        return;
      }
    }
  }
}

/** An `Output` whose lines go to the task's log. */
function taskOutput(Output: new () => OutputLike, logger: Logger): OutputLike {
  const output = new Output();
  return Object.assign(output, {
    line: (text = '') => text !== '' && logger.info(text),
    info: (text: string) => logger.info(text),
    success: (text: string) => logger.info(text),
    warn: (text: string) => logger.warn(text),
    error: (text: string) => logger.error(text),
  });
}
