import { authenticate, verified } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { ConfirmMemberImportController, ImportMembersController } from './controllers/ImportMembersController.ts';
import { ListMembersController } from './controllers/ListMembersController.ts';
import { MembersTable } from './tables/MembersTable.ts';

export default defineRoutes((Route) => {
  // A confirmed address first (private registration) — for the page and, on the same registrar, for the table's endpoints.
  const members = Route.prefix('/members').middleware(authenticate()).middleware(verified()).name('members.');
  // Decided for the page and the table's endpoints only: every confirmed account may read the member list. The table's action, bulk
  // and export endpoints act on rows by key; they are safe because MembersTable authorizes each with MemberPolicy. A route you add
  // needs its own decision.
  const readers = members.authorize(everyone);
  // The table's actions, bulk actions and CSV export (POST /members/_tables/members/…, GET …/export/csv) hang on the page that shows
  // them: the same middleware and checks as the page — a guest or an unconfirmed account never reaches them. CSRF as for every POST of
  // the `web` group. Throttled (60 a minute per user, MembersServiceProvider), the export further (ten a minute): it reads the whole
  // filtered table.
  const endpoints = () => MembersTable.endpoints({ middleware: [throttle('members-table')], export: { middleware: [throttle('members-export')] } });
  readers.get('/', ListMembersController).name('index').attach(endpoints());
  // The same table on a second page: its endpoints hang under this page's own path too (/members/directory/_tables/members/…),
  // and each page's props link its own.
  readers.get('/directory', ListMembersController).name('directory').attach(endpoints());
  // The file import: uploaded ahead, this route hands out the upload target for its `file` field, and its request authorizes
  // (administrators only, MemberPolicy) — which is why it is on `members`, not `readers`. Throttled like the table's endpoints.
  members.middleware(throttle('members-table')).post('/import', ImportMembersController).name('import');
  // The second step: confirms the file the first one kept (its id in the path; only this session's, under this flow's scope, finds it).
  members.middleware(throttle('members-table')).post('/import/:import', ConfirmMemberImportController).name('import.confirm');
});
