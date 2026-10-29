import type { Authenticated } from '@marmeon/auth';
import { Connections } from '@marmeon/database';
import { rules as r } from '@marmeon/validation';
import { action, bulk, column, defineTable, exportCsv, filter, type DataTableRow, type TableContext } from '@marmeon/table';
import { RemoveMemberLinks } from '../actions/RemoveMemberLinks.ts';
import { RemoveMembersLinks } from '../actions/RemoveMembersLinks.ts';
import { SetMembersLocale } from '../actions/SetMembersLocale.ts';
import { MemberPolicy } from '../policies/MemberPolicy.ts';

/**
 * The members: everyone with a confirmed address — an unconfirmed account is no member yet, and with private registration
 * its address must not show anywhere. Every page, action, bulk action ("all matching" too) and export starts from this query.
 * The e-mail column exists for administrators only: for everyone else it is not selected, not in the props, not in the export.
 */
export const MembersTable = defineTable({
  name: 'members',
  query: (db, _ctx: TableContext<Authenticated>) =>
    db.selectFrom('users').withCount('profile_links', { as: 'links' }).where('users.email_verified_at', 'is not', null),
  key: 'users.id',
  columns: {
    name: column('users.name').sortable().searchable(),
    email: column('users.email').visible(MemberPolicy, 'viewEmails').sortable().searchable(),
    joined: column('users.created_at').sortable(),
    links: column('links').sortable(),
  },
  filters: {
    joined: filter.dateRange('users.created_at'),
    locale: filter.select('users.locale', ['en', 'de']),
    // Members who link to the same place as the signed-in one: the options are the labels of the viewer's own links, computed for
    // each request — a label of anyone else's is a 400, so the URL cannot probe other members' links.
    link: filter.has(
      'profile_links',
      async (resolve, ctx: TableContext<Authenticated>) => {
        const mine = await resolve(Connections).get().selectFrom('profile_links').select('label').distinct().where('user_id', '=', ctx.user.id).orderBy('label').execute();
        return mine.map((row) => ({ value: row.label, label: row.label }));
      },
      { column: 'label' },
    ),
  },
  defaultSort: 'name',
  pagination: { perPage: [10, 25, 50] },
  actions: { removeLinks: action(RemoveMemberLinks).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'removeLinks').confirm() },
  bulk: {
    removeLinks: bulk(RemoveMembersLinks).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'removeLinks').confirm().max(100),
    // One action for every value: the language comes with the request and is checked before any member is read.
    setLocale: bulk(SetMembersLocale).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'setLocale').input(r.object({ locale: r.in(['en', 'de']) })).max(100),
  },
  export: { csv: exportCsv().authorize(MemberPolicy, 'export') },
});

/** A row of the table as actions and policies get it: the key and the visible columns. */
export type MemberRow = DataTableRow<typeof MembersTable>;
