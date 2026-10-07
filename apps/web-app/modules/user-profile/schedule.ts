import { defineSchedule } from '@marmeon/scheduler';
import { RebuildMemberStatsJob } from './jobs/RebuildMemberStatsJob.ts';
import { PruneDataExports } from './tasks/PruneDataExports.ts';

// The dashboard's member numbers are rebuilt after every registration — and hourly, for what changes without one (a
// confirmed address, a deleted account). Queued, not run here: while one still waits for a worker, no second one (E88).
export const schedule = defineSchedule((s) => {
  s.job(RebuildMemberStatsJob).hourly();
  // "Download my data" files (the private disk): gone once their five-minute link has expired (W6.9 — W6.8 kept them forever).
  s.call(PruneDataExports).everyTenMinutes().withoutOverlapping().onOneServer().name('user-profile.prune-data-exports');
});
