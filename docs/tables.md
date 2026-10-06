# Tables

A list that people sort, filter, page through, tick rows in and act on — and download. Hand-written, such a table is where the
classic leaks live: a hidden column that still travels in the props, a sort parameter that goes into `ORDER BY`, a bulk action that
takes another tenant's IDs, a cell that a spreadsheet runs as a formula. [@bespokecore/table](../packages/table/README.md) handles
them once (E183): **one definition** per table on the server, the URL as its state, parsed strictly, and endpoints that check
everything again. The browser half is headless — `useTable` gives a component what the props allow and renders nothing itself.

This guide builds the members table of the web app (`apps/web-app/modules/members`) step by step, then goes through the security
model attack by attack, and ends with the markup. The package's README is the reference for every option.

## 1. The definition

```ts
// modules/members/tables/MembersTable.ts
import type { Authenticated } from '@bespokecore/auth';
import { sql } from '@bespokecore/database';
import { action, bulk, column, defineTable, exportCsv, filter, type TableContext } from '@bespokecore/table';

export const MembersTable = defineTable({
  name: 'members',
  // The base query: every row this table may ever show in this request. Pages, actions, bulk actions and exports all start here.
  query: (db, _ctx: TableContext<Authenticated>) =>
    db
      .selectFrom('users')
      .leftJoin(
        (eb) => eb.selectFrom('profile_links').select(['profile_links.user_id', sql<number>`cast(count(*) as integer)`.as('links')]).groupBy('profile_links.user_id').as('link_counts'),
        (join) => join.onRef('link_counts.user_id', '=', 'users.id'),
      )
      .where('users.email_verified_at', 'is not', null),
  key: 'users.id',
  columns: {
    name: column('users.name').sortable().searchable(),
    email: column('users.email').visible(MemberPolicy, 'viewEmails').sortable().searchable(),   // administrators only
    joined: column('users.created_at').sortable(),                                            // the alias `joined`, never created_at
    links: column('link_counts.links').sortable(),
  },
  filters: { joined: filter.dateRange('users.created_at'), locale: filter.select('users.locale', ['en', 'de']) },
  defaultSort: 'name',
  pagination: { perPage: [10, 25, 50] },
  actions: { removeLinks: action(RemoveMemberLinks).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'removeLinks').confirm() },
  bulk: { removeLinks: bulk(RemoveMembersLinks).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'removeLinks').confirm().max(100) },
  export: { csv: exportCsv().authorize(MemberPolicy, 'export') },
});
```

- **The base query selects nothing** — the table selects the visible columns and the key itself. A tenant belongs into it
  (`.where('users.team_id', '=', ctx.user.team_id)`): it is the boundary every endpoint starts from.
- **Columns have aliases** — their key in `columns`. The URL, the props and the export use the alias only; a column of the query
  that is no column of the table cannot be sorted, filtered or seen. A secret column of a migration (`.secret()`) cannot be a
  column at all — that is a compile error, as is a typo, a sort that is not sortable or an ability the policy does not have
  ([type checks](../packages/table/README.md#type-checks)).
- **`.visible(Policy, 'ability')`** is asked once per request (no row); **`.authorize(Policy, 'ability')`** of an action is asked
  per row. The web app's `MemberPolicy` lets administrators see addresses, moderate and export, and nobody remove their own links.
- **The key's type** is part of the definition: `key: 'users.id'` is an integer; a text key says how to read it
  (`key: { column: 'users.uuid', type: 'uuid' }` — `string`, `uuid`, `bigint`).

## 2. The controller and the routes

```ts
// modules/members/controllers/ListMembersController.ts
export const ListMembersRequest = defineRequest({ query: MembersTable.query });   // the table's state — strict: 400 for what it does not offer

export class ListMembersController extends Controller {
  static request = ListMembersRequest;
  readonly #tables: Tables;
  constructor(tables: Tables) { super(); this.#tables = tables; }

  handle(ctx: ContextOf<typeof ListMembersRequest> & Authenticated) {
    return this.view('members/Index', { members: () => this.#tables.resolve(MembersTable, ctx) });   // TableProps<typeof MembersTable>
  }
}

// modules/members/routes.ts
export default defineRoutes((Route) => {
  const members = Route.prefix('/members').middleware(authenticate()).middleware(verified()).name('members.');
  members.get('/', ListMembersController).name('index');
  tableRoutes(members.middleware(throttle('members-table')), MembersTable);   // POST …/_tables/members/actions/:tableAction, …/bulk/…, GET …/export/…
});
```

`tableRoutes` registers the table's endpoints **on the registrar you pass** — the page's, with its middleware, its route bindings
and its group (session, CSRF). A registrar that lacks what the base query needs (`ctx.user` without `authenticate()`) is a
compile error. The limiter (`members-table`: 60 a minute per user in the web app's `MembersServiceProvider`) is there because an
export reads the whole filtered table.

## 3. The page

```tsx
// modules/members/views/Index.tsx (shortened)
import { useTable } from '@bespokecore/react/table';

export default function Index({ members }: PageProps<ListMembersController>) {
  const t = useTranslation('members');
  const table = useTable(members, {
    labels: { column: (name) => t(`column.${name}`), row: (row) => row.name, select: (name) => t('select', { name }) },
  });
  return (
    <>
      <p {...table.statusProps}>{table.status}</p>
      <table>
        <caption>{t('caption')}</caption>
        <thead>
          <tr>
            <th scope="col"><input {...table.pageCheckboxProps()} /></th>
            {table.columns.map((column) => (
              <th key={column.name} {...column.headerProps}>
                {column.sortLinkProps ? <a {...column.sortLinkProps}>{column.label}</a> : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.id}>
              <td><input {...table.checkboxProps(row)} /></td>
              <th scope="row">{row.name}</th>
              …
            </tr>
          ))}
        </tbody>
      </table>
      {table.page.type === 'offset' && <Pagination meta={table.page} />}
      {members.exports.length > 0 && <a href={table.exportUrl('csv')} download>{t('export')}</a>}
    </>
  );
}
```

- **Sorting, filtering, searching, paging** (`table.sort('joined')`, `filter`, `filterBy`, `setSearch`, `goTo`, `perPage`, `next`)
  are visits of the page's URL with the props' keys and the columns' aliases — only the table's prop reloads. Asking for something
  the props do not offer throws before a request leaves (`[bespoke:C9]`–`[C12]`). Sort links are real links: without JavaScript,
  or in a new tab, they work.
- **The selection** lives with the history entry — in memory, never in `history.state` or storage: a new sort, filter or page
  starts with nothing selected, Back brings the old one back, and leaving the document (signing out, a new build) forgets it.
- **Actions** (`table.run('removeLinks', row)`, `table.runBulk('removeLinks')`) are action requests; afterwards the table's prop
  reloads and **replaces** what the page had — also a table that is `merge()`d ([lists](lists.md#revalidations-replace-load-more-appends)).
  Their code is a chunk of its own, loaded with the first run.
- **`table.exportUrl('csv')`** is a link to the download with the table's current state.

The web app's page works without JavaScript too: sort links are links, filters a GET form, row and bulk actions plain forms that
come back with a 303.

## The security model

Every endpoint starts again at the beginning — nothing the browser sends is trusted, whatever the page showed.

| Attack | What stops it |
| --- | --- |
| **A hidden column read anyway** — in the props, the devtools' query log, a cursor or the CSV | Two measures, each tested on its own: the **projection** (only visible columns and the key are selected — the column is not in the SQL) and the **props filter** (only visible columns are picked by name, even when the base query selects more). |
| **Sorting by a column you may not see** — the order alone tells its values (a sort by a password hash is an oracle) | The **allowlist**: a sort, filter, search or page size the definition does not offer — a raw column name (`?sort=password`, `?sort=created_at` instead of `joined`), `?filter[password]=x`, `?per_page=10000` — is a **400**, never a fallback. Sorting, filtering or searching by a column the user cannot see is a 400 too; the search looks into visible columns only. Nothing from the URL reaches `ORDER BY` or `WHERE` that the definition did not name. |
| **Another tenant's rows** | The **base query** is the boundary: a row action looks its row up in it (another tenant's, a deleted or a made-up key: 404), a bulk action intersects with it, an export reads from it. |
| **An endpoint without the page's protection** | `tableRoutes` **inherits the page registrar's middleware**: a guest, an unconfirmed account, a tenant the binding refuses never reach it — and a registrar without what the base query needs does not compile. The endpoints do not run the page controller's `authorize`: a table that needs one says so (`authorize: can(MemberPolicy, 'viewAny')`). |
| **Bulk IDOR** — keys of rows you may not touch in the request body | A bulk action acts on **keys ∩ base query ∩ policy per row**: keys that are no row of the table are left out and counted (`missing`), rows the policy refuses too (`skipped`) — the handler gets only the rest. |
| **"All matching" as a huge or forged list** | "All matching" sends the table's **state**, never keys (`{ all: true, query }`): the server parses it again, as strictly as the URL, and refuses more rows than the action's `max` (default 1000) with a **422** — it never acts on a cut-off list. |
| **CSV injection** — a cell a spreadsheet runs (`=HYPERLINK(…)`, `+cmd`, `@SUM(…)`) | **OWASP escaping:** a text cell that starts with `=`, `+`, `-`, `@`, a tab, CR or LF gets a `'` in front; every field is quoted, quotes doubled; numbers stay numbers. |
| **An export as a denial of service** | `exportCsv().max(rows)` (default **10 000**): one `count(*)` first, over it a **422** before a byte is streamed (never a file cut short); **throttle** the table's routes. The export has its own `authorize` and exports only visible columns, `no-store`, `attachment`, `nosniff`. |
| **A key of the wrong type** — text at an integer column (a 500 on Postgres), a guessed query | **Key types:** every key from the browser is parsed by the declared type before any query; one that does not parse is no row (404, or `missing`). |
| **An export that writes with a transaction long gone** | The **export runs outside the transaction**: the first batch of 500 in the handler, the later ones after the answer — in the request's context (logs, request id) and **outside** any transaction open around the handler (`outsideTransaction`, E107). |

Policies that decide per row see the row as the table hands it out — the key and the visible columns. One that needs more looks it
up by the key, or the column becomes part of the table.

**Testing:** `app.actingAs(user).acting().post(url, { json: { key } })` runs an action as the browser would;
`app.actingAs(user).get(exportUrl)` downloads the CSV. Under the test isolation (one pinned connection per test) an export's later
batches have no connection outside the test's transaction — keep exports in app tests under 500 rows (the package's own tests stream
1 203).

## Accessible markup

`useTable` hands out the attributes; the markup is yours. The rules, after the WAI-ARIA Authoring Practices for sortable tables
([accessible markup](../packages/table/README.md#accessible-markup)):

- a native `<table>` with a `<caption>` that names it — no `role="grid"` without real cell navigation;
- `aria-sort` **only** on the heading the table is sorted by (`headerProps`), never `none` on the others;
- the sort control is a link or button **inside** the `<th>` (`sortLinkProps`), named after its column;
- the row's header is a `<th scope="row">` (the member's name);
- the count — with the sort and the page — in a live region (`statusProps` + `status`); what an action did in a second one;
- checkboxes and row buttons named after their row, the name **starting with the visible text** ("Remove links: Ada Lovelace",
  WCAG 2.5.3) — `checkboxProps`, `pageCheckboxProps` (indeterminate), `actionLabel`;
- focus never dropped: a control that cannot run right now stays focusable (`aria-disabled`, its click does nothing) instead of
  `disabled` — a confirmation dialog gives focus back to the button that opened it.

## TanStack Table

An app that wants TanStack's header and cell model, column sizing or pinning keeps the server in charge:

```tsx
import { rowPaginationFeature, rowSelectionFeature, rowSortingFeature, tableFeatures, useTable as useTanStackTable } from '@tanstack/react-table';
import { useTable } from '@bespokecore/react/table';
import { toTanStack } from '@bespokecore/react/table-tanstack';

const features = tableFeatures({ rowSortingFeature, rowPaginationFeature, rowSelectionFeature });   // module scope: stable

const table = useTable(props.members);
const tanstack = useTanStackTable(toTanStack(table, { features }));
```

TanStack runs in manual mode — it sees one page and sorts nothing itself; its sorting, pagination and row selection go back
through `useTable` (a visit, the entry's selection). `@tanstack/react-table` is an optional peer, and the bridge imports only its
types: TanStack is in a bundle only where the app imports it. Put the sort toggle into a button inside the `<th>`, as above.

## Size

`useTable` and its controller are in the page's chunk only (≈ 3.3 KB gzip over an empty app, the budget's `table` scenario); the
action code loads with the first run. Nothing of it is in an app's first download unless a page there uses it.
