import type { CommandClass } from 'marmeon';
import type { CheckJob, JobClass, JobInput } from '@marmeon/queue';
import { ScheduleError } from './cron.ts';
import { PendingTask, type InvokableClass, type TaskDefinition, type UnscheduledTask } from './task.ts';

/** The payload argument of `s.job()`: optional when the job's schema takes an empty object. */
export type JobPayloadArgument<J extends JobClass> = {} extends JobInput<J> ? [payload?: JobInput<J>] : [payload: JobInput<J>];

/**
 * What a module's schedule is written with — `defineSchedule((s) => { … })`. Each call adds a task; give it a frequency
 * (`.daily()`, `.everyFifteenMinutes()`, `.cron('…')`) and options.
 */
export interface Schedule {
  /**
   * Queues a job when due — `s.job(PruneJob).daily()`. Unique until a worker starts it (E88): while the one queued last
   * time still waits (the workers are behind or down), the next is not queued — no pile of N waiting jobs.
   */
  job<J extends JobClass>(job: J & CheckJob<J>, ...payload: JobPayloadArgument<J>): UnscheduledTask<'job'>;
  /** Runs a console command when due, in the scheduler's process — `s.command('session:prune')`, `s.command('queue:prune-failed', ['--hours=168'])`. */
  command(command: string | CommandClass, args?: readonly string[]): UnscheduledTask<'command'>;
  /** Runs an invokable class when due — built through the container in a scope of its own, then `handle()`. */
  call(target: InvokableClass): UnscheduledTask<'call'>;
}

const DEFINE = Symbol.for('marmeon.scheduler.define');

/** A module's schedule (`defineModule({ schedule })`). */
export interface ScheduleDefinition {
  readonly [DEFINE]: (s: Schedule) => void;
}

/**
 * A module's scheduled tasks — `schedule` in `defineModule` (E88):
 *
 * ```ts
 * export const schedule = defineSchedule((s) => {
 *   s.command('auth:prune-tokens').daily().at('03:10').timezone('Europe/Berlin').onOneServer();
 *   s.command('session:prune').everyFifteenMinutes().withoutOverlapping();
 *   s.job(RebuildStatsJob, { userId: 1 }).hourly();
 *   s.call(PruneTemporaryUploads).hourly();
 * });
 * ```
 *
 * `marmeon schedule:work` runs them (`marmeon dev` starts it), `marmeon schedule:run` from a system cron every minute.
 */
export function defineSchedule(define: (s: Schedule) => void): ScheduleDefinition {
  if (typeof define !== 'function') throw new ScheduleError('defineSchedule() takes a function: defineSchedule((s) => { s.command(…).daily(); }).');
  return { [DEFINE]: define };
}

/** Runs a module's schedule definition and returns its tasks. */
export function collectTasks(definition: ScheduleDefinition, module: string): TaskDefinition[] {
  const define = (definition as Partial<ScheduleDefinition> | undefined)?.[DEFINE];
  if (typeof define !== 'function') throw new ScheduleError(`The schedule of module ${module} is not a defineSchedule(…) — write schedule: defineSchedule((s) => { … }).`);
  const tasks: PendingTask[] = [];
  const add = <T>(task: PendingTask) => (tasks.push(task), task as T);
  const s: Schedule = {
    job: (job, ...payload) => {
      if (typeof job !== 'function' || typeof job.job !== 'string') throw new ScheduleError(`s.job() in the schedule of module ${module} needs a job class (static job, static schema, handle()).`);
      return add(new PendingTask({ kind: 'job', target: job, payload: payload[0] ?? {}, args: [], module }));
    },
    command: (command, args = []) => {
      const valid = typeof command === 'string' ? command.trim() !== '' : typeof command === 'function' && typeof command.command === 'string';
      if (!valid) throw new ScheduleError(`s.command() in the schedule of module ${module} needs a command name ('session:prune') or a command class.`);
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new ScheduleError(`s.command(${JSON.stringify(typeof command === 'string' ? command : command.command)}, args): args is a list of strings, like ['--hours=168'].`);
      return add(new PendingTask({ kind: 'command', target: command, payload: undefined, args: [...args], module }));
    },
    call: (target) => {
      if (typeof target !== 'function') throw new ScheduleError(`s.call() in the schedule of module ${module} needs a class with handle().`);
      return add(new PendingTask({ kind: 'call', target, payload: undefined, args: [], module }));
    },
  };
  define(s);
  return tasks.map((task) => task.definition);
}
