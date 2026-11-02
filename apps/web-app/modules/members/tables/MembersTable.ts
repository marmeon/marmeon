import type { Authenticated } from '@marmeon/auth';
import { Clock } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { rules as r } from '@marmeon/validation';
import { action, bulk, column, defineTable, exportCsv, filter, type DataTableRow, type TableContext } from '@marmeon/table';
import { RecordMembersExport } from '../actions/RecordMembersExport.ts';
import { RemoveMemberLinks } from '../actions/RemoveMemberLinks.ts';
import { RemoveMembersLinks } from '../actions/RemoveMembersLinks.ts';
import { SetMembersLocale } from '../actions/SetMembersLocale.ts';
import { MemberPolicy } from '../policies/MemberPolicy.ts';

/**
 * The members: everyone with a confirmed address — an unconfirmed account is no member yet, and with private registration
 * its address must not show anywhere. Every page, action, bulk action ("all matching" too) and export starts from this query.
 * The e-mail column exists for administrators only: for everyone else it is not selected, not in the props, not in the export (which names it, and the visibility still decides).
 */
export const MembersTable = defineTable({
  name: 'members',
  // `resolve` is the request's, as in the checks: the app's clock says now, so a test that travels in time moves the table.
  query: (db, _ctx: TableContext<Authenticated>, resolve) =>
    db.selectFrom('users').withCount('profile_links', { as: 'links' }).where('users.email_verified_at', '<=', new Date(resolve(Clock).now()).toISOString()),
  key: 'users.id',
  columns: {
    // Headings in the request's language, in the props and in the export.
    name: column('users.name').label((t) => t('members.column.name')).sortable().searchable(),
    email: column('users.email').label((t) => t('members.column.email')).visible(MemberPolicy, 'viewEmails').sortable().searchable(),
    joined: column('users.created_at').label((t) => t('members.column.joined')).sortable(),
    links: column('links').label((t) => t('members.column.links')).sortable(),
    // Only for the files: the page has no language column (it filters by it), the spreadsheet wants one.
    locale: column('users.locale').label((t) => t('members.column.locale')).exportOnly(),
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
  // A German spreadsheet reads a semicolon as the column break (its decimal sign is the comma). The file is named after the app's
  // day and the request's language (Mitglieder-2026-11-18.csv): the framework cleans the name and adds .csv. The file chooses its
  // columns: the links count is for the page, the language for the file.
  export: { csv: exportCsv().authorize(MemberPolicy, 'export').columns(['name', 'email', 'joined', 'locale']).filename((_ctx, resolve, translator) => `${translator?.text('members.export_file') ?? 'members'}-${new Date(resolve(Clock).now()).toISOString().slice(0, 10)}`).delimiter((_ctx, _resolve, translator) => (translator?.locale === 'de' ? ';' : ',')).onExport(RecordMembersExport) },
});

/** A row of the table as actions and policies get it: the key and the visible columns. */
export type MemberRow = DataTableRow<typeof MembersTable>;
