/**
 * Type guarantees of a table's query on its module's `Database` — checked by `tsc` (`pnpm typecheck`), never run.
 */
import type { Authenticated } from '@marmeon/auth';
import type { Database } from '@marmeon/database';
import { column, defineTable, type DataTableRow, type TableContext } from '@marmeon/table';

const Verified = defineTable({
  name: 'verified',
  query: (db: Database<'members'>, _ctx: TableContext<Authenticated>) => db.selectFrom('users').where('users.email_verified_at', 'is not', null),
  key: 'users.id',
  columns: { name: column('users.name') },
}); // fine — `users` is exposed by the auth module
export type VerifiedRow = DataTableRow<typeof Verified>;
export const row: VerifiedRow = { id: 1, name: 'Ada' };

defineTable({
  name: 'linked',
  // @ts-expect-error — `profile_links` belongs to user-profile and is not exposed: why MembersTable's `db` stays unannotated
  query: (db: Database<'members'>, _ctx: TableContext<Authenticated>) => db.selectFrom('users').withCount('profile_links', { as: 'links' }),
  key: 'users.id',
  columns: { name: column('users.name') },
});
