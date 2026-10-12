import { Application, Clock, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { ScheduleListCommand, ScheduleRunCommand, ScheduleTestCommand, ScheduleWorkCommand } from './commands/schedule.ts';
import { ScheduleConfig } from './config.ts';
import { Scheduler } from './scheduler.ts';

export { ScheduleConfig } from './config.ts';
export { CronExpression, ScheduleError } from './cron.ts';
export type { WallTime } from './cron.ts';
export { defineSchedule } from './schedule.ts';
export type { JobPayloadArgument, Schedule, ScheduleDefinition } from './schedule.ts';
export type { CatchUp, CheckTime, Frequencies, Invokable, InvokableClass, ScheduledTask, TaskDefinition, TaskFilter, TaskKind, TimeOfDay, UnscheduledTask, Weekday } from './task.ts';
export { CATCH_UP_DAYS, didYouMean, JOB_UNIQUE_FOR, ONE_SERVER_SECONDS, Scheduler } from './scheduler.ts';
export type { RunReason, SkipReason, Task, TaskResult, TaskRun } from './scheduler.ts';
export { dueMinutes, formatMinute, isDue, lastDue, MINUTE, minuteOf, nextDue } from './time.ts';
export { ScheduledTaskEvent, ScheduledTaskFailed, ScheduledTaskFinished, ScheduledTaskSkipped, ScheduledTaskStarting } from './events.ts';
export { ScheduleWorker } from './worker.ts';
export type { Sleep } from './worker.ts';
export { ScheduleTester, toEpoch } from './testing.ts';
export type { ScheduleTime } from './testing.ts';
export { ScheduleListCommand, ScheduleRunCommand, ScheduleTestCommand, ScheduleWorkCommand } from './commands/schedule.ts';

/**
 * Registers the `Scheduler` and the `schedule:*` commands; `marmeon dev` runs `schedule:work` next to the server when
 * the app schedules anything. Found by `marmeon discover`.
 */
export class SchedulerServiceProvider implements ServiceProvider {
  static config = [ScheduleConfig];

  register(container: Container): void {
    container.singleton(Scheduler, (c) => new Scheduler(container, c.make(Application), c.make(ScheduleConfig), c.make(Clock), c.make(Logger)));
  }

  async boot(app: Application): Promise<void> {
    // A task without a frequency, an invalid cron expression or time zone, two tasks with one name: the start fails.
    const tasks = app.container.make(Scheduler).tasks;

    const cli = await import('marmeon').catch(() => undefined);
    if (cli && app.container.has(cli.CommandRegistry)) {
      app.container.make(cli.CommandRegistry).add([ScheduleWorkCommand, ScheduleRunCommand, ScheduleListCommand, ScheduleTestCommand], '@marmeon/scheduler');
    }
    if (cli && app.container.has(cli.DevProcesses) && tasks.length > 0) {
      app.container.make(cli.DevProcesses).add({ name: 'schedule', args: ['schedule:work', '--stop-timeout=5'] });
    }
  }
}
