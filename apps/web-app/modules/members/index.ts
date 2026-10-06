import { defineModule } from '@bespokecore/core';
import routes from './routes.ts';

// Public API of the module.
export { MembersTable, type MemberRow } from './tables/MembersTable.ts';
export { MemberPolicy } from './policies/MemberPolicy.ts';

/** The members (`/members`): a server-driven table (@bespokecore/table) — columns, actions and the export by policy. */
export default defineModule({
  name: 'members',
  routes,
});
