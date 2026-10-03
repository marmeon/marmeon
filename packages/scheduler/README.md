# @bespokecore/scheduler

Scheduled tasks (E88): written in the modules, run by a process of their own — `bespoke schedule:work` (a tick at every
minute; `bespoke dev` starts one) or `bespoke schedule:run` from a system cron every minute.

```ts
// modules/auth/schedule.ts — and `schedule` in defineModule({ … })
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').timezone('Europe/Berlin').onOneServer();
  s.command('session:prune').everyFifteenMinutes().withoutOverlapping();
  s.job(RebuildStatsJob).hourly();          // queues the job; while the last one still waits, no second one
  s.call(PruneTemporaryUploads).hourly();   // an invokable class, built in a scope of its own
});
```

```text
bespoke schedule:work [--stop-timeout=30] | schedule:run | schedule:list | schedule:test <name>
```

- **Frequencies:** `everyMinute()` … `everyThirtyMinutes()`, `hourly()`, `hourlyAt(m)`, `everyTwoHours()` …, `daily()`,
  `dailyAt('03:10')`, `weekly()`, `weeklyOn('monday', '8:00')`, `monthly()`, `monthlyOn(1, '6:00')`, `yearly()`,
  `cron('*/5 9-17 * * mon-fri')`; then `at()`, `weekdays()`, `weekends()`, `days(…)`. Options come after the frequency.
- **Time zones** (`SCHEDULE_TIMEZONE`, default UTC, or `.timezone()`) by `Temporal`, daylight saving time included: a task
  at a time the clocks skip (02:30 on the last Sunday of March in Berlin) runs right after the gap; at a time they repeat
  (02:30 in October) in the first pass only. Tasks for every hour run as the minutes really pass.
- **Filters:** `when(fn)`, `skip(fn)` (asked each time, with the run's scope), `environments('production')` (`NODE_ENV`).
- **`onOneServer()`:** the first scheduler to take the lock `schedule:<name>:<minute>` in the app's cache runs it. Needs a
  cache all servers share — `CACHE_DRIVER=database` or `redis` — when more than one scheduler runs.
- **`withoutOverlapping(minutes = 1440)`:** a run is skipped while the previous one still runs (on any server). A
  scheduler that stops before its runs end frees their locks.
- **Locks in a cache that is not shared (E123):** with `CACHE_DRIVER=file` the locks hold on this machine only, with
  `memory` in this process only. That is right for a single scheduler — also a production with one instance — so
  `schedule:work` and `schedule:run` start, in every environment, and warn; `schedule:list` shows the same warning:

  ```text
  onOneServer()/withoutOverlapping() lock in CACHE_DRIVER=file: locks only hold on this machine. With more than one
  scheduler instance (more servers), use CACHE_DRIVER=database (bespoke make:cache-table) or redis. Tasks: auth:prune-tokens, session:prune
  ```

  Two `schedule:work` on one machine share a `file` cache: an `onOneServer()` task still runs once a minute. With `memory`
  each process has its own locks — a second one runs everything again. Only a missing cache stops the start (`ScheduleError`).
- **Missed runs (`catchUp('once' | 'skip')`, default `once`):** a scheduler that was down (a deploy, a sleeping machine)
  runs a task it missed **once** when it is back — however often it was due meanwhile (at most 7 days back). The last tick
  is kept in the cache.
- **`s.job()`** queues with `unique` until a worker starts the job: workers that are behind or down find one waiting job,
  not one per tick.
- **Every run is a boundary** like a request or a job: outside any transaction (E107), in a container scope of its own,
  with `{ task }` in its log entries. Runs never wait for each other; a failing run is logged, the others go on.

## Events (E127)

Every run says what became of it through the app's `EventDispatcher` — like Laravel's `ScheduledTask*` events; tests see
them in `app.events`:

| Event | When | Fields (besides `task`, `minute`, `reason`) |
|---|---|---|
| `ScheduledTaskStarting` | it passed its filters and locks and starts | — |
| `ScheduledTaskFinished` | it ran to its end | `ms` |
| `ScheduledTaskFailed` | it threw (or its command exited ≠ 0) — once per failed run | `error`, `ms` |
| `ScheduledTaskSkipped` | it was due and did not run | `skipped`: `filter`, `other-server`, `overlapping`, `job-waiting` (after `Starting`) |

`reason` is why it ran: `due`, `catch-up` or `test` (`schedule:test`). Listen to one (`listen(ScheduledTaskFailed,
AlertOnFailedTask)` — the web app raises an alert) or to all of them (`listen(ScheduledTaskEvent, …)`). They are not
queueable: listeners run in the scheduler's process; a listener's error is logged as a warning and changes nothing about
the run. Tools (devtools, OpenTelemetry) use the `schedule.task` channel of `@bespokecore/core/diagnostics` instead (E118):
one traced message per run with `task`, `minute`, `reason`, `outcome`, `skipped` and `durationMs`.

## Testing

Testing (`@bespokecore/testing`, with the test clock): `app.schedule.due(time)` — the tasks due then;
`await app.schedule.run(time)` — moves the clock there and runs them (catching up what was missed since the last `run`);
`app.schedule.runTask(name)`.

Prune commands of the framework to schedule: `auth:prune-tokens`, `session:prune`, `cache:prune`, `queue:prune-failed`,
`notifications:prune`, `uploads:prune` — each one statement (or one guarded step per entry), its time from the app's `Clock`.

## Production

In production run **one `schedule:work` per server** under a supervisor (or `schedule:run` from cron every minute), next to the
web processes and `queue:work`; `onOneServer()` tasks then run once across them. `bespoke dev` starts it with the server when a
module has a schedule (E101).
