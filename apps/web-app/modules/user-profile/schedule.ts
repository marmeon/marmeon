import { defineSchedule } from '@bespokecore/scheduler';
import { RebuildMemberStatsJob } from './jobs/RebuildMemberStatsJob.ts';

// The dashboard's member numbers are rebuilt after every registration — and hourly, for what changes without one (a
// confirmed address, a deleted account). Queued, not run here: while one still waits for a worker, no second one (E88).
export const schedule = defineSchedule((s) => {
  s.job(RebuildMemberStatsJob).hourly();
});
