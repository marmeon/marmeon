// Type guarantees of the scheduler (W6 step 6, E88) — compiled by `pnpm typecheck` / `bespoke build`, never run.
import { PruneTokensCommand } from '@bespokecore/auth';
import { defineSchedule } from '@bespokecore/scheduler';
import type { TestApp } from '@bespokecore/testing';
import { RebuildMemberStatsJob } from '../user-profile/jobs/RebuildMemberStatsJob.ts';
import { SendWelcomeMailJob } from './jobs/SendWelcomeMailJob.ts';

export const Fine = defineSchedule((s) => {
  s.job(SendWelcomeMailJob, { userId: 7 }).daily().at('03:10').timezone('Europe/Berlin').onOneServer();
  s.job(RebuildMemberStatsJob).hourly(); // an empty schema: no payload needed
  s.command('auth:prune-tokens').weeklyOn('monday', '9:30').withoutOverlapping(30).catchUp('skip');
  s.command(PruneTokensCommand, ['--hours=24']).cron('*/5 9-17 * * mon-fri').environments('production');
  s.command('session:prune').everyFifteenMinutes().weekdays().when(() => true).skip(async () => false);
});

export const Payloads = defineSchedule((s) => {
  // @ts-expect-error — the payload comes from the job's static schema: userId is a number
  s.job(SendWelcomeMailJob, { userId: 'x' }).daily();
  // @ts-expect-error — and it is required
  s.job(SendWelcomeMailJob).daily();
});

export const Times = defineSchedule((s) => {
  // @ts-expect-error — hours are 0–23
  s.command('auth:prune-tokens').daily().at('25:00');
  // @ts-expect-error — minutes are two digits, 00–59
  s.command('auth:prune-tokens').daily().at('3:7');
  // @ts-expect-error — in dailyAt() as well
  s.command('auth:prune-tokens').dailyAt('noon');
  // @ts-expect-error — a day of the week is 0–6 or its name
  s.command('auth:prune-tokens').weeklyOn('someday');
  const fromConfig: string = process.env.PRUNE_AT ?? '03:10';
  s.command('auth:prune-tokens').daily().at(fromConfig); // a string from elsewhere: checked when the schedule is read
});

export const Order = defineSchedule((s) => {
  // @ts-expect-error — onOneServer() needs a frequency first: .daily().onOneServer()
  s.command('auth:prune-tokens').onOneServer().daily();
  // @ts-expect-error — at() needs a frequency first
  s.command('auth:prune-tokens').at('03:10');
  // @ts-expect-error — s.job() only queues: it never overlaps (that is middleware on the job)
  s.job(RebuildMemberStatsJob).everyMinute().withoutOverlapping();
  // @ts-expect-error — 'once' or 'skip'
  s.command('auth:prune-tokens').hourly().catchUp('always');
});

export async function Testing(app: TestApp) {
  const due: string[] = app.schedule.due('2026-10-05T03:10:00+02:00');
  const [result] = await app.schedule.run(new Date('2026-10-05T01:10:00Z'));
  // @ts-expect-error — an outcome is 'ran', 'skipped' or 'failed'
  if (result?.outcome === 'queued') return due;
  return result?.skipped;
}
