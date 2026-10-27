import { Application, Clock, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { ScheduleListCommand, ScheduleRunCommand, ScheduleTestCommand, ScheduleWorkCommand } from './commands/schedule.ts';
import { ScheduleConfig } from './config.ts';
import { Scheduler } from './scheduler.ts';
import type { CommandClass } from 'marmeon';

export { ScheduleConfig } from './config.ts';
export { CronExpression, ScheduleError } from './cron.ts';
export { defineSchedule } from './schedule.ts';
export type { JobPayloadArgument, Schedule, ScheduleDefinition } from './schedule.ts';
export type { CallableTask, CallableTaskClass, CatchUp, CheckTime, Frequencies, ScheduledTask, TaskDefinition, TaskFilter, TaskKind, TaskOverlapOptions, TimeOfDay, UnscheduledTask, Weekday } from './task.ts';
export { Scheduler } from './scheduler.ts';
export type { RunReason, SkipReason, Task, TaskResult } from './scheduler.ts';
export { ScheduledTaskEvent, ScheduledTaskFailed, ScheduledTaskFinished, ScheduledTaskSkipped, ScheduledTaskStarting } from './events.ts';

/**
 * Registers the `Scheduler` and the `schedule:*` commands; `marmeon dev` runs `schedule:work` next to the server when
 * the app schedules anything. Found by `marmeon discover`.
 */
export class SchedulerServiceProvider implements ServiceProvider {
  static config = [ScheduleConfig];
  static commands: readonly CommandClass[] = [ScheduleWorkCommand, ScheduleRunCommand, ScheduleListCommand, ScheduleTestCommand];

  register(container: Container): void {
    container.singleton(Scheduler, (c) => new Scheduler(container, c.make(Application), c.make(ScheduleConfig), c.make(Clock), c.make(Logger)));
  }

  async boot(app: Application): Promise<void> {
    // A task without a frequency, an invalid cron expression or time zone, two tasks with one name: the start fails.
    const tasks = app.container.make(Scheduler).tasks;

    const cli = await import('marmeon').catch(() => undefined);
    if (cli && app.container.has(cli.DevProcesses) && tasks.length > 0) {
      app.container.make(cli.DevProcesses).add({ name: 'schedule', args: ['schedule:work', '--stop-timeout=5'] });
    }
  }
}
