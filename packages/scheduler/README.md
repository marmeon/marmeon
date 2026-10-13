# @marmeon/scheduler

Scheduled tasks for Marmeon apps: commands, jobs and classes on a schedule, written in the modules and run by `schedule:work` or
from cron, with locks against overlapping runs.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

## A schedule

```ts title="modules/system/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('session:prune').everyFifteenMinutes().withoutOverlapping().onOneServer();
  s.command('cache:prune').hourlyAt(25).withoutOverlapping().onOneServer();
  s.command('queue:prune-failed', ['--hours=168']).daily().at('03:20').timezone('Europe/Berlin').onOneServer();
});
```

The module lists it as `schedule` in its definition. `marmeon dev` runs the scheduler; in production it is
`marmeon schedule:work`. With more than one scheduler, `onOneServer()` and `withoutOverlapping()` need a cache they share:
`database` or `redis`.

## Documentation

- [Task Scheduling](https://marmeon.com/docs/scheduling)
- [Task Scheduling: running the scheduler](https://marmeon.com/docs/scheduling#running-the-scheduler)
- [Task Scheduling: the cache they need](https://marmeon.com/docs/scheduling#the-cache-they-need)
- [Fakes: the schedule](https://marmeon.com/docs/fakes#the-schedule)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
