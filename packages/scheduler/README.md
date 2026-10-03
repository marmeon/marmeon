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
  cache all servers share — `CACHE_DRIVER=database` or `redis`; with `file` or `memory`, `schedule:work`/`schedule:run`
  refuse to start.
- **`withoutOverlapping(minutes = 1440)`:** a run is skipped while the previous one still runs (on any server). A
  scheduler that stops before its runs end frees their locks.
- **Missed runs (`catchUp('once' | 'skip')`, default `once`):** a scheduler that was down (a deploy, a sleeping machine)
  runs a task it missed **once** when it is back — however often it was due meanwhile (at most 7 days back). The last tick
  is kept in the cache.
- **`s.job()`** queues with `unique` until a worker starts the job: workers that are behind or down find one waiting job,
  not one per tick.
- **Every run is a boundary** like a request or a job: outside any transaction (E107), in a container scope of its own,
  with `{ task }` in its log entries. Runs never wait for each other; a failing run is logged, the others go on.

Testing (`@bespokecore/testing`, with the test clock): `app.schedule.due(time)` — the tasks due then;
`await app.schedule.run(time)` — moves the clock there and runs them (catching up what was missed since the last `run`);
`app.schedule.runTask(name)`.

Prune commands of the framework to schedule: `auth:prune-tokens`, `session:prune`, `cache:prune`, `queue:prune-failed`.
