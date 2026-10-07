import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ShowDashboardController } from './controllers/ShowDashboardController.ts';
import { ShowMemberStatsController } from './controllers/ShowMemberStatsController.ts';
import { ShowMyActivityController } from './controllers/ShowMyActivityController.ts';
import { ShowRecentSignInsController } from './controllers/ShowRecentSignInsController.ts';

export default defineRoutes((Route) => {
  // A confirmed address first (private registration, E146): an unconfirmed account sees the verification notice instead.
  const dashboard = Route.prefix('/dashboard').middleware(authenticate()).middleware(verified()).name('dashboard.');
  dashboard.get('/', ShowDashboardController).name('show');

  // Islands (E48): GET routes of their own, each with its own middleware, authorization and query — embedded with
  // `<Island route>`, never visited (a direct hit is a 404), read-only (E52).
  dashboard.get('/islands/sign-ins', ShowRecentSignInsController).name('sign-ins');
  dashboard.get('/islands/activity', ShowMyActivityController).name('activity');
  // Not an administrator → 403, its `unauthorized` fallback (an unverified account never gets this far: the page asks first).
  dashboard.get('/islands/members', ShowMemberStatsController).name('members');
});
