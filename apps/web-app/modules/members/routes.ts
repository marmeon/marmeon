import { authenticate, verified } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { tableRoutes } from '@marmeon/table';
import { ImportMembersController } from './controllers/ImportMembersController.ts';
import { ListMembersController } from './controllers/ListMembersController.ts';
import { MembersTable } from './tables/MembersTable.ts';

export default defineRoutes((Route) => {
  // A confirmed address first (private registration) — for the page and, on the same registrar, for the table's endpoints.
  const members = Route.prefix('/members').middleware(authenticate()).middleware(verified()).name('members.');
  // Decided for the page and the table's endpoints only: every confirmed account may read the member list. The table's action, bulk
  // and export endpoints act on rows by key; they are safe because MembersTable authorizes each with MemberPolicy. A route you add
  // needs its own decision.
  const readers = members.authorize(everyone);
  readers.get('/', ListMembersController).name('index');
  // The table's actions, bulk actions and CSV export (POST /members/_tables/members/…, GET …/export/csv): the same middleware as
  // the page — a guest or an unconfirmed account never reaches them. CSRF as for every POST of the `web` group. Throttled (60 a minute
  // per user, MembersServiceProvider): an export reads the whole filtered table.
  // The file import: uploaded ahead, this route hands out the upload target for its `file` field, and its request authorizes
  // (administrators only, MemberPolicy) — which is why it is on `members`, not `readers`. Throttled like the table's endpoints.
  members.middleware(throttle('members-table')).post('/import', ImportMembersController).name('import');
  tableRoutes(readers.middleware(throttle('members-table')), MembersTable);
});
