import type { Authenticated } from '@marmeon/auth';
import { sql } from '@marmeon/database';
import { action, bulk, column, defineTable, exportCsv, filter, type RowOfTable, type TableContext } from '@marmeon/table';
import { RemoveMemberLinks } from '../actions/RemoveMemberLinks.ts';
import { RemoveMembersLinks } from '../actions/RemoveMembersLinks.ts';
import { MemberPolicy } from '../policies/MemberPolicy.ts';

/**
 * The members (E183): everyone with a confirmed address — an unconfirmed account is no member yet, and with private registration
 * (E146) its address must not show anywhere. Every page, action, bulk action ("all matching" too) and export starts from this query.
 * The e-mail column exists for administrators only: for everyone else it is not selected, not in the props, not in the export.
 */
export const MembersTable = defineTable({
  name: 'members',
  query: (db, _ctx: TableContext<Authenticated>) =>
    db
      .selectFrom('users')
      .leftJoin(
        (eb) =>
          eb
            .selectFrom('profile_links')
            .select(['profile_links.user_id', sql<number>`cast(count(*) as integer)`.as('links')])
            .groupBy('profile_links.user_id')
            .as('link_counts'),
        (join) => join.onRef('link_counts.user_id', '=', 'users.id'),
      )
      .where('users.email_verified_at', 'is not', null),
  key: 'users.id',
  columns: {
    name: column('users.name').sortable().searchable(),
    email: column('users.email').visible(MemberPolicy, 'viewEmails').sortable().searchable(),
    joined: column('users.created_at').sortable(),
    links: column('link_counts.links').sortable(),
  },
  filters: {
    joined: filter.dateRange('users.created_at'),
    locale: filter.select('users.locale', ['en', 'de']),
  },
  defaultSort: 'name',
  pagination: { perPage: [10, 25, 50] },
  actions: { removeLinks: action(RemoveMemberLinks).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'removeLinks').confirm() },
  bulk: { removeLinks: bulk(RemoveMembersLinks).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'removeLinks').confirm().max(100) },
  export: { csv: exportCsv().authorize(MemberPolicy, 'export') },
});

/** A row of the table as actions and policies get it: the key and the visible columns. */
export type MemberRow = RowOfTable<typeof MembersTable>;
