import type { Application } from '@marmeon/core';
import type { JobClass } from '@marmeon/queue';
import { ScheduleConfig } from './config.ts';
import type { Task } from './scheduler.ts';

/** A class's name for a message: a non-empty string, else a stand-in — a class may carry any value, or a getter that throws. */
function nameOf(job: JobClass): string {
  try {
    const { name } = job;
    return typeof name === 'string' && name !== '' ? name : '(unnamed class)';
  } catch {
    return '(unnamed class)';
  }
}

/**
 * @internal What `schedule:work` prints once at its start: for each task that queues a job whose name the app registers for
 * another class, one line through `warn`. The queue refuses that class, so each run of the task fails; the scheduler's other
 * tasks work, so this is a line and never an error. It never rejects, whatever the container, the tasks, the classes' names or
 * `warn` do — and it needs `@marmeon/queue` only when a task queues a job (the package is an optional peer).
 */
export async function warnJobNames(tasks: readonly Task[], app: Application, warn: (text: string) => void): Promise<void> {
  try {
    const jobs = tasks.filter((task) => task.definition.kind === 'job');
    if (jobs.length === 0) return;
    const { container } = app;
    const { environment } = container.make(ScheduleConfig);
    const queue = await import('@marmeon/queue');
    const registry = container.make(queue.JobRegistry);
    for (const task of jobs) {
      try {
        const { environments } = task.definition;
        if (environments !== undefined && !environments.includes(environment)) continue;
        const job = task.definition.target as JobClass;
        const registered = registry.get(job.job);
        if (registered === undefined || registry.has(job)) continue;
        const mine = nameOf(job);
        const other = nameOf(registered);
        const same = mine === other;
        warn(
          `The task "${task.name}" queues ${mine} ("${job.job}"), but this app registers that job name for ${same ? 'another class' : other}. The queue of @marmeon/queue refuses ${mine}, so the task's runs fail. Schedule the class the app registers, or a job class of your own (not a subclass of it) with another job name (not under marmeon.), listed in a module's jobs.` +
            (same ? ' Two classes with one name also come from an app that loads two copies of one package: load one.' : ''),
        );
      } catch {
        // This task's line cannot be made or printed: the next task is still checked.
      }
    }
  } catch {
    // A line that cannot be made never stops the scheduler.
  }
}
