import { authenticate, verified } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { tableRoutes } from '@marmeon/table';
import { ListMembersController } from './controllers/ListMembersController.ts';
import { MembersTable } from './tables/MembersTable.ts';

export default defineRoutes((Route) => {
  // A confirmed address first (private registration) — for the page and, on the same registrar, for the table's endpoints.
  const members = Route.prefix('/members').middleware(authenticate()).middleware(verified()).name('members.');
  // Decided for the page and the table's endpoints only: every confirmed account may read the member list, and none of these routes
  // binds a record. A route you add needs its own decision.
  const readers = members.authorize(everyone);
  readers.get('/', ListMembersController).name('index');
  // The table's actions, bulk actions and CSV export (POST /members/_tables/members/…, GET …/export/csv): the same middleware as
  // the page — a guest or an unconfirmed account never reaches them. CSRF as for every POST of the `web` group. Throttled (60 a minute
  // per user, MembersServiceProvider): an export reads the whole filtered table.
  tableRoutes(readers.middleware(throttle('members-table')), MembersTable);
});
