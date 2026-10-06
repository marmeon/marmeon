import { Login, Registered } from '@bespokecore/auth';
import { defineModule, listen } from '@bespokecore/core';
import { RebuildMemberStatsJob } from './jobs/RebuildMemberStatsJob.ts';
import { RecordLastLogin } from './listeners/RecordLastLogin.ts';
import { RefreshMemberStats } from './listeners/RefreshMemberStats.ts';
import { DemoLinksSeeder } from './seeders/DemoLinksSeeder.ts';
import apiRoutes from './api-routes.ts';
import routes from './routes.ts';
import { UserProfileServiceProvider } from './UserProfileServiceProvider.ts';
import { ProfileConfig } from './config.ts';
import { schedule } from './schedule.ts';

// Public API of the module — the dashboard's islands read through it.
export { MemberStats, type MemberNumbers } from './MemberStats.ts';
export { ProfileActivity, type ActivityEntry } from './ProfileActivity.ts';
export { ProfileDirectory } from './ProfileDirectory.ts';
export { ProfileLinkRepository } from './ProfileLinkRepository.ts';
export { ProfilePolicy } from './policies/ProfilePolicy.ts';
export { profileChannel, SIGN_INS_CHANNEL } from './live.ts';

export default defineModule({
  name: 'user-profile',
  providers: [UserProfileServiceProvider],
  config: [ProfileConfig],
  listeners: [listen(Login, RecordLastLogin), listen(Registered, RefreshMemberStats)],
  // The dashboard's member numbers, rebuilt in the background after a registration (unique, withoutOverlapping).
  jobs: [RebuildMemberStatsJob],
  migrations: new URL('./migrations/', import.meta.url),
  seeders: [DemoLinksSeeder],
  routes,
  apiRoutes,
  // The member numbers, also rebuilt hourly (a queued job — bespoke schedule:work queues it, a worker runs it).
  schedule,
});
