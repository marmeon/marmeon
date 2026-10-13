# @marmeon/table

Data tables driven by the server for Marmeon apps: typed columns, filters and sorting by allowlist, columns by policy, a strict
URL state, row and bulk actions and CSV export.

## Installation

```sh
pnpm add @marmeon/table
```

In the browser, `useTable()` of `@marmeon/react/table` renders it. TanStack Table is optional, through
`@marmeon/react/table-tanstack`, and an optional peer the app installs itself: `pnpm add @tanstack/react-table@^9`.

## A table

```ts title="modules/members/tables/MembersTable.ts"
import type { Authenticated } from '@marmeon/auth';
import { column, defineTable, filter, type TableContext } from '@marmeon/table';
import { MemberPolicy } from '../policies/MemberPolicy.ts';

export const MembersTable = defineTable({
  name: 'members',
  query: (db, _ctx: TableContext<Authenticated>) => db.selectFrom('users').where('users.email_verified_at', 'is not', null),
  key: 'users.id',
  columns: {
    name: column('users.name').sortable().searchable(),
    email: column('users.email').visible(MemberPolicy, 'viewEmails').sortable().searchable(),
    joined: column('users.created_at').sortable(),
  },
  filters: { joined: filter.dateRange('users.created_at') },
  defaultSort: 'name',
  pagination: { perPage: [10, 25, 50] },
});
```

`defineTable()` is typed from the base query's tables: a column that does not exist, a sort that is not sortable or an ability
the policy lacks is a compile error. The browser gets only the columns its user may see.

## Documentation

- [Data Tables](https://marmeon.com/docs/tables)
- [Data Tables: actions](https://marmeon.com/docs/tables#actions)
- [Data Tables: exports](https://marmeon.com/docs/tables#exports)
- [Data Tables: the security model](https://marmeon.com/docs/tables#the-security-model)
- [Data Tables: in the browser](https://marmeon.com/docs/tables#in-the-browser)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
