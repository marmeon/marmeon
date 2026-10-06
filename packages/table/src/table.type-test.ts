import type { Authenticated } from '@bespokecore/auth';
import { describe, expectTypeOf, it } from 'vitest';
import './__fixtures__/schema.ts';
import { MemberPolicy } from './__fixtures__/policies.ts';
import { defineMiddleware, defineRequest, defineRoutes } from '@bespokecore/router';
import { action, bulk, column, defineTable, exportCsv, filter, tableRoutes, type TableContext, type TableProps } from './index.ts';

class Deactivate {
  handle(_row: { readonly id: number }, _ctx: TableContext<Authenticated>) {}
}
class DeactivateMany {
  handle(_rows: readonly { readonly id: number }[]) {}
}
class NeedsRole {
  handle(_row: { readonly role: string }) {}
}

const Members = defineTable({
  name: 'members',
  query: (db, ctx: TableContext<Authenticated>) => db.selectFrom('members').where('team_id', '=', Number(ctx.user.id)),
  key: 'id',
  columns: {
    name: column('name').sortable().searchable(),
    email: column('email').visible(MemberPolicy, 'viewEmails'),
    joined: column('created_at').sortable(),
    seen: column('last_seen_at').sortable(),
  },
  filters: { role: filter.select('role', ['admin', 'member']), joined: filter.dateRange('created_at') },
  defaultSort: '-joined',
  actions: { deactivate: action(Deactivate).authorize(MemberPolicy, 'deactivate').confirm() },
  bulk: { deactivate: bulk(DeactivateMany).authorize(MemberPolicy, 'deactivate').max(500) },
  export: { csv: exportCsv().authorize(MemberPolicy, 'export') },
});

describe('defineTable — typed from the query', () => {
  it('gives the client its rows: the columns by name, a hidden one optional, the key', () => {
    type Props = TableProps<typeof Members>;
    type Row = Props['rows'][number];
    expectTypeOf<Row['name']>().toEqualTypeOf<string>();
    expectTypeOf<Row['joined']>().toEqualTypeOf<string>();
    expectTypeOf<Row['seen']>().toEqualTypeOf<string | null>();
    expectTypeOf<Row['id']>().toEqualTypeOf<number>();
    expectTypeOf<Row['email']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Row['can']>().toEqualTypeOf<{ readonly deactivate: boolean }>();
    expectTypeOf<Props['columns'][number]['name']>().toEqualTypeOf<'name' | 'email' | 'joined' | 'seen'>();
    expectTypeOf<Props['filters'][number]['name']>().toEqualTypeOf<'role' | 'joined'>();
    expectTypeOf<Props['exports'][number]['name']>().toEqualTypeOf<'csv'>();
  });

  it('refuses what the query has not', () => {
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      // @ts-expect-error — 'emial' is not a column of the table's query
      columns: { email: column('emial') },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      // @ts-expect-error — a secret column
      columns: { password: column('password') },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      // @ts-expect-error — not a column
      key: 'uuid',
      columns: { name: column('name') },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name').sortable(), email: column('email') },
      // @ts-expect-error — not sortable
      defaultSort: '-email',
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
      // @ts-expect-error — no such column
      filters: { role: filter.select('rol', ['a']) },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
      // @ts-expect-error — the handler wants a column the rows do not have
      actions: { promote: action(NeedsRole) },
    });
    // @ts-expect-error — not an ability of the policy
    action(Deactivate).authorize(MemberPolicy, 'deactivat');
    // @ts-expect-error — a column's visibility is asked once per request: an ability without a row
    column('email').visible(MemberPolicy, 'deactivate');
  });
});

describe('the query schema and the routes', () => {
  it('types the table\'s query fields — with its prefix, its sorts, its page sizes, its filter options', () => {
    type Values = NonNullable<(typeof Members.query)['~standard']['types']>['output'];
    expectTypeOf<Values['sort']>().toEqualTypeOf<'name' | '-name' | 'joined' | '-joined' | 'seen' | '-seen'>();
    expectTypeOf<Values['page']>().toEqualTypeOf<number>();
    expectTypeOf<Values['per_page']>().toEqualTypeOf<25 | 50 | 100>();
    expectTypeOf<Values['search']>().toEqualTypeOf<string>();
    expectTypeOf<Values['filter[role]']>().toEqualTypeOf<'admin' | 'member' | undefined>();
    const Feed = defineTable({
      name: 'feed',
      prefix: 'feed',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name').sortable() },
      pagination: { perPage: [10, 20], cursor: true },
    });
    type FeedValues = NonNullable<(typeof Feed.query)['~standard']['types']>['output'];
    expectTypeOf<FeedValues>().toEqualTypeOf<{ readonly feed_sort: 'name' | '-name'; readonly feed_cursor?: string; readonly feed_per_page: 10 | 20 }>();
    // A query schema the router takes: `defineRequest({ query: Members.query })` type-checks (CheckQuery).
    defineRequest({ query: Members.query });
  });

  it('registers the endpoints only where the routes give the query what it needs', () => {
    defineRoutes((Route) => {
      const signedIn = Route.middleware(defineMiddleware<Authenticated>('auth', (_ctx, next) => next({ user: null! })));
      tableRoutes(signedIn, Members);
      // @ts-expect-error — the table's query needs ctx.user: these routes have no authenticate() before them
      tableRoutes(Route, Members);
    });
  });
});
