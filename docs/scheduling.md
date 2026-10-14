# Task Scheduling

## Introduction

Some work runs on a clock: expired sessions to delete at night, numbers to count again every hour. A module writes its tasks in a
schedule, and a process of its own, `marmeon schedule:work`, runs each task when it is due:

```ts title="modules/system/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('session:prune').everyFifteenMinutes().withoutOverlapping().onOneServer();
  s.command('cache:prune').hourlyAt(25).withoutOverlapping().onOneServer();
  s.command('queue:prune-failed', ['--hours=168']).daily().at('03:20').timezone('Europe/Berlin').onOneServer();
});
```

The module lists its schedule in its definition:

```ts title="modules/system/index.ts"
import { defineModule } from '@marmeon/core';
import { schedule } from './schedule.ts';

export default defineModule({
  name: 'system',
  schedule,
});
```

`marmeon dev` starts the scheduler next to the server whenever a module has a schedule. `pnpm marmeon schedule:list` shows every
task, when it runs next and its options.

## Defining tasks

A schedule has three kinds of task. Each one needs a frequency, and its options come after it.

### Commands

`s.command(name, args)` runs a console command in the scheduler's process, with its arguments as a list:

```ts
s.command('notifications:prune', ['--days=30']).daily().at('03:30');
```

`s.command()` also takes the command's class. A command that ends with an exit code other than 0 counts as a failed run. Each run
gets a container scope of its own, as it does on the command line. The [console](console.md#writing-commands) page shows how to
write a command.

### Jobs

`s.job(Job, payload)` queues a job when the task is due, and a worker runs it. The payload is optional when the job's schema takes
an empty object:

```ts title="modules/user-profile/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';
import { RebuildMemberStatsJob } from './jobs/RebuildMemberStatsJob.ts';

export const schedule = defineSchedule((s) => {
  s.job(RebuildMemberStatsJob).hourly();
});
```

The job must be listed in its module's `jobs`. It is queued as a [unique job](queues.md#unique-jobs) until a worker starts it, so
while the job of the last hour still waits, because the workers are behind or down, the task queues no second one.

### Invokable classes

`s.call(Class)` builds a class through the container, in a scope of its own, and calls its `handle()`:

```ts title="modules/user-profile/tasks/PruneDataExports.ts"
import { Clock } from '@marmeon/core';
import { Storage } from '@marmeon/storage';

export class PruneDataExports {
  readonly #storage: Storage;
  readonly #clock: Clock;

  constructor(storage: Storage, clock: Clock) {
    this.#storage = storage;
    this.#clock = clock;
  }

  async handle(): Promise<void> {
    const disk = this.#storage.disk('local');
    const before = this.#clock.now() - 15 * 60_000;
    for (const key of await disk.list('exports')) {
      if ((await disk.lastModified(key)).getTime() <= before) await disk.delete(key);
    }
  }
}
```

```ts
s.call(PruneDataExports).everyTenMinutes().withoutOverlapping().onOneServer().name('user-profile.prune-data-exports');
```

### Names

A task's name appears in `schedule:list`, in `schedule:test`, in the log and in its locks. By default it is the command with its
arguments, such as `queue:prune-failed --hours=168`, the job's `static job` or the class name. The arguments belong to the name,
so the same command with other arguments is another task, with locks of its own. `.name()` sets another one. Give a class a
name with its module in front, as above, so it stays unique across modules. `.description()` adds a line for `schedule:list`.

The app does not start when two tasks have one name, when a task has no frequency, or when a cron expression or a time zone is
invalid.

## Frequencies

| Method | When |
| --- | --- |
| `everyMinute()`, `everyTwoMinutes()`, `everyThreeMinutes()`, `everyFiveMinutes()`, `everyTenMinutes()`, `everyFifteenMinutes()`, `everyThirtyMinutes()` | Every so many minutes. |
| `hourly()` | At minute 0 of every hour. |
| `hourlyAt(minute)` | At that minute of every hour. |
| `everyTwoHours()`, `everyThreeHours()`, `everySixHours()` | Every so many hours, at minute 0. |
| `daily()` | At midnight. |
| `dailyAt('03:10')` | Every day at that time. |
| `weekly()` | Sundays at midnight. |
| `weeklyOn('monday', '8:00')` | That day of the week, at that time. |
| `monthly()` | On the 1st at midnight. |
| `monthlyOn(1, '6:00')` | That day of the month, at that time. |
| `yearly()` | On January 1st at midnight. |
| `cron('*/5 9-17 * * mon-fri')` | A cron expression of your own. |

After a frequency, `at('03:10')` sets the time of day, `weekdays()` and `weekends()` limit it to those days, and `days('monday',
'friday')` to the days you name. A time is `HH:MM` from `0:00` to `23:59`, and a literal that is no time is a compile error. An
option before a frequency is a compile error too:

```text
Say how often first — .daily().onOneServer(): a task needs a frequency before its options
```

### Time zones

A task's times are on the clocks of `SCHEDULE_TIMEZONE`, UTC by default, or of the zone that `.timezone('Europe/Berlin')` names.
Daylight saving time counts. A task at a time the clocks skip, such as 02:30 on the last Sunday of March in Berlin, runs right after
the gap. A task at a time that happens twice, 02:30 in October, runs the first time only. Tasks that run every hour run as the hours
really pass.

## Conditions

| Option | What it does |
| --- | --- |
| `when(filter)` | Runs only when `filter` returns `true`. |
| `skip(filter)` | Does not run when `filter` returns `true`. |
| `environments('production')` | Runs only in these environments, by `APP_ENV`. Without it the name follows `NODE_ENV`: `local`, `testing` or `production`. |

A filter is asked every time the task is due. It gets the run's container scope, so it can ask a service, here a config
definition of the module:

```ts
s.command('reports:send').daily().at('07:00').when((scope) => scope.make(ReportsConfig).enabled);
```

`environments()` compares against the environment's name, `APP_ENV`. A staging server, `NODE_ENV=production APP_ENV=staging`,
runs the tasks of `.environments('staging')` and leaves those of `.environments('production')` out:

```ts title="modules/reports/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  // Mails to customers: production only, never from staging.
  s.command('reports:send').daily().at('07:00').environments('production');
  // A copy of production's data for the testers: staging only.
  s.command('reports:refresh-demo').daily().at('05:00').environments('staging');
});
```

Selecting tasks is all `APP_ENV` does here. It never weakens a protection and never enables a development tool, which follow
`NODE_ENV` alone, as the [configuration](configuration.md#app_env-the-environments-name) page explains.

The scheduler checks at its start that every `s.command()` names a command the app has and every `s.job()` a job a module lists.
A task limited to other environments is left out of that check, because it never runs here and its package may be a dev
dependency: `s.command('devtools:prune').hourlyAt(40).environments('local')`.

## Several servers and long runs

### One server only

With several servers that each run a scheduler, every task would run on each of them. `onOneServer()` runs it on one: the first
scheduler to take the task's lock for that minute runs it, and the others skip it. The lock lives in the app's cache and is kept an
hour.

### No overlapping runs

`withoutOverlapping()` skips a run while the previous one still runs, on any server. The lock expires after 1440 minutes, or after
the minutes you pass, `withoutOverlapping(30)`, so a scheduler that crashed cannot block the task forever. A scheduler that stops
before its runs end frees their locks. `s.job()` takes no `withoutOverlapping()`: queuing a job never overlaps, and the type error
says so. Runs of the job itself that must not overlap use the job's [middleware](queues.md#job-middleware).

### The cache they need

Both options lock in the app's [cache](cache.md). With more than one scheduler, the cache must be one they share: `database` or
`redis`. With `file` the locks hold on one machine, and with `memory` in one process. That is right for a single scheduler, so
`schedule:work`, `schedule:run` and `schedule:list` only warn:

```text
onOneServer()/withoutOverlapping() lock in CACHE_DRIVER=file: locks only hold on this machine. With more than one
scheduler instance (more servers), use CACHE_DRIVER=database (marmeon make:cache-table) or redis. Tasks: session:prune,
cache:prune, queue:prune-failed --hours=168
```

Two schedulers on one machine share a `file` cache, so a task with `onOneServer()` still runs once. With `memory` each process has
locks of its own, and a second scheduler runs everything again.

## Missed runs

A scheduler that was down, during a deploy or on a machine that slept, runs a task it missed **once** when it is back, however
often the task was due meanwhile. It looks back at most 7 days. `catchUp('skip')` waits for the next due time instead.

The scheduler keeps the time of its last tick in the cache: one for the tasks with `onOneServer()`, which any server's tick
updates, and one per host name for the others. So nothing is caught up after `cache:clear`, and a task without `onOneServer()`
catches up nothing in a container that starts with a new host name.

## Running the scheduler

`schedule:work` checks every minute what is due, until it is stopped:

```sh
pnpm marmeon schedule:work
```

Its first line names its tasks and the environment it assumed, such as `Running the schedule every minute: 3 tasks (session:prune,
cache:prune, queue:prune-failed --hours=168) — in production (APP_ENV=production)`. On `SIGTERM` or `SIGINT` it starts no new run, gives
the runs still going `--stop-timeout` seconds, 30 by default, then ends and frees their locks.

| Command | What it does |
| --- | --- |
| `schedule:work [--stop-timeout=30]` | Runs the schedule every minute, until stopped. |
| `schedule:run` | Runs what is due now, waits for the runs and ends: with exit code 1 when a run failed. |
| `schedule:list` | Lists the tasks, their schedule in their time zone, the next run and their options. |
| `schedule:test <name>` | Runs one task now, whatever its frequency, filters and environments say. Its overlap lock still counts. |

In production, run **one** `schedule:work` per server under a supervisor, next to the web processes and the workers. A task with
`onOneServer()` then runs once across them. `marmeon make:docker` writes the role as a `scheduler` container and as a systemd unit;
the [deployment](deployment.md#roles-and-processes) page covers the roles.

Without a supervisor, a system cron can call `schedule:run` every minute. A crontab line gets no environment of its own, so name
`NODE_ENV` in it:

```text
* * * * * cd /app && NODE_ENV=production marmeon schedule:run
```

A scheduler that is `development` only because of the app's `.env` logs a warning and runs anyway. The
[configuration](configuration.md#where-node_env-comes-from) page explains where `NODE_ENV` comes from. Without `@marmeon/cache`
the scheduler refuses to start, because it keeps its locks and its last tick there.

### What a run is

Every run is a unit of work of its own, like a request or a job: outside any transaction, in a container scope of its own, with
`task` in its log entries. Runs never wait for each other. A run that fails is logged, and the others go on.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `SCHEDULE_TIMEZONE` | `UTC` | Whose clocks the tasks' times are on: an IANA name such as `Europe/Berlin`, checked at the start. |
| `APP_ENV` | `local`, `testing` or `production`, by `NODE_ENV` | What `environments()` compares against. |

## Housekeeping commands

The framework's tables grow until something prunes them. Schedule these commands in an app that uses the tables:

| Command | What it deletes | Read more |
| --- | --- | --- |
| `session:prune` | Expired sessions of the `database` driver. | [Session](session.md#expiry-and-clean-up) |
| `cache:prune` | Expired cache entries and locks. | [Cache](cache.md#expired-entries-and-clearing) |
| `queue:prune-failed --hours=168` | Failed jobs older than a week. | [Queues](queues.md#failed-jobs) |
| `notifications:prune` | Notifications read long ago. | [Notifications](notifications.md#the-notifications-table) |
| `uploads:prune` | Uploads that were never used, or used up. | [File storage](storage.md#the-uploads-table) |
| `auth:prune-tokens` | Expired reset and API tokens, and remember-me tokens that expired or are older than `AUTH_REMEMBER_DAYS`; with a bound `SignInStore`, also the sign-ins that are over. | [Remember me](authentication.md#remember-me), [sign-ins](authentication.md#pruning-sign-ins) |

The starter kit's auth module schedules `auth:prune-tokens` and its own `PruneEmailChanges` task, which clears the changes of
address nobody confirmed in time, at 03:10. Its schedule also holds `auth:prune-unverified`, which deletes accounts whose address
was never confirmed, as a line that is commented out: deleting accounts is your app's decision, so turn it on deliberately. The
[starter kit](starter-kit.md#accounts-nobody-confirmed) page explains it.

## Events

Every run says what became of it through the app's event dispatcher:

| Event | When | Fields besides `task`, `minute` and `reason` |
| --- | --- | --- |
| `ScheduledTaskStarting` | The run passed its filters and locks and starts. | none |
| `ScheduledTaskFinished` | The run ended. | `ms` |
| `ScheduledTaskFailed` | The run threw, or its command ended with another exit code than 0. | `error`, `ms` |
| `ScheduledTaskSkipped` | The task was due and did not run. With `job-waiting` it comes after `ScheduledTaskStarting`, because the queue says no only when the task tries to queue its job. | `skipped`: `filter`, `other-server`, `overlapping` or `job-waiting` |

`reason` says why it ran: `due`, `catch-up` or `test`. All of them extend `ScheduledTaskEvent`. A listener runs in the scheduler's
process, and its error is logged and changes nothing about the run. This one raises an alert for every failed task:

```ts title="modules/system/listeners/AlertOnFailedTask.ts"
import { Logger, Redactor } from '@marmeon/core';
import type { ScheduledTaskFailed } from '@marmeon/scheduler';

export class AlertOnFailedTask {
  readonly #logger: Logger;
  readonly #redactor: Redactor;

  constructor(logger: Logger, redactor: Redactor) {
    this.#logger = logger.child({ channel: 'alerts' });
    this.#redactor = redactor;
  }

  handle(event: ScheduledTaskFailed): void {
    const message = event.error instanceof Error ? event.error.message : String(event.error);
    this.#logger.error(`The scheduled task ${event.task} failed: ${this.#redactor.text(message)}`, { alert: true, task: event.task });
  }
}
```

The module registers it with `listeners: [listen(ScheduledTaskFailed, AlertOnFailedTask)]`, as the
[events](events.md#registering-listeners) page shows.

## Testing

`app.schedule` runs the schedule on the test's clock:

```ts title="modules/system/schedule.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('prunes failed jobs at night, Berlin time', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  expect(app.schedule.due('2026-10-04T03:20:00+02:00')).toContain('queue:prune-failed --hours=168');
  expect(app.schedule.due('2026-10-04T03:20:00Z')).not.toContain('queue:prune-failed --hours=168');

  const results = await app.schedule.run('2026-10-04T03:20:00+02:00');
  expect(results.find((result) => result.task === 'queue:prune-failed --hours=168')).toMatchObject({ outcome: 'ran' });
});
```

`due(time)` lists the tasks due then, `run(time)` moves the clock there and runs them, `runTask(name)` runs one, and `tasks` lists
every name. The [fakes](fakes.md#the-schedule) page covers the schedule's fake, and the
[time](time.md#the-schedule-and-the-clock) page the clock.
