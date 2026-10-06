import { authenticate, verified } from '@bespokecore/auth';
import { defineRoutes } from '@bespokecore/http';
import { tableRoutes } from '@bespokecore/table';
import { ListMembersController } from './controllers/ListMembersController.ts';
import { MembersTable } from './tables/MembersTable.ts';

export default defineRoutes((Route) => {
  // A confirmed address first (private registration, E146) — for the page and, on the same registrar, for the table's endpoints.
  const members = Route.prefix('/members').middleware(authenticate()).middleware(verified()).name('members.');
  members.get('/', ListMembersController).name('index');
  // The table's actions, bulk actions and CSV export (POST /members/_tables/members/…, GET …/export/csv): the same middleware as
  // the page — a guest or an unconfirmed account never reaches them. CSRF as for every POST of the `web` group.
  tableRoutes(members, MembersTable);
});
