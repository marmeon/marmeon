import { authenticate, verified } from '@bespokecore/auth';
import { defineRoutes } from '@bespokecore/http';
import { ShowDashboardController } from './controllers/ShowDashboardController.ts';
import { ShowMemberStatsController } from './controllers/ShowMemberStatsController.ts';
import { ShowMyActivityController } from './controllers/ShowMyActivityController.ts';
import { ShowRecentSignInsController } from './controllers/ShowRecentSignInsController.ts';

export default defineRoutes((Route) => {
  const dashboard = Route.prefix('/dashboard').middleware(authenticate()).name('dashboard.');
  dashboard.get('/', ShowDashboardController).name('show');

  // Islands (E48): GET routes of their own, each with its own middleware, authorization and query — embedded with
  // `<Island route>`, never visited (a direct hit is a 404), read-only (E52).
  dashboard.get('/islands/sign-ins', ShowRecentSignInsController).name('sign-ins');
  dashboard.get('/islands/activity', ShowMyActivityController).name('activity');
  // Unverified → its redirect becomes the island's `unauthorized` fallback; not an administrator → 403, the same.
  dashboard.middleware(verified()).get('/islands/members', ShowMemberStatsController).name('members');
});
