# Data Tables

## Introduction

A list that people sort, filter, page through, tick rows in, act on and download is where the classic leaks of a web app live: a
hidden column that still travels in the props, a sort parameter that reaches `ORDER BY`, a bulk action that takes another tenant's
ids, a cell that a spreadsheet runs as a formula. A data table handles them once. You write **one definition** per table on the
server; the URL holds its state and is parsed strictly; its actions and exports are endpoints that check everything again. The
browser half is headless: `useTable()` gives a component what the props allow and renders nothing itself.

Install the package first, in the version of the app's other framework packages:

```sh
pnpm add -E @marmeon/table@<version of your app>
```

This page builds the members table of the web app: every member with a confirmed address and the number of their links, an e-mail
column only administrators see, a row action, a bulk action and a CSV export.

```ts title="modules/members/tables/MembersTable.ts"
import type { Authenticated } from '@marmeon/auth';
import { action, bulk, column, defineTable, exportCsv, filter, type TableContext } from '@marmeon/table';
import { RemoveMemberLinks } from '../actions/RemoveMemberLinks.ts';
import { RemoveMembersLinks } from '../actions/RemoveMembersLinks.ts';
import { MemberPolicy } from '../policies/MemberPolicy.ts';

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
  },
  defaultSort: 'name',
  pagination: { perPage: [10, 25, 50] },
  actions: { removeLinks: action(RemoveMemberLinks).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'removeLinks').confirm() },
  bulk: { removeLinks: bulk(RemoveMembersLinks).visible(MemberPolicy, 'moderate').authorize(MemberPolicy, 'removeLinks').confirm().max(100) },
  export: { csv: exportCsv().authorize(MemberPolicy, 'export') },
});
```

`defineTable()` is typed from the base query's tables, so a column that does not exist, a sort that is not sortable or an ability
the policy lacks is a compile error.

## Defining a table

### The base query

`query(db, ctx)` returns every row the table may ever show in this request. Pages, actions, bulk actions and exports all start
from it, so it is the boundary: put the tenant here, `.where('users.team_id', '=', ctx.user.team_id)`, and nothing of another
tenant can be shown, changed or downloaded. The base query selects nothing but values it computes, such as a
[count](queries.md#counting-related-rows). The table selects the visible columns and the key itself. Type its `ctx` as
`TableContext<…>` with what the routes' middleware adds, such as `Authenticated`.

An untyped `db` sees every table of the app. To keep the query inside its module, annotate it as the module's
[`Database<'members'>`](queries.md#module-boundaries): the module's own tables and the ones other modules expose, and any other
table is a compile error. The table's columns are still typed from the query.

```ts
query: (db: Database<'members'>, ctx: TableContext<Authenticated>) =>
  db.selectFrom('users').where('users.team_id', '=', ctx.user.team_id),
```

A table on a route with a bound parameter, `/teams/{team}/members`, reads it from `ctx.params`; type the context with the parameters the route binds:

```ts
query: (db: Database<'members'>, ctx: TableContext<Authenticated, { team: Row<'teams'> }>) =>
  db.selectFrom('users').where('users.team_id', '=', ctx.params.team.id),
```

The restriction is a type, as everywhere else: at runtime the table passes the app's connection.

### Columns

A column is a column of the query: `column('name')`, or `column('users.name')` for a join. Its key in `columns` is its **alias**,
the only name the URL, the props and the export ever use. The members table calls `users.created_at` `joined`, and no URL ever
says `created_at`.

| Method | What it does |
| --- | --- |
| `.sortable()` | The table may sort by it. |
| `.searchable()` | The search looks into it while the user can see it: case-insensitive, with `LIKE`'s wildcards taken literally. |
| `.label(text)` | Its heading in the props and in the CSV. Without it, the props carry `label: null`, the page labels the column through `useTable()`'s `labels`, and the CSV heading is the alias. |
| `.label((t) => t('members.column.name'))` | The heading in the request's language: the function runs once per request with `t(key, params?)` of the request's translator (`@marmeon/i18n`), and `t` gives the key itself where none is bound. The props and the CSV carry the same text. |
| `.visible(Policy, 'ability')` | Only users the policy allows see it. Asked once per request, without a row. |
| `.visible((ctx, resolve) => …)` | The same with a function of your own. |

A hidden column is not selected, not sent and not exported, and in the row's type it is optional. A column that a migration marked
`.secret()`, such as a password hash, cannot be a column at all: that is a compile error, and a column that names a `secret(eb, …)`
of the base query is refused when the table runs.

A column can also show a value the base query computes under a name: `withCount('profile_links', { as: 'links' })` gives
`links: column('links')`, typed as a number, sorted by in `ORDER BY` without a join. Its key is that name. It cannot be
searched or filtered by, since `WHERE` cannot see a value the query computes; both are compile errors. Hidden by `.visible(…)`, the
value is left out of the base query too, so it never reaches the SQL.

### Generating a table

`marmeon make:table Members --module=members` writes `modules/members/tables/MembersTable.ts` (`--table` names the table; it is the plural of the name by default): the base query typed with the module's `Database`, the key, an `id` column and `authorize: () => false`. Nobody sees the table until you replace that with `can(Policy, 'viewAny')`. It registers nothing; `endpoints()` of the table does, when you [attach it to its page](#the-controller-and-the-routes).

### The key

The key identifies a row, and it is what actions send. A number column goes by name, `key: 'users.id'`, and is read as an integer.
A text key says how to read it: `key: { column: 'users.uuid', type: 'uuid' }`, with the types `integer`, `bigint`, `string` and
`uuid`. A text key by name alone is a compile error. Every key from the browser is parsed by its type before any query. One that
does not parse is no row, so text never reaches an integer column. In the props, the key of a row is under its column's name:
`users.id` becomes `id`.

### Filters

Filters are an allowlist too:

| Filter | URL |
| --- | --- |
| `filter.select(column, options)` | `?filter[locale]=de`. Anything but one of `options` is a 400. |
| `filter.has(relation, options)` | `?filter[team]=3`. The rows that have a related row with that value, see [below](#filtering-by-a-relation). |
| `filter.dateRange(column)` | `?filter[joined]=2026-01-01..2026-03-31`, both days included. Either end may be empty. |

A filter takes `.visible(…)` like a column. A filter on the column of a hidden column is hidden with it, because the number of rows
it leaves would tell that column's values.

An option is a text, or `{ value, label }` when the browser should show another text than the value. `filter.select()` and
`filter.has()` send the values in the props (`filters[].options`) and the texts beside them (`filters[].labels`, the same length;
the value itself where no label was given). Only the value and the label are sent: whatever else an option object carries, such
as a spread row, stays on the server.

#### Filtering by a relation

`filter.has(relation, options)` keeps the rows of the base query that have a related row whose column is the value, like
[`whereHas()`](queries.md#filtering-by-relations): guests of a category, members of a team.

```ts
filters: {
  category: filter.has('category', [{ value: '1', label: 'Speakers' }, { value: '2', label: 'Press' }]),
  label: filter.has('profile_links', ['website', 'blog'], { column: 'label' }),
},
```

`relation` is a relation of the query's table, and `column` (default `id`) a column of the related table. Both are checked
against the schema: in the types (a relation the query's tables do not have, or a column the related table lacks, is a compile
error), and again when the table is first used (an error on its first request, whatever the URL carries). The column is
compared with its table's name, so it can never be a column of the outer row. A secret column of the related table is refused, as in a column of the table itself. Both come from the definition, never from the URL,
so the URL can only choose one of the `options`. The value is a bound parameter, and the filter is
one more `AND` on the base query, so it narrows what the query returns and never widens it. It reads no column of the table, so
the rule above does not apply to it, but `.visible(…)` does.

#### Options for each request

Options that differ per request, such as the categories of this event, are a function of the request's `resolve` and `ctx`:

```ts
filters: {
  category: filter.has('category', async (resolve, ctx: TableContext<Authenticated, { event: Row<'events'> }>) => {
    const categories = await resolve(CategoryRepository).query().where('event_id', '=', ctx.params.event.id).execute();
    return categories.map((category) => ({ value: String(category.id), label: category.name }));
  }),
},
```

The function runs once for a request, after the table's `authorize` and after the URL is parsed, and the URL then takes only a value
from its list: any other value is a **400** (`TableQueryError`) before the table is read, in a page, an export and "all matching"
alike. It does not say whether the value exists elsewhere. The function has to scope by the tenant like the base query does,
because a list of another tenant's values would make them valid choices. In the types, the URL value of such a filter is a
`string`, where a list in the definition makes it a union. Only the table checks a value against the options: a controller that
reads `ctx.query['filter[x]']` itself gets a value that was only checked for its shape, so it must not trust it.

### Sorting and pages

`defaultSort` is the sort without a `?sort=`: an alias, with `-` in front for descending. Without it, the table sorts by its first
sortable column that everyone sees; with none, there is no default sort and `ctx.query.sort` is optional. The key always breaks
ties. A default sort by a column with `.visible(…)` is refused, as a
compile error and when `defineTable()` runs, because it would answer 400 to everyone who may not see the column.

`pagination` pages by number with a total, by default. `perPage` lists the page sizes `?per_page=` allows, and the first one is the
default: `[25, 50, 100]` unless you say otherwise. `{ cursor: true }` pages by an encrypted cursor instead, for "load more", without
counting every row. The [pagination](pagination.md) page explains both.

### Who may see the table

`authorize` decides whether the user may see the table at all. It is asked on the page and in every endpoint. `can()` of
`@marmeon/auth` takes a policy and one of its abilities, here an ability `viewAny` that you add to the policy:

```ts
authorize: can(MemberPolicy, 'viewAny'),
```

The table's endpoints hang on the page's route, so they carry everything the page checks: its middleware, the registrar's
`authorize`, and the `authorize` of the page controller's request. A user the page refuses is refused on every endpoint, too. This
`authorize` is for what the table itself requires, on every page that shows it.

### More than one table on a page

`prefix: 'teams'` puts a prefix before the table's keys in the URL: `teams_sort`, `teams_filter[role]`. Spread both tables' query
schemas into the page's request:
`defineRequest({ query: r.query({ ...MembersTable.query.entries, ...TeamsTable.query.entries }) })`. Attach both to the page:
`.attach(MembersTable.endpoints()).attach(TeamsTable.endpoints())`.

The start refuses a page whose tables would share a key in the URL: two without a prefix, two with the same prefix, or a prefix that
makes a key of the other table (`per` gives `per_page`, which an unprefixed table already reads). Without that they would sort
and page together, or answer a 400 to a key the other does not know. It also refuses two tables of one name (their endpoints would
share `/_tables/<name>/…`) and the same table attached twice, naming the page and both tables. A table may sit on several pages.
The start cannot see the page's own request schema: its query fields need names other than the tables' keys.

## The controller and the routes

The page's controller validates the table's state as its query and resolves the table as a prop:

```ts title="modules/members/controllers/ListMembersController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { DataTables } from '@marmeon/table';
import { MembersTable } from '../tables/MembersTable.ts';

export const ListMembersRequest = defineRequest({ query: MembersTable.query });

export class ListMembersController extends Controller {
  static request = ListMembersRequest;

  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  handle(ctx: ContextOf<typeof ListMembersRequest> & Authenticated) {
    return this.view('members/Index', { members: () => this.#tables.resolve(MembersTable, ctx) });
  }
}
```

The prop is a function, so a partial reload of another prop leaves the table out. The table's `endpoints()` hang its action, bulk and
export endpoints **on the page's route**, with `attach()`:

```ts title="modules/members/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListMembersController } from './controllers/ListMembersController.ts';
import { MembersTable } from './tables/MembersTable.ts';

export default defineRoutes((Route) => {
  // Every verified user may see the members. The table's endpoints inherit this decision from the page's route.
  const members = Route.prefix('/members').middleware(authenticate()).middleware(verified()).authorize(everyone).name('members.');
  members.get('/', ListMembersController).name('index').attach(MembersTable.endpoints({ middleware: [throttle('members-table')] }));
});
```

| Route | Body | Answer |
| --- | --- | --- |
| `POST /members/_tables/members/actions/:tableAction` | `{ key }` | `{ done, skipped, missing, data? }` |
| `POST /members/_tables/members/bulk/:tableBulk` | `{ keys: [...] }` or `{ all: true, query }` | `{ done, skipped, missing, data? }` |
| `GET /members/_tables/members/export/:tableExport` | none: the table's state in the query | a CSV file |

The endpoints are ordinary routes under the page's path, with its middleware, its route bindings, its checks and the `authorize` of
its request, the session and CSRF protection for the posts. A guest or an unconfirmed account never reaches them, and a user the
page's request refuses does not either. A page whose route lacks what the base query needs, such as `ctx.user` without
`authenticate()`, is a compile error. The routes have no names, because the props carry their URLs, and a table has routes only for
the kinds it has: a table without an export has no export route, and a request to its export URL is a 404 for every user, before
the page's middleware and checks.

Every table is attached to the page that shows it, also one without actions and exports: `endpoints()` is how `resolve()` finds
the table's URLs, and a page that resolves a table nobody attached to it fails with an error that names the table and the page.
Throttle the endpoints: an export reads the whole filtered table, and [can have a limit of its own](#middleware-per-endpoint). The [rate limiting](rate-limiting.md) page shows the `members-table` limiter.

### Middleware per endpoint

The page's middleware covers the action, bulk and export endpoints alike. An export reads the whole filtered table, so it usually
wants a stricter limit than a row action. `endpoints()` takes `middleware` for all three kinds, and a list of middleware for each
kind of endpoint:

```ts title="modules/members/routes.ts"
members.get('/', ListMembersController).name('index').attach(
  MembersTable.endpoints({
    middleware: [throttle('members-table')],
    export: { middleware: [throttle('members-export')] },
    // bulk: { middleware: [...] }, action: { middleware: [...] }
  }),
);
```

```ts title="modules/members/MembersServiceProvider.ts"
app.container.make(RateLimiter).for('members-export', (ctx) => Limit.perMinute(10).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
```

`middleware`, `export`, `bulk` and `action` are the options; a kind without one has the page's middleware and `middleware` alone.
The order is the page's middleware, then `middleware`, then the kind's, each in the order of its list, and then the endpoint's own
checks (`authorize`, visibility, the input) and the controller. Like any route middleware it runs before the route bindings and the
page's `authorize()`: `ctx.params` are still strings and the request is not yet authorized. It adds to the page's protection and
never replaces it: with `authenticate()` on the registrar a guest never reaches it, the table's own `authorize` and the CSRF
protection of the `web` group still apply, and the start still checks every attachment. Middleware that answers the request
or throws stops the endpoint; for an export, that is before the count, the first batch and the export recorder. The middleware
follows the kind of endpoint, not its path, so a workspace slug such as `export` changes nothing. Both throttles count: with the
two throttles above an export uses one request of `members-table` and one of `members-export`.

### One table on several pages

A table can be shown on more than one page. `attach()` its endpoints to each page:

```ts title="modules/members/routes.ts"
const readers = members.authorize(everyone);
const endpoints = () => MembersTable.endpoints({ middleware: [throttle('members-table')] });
readers.get('/', ListMembersController).name('index').attach(endpoints());
readers.get('/directory', ListMembersController).name('directory').attach(endpoints());
```

Each page links the endpoints attached to it: `/members` gets `/members/_tables/members/…`, `/members/directory` gets
`/members/directory/_tables/members/…`. Every page keeps its own middleware, `authorize` checks, route bindings and parameters, so
one page can be stricter than another, with an `authorize` in its request. Two pages under the same URLs (even with other parameter
names) stop the start with an error that names both paths. A page's own parameters fill the links.

## What the browser gets

`tables.resolve(MembersTable, ctx)` resolves to `TableProps<typeof MembersTable>`:

```ts
{
  name: 'members', key: 'id',
  columns: [{ name: 'name', label: null, sortable: true, searchable: true, sort: 'asc' }, …],
  rows: [{ id: 7, name: 'Ada', joined: '2026-01-10T09:00:00.000Z', can: { removeLinks: true } }, …],
  sort: { column: 'name', direction: 'asc' },
  search: { value: '' },
  filters: [{ name: 'locale', type: 'select', key: 'filter[locale]', options: ['en', 'de'], labels: ['en', 'de'], value: null }, …],
  page: { type: 'offset', page: 1, perPage: 10, perPageOptions: [10, 25, 50], total: 42, lastPage: 5, from: 1, to: 10 },
  query: { sort: 'sort', page: 'page', perPage: 'per_page', cursor: 'cursor', search: 'search' },
  state: { sort: '-joined', 'filter[locale]': 'de' },
  actions: [{ name: 'removeLinks', url: '/members/_tables/members/actions/removeLinks', confirm: true }],
  bulk: [{ name: 'removeLinks', url: '/members/_tables/members/bulk/removeLinks', confirm: true, max: 100 }],
  exports: [{ name: 'csv', format: 'csv', url: '/members/_tables/members/export/csv?sort=-joined&filter%5Blocale%5D=de', max: 10000 }],
}
```

- `columns` holds the visible columns, in the definition's order.
- Each row has the key and the visible columns, nothing else. `can` holds one boolean per row action, computed for the whole page
  with one policy call per ability, never a policy's reason.
- `search` is `null` when no visible column is searchable.
- `state` is the table's state in the URL, without defaults.
- Actions, bulk actions and exports the user may not use are not in the props at all.

**The kinds are open.** `filters[].type` (now `select`, `has` and `dateRange`), `page.type` (`offset` and `cursor`) and `exports[].format`
(`csv`) grow: a new kind is a minor release, never a breaking change. Code that branches on one of them needs a `default` branch
for a kind it does not know. `useTable` and `toTanStack` render a kind they do not know without throwing; `goTo()` and `next()` refuse a page kind they do not
page, as they refuse a page that does not exist.

The URLs carry the page's own route parameters: a table under `/teams/:team` links to `/teams/7/_tables/…`.

## The URL is strict

`MembersTable.query` is the table's state as a query schema: `sort`, `page` or `cursor`, `per_page`, `search` when a column is
searchable, and `filter[<name>]`, with the table's prefix. It is typed, so `ctx.query.sort` is `'name' | '-name' | 'joined' | …`.

Other query schemas [fall back per field](requests.md#how-a-query-is-parsed): a link with a broken value shows the default. A table
does not. Each of these is a **400**:

- a sort that is not offered, or a raw column name: `?sort=password`, `?sort=created_at` instead of `joined`,
- a filter that does not exist, `?filter[password]=x`, or a value its filter does not offer (for options computed per request: not in this request's list),
- a page size that is not in `perPage`, `?per_page=10000`, or a page that is no whole number,
- a repeated key, or a search longer than 100 characters,
- sorting by a column the user cannot see, or a filter the user cannot see,
- a search when no column the user can see is searchable.

The search never looks into a column the user cannot see. It leaves such a column out without an error, so a search finds nothing
in a hidden column and tells nothing about it.

Nothing from the URL reaches `ORDER BY` or `WHERE` that the definition did not name. A sort or a filter is an alias that is looked
up, and only its column goes into the query.

## Actions

### Row actions

A row action is a class with `handle(row, ctx)` (`handle(row, ctx, input)` with [input](#an-action-with-input)), built per request through the container:

```ts title="modules/members/actions/RemoveMemberLinks.ts"
import { ProfileLinkRepository } from '#modules/user-profile';

export class RemoveMemberLinks {
  readonly #links: ProfileLinkRepository;

  constructor(links: ProfileLinkRepository) {
    this.#links = links;
  }

  async handle(member: { readonly id: number }) {
    return { removed: await this.#links.removeAllOf([member.id]) };
  }
}
```

`action(Handler)` puts it into the table. `.visible(Policy, 'ability')` offers it only to some users, asked once per request.
`.authorize(Policy, 'ability')` asks the policy **for each row**, with the row as the table hands it out. `.confirm()` makes the
browser ask first. The endpoint checks, in this order:

1. the table's `authorize`, else 403,
2. that the action exists, else 404, and is visible, else 403,
3. the body, and the action's [input](#an-action-with-input) against its schema, else 422,
4. that the row is in the **base query**: another tenant's row, a deleted one or a made-up key is a 404,
5. the action's policy for that row, else 403.

Only then does `handle()` run. A policy that decides per row sees the key and the visible columns, by alias. One that needs more
looks the row up by its key, or the column becomes part of the table.

### Bulk actions

A bulk action is a class with `handle(rows, ctx)` (`handle(rows, ctx, input)` with [input](#an-action-with-input)). It acts on the chosen keys **∩ the base query ∩ the policy per row**. Keys that
are no rows of the table are left out and counted as `missing`, and rows the policy refuses as `skipped`. The handler gets only the
rest, and none of it runs when nothing is left.

"All matching" sends the table's state, `{ all: true, query }`, never a list of keys. The server parses it again, as strictly as
the URL, and refuses more rows than the action's `max`, 1000 by default, with a 422. It never acts on a list that was cut short.
Chosen keys are held to `max` as well.

### An action with input

An action that needs a value from the user, such as a status, a category or a reason, takes it with `.input()`. One action serves
every value, instead of one action per value:

```ts title="modules/members/tables/MembersTable.ts"
import { rules as r } from '@marmeon/validation';

export const MembersTable = defineTable({
  // …
  bulk: {
    setLocale: bulk(SetMembersLocale)
      .authorize(MemberPolicy, 'setLocale')
      .input(r.object({ locale: r.in(['en', 'de']) })),
  },
});
```

```ts title="modules/members/actions/SetMembersLocale.ts"
export class SetMembersLocale {
  // …
  async handle(members: readonly { readonly id: number }[], _ctx: unknown, input: { readonly locale: 'en' | 'de' }) {
    // `input` is the schema's output.
  }
}
```

`.input()` takes any [Standard Schema](validation.md), and works the same on `action()` and `bulk()`. The browser sends the values
along, `table.run('setLocale', row, { input })` or `table.runBulk('setLocale', { input })`. Both are typed from the schema: the
call needs `input` when the action has a schema and refuses it when it has none. "All matching" sends the input next to the
state. A form posted without JavaScript names its fields `input[locale]`.

The server validates the input after the table's `authorize`, the action's visibility and the shape of the body, and **before
any row is read**. A value the schema refuses is a 422 with the errors under `input.<field>` (`input.locale`), and the handler
does not run. An action without `.input()` that gets an `input` answers 422 as well (`This action takes no input.`), so a field
that does nothing is never mistaken for one that is checked. A handler's third parameter must fit the schema's output, which the
table's type check enforces, and a handler that takes an input needs a schema.

A value that has to belong to the request, such as a category of this event, is a rule that asks the database. Build the
schema per request with a function, whose `resolve` and `ctx` are the request's, like a [request's schema](validation.md#a-schema-built-per-request):

```ts
bulk(MoveToCategory)
  .authorize(EventPolicy, 'update')
  .input(() =>
    r.object({
      category: r.integer().exists(CategoryRepository, 'id', {
        where: (query, ctx: HttpContext<Authenticated, { event: Row<'events'> }>) => query.where('event_id', '=', ctx.params.event.id),
      }),
    }),
  ),
```

A category of another event is a 422, and nothing is written. An action can also tell values apart by the route's
`ctx.params.tableBulk` or `ctx.params.tableAction`, with one class or one branch per value.

### The answer

An action request, the kind `useTable()` sends, and an API client get JSON: `{ done, skipped, missing }`, and `data` with what the
handler returned. The answer is never cached. A form posted without JavaScript, or a page visit, goes back to the page with a 303.
A handler that returns a redirect, a JSON result or a `Response` answers for itself.

## Exports

`exportCsv()` downloads the visible columns, filtered and sorted as the URL says:

- **Its own `authorize`.** Without one, whoever sees the table may download what they see.
- **A record.** `exportCsv().onExport(Recorder)` runs `handle(info, ctx)` of the class once the export is authorized, its URL checked
  and its rows counted within the limit, and before the first byte. `info` holds the `table`, the `export`, the number of `rows`
  that matched when the export started, its `columns` and the `state` (`sort`, `search`, `filters`); `ctx` is the request's, with
  the user and the route parameters. A refused export (401, 403, 404, 400 or 422) never reaches it, and the client cannot skip it.
  If `handle` throws, no file is sent and the download fails with that error. The entry records an export that started: if its
  first query fails or the stream breaks, the entry stays though the file was not delivered in full. It runs in the handler: a row
  it writes joins a transaction around the handler, if there is one, and commits before the later batches. The recorder is built
  per request like an action. Writing a row in the database is an [audit trail](events.md#an-audit-trail); a log line is not.
- **A delimiter.** `exportCsv().delimiter(';')` separates the cells by a semicolon, `'\t'` by a tab (a comma by default), for a spreadsheet
  that opens a comma-separated file in one column. A function chooses per request: `.delimiter((ctx, resolve, translator) => (translator?.locale === 'de' ? ';' : ','))`
  gets the request's `ctx`, the resolver and the request's translator (`undefined` without `@marmeon/i18n`). Nothing else is a
  delimiter: a quote, a line break, a formula sign or a text of more than one character would break the quoting or the escape, so
  they are a `TypeError`, when the table is defined or, for an answer of a function, on the request before the count, the record and
  any byte: no file, no record. Every cell stays
  quoted and escaped. `readCsv()` finds all three by itself.
- **Headings.** The heading of a column is its `label(…)`, else its alias. A label function (see [Columns](#columns)) translates it
  for the request, and the CSV passes the translated text through the escape below like a cell: a translation that starts with `=`
  gets a `'` in front.
- **A limit.** `exportCsv().max(rows)`, 10000 by default. One count runs first, and an export over the limit is a 422 before a byte
  is sent, never a file cut short.
- **Batches.** Rows stream in batches of 500. The first batch runs in the handler, and the later ones after it has answered: in the
  request's context, for the log and the request id, and **outside** any transaction that was open around the handler. Each batch
  goes on after the last row written, by the table's order and then the key, never at an offset. A row deleted meanwhile moves no
  later row out of the file, and a row added meanwhile shows at most once.
- **Headers.** `Content-Disposition: attachment` with a safe file name such as `members-2026-10-06.csv`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, and a byte order mark, so spreadsheets read umlauts right.
- **Formula injection** is escaped. A text cell that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or a line feed, also
  after spaces or invisible characters such as a byte order mark or a zero-width space, or with a full-width `＝`, `＋`, `－` or `＠`, or a minus sign (U+2212),
  gets a `'` in front, before the spaces. Every field is quoted, with quotes doubled. Numbers stay numbers, and so does a decimal: `-5` and `-12.50` are no
  formula. Anything more than digits after the minus (`-2+3`, `-2E3`) is escaped.
- **Reading an export back.** A text that already starts with `'` before such a character gets one more `'`, so no two texts give the
  same cell. `unescapeCsvCell(cell)` from `@marmeon/table` removes exactly that one `'` and gives the text back as it was. It takes a cell as a CSV reader returns it:
  without the outer quotes, and with `""` already turned into `"`. `=x`, `'=x` and `''=x` are written as `'=x`, `''=x` and `'''=x`,
  and each one reads back as it was; every other text stays as it is. The result is plain text; never run it as a formula.

## A CSV file of your own

An import template, a report that is no table: `writeCsv(rows, options?)` from `@marmeon/table` writes the rows as the text of a CSV
file, with the quoting and the formula escape of an [export](#exports) — every cell quoted, lines ended by CRLF, a byte order mark
first so spreadsheets read umlauts right. Never write the quoting yourself: a cell that starts with `=`, `+`, `-` or `@` runs as a
formula in a spreadsheet unless it is escaped.

```ts
import { contentDisposition } from '@marmeon/storage';
import { writeCsv } from '@marmeon/table';

return new Response(writeCsv([['name', 'email'], ['Ada Lovelace', 'ada@example.com']]), {
  headers: {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': contentDisposition('attachment', 'members-template.csv'),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  },
});
```

`rows` is any iterable of arrays of cells (text, numbers, booleans, dates, `null`). `{ delimiter: ';' }` or `'\t'` separates by a
semicolon or a tab, `{ bom: false }` leaves the byte order mark out; any other delimiter is a `TypeError`. `readCsv(bytes, { unescape: true })`
reads the file back and gives every text as it was, as long as every row is as wide as the header (a row of empty cells is skipped), the
file stays within the reader's limits (`maxBytes` 5 MB, `maxRows` 10000, `maxColumns` 100, `maxCellLength` 10000 characters) and no text holds a
NUL (the reader takes it for a binary file); see [Importing a CSV file](#importing-a-csv-file).

## Importing a CSV file

`readCsv(bytes, options?)` turns the bytes of a CSV file into text rows. It returns a `Result`: a file that breaks a limit, has a
row of another width than its header, or is no text is an `err` for the app to answer, never a throw.

```ts
import { readFile } from 'node:fs/promises';
import { readCsv } from '@marmeon/table';

const csv = readCsv(await readFile(path), { unescape: true });
if (!csv.ok) return this.redirect().back().withErrors({ file: [csv.error.message] });
const { headers, rows, delimiter, encoding } = csv.value;
```

The bytes of an uploaded file come from [`await upload.bytes()`](storage.md#reading-an-upload) of a `TemporaryUpload`, which reads the
file without storing it. Check each row with `validate()` ([validation](validation.md#outside-a-request)), and answer the errors:

```ts
const csv = readCsv(await ctx.body.file.bytes(), { unescape: true });
if (!csv.ok) return this.redirect().back().withErrors({ file: [csv.error.message] });
for (const row of csv.value.rows) {
  const member = await validate(MemberRow, { name: row[0], email: row[1] }, { translator });
  if (!member.ok) problems.push(member.error.errors);
}
```

- **Encoding.** A byte order mark decides (UTF-8, UTF-16LE, UTF-16BE) and is removed; one that contradicts a named `encoding` is
  `not-text`. Without one, bytes that are valid UTF-8 are UTF-8, and anything else is read as `windows-1252`, the encoding of a
  German spreadsheet's "CSV" export.
- **Delimiter.** The one of `,` `;` and a tab with the most separators in the header, outside quotes (a quote opens only at the
  start of a cell). On a tie, the ones under which the first rows keep the header's width; if several do, the first of tab, `;` and `,`.
- **A format you know is better than a guess.** Detection is a convenience for files from anywhere. When you know where the file
  comes from, set `delimiter` and `encoding`, and check `headers` against the names you expect before you use a row.
- **Format.** RFC 4180 quotes, with `""` for a quote and line breaks inside a quoted cell. CRLF, LF and CR end a row. A row whose
  cells are all empty (a blank line, or the `;` rows a spreadsheet leaves at the end) is skipped. Every other row must be as
  wide as the header.
- **Limits.** `maxBytes` (5 MB), `maxRows` below the header (10000), `maxColumns` (100) and `maxCellLength` (10000 characters),
  each checked before the data grows. The file is decoded in memory, so keep `maxBytes` as low as the use needs.
- **Errors.** The `kind` is one of `too-large` (the file; `limit` in bytes), `cell-too-long` (`limit` in characters),
  `too-many-rows`, `too-many-columns`, `row-length` (`expected` and `actual`), `unclosed-quote` or `not-text` (a NUL byte, or
  bytes the encoding cannot decode). Each but `too-large` and `not-text` has the `line` it starts in: the physical line of the
  file, from 1, blank lines and line breaks inside quotes counted. Each has a `message` fit to show.
- **`unescape: true`** runs `unescapeCsvCell()` over the headers and every cell (see "Reading an export back" under
  [Exports](#exports)), so an exported file reads back exactly as it was written.
- **Values are only read.** Nothing in a cell is run or evaluated; `=HYPERLINK(…)` arrives as that text. The danger of a formula
  is in a file you write, which the export and `writeCsv()` escape. Validate each row like any other input before it reaches the database.

## The security model

Every endpoint starts again at the beginning. Nothing the browser sends is trusted, whatever the page showed:

| Attack | What stops it |
| --- | --- |
| A hidden column read anyway, in the props, the devtools' query log, a cursor or the CSV | Two measures: the **projection** selects only the visible columns and the key, so the column is not in the SQL, and the **props** pick only the visible columns by name, even when the base query selects more. |
| Sorting by a column you may not see: the order alone tells its values | The **allowlist**: a sort, a filter, a search or a page size the definition does not offer is a 400, never a fallback. Sorting or filtering by a hidden column is a 400 too, and the search never looks into one. |
| Another tenant's rows | The **base query**: a row action looks its row up there, a bulk action intersects with it, an export reads from it. |
| A related row of another tenant chosen through a filter, its existence told by the count | `filter.has()` takes only the table's declared relation and column, binds the value, and accepts a value of the **options of this request** only (a 400 otherwise). The options function scopes like the base query. |
| An endpoint without the page's protection | `endpoints()` hangs on the **page's route**: its middleware, bindings, checks and the `authorize` of its request. A page without what the base query needs does not compile. |
| An action or export open to anyone who sees the table | On a page whose checks are all `everyone`, with no `authorize` in its request, nothing decides who may act on a row key sent in a body: `endpoints()` refuses to load a row action, bulk action or export without `.authorize()`. |
| A value the action does not expect: a status that is none, a category of another event | `.input()`: the schema validates the body's `input` **before any row is read**, with the request's `resolve` and `ctx`, so an `exists` can be limited to the request. An `input` for an action without a schema is a 422. |
| Keys of rows you may not touch, in a bulk action's body | **Keys ∩ base query ∩ policy per row**: what is left out is counted, never acted on. |
| "All matching" as a huge or forged list | The **state** is sent, never keys, and parsed again. More rows than `max` is a 422. |
| A cell a spreadsheet runs, such as `=HYPERLINK(…)` | **Escaping** of every text cell that starts like a formula. |
| An export as a denial of service | **`max`** before the first byte, an `authorize` of its own, and a `throttle()` on the table's routes. |
| A key of the wrong type, such as text for an integer column | **Key types**: every key is parsed by its type before any query, and one that does not parse is no row. |

The [security](security.md#tables-and-exports) page puts the table's model next to the app's other defaults.

## In the browser

`useTable(props.members)` from `@marmeon/react/table` gives a component what the props allow, typed by them: only sortable columns
sort, only the table's filters filter, only its actions run. The markup is yours:

```tsx title="modules/members/views/Index.tsx"
import type { PageProps } from '@marmeon/http';
import { useTranslation } from '@marmeon/react';
import { useTable } from '@marmeon/react/table';
import type { ListMembersController } from '../controllers/ListMembersController.ts';

export default function Index({ members }: PageProps<ListMembersController>) {
  const t = useTranslation('members');
  const table = useTable(members, {
    labels: { column: (name) => t(`column.${name}`), row: (row) => row.name, action: (_action, name) => t('remove_links_of', { name }) },
  });
  const csv = table.exports.find((entry) => entry.name === 'csv');

  return (
    <main>
      <p {...table.statusProps}>{table.status}</p>
      <table>
        <caption>{t('caption')}</caption>
        <thead>
          <tr>
            <th scope="col">
              <input {...table.pageCheckboxProps()} />
            </th>
            {table.columns.map((column) => (
              <th key={column.name} {...column.headerProps}>
                {column.sortLinkProps ? <a {...column.sortLinkProps}>{column.label}</a> : column.label}
              </th>
            ))}
            <th scope="col">{t('actions')}</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.id}>
              <td>
                <input {...table.checkboxProps(row)} />
              </td>
              <th scope="row">{row.name}</th>
              <td>{row.email ?? ''}</td>
              <td>{row.joined}</td>
              <td>
                {table.can('removeLinks', row) && (
                  <button type="button" aria-label={table.actionLabel('removeLinks', row)} onClick={() => void table.run('removeLinks', row)}>
                    {t('remove_links')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => void table.runBulk('removeLinks')}>
        {t('bulk_remove', { count: table.selectedCount })}
      </button>
      {csv && (
        <a href={table.exportUrl('csv')} download>
          {t('export')}
        </a>
      )}
    </main>
  );
}
```

The example assumes the e-mail column is visible. The web app's page renders each cell from `table.columns`, so a column the user
cannot see leaves no empty cell.

A filter renderer of your own branches on `type` and renders nothing for a kind it does not know, since a minor release may add one:

```tsx title="modules/members/views/FilterField.tsx"
import type { TableFilter } from '@marmeon/table';

function FilterField({ filter }: { filter: TableFilter }) {
  switch (filter.type) {
    case 'select':
      return <select name={filter.key} defaultValue={filter.value ?? ''}>{/* … */}</select>;
    case 'dateRange':
      return <input name={filter.key} defaultValue={filter.value ?? ''} />;
    default:
      return null;
  }
}
```

- **Sorting, filtering, searching and paging** are visits of the page's URL with the props' keys and the columns' aliases:
  `table.sort('joined')`, `table.filter('locale', 'de')`, `table.filterBy({ … })`, `table.setSearch('ada')`, `table.goTo(2)`,
  `table.perPage(25)` and `table.next()` for a cursor. Only the table's prop reloads, and the server parses the state again.
  Asking for something the props do not offer throws before a request goes out, with an error code from `[marmeon:C9]` to
  `[marmeon:C12]`. Sorting, filtering and paging add a history entry. The search waits 300 milliseconds after the last keystroke
  and replaces the current history entry instead of adding one. Back after a search therefore returns to the entry before it: an
  earlier sort, filter or page, or the page you came from when the search was the table's first change. Sort links are real
  links: without JavaScript, or opened in a new tab, they work. `table.page.type` is `offset` or `cursor`, so a page knows which
  pagination to render.
- **The selection** lives with the history entry, in memory, never in `history.state` or the browser's storage. A new sort, filter
  or page starts with nothing selected, and Back brings the old selection back. Leaving the document, by signing out or after a new
  build, forgets it. `table.selectMatching()` selects every matching row, not only those on screen.
- **Actions** are [action requests](actions.md): `table.run(action, row)` and `table.runBulk(action)`, with `{ input }` for an action
  that has an [input](#an-action-with-input). Afterwards the table's prop
  reloads and **replaces** what the page had, also a merged table. A bulk action clears the selection. The action's code loads with
  the table's first run, in a chunk of its own. An action with `.confirm()` asks first, with `labels.confirm` or the run's
  `confirm` option.
- **`table.exportUrl('csv')`** is the download's URL with the table's current sort, search and filters. Use it in a link with
  `download`, not in a visit.

The web app's page works without JavaScript as well: sort links are links, the filters are a GET form, and the row and bulk actions
are plain forms that come back with a 303. The table's browser code is in the chunk of the page that imports `useTable()`, so an
app's first download carries none of it unless its first page shows a table.

A table component for another UI library builds on `TableController` and the helpers of `@marmeon/table/client` (`sortUrl`, `exportUrl`, `keyOf`, `tableStatus`), as `@marmeon/react/table` does.

### Accessible markup

`useTable()` hands out the attributes for markup that follows the WAI-ARIA Authoring Practices for sortable tables:

- A native `<table>` with a `<caption>` that names it. No `role="grid"` without real cell navigation by arrow keys.
- `aria-sort` **only** on the heading the table is sorted by, through `headerProps`. Never `none` on the others.
- The sort control is a link or a button **inside** the `<th>`, named after its column: `sortLinkProps` or `toggleSort()`.
- The cell that names the row is a `<th scope="row">`, so a screen reader says whose value a cell holds.
- The number of rows, with the sort and the page, goes into a live region: `statusProps` and `status`. What an action did goes into
  a second one, because the list's count often stays the same.
- Checkboxes and row buttons are named after their row. A button's name **starts with its visible text**, "Remove links: Ada
  Lovelace" for a button that says "Remove links", so a voice user can say what they see.
- Focus is never dropped. A control that cannot be used right now stays focusable, with `aria-disabled` and a click that does
  nothing, instead of `disabled`. A confirmation dialog gives focus back to the button that opened it.

### TanStack Table

An app that wants TanStack Table's column model, sizing or pinning keeps the server in charge with a bridge:

```tsx title="modules/members/views/Grid.tsx"
import type { PageProps } from '@marmeon/http';
import { useTable } from '@marmeon/react/table';
import { toTanStack } from '@marmeon/react/table-tanstack';
import { rowPaginationFeature, rowSelectionFeature, rowSortingFeature, tableFeatures, useTable as useTanStackTable } from '@tanstack/react-table';
import type { ListMembersController } from '../controllers/ListMembersController.ts';

const features = tableFeatures({ rowSortingFeature, rowPaginationFeature, rowSelectionFeature });

export default function Grid({ members }: PageProps<ListMembersController>) {
  const table = useTable(members);
  const tanstack = useTanStackTable(toTanStack(table, { features }));
  return <p>{tanstack.getRowModel().rows.length}</p>;
}
```

TanStack runs in manual mode: it sees one page and sorts nothing itself, and its sorting, paging and row selection go back through
`useTable()`. Install TanStack yourself with `pnpm add @tanstack/react-table@^9`. The bridge imports only its types, so TanStack
is in a bundle only where the app imports it. Define `features` at module scope, so it stays the same object between renders.

## Type checks

Mistakes in a definition are compile errors with readable messages:

```text
'emial' is not a column of the table's query — it has avatar_path, bio, created_at, email, …
'password' is a secret column — a table never reads it (its migration marked it .secret())
the key 'email' holds text — say how to read it: key: { column: 'email', type: 'string' } (or 'uuid', 'bigint')
'-email' is not a sortable column — it sorts by -name, name
'deactivat' is not an ability of this policy — it has deactivate, export, …
```

The same goes for a default sort by a hidden column, an action whose handler takes other rows than the table's or another input than its schema gives, a `.visible()`
ability that wants a row, and `attach(Table.endpoints())` on a page whose route lacks what the base query needs. A handler's `ctx` is not compared
with the base query's context, so type it as `TableContext<…>` like the query.

## Testing

A test runs an action the way the browser does, and downloads an export of any length:

```ts title="modules/members/members.test.ts"
import { UserRepository, type User } from '#modules/auth';
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('a member who is no administrator can neither sort by e-mail nor export', async () => {
  const app = await createTestApp(application, { database: 'refresh', seed: true });
  const [, alan] = (await app.make(UserRepository).query().selectAll().orderBy('id').execute()) as User[];

  await app.actingAs(alan!).navigating().get('/members?sort=password').assertStatus(400);
  await app.actingAs(alan!).navigating().get('/members?sort=email').assertStatus(400);
  await app.actingAs(alan!).get('/members/_tables/members/export/csv').assertForbidden();
});
```

`app.actingAs(user).acting().post(url, { json: { key } })` sends a row action as `useTable()` would. The [HTTP
tests](http-tests.md#making-requests) page covers requests in tests.
