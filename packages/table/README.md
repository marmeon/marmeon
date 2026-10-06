# @bespokecore/table

Server-driven tables (E183): **one definition** per table — its base query, its columns with aliases, who may see which column,
filters and sorts by allowlist, row actions, bulk actions and a CSV export. Per request the server decides what the user may see
and sends exactly that as a page prop; sorting, filtering and paging are the page's URL, parsed **strictly** on the server; actions
and exports are endpoints on the page's own routes, which check everything again. The classic leaks of hand-written tables —
hidden columns in the props, raw identifiers in `ORDER BY`, IDs of another tenant in a bulk action, formulas in a CSV — are handled
once, here, instead of in every app.

`bespoke discover` registers its `TableServiceProvider` like any installed package. It builds on
[@bespokecore/database](../database/README.md) (Kysely), [@bespokecore/auth](../auth/README.md) (policies, the `Gate`) and
[@bespokecore/http](../http/README.md). The browser half — the props' types and the UI-free table controller, nothing of the
server — is `@bespokecore/table/client`; the headless React hook (`useTable`) lives in
[@bespokecore/react](../react/README.md#tables) — see [In the browser](#in-the-browser).

```ts
// modules/members/tables/MembersTable.ts
export const MembersTable = defineTable({
  name: 'members',
  // The base query: every row the table may ever show this request — the tenant, the scope. Pages, actions, bulk actions and
  // exports all start from it. It selects nothing: the table selects its visible columns itself.
  query: (db, ctx: TableContext<Authenticated>) => db.selectFrom('users').where('users.team_id', '=', ctx.user.team_id),
  key: 'users.id',
  columns: {
    name: column('users.name').sortable().searchable(),
    email: column('users.email').visible(MemberPolicy, 'viewEmails').sortable(),   // hidden: not selected, not sent, not exported
    joined: column('users.created_at').sortable(),                                  // the alias `joined` in URLs and props, never created_at
  },
  filters: { role: filter.select('users.role', ['admin', 'member']), joined: filter.dateRange('users.created_at') },
  defaultSort: '-joined',                                                           // the key always breaks ties
  pagination: { perPage: [25, 50, 100] },                                           // offset with a total; { cursor: true } for "load more"
  actions: { deactivate: action(DeactivateMember).authorize(MemberPolicy, 'deactivate').confirm() },
  bulk: { deactivate: bulk(DeactivateMembers).authorize(MemberPolicy, 'deactivate').max(1000) },
  export: { csv: exportCsv().authorize(MemberPolicy, 'export') },
});

// modules/members/controllers/ListMembersController.ts
export const ListMembersRequest = defineRequest({ query: MembersTable.query });     // the table's state in the URL — strict (400)

export class ListMembersController extends Controller {
  static request = ListMembersRequest;
  constructor(tables: Tables) { … }
  handle(ctx: ContextOf<typeof ListMembersRequest> & Authenticated) {
    return this.view('members/Index', { members: () => this.#tables.resolve(MembersTable, ctx) });   // TableProps<typeof MembersTable>
  }
}

// modules/members/routes.ts — the endpoints on the page's registrar: the same middleware, bindings and group
const members = Route.prefix('/members').middleware(authenticate()).middleware(verified()).name('members.');
members.get('/', ListMembersController).name('index');
tableRoutes(members, MembersTable);
```

The web app's members page (`apps/web-app/modules/members`) is the example in full: an e-mail column only administrators see, a row
action, a bulk action and a CSV export — rendered with plain, accessible markup. The guide [tables](../../docs/tables.md) builds it
step by step and goes through the security model attack by attack.

## Defining a table

`defineTable({ … })` is typed from the base query's tables (Kysely):

- **Columns** are columns of the query — `column('name')` or `column('users.name')` for a join. Their key in `columns` is their
  **alias**: the only name the URL, the props and the export ever use. `.sortable()`, `.searchable()` (case-insensitive `LIKE`,
  wildcards taken literally), `.label(text)` (otherwise the app labels a column by its alias, in its own translations) and
  `.visible(Policy, 'ability')` / `.visible((ctx) => …)`.
- **The key** identifies a row — what actions send. By name for a number column (`key: 'users.id'`, read as an integer); a text key
  names its type: `key: { column: 'users.uuid', type: 'uuid' }` (`integer`, `bigint` — digits within Postgres' `bigint` —, `string`,
  `uuid`; a text key by name alone is a compile error). Every key the browser sends is **parsed by that type before any query**: one
  that does not parse is no row (404, or `missing` in a bulk action) — text never reaches an integer column (on Postgres a 500), and
  no query guesses the type. A row in the props has the key under its column's name (`users.id` → `id`).
- **Filters** are an allowlist too: `filter.select(column, options)` (`?filter[role]=admin`) and `filter.dateRange(column)`
  (`?filter[joined]=2026-01-01..2026-03-31`, either end may be empty, both days included). `.visible(…)` like columns.
- **Pagination:** by number with a total (the default; `?page=`, `?per_page=` from `perPage`, default `[25, 50, 100]`), or by an
  encrypted cursor (`{ cursor: true }`: keyset along the sort, `?cursor=`, no `count(*)` — the cursor of
  [`cursorPaginate`](../database/README.md#pagination), so a changed one is a 400).
- **More than one table on a page:** `prefix: 'teams'` gives its keys a prefix (`teams_sort`, `teams_filter[role]`); spread both
  schemas: `defineRequest({ query: v.object({ ...MembersTable.query.entries, ...TeamsTable.query.entries }) })`.
- **Who may see the table at all:** `authorize: can(MemberPolicy, 'viewAny')` (or any check) — asked on the page and in every
  endpoint. The endpoints run the page registrar's middleware, **not** the page controller's `authorize`: a table that needs one
  says so here.

## What the browser gets

`tables.resolve(MembersTable, ctx)` — best as a lazy prop (`members: () => …`) — resolves to `TableProps<typeof MembersTable>`:

```ts
{
  name: 'members', key: 'id',
  columns: [{ name: 'name', label: null, sortable: true, searchable: true, sort: 'asc' }, …],   // the visible ones, in order
  rows: [{ id: 7, name: 'Ada', joined: '2026-01-10T09:00:00.000Z', can: { deactivate: true } }, …],
  sort: { column: 'name', direction: 'asc' },
  search: { value: '' },                       // null when no visible column is searchable
  filters: [{ name: 'role', type: 'select', key: 'filter[role]', options: ['admin', 'member'], value: null }, …],
  page: { type: 'offset', page: 1, perPage: 25, perPageOptions: [25, 50, 100], total: 42, lastPage: 2, from: 1, to: 25 },
  query: { sort: 'sort', page: 'page', perPage: 'per_page', cursor: 'cursor', search: 'search' },   // the URL keys (prefixed)
  state: { sort: '-joined', 'filter[role]': 'admin' },                                              // the URL's state, no defaults
  actions: [{ name: 'deactivate', url: '/members/_tables/members/actions/deactivate', confirm: true }],
  bulk: [{ name: 'deactivate', url: '/members/_tables/members/bulk/deactivate', confirm: false, max: 1000 }],
  exports: [{ name: 'csv', format: 'csv', url: '/members/_tables/members/export/csv?sort=-joined&filter%5Brole%5D=admin', max: 10000 }],
}
```

The row type follows the definition: a column with `.visible(…)` is optional (`email?: string`), the rest as Kysely selects it.
`can` holds one boolean per row action — computed for the whole page at once, one `gate.withAbilities` per policy, never a policy's
reason. Actions, bulk actions and exports the user may not use are not in the props at all. The URLs carry the page's own path
parameters (a table under `/teams/:team` links to `/teams/7/_tables/…`).

## The URL — strict on purpose

`MembersTable.query` is the table's state as a query schema: `sort`, `page` (or `cursor`), `per_page`, `search` (when a column is
searchable) and `filter[<name>]`, with the table's prefix. Typed — `ctx.query.sort` is `'name' | '-name' | 'joined' | …` — so
`useQueryState` and `<Link query>` know it too.

Other query fields **fall back per field** (E55/E56: a link with `?sort=nonsense` shows the default). A table does not: an unknown
sort, a raw column name (`?sort=password`, `?sort=created_at` instead of `joined`), a filter that is none (`?filter[password]=x`), a
value its filter does not offer, a page size not in `perPage` (`?per_page=10000`), a page that is none, a repeated key, a search
longer than 100 characters — all **400**. A table says out loud what it cannot do, and nothing from the URL gets near `ORDER BY` or
`WHERE` that the definition did not name: a sort or filter is an alias, looked up, and only its column goes into the query.
Visibility counts as well: sorting or searching by a column the user cannot see is a 400 (the order alone would tell its values) —
the search looks only into visible columns — and so is a filter the user cannot see. A filter on the column of a hidden one is
hidden with it, whatever its own visibility (the number of rows it leaves would tell that column's values; the same column counts
with or without its table, `created_at` and `users.created_at`); a filter's own `.visible(…)` can hide it further.

## Actions, bulk actions, exports

`tableRoutes(Route, Table)` registers three routes **on the registrar you pass** — the page's:

| Route | Body | Answer |
| --- | --- | --- |
| `POST …/_tables/<name>/actions/:tableAction` | `{ key }` | `{ done, skipped, missing, data? }` |
| `POST …/_tables/<name>/bulk/:tableBulk` | `{ keys: [...] }` or `{ all: true, query }` | `{ done, skipped, missing, data? }` |
| `GET …/_tables/<name>/export/:tableExport` | — (the table's state in the query) | a CSV file |

They are ordinary routes of the page's group: its middleware (`authenticate()`, `verified()`, a tenant), its route bindings, sessions
and CSRF for the POSTs (Fetch Metadata stages, E143). A registrar whose routes lack what the base query needs (`ctx.user` without
`authenticate()`) is a compile error. They have no names — the props carry their URLs.

A **row action** checks, in this order: the table's `authorize` (403) → the action exists (404) and is visible (403) → the body →
the row is looked up **in the base query** (another tenant's, a deleted or a made-up key: 404) → its policy for that row (403) → its
handler, a class built per request: `handle(row, ctx)`. A **bulk action** takes the keys **∩ the base query ∩ the policy per row**:
keys that are no rows of the table are left out and counted (`missing`), rows the policy refuses too (`skipped`) — the handler gets
only the rest: `handle(rows, ctx)`. **"All matching"** sends the table's state (`{ all: true, query: props.state }`), never a list of
keys: the server parses it again, as strictly as the URL, and refuses more rows than the action's `max` (default 1000) with a 422 —
it never acts on a cut-off list. Bulk actions take at most `max` chosen keys as well.

The answer is JSON for an action request (`x-bespoke-action`, what `useAction` sends — `no-store` either way) and for an API client;
a form posted without JavaScript, or a page visit, goes back to the page (303). A handler that returns a `JsonResult`, a redirect or
a `Response` answers for itself; anything else it returns is `data`.

An **export** has its own `authorize` (without it, whoever sees the table may download what they see), exports the visible columns
only, as the URL filters and sorts them, takes at most `max` rows (`exportCsv().max(rows)`, default **10 000**: one count first, an
export over it is a 422 before a byte is streamed — never a file cut short), and streams them in batches of 500. The first batch runs
in the handler; the later ones run once it has answered — a framework boundary (E107): in the request's context (logging, request id),
**outside** any transaction that was open around the handler (`outsideTransaction`). An export reads the whole filtered table:
**throttle the table's routes** — `tableRoutes(members.middleware(throttle('members-table')), MembersTable)` with a limiter of
@bespokecore/cache (the web app: 60 a minute per user) — `Content-Disposition: attachment` with a safe file name
(`members-2026-10-06.csv`), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a UTF-8 byte order mark (spreadsheets need it
for umlauts). **Formula injection** (OWASP "CSV Injection") is escaped: a text cell that starts with `=`, `+`, `-`, `@`, a tab, a
carriage return or a line feed gets a `'` in front; every field is quoted, quotes doubled. Numbers stay numbers (`-5` is no formula).

## Security model

1. **Who may see the table** — the page registrar's middleware, the table's `authorize`.
2. **What they may see** — column, filter, action and export visibility by policy, asked once per request.
3. **The state** — parsed strictly (400), checked against what is visible.
4. **The projection** — only the visible columns and the key are selected: a hidden column is not in the SQL, so it cannot reach
   the props, the devtools' query log, a cursor or an export by accident.
5. **The props** — only the visible columns and the key, picked by name: whatever else a row carries (a base query that selects a
   column itself) stays on the server. Two measures on purpose — each has its own test.
6. **Every endpoint starts again at 1** — nothing the browser sends is trusted: the row comes from the base query, the policy is
   asked again, "all matching" is parsed again.

Policies that decide per row see the row as the table hands it out — the key and the visible columns (by alias). One that needs
more looks it up by the key, or the column becomes part of the table.

## In the browser

`useTable(props.members)` (`@bespokecore/react/table`) renders nothing — it gives a component what the props allow, typed by them
(`TableProps<typeof MembersTable>`: only sortable columns sort, only the table's filters filter, only its actions run):

```tsx
const table = useTable(members, { labels: { column: (name) => t(`column.${name}`), row: (row) => row.name } });
table.columns        // the visible ones: label, headerProps (aria-sort on the sorted one only), sortLinkProps, toggleSort()
table.sort('joined'); table.filter('locale', 'de'); table.filterBy({ locale: null, joined: '2026-01-01..' }); table.setSearch('ada')
table.goTo(2); table.perPage(25); table.next()                  // pages by number, page size, the next cursor
table.select(row); table.selectAll(); table.selectMatching()    // "all matching" is the table's state, never a list of keys
await table.run('removeLinks', row); await table.runBulk('removeLinks')
table.exportUrl('csv'); table.status                           // a download; the live region's text
```

- **The URL:** sorting, filters, search (after a pause in typing, one history entry) and pages are visits of the page's URL with the
  props' keys (`query`, `filter[…]` with the prefix) and the columns' **aliases** — the browser never names a database column, and
  asking for what the props do not offer throws before a request goes out (`[bespoke:C9]`–`[bespoke:C12]`). Only the table's prop
  reloads; the server parses the state again, as strictly as ever.
- **The selection** is the core's (`navigator.use(selection)`, a slot of the history entry): a sort, a filter or another page is a
  visit with an entry of its own and starts with nothing selected — Back brings the old one back from memory; the core empties it
  with the entry and when the document is left (signing out, a new build). Never in `history.state` or storage.
- **Actions** are action requests (E59: CSRF, JSON, never cached), then the table's prop reloads — a revalidation, so it **replaces**
  what the page had, a `merge()`d table too ([Merged props](../http/README.md#merged-props-revalidations-replace-load-more-appends-w9)).
  A bulk action clears the selection. Their code (the actions feature, the page's reloads) loads with a table's first run, in a chunk
  of its own. An action defined with `.confirm()` asks first (`labels.confirm`, or the run's `confirm`).
- **UI-free:** `TableController` (`@bespokecore/table/client`) is all of this without React — `new TableController(navigator,
  props, { entry })`, `update(props)` after a render; React's hook is a thin layer over it, a plain-DOM adapter its test.
- **TanStack Table v9**, for an app that wants its column model: `toTanStack(table, { features })` (`@bespokecore/react/table-tanstack`,
  `@tanstack/react-table` an optional peer) gives TanStack's `useTable` the rows, the columns and the state the server owns in
  manual mode — its sorting, pagination and row selection go back through `useTable`. The bridge has no TanStack code of its own:
  TanStack is in a bundle only where the app imports it.

The table's browser code is only where it is imported (the page's chunk); its size has a scenario of its own in the React
adapter's budget (`table`, E186).

## Accessible markup

Any markup built on the props follows the WAI-ARIA Authoring Practices for sortable tables — `useTable` hands out the attributes
for it (`headerProps`, `sortLinkProps`, `checkboxProps`, `pageCheckboxProps`, `actionLabel`, `statusProps` + `status`):

- A **native `<table>`** with a **`<caption>`** that names it — and says once that it can be sorted, instead of on every heading.
- **`aria-sort` only on the heading the table is sorted by** (`ascending`/`descending`) — never `none` on the others.
- The sort control is a **button (or a link to the sorted URL) inside the `<th>`**, named after its column.
- The number of rows after a filter, sort or page goes into a **live region** (`role="status"`, polite) — "42 members, sorted by
  joined (descending), page 2 of 5" (the page too: the same count and sort would otherwise say nothing). Not the selection: a
  checkbox says its own state.
- **Selection checkboxes have names** ("Select Ada Lovelace"; "Select every member on this page"), row actions are buttons named
  after their row — the name **starting with the visible text** ("Remove links: Ada Lovelace" for a button that says "Remove links",
  WCAG 2.5.3), so a voice user can say what they see.
- **The row has a header:** the cell that names the row is a `<th scope="row">` — moving down a column, a screen reader says whose
  value it is.
- **What an action did** goes into a live region of its own ("Links of 2 members removed, 1 left out" — or why it failed): the
  list's count often stays the same, so its region would say nothing.
- **Focus is never dropped:** a control that cannot be used right now stays focusable (`aria-disabled`, its click does nothing)
  instead of `disabled` or unmounted — a confirmation dialog gives focus back to the button that opened it, which a disabled button
  cannot take. Bulk controls come after the table, where the rows were ticked.
- **No `role="grid"`** without real cell navigation (roving tabindex and arrow keys) — a table that is read and sorted is a table.
- `aria-busy` while a page loads is already on the document (the client core sets it during visits).

## Type checks

Mistakes in a definition are compile errors with readable messages, for example:

```ts
column('emial')            // 'emial' is not a column of the table's query — it has avatar_path, bio, created_at, email, …
column('password')         // 'password' is a secret column — a table never reads it (its migration marked it .secret())
key: 'uuid'                // 'uuid' is not a column of the table's query — it has …
key: 'email'               // the key 'email' holds text — say how to read it: key: { column: 'email', type: 'string' } (or 'uuid', 'bigint')
defaultSort: '-email'      // '-email' is not a sortable column — it sorts by -name, name
action(NeedsRole)          // 'promote': its handler's handle(row, ctx) takes other rows than the table's — they have id, name
.authorize(MemberPolicy, 'deactivat')    // 'deactivat' is not an ability of this policy — it has deactivate, export, …
column('email').visible(MemberPolicy, 'deactivate')   // 'deactivate' takes a resource — this is asked once per request: …
tableRoutes(Route, MembersTable)   // … 'the table needs more of the request than these routes have — register them on the registrar of its page, …'
```

A handler's `ctx` parameter is not compared with the base query's context (the comparison broke the inference of the whole
definition) — type it as `TableContext<…>` like the query.

## Testing

The package's own tests run on SQLite and Postgres (`pnpm test:pgsql`): the projection by query log, the props filter with a base
query that selects a hidden column, the 400s, the tenant in actions and bulk actions, the policy per row, "all matching" over the
limit, formula escaping, a streamed export of 1 203 rows. In an app, `app.actingAs(user).acting().post(url, { json: { key } })` runs an
action as `useAction` would; `app.actingAs(user).get(exportUrl)` downloads the CSV.
