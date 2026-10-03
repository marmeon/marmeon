import { join } from 'node:path';
import { CacheServiceProvider } from '@bespokecore/cache';
import { CliServiceProvider } from '@bespokecore/cli';
import { Clock, defineApplication, defineModule } from '@bespokecore/core';
import { DatabaseServiceProvider } from '@bespokecore/database';
import { RedisServiceProvider } from '@bespokecore/redis';
import { defineSchedule, SchedulerServiceProvider } from '../../../index.ts';
import { RecordRun } from '../tasks.ts';

// A minimal app for the scheduler processes of `processes.test.ts`: `bespoke schedule:work` and `schedule:run` run in it
// for real. Database and cache come from the environment (DB_*, CACHE_DRIVER, REDIS_*), the tasks from FIXTURE_*:
// - FIXTURE_ONE_SERVER=1: the task `record` (every minute) runs on one server only;
// - FIXTURE_MISSED=<minute of the hour>: a task `missed`, due at that minute of every hour;
// - FIXTURE_CLOCK_OFFSET=<ms>: the app's clock runs that far ahead — so a test can place a minute boundary (or ten
//   minutes of downtime) where it needs them, with the real command and the real timers.
const offset = Number(process.env.FIXTURE_CLOCK_OFFSET ?? 0);

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  discover: false,
  providers: [CliServiceProvider, DatabaseServiceProvider, RedisServiceProvider, CacheServiceProvider, SchedulerServiceProvider],
  modules: [
    defineModule({
      name: 'fixture',
      schedule: defineSchedule((s) => {
        const record = s.call(RecordRun).everyMinute().name('record');
        if (process.env.FIXTURE_ONE_SERVER === '1') record.onOneServer();
        if (process.env.FIXTURE_MISSED !== undefined) s.call(RecordRun).cron(`${process.env.FIXTURE_MISSED} * * * *`).name('missed');
      }),
    }),
  ],
  override: (container) => {
    container.instance(Clock, { now: () => Date.now() + offset });
  },
});
