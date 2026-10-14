import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ShowDashboardController } from './controllers/ShowDashboardController.ts';
import { ShowMemberStatsController } from './controllers/ShowMemberStatsController.ts';
import { ShowMyActivityController } from './controllers/ShowMyActivityController.ts';
import { ShowRecentSignInsController } from './controllers/ShowRecentSignInsController.ts';

export default defineRoutes((Route) => {
  // A confirmed address first (private registration): an unconfirmed account sees the verification notice instead.
  const dashboard = Route.prefix('/dashboard').middleware(authenticate()).middleware(verified()).name('dashboard.');
  // Decided for the page and the two islands below only: they show the signed-in user's own view, or what every confirmed account
  // may see (who signed in lately: names and times). A route you add needs its own decision.
  const open = dashboard.authorize(everyone);
  open.get('/', ShowDashboardController).name('show');

  // Islands: GET routes of their own, each with its own middleware, authorization and query — embedded with
  // `<Island route>`, never visited (a direct hit is a 404), read-only.
  open.get('/islands/sign-ins', ShowRecentSignInsController).name('sign-ins');
  open.get('/islands/activity', ShowMyActivityController).name('activity');
  // Decided by its own request (DashboardPolicy). Not an administrator → 403, its `unauthorized` fallback (an unverified account never gets this far: the page asks first).
  dashboard.get('/islands/members', ShowMemberStatsController).name('members');
});
