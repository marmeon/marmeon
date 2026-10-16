import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CacheServiceProvider } from '@marmeon/cache';
import { CliServiceProvider } from 'marmeon';
import { Clock, defineApplication, defineModule, type Container, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { RedisServiceProvider } from '@marmeon/redis';
import { defineSchedule, SchedulerServiceProvider } from '../../../index.ts';
import { RecordRun } from '../tasks.ts';

// A minimal app for the scheduler processes of `processes.test.ts`: `marmeon schedule:work` and `schedule:run` run in it
// for real. Database and cache come from the environment (DB_*, CACHE_DRIVER, REDIS_*), the tasks from FIXTURE_*:
// - FIXTURE_ONE_SERVER=1: the task `record` (every minute) runs on one server only;
// - FIXTURE_MISSED=<minute of the hour>: a task `missed`, due at that minute of every hour;
// - FIXTURE_CLOCK_AT=<ms>: the app's clock reads exactly that at its first read and runs on in real time — so a test can
//   place a minute boundary (or ten minutes of downtime) where it needs them, with the real command and the real timers;
// - FIXTURE_CLOCK_GATE=<path>: the first read waits until that file exists and holds the real instant (ms) at which the
//   clock reads `at`. Two schedulers must reach the same app minute at the same real moment for the cross-process
//   `cache.lock` race to happen at all — whatever their boot time, which a timer set in advance cannot promise.
const at = process.env.FIXTURE_CLOCK_AT === undefined ? undefined : Number(process.env.FIXTURE_CLOCK_AT);
const gate = process.env.FIXTURE_CLOCK_GATE;
let offset: number | undefined;

/** Blocks the process (nothing else runs in it meanwhile) until the gate file exists; the instant it holds. */
function awaitGate(path: string): number {
  const sleeping = new Int32Array(new SharedArrayBuffer(4));
  const giveUp = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() > giveUp) throw new Error(`The clock gate ${path} was not opened within 30 s`);
    Atomics.wait(sleeping, 0, 0, 5);
  }
  return Number(readFileSync(path, 'utf8'));
}

/** The definition cannot carry an `override` (test doubles never ship): the fixture's clock is a provider, registered after the core's own. */
class FixtureClock implements ServiceProvider {
  register(container: Container): void {
    container.instance(Clock, {
      now: () => {
        // The first read — the loop of schedule:work right after its "Running…" line, or the tick of schedule:run — is `at` (with FIXTURE_CLOCK_GATE: at the instant the gate file holds).
        if (offset === undefined) offset = at === undefined ? 0 : at - (gate === undefined ? Date.now() : awaitGate(gate));
        return Date.now() + offset;
      },
    });
  }
}

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  discover: false,
  providers: [CliServiceProvider, DatabaseServiceProvider, RedisServiceProvider, CacheServiceProvider, SchedulerServiceProvider, FixtureClock],
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
});
