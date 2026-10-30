import { can, type Authenticated } from '@marmeon/auth';
import type { Database, Row } from '@marmeon/database';
import type { Serialize } from '@marmeon/http';
import { describe, expectTypeOf, it } from 'vitest';
import './__fixtures__/schema.ts';
import { MemberPolicy } from './__fixtures__/policies.ts';
import { defineMiddleware, defineRequest, defineRoutes, type HttpContext, type Next } from '@marmeon/router';
// @ts-expect-error — `RowAuthorization` is not exported
import type { RowAuthorization } from './index.ts';
// @ts-expect-error — `TableDefinition` is not exported
import type { TableDefinition } from './index.ts';
// @ts-expect-error — `TableVisibility` is not exported
import type { TableVisibility } from './index.ts';
import { rules as r } from '@marmeon/validation';
import type { AnyTableData, TableController } from './client/index.ts';
import { action, bulk, column, defineTable, exportCsv, filter, type ContextOfTable, type DataTableRow, type TableContext, type TableProps } from './index.ts';

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

describe('defineTable — authorize', () => {
  it('takes what can() returns — the snippet of the docs', () => {
    defineTable({
      name: 'members',
      query: (db, ctx: TableContext<Authenticated>) => db.selectFrom('members').where('team_id', '=', Number(ctx.user.id)),
      key: 'id',
      columns: { name: column('name') },
      authorize: can(MemberPolicy, 'viewAny'),
    });
  });

  it('takes can() with a resource the table\'s query binds', () => {
    defineTable({
      name: 'members',
      query: (db, _ctx: TableContext<Authenticated, { event: { readonly id: number } }>) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
      authorize: can(MemberPolicy, 'viewEvent', 'event'),
    });
  });

  it('refuses a check that needs a user on a table without one', () => {
    defineTable({
      name: 'members',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
      // @ts-expect-error — the table's context has no user: there is no authenticate() before it
      authorize: can(MemberPolicy, 'viewAny'),
    });
  });
});

describe('defineTable — authorize and the query string', () => {
  it('refuses a check that reads ctx.query: the page and the endpoints have another one', () => {
    defineTable({
      name: 'members',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
      // @ts-expect-error — `query` differs between the page and the table's endpoints
      authorize: (ctx) => ctx.query.get('x') === '1',
    });
  });
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

  it('serializes to props the client takes — a table without filters, actions, exports or a sortable column too', () => {
    const Minimal = defineTable({ name: 'minimal', query: (db) => db.selectFrom('members'), key: 'id', columns: { name: column('name') } });
    const takes = (_data: AnyTableData) => {};
    takes(undefined as unknown as Serialize<TableProps<typeof Minimal>>);
    takes(undefined as unknown as Serialize<TableProps<typeof Members>>);
    expectTypeOf<keyof Serialize<TableProps<typeof Minimal>>>().toEqualTypeOf<keyof TableProps<typeof Minimal>>(); // no key lost
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
      // @ts-expect-error — a text key names its type (keys are parsed by it)
      key: 'email',
      columns: { name: column('name') },
    });
    const byEmail = defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: { column: 'email', type: 'string' },
      columns: { name: column('name') },
    });
    expectTypeOf<TableProps<typeof byEmail>['rows'][number]['email']>().toEqualTypeOf<string>();
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      // @ts-expect-error — not a column
      key: { column: 'mail', type: 'string' },
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
      columns: { name: column('name').sortable(), email: column('email').visible(MemberPolicy, 'viewEmails').sortable() },
      // Type '"-email"' is not assignable to type '"'-email' is a column with .visible() — whoever may not see it would get a 400; the
      // default sort is a column everyone sees"'.
      // @ts-expect-error — a column some may not see: the default sort is everyone's
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

  it('shows and sorts by a value the base query selects — under its name, never searched or filtered', () => {
    const Teams = defineTable({
      name: 'teams',
      query: (db) => db.selectFrom('teams').withCount('members', { as: 'size' }).withCount('members'),
      key: 'teams.id',
      columns: { name: column('teams.name').sortable(), size: column('size').sortable(), members_count: column('members_count').visible(MemberPolicy, 'viewEmails') },
      defaultSort: '-size',
    });
    type Row = TableProps<typeof Teams>['rows'][number];
    expectTypeOf<Row['size']>().toEqualTypeOf<number>();
    expectTypeOf<Row['members_count']>().toEqualTypeOf<number | undefined>();
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('teams').withCount('members', { as: 'size' }),
      key: 'teams.id',
      // @ts-expect-error — a value the query selects is read under its own name
      columns: { members: column('size') },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('teams').withCount('members', { as: 'size' }),
      key: 'teams.id',
      // @ts-expect-error — the search runs in WHERE, which cannot see it
      columns: { size: column('size').searchable() },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('teams').withCount('members', { as: 'size' }),
      key: 'teams.id',
      columns: { size: column('size') },
      // @ts-expect-error — a filter runs in WHERE, which cannot see a value the query selects
      filters: { size: filter.select('size', ['1']) },
    });
  });
});

describe('filters by a relation and by options per request', () => {
  const Teams = defineTable({
    name: 'teams',
    query: (db) => db.selectFrom('teams'),
    key: 'teams.id',
    columns: { name: column('teams.name').sortable() },
    filters: {
      kind: filter.has('members', ['admin', { value: 'member', label: 'Members' }], { column: 'role' }),
      owner: filter.has('members', () => [{ value: '1', label: 'Ada' }]),
      name: filter.select('teams.name', () => ['x']),
    },
  });
  type Values = NonNullable<(typeof Teams.query)['~standard']['types']>['output'];

  it('types the URL value: the static options as a union, options computed for the request as text', () => {
    expectTypeOf<Values['filter[kind]']>().toEqualTypeOf<'admin' | 'member' | undefined>();
    expectTypeOf<Values['filter[owner]']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Values['filter[name]']>().toEqualTypeOf<string | undefined>();
  });

  it('needs options, and takes a "column" for has() only', () => {
    // @ts-expect-error — a filter without options allows nothing
    filter.has('members', []);
    // @ts-expect-error — an option is a text or { value, label }
    filter.select('role', [1]);
    // @ts-expect-error — a function must give the options, not a number
    filter.has('members', () => 1);
    // @ts-expect-error — only has() names a column of a related table
    filter.select('role', ['a'], { column: 'x' });
  });

  it('puts the options of a select or has filter into the props, with their labels', () => {
    type Filters = TableProps<typeof Teams>['filters'][number];
    expectTypeOf<Filters['name']>().toEqualTypeOf<'kind' | 'owner' | 'name'>();
    expectTypeOf<Extract<Filters, { type: 'has' }>['options']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Extract<Filters, { type: 'has' }>['labels']>().toEqualTypeOf<readonly string[]>();
  });

  it('checks the relation and the column against the query\'s tables', () => {
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('teams'),
      key: 'teams.id',
      columns: { name: column('teams.name') },
      // @ts-expect-error — no such relation
      filters: { kind: filter.has('nope', ['a']) },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('teams'),
      key: 'teams.id',
      columns: { name: column('teams.name') },
      // @ts-expect-error — a relation of members, not of teams
      filters: { kind: filter.has('team', ['a']) },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('teams'),
      key: 'teams.id',
      columns: { name: column('teams.name') },
      // @ts-expect-error — no such column in members
      filters: { kind: filter.has('members', ['a'], { column: 'nope' }) },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('teams'),
      key: 'teams.id',
      columns: { name: column('teams.name') },
      // @ts-expect-error — a secret column of the related table
      filters: { kind: filter.has('vaults', ['a'], { column: 'token' }) },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'members.id',
      columns: { name: column('members.name') },
      filters: { team: filter.has('team', ['1']), name: filter.has('team', ['a'], { column: 'name' }) },
    });
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

  it('spreads the entries of tables with filters and a cursor into another r.query()', () => {
    const Other = defineTable({
      name: 'other',
      prefix: 'b',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name').sortable() },
      filters: { kind: filter.select('role', ['x', 'y']) },
      pagination: { cursor: true },
    });
    const query = r.query({ ...Members.query.entries, ...Other.query.entries, tab: r.in(['all', 'mine']).default('all') });
    defineRequest({ query });
    type Values = NonNullable<(typeof query)['~standard']['types']>['output'];
    expectTypeOf<Values['filter[role]']>().toEqualTypeOf<'admin' | 'member' | undefined>();
    expectTypeOf<Values['b_filter[kind]']>().toEqualTypeOf<'x' | 'y' | undefined>();
    expectTypeOf<Values['b_cursor']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Values['tab']>().toEqualTypeOf<'all' | 'mine'>();
    expectTypeOf<Values['page']>().toEqualTypeOf<number>();
    // An entry is a rule for every key, never `undefined`, even for a key whose value may be.
    // @ts-expect-error — an entry is a rule, never undefined
    const cursorEntry: (typeof Other.query.entries)['b_cursor'] = undefined;
    // @ts-expect-error — an entry is a rule, never undefined
    const roleEntry: (typeof Members.query.entries)['filter[role]'] = undefined;
    void [cursorEntry, roleEntry];
    // CheckQuery still refuses a field of the page's own that cannot go back into a URL.
    // @ts-expect-error — a Date cannot go back into a URL
    defineRequest({ query: r.query({ ...Members.query.entries, since: r.string().transform((value) => new Date(value)).default(new Date(0)) }) });
  });

  it('attaches the endpoints only to a page whose route gives the query what it needs', () => {
    defineRoutes((Route) => {
      const signedIn = Route.middleware(defineMiddleware<Authenticated>('auth', (_ctx, next) => next({ user: null! })));
      signedIn.get('/members', () => 'page').attach(Members.endpoints());
      // @ts-expect-error — the table's query needs ctx.user: this page's route has no authenticate() before it
      Route.get('/members', () => 'page').attach(Members.endpoints());
    });
  });

  it('takes middleware for all endpoints and for the export, bulk and action endpoints, and nothing else', () => {
    defineRoutes((Route) => {
      const signedIn = Route.middleware(defineMiddleware<Authenticated>('auth', (_ctx, next) => next({ user: null! })));
      const limit = defineMiddleware('limit', (_ctx, next) => next());
      signedIn.get('/a', () => 'page').attach(Members.endpoints({ middleware: [limit], export: { middleware: [limit] }, bulk: { middleware: [] }, action: { middleware: [limit, limit] } }));
      // @ts-expect-error — an endpoint kind the table does not have
      signedIn.get('/b', () => 'page').attach(Members.endpoints({ exports: { middleware: [limit] } }));
      // @ts-expect-error — an unknown option next to a known one
      signedIn.get('/c', () => 'page').attach(Members.endpoints({ middleware: [limit], exports: { middleware: [limit] } }));
      class NeedsUser {
        handle(_ctx: HttpContext<Authenticated>, next: Next<{}>) {
          return next();
        }
      }
      const needsUser = NeedsUser;
      signedIn.get('/d', () => 'page').attach(Members.endpoints({ export: { middleware: [needsUser] } }));
      signedIn.get('/e', () => 'page').attach(Members.endpoints({ middleware: [needsUser] }));
      // A table whose query needs nothing: only the middleware's needs can fail these.
      const Plain = defineTable({ name: 'plain', query: (db) => db.selectFrom('members'), key: 'id', columns: { name: column('name').sortable() } });
      Route.get('/p', () => 'page').attach(Plain.endpoints());
      // @ts-expect-error — the middleware needs ctx.user, which this page's route does not have
      Route.get('/f', () => 'page').attach(Plain.endpoints({ export: { middleware: [needsUser] } }));
      // @ts-expect-error — the middleware for all endpoints needs ctx.user, too
      Route.get('/g', () => 'page').attach(Plain.endpoints({ middleware: [needsUser] }));
      // @ts-expect-error — the middleware is a list
      signedIn.get('/h', () => 'page').attach(Members.endpoints({ export: { middleware: limit } }));
    });
  });

  it('leaves the types of the table as they were', () => {
    expectTypeOf<ContextOfTable<typeof Members>>().toEqualTypeOf<TableContext<Authenticated>>();
    expectTypeOf<TableProps<typeof Members>['page']>().toHaveProperty('perPage');
  });
});

export type Hidden = [RowAuthorization, TableDefinition, TableVisibility];

describe('defineTable — a query on its module\'s Database', () => {
  it('takes Database<\'directory\'> and still types the columns from the query', () => {
    const Table = defineTable({
      name: 'members',
      query: (db: Database<'directory'>, ctx: TableContext<Authenticated>) => db.selectFrom('members').where('team_id', '=', Number(ctx.user.id)),
      key: 'id',
      columns: { name: column('name').sortable() },
    });
    expectTypeOf<DataTableRow<typeof Table>>().toEqualTypeOf<{ readonly id: number; readonly name: string }>();
    defineTable({
      name: 'members',
      query: (db: Database<'directory'>) => db.selectFrom('members'),
      key: 'id',
      // @ts-expect-error — the table has no column `nope`
      columns: { nope: column('nope') },
    });
  });

  it('reads the tables another module exposes, and no others', () => {
    defineTable({
      name: 'teams',
      query: (db: Database<'billing'>) => db.selectFrom('teams'),
      key: 'id',
      columns: { name: column('name') },
    });
    defineTable({
      name: 'members',
      // @ts-expect-error — `members` is no table of the billing module, and the directory module does not expose it
      query: (db: Database<'billing'>) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
    });
    defineTable({
      name: 'members',
      // @ts-expect-error — the same for a join
      query: (db: Database<'billing'>) => db.selectFrom('ledger').innerJoin('members', 'members.id', 'ledger.id'),
      key: 'id',
      columns: { note: column('note') },
    });
  });

  it('leaves a query without an annotation seeing every table', () => {
    defineTable({
      name: 'members',
      query: (db) => db.selectFrom('members').innerJoin('ledger', 'ledger.id', 'members.id'),
      key: 'members.id',
      columns: { note: column('ledger.note') },
    });
  });

  it('refuses a context that is none and a db that reads nothing', () => {
    defineTable({
      name: 'members',
      // @ts-expect-error — `ctx` is a TableContext
      query: (db, ctx: { tenant: number }) => db.selectFrom('members').where('team_id', '=', ctx.tenant),
      key: 'id',
      columns: { name: column('name') },
    });
    defineTable({
      name: 'members',
      // @ts-expect-error — `db` is a database
      query: (db: { tenant: number }) => (db as never as Database).selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
    });
  });

  it('types the route parameters a query reads', () => {
    defineTable({
      name: 'members',
      query: (db: Database<'directory'>, ctx: TableContext<Authenticated, { team: Row<'teams'> }>) => db.selectFrom('members').where('team_id', '=', ctx.params.team.id),
      key: 'id',
      columns: { name: column('name') },
    });
    defineTable({
      name: 'members',
      // @ts-expect-error — the parameter `team` has no column `nope`
      query: (db: Database<'directory'>, ctx: TableContext<Authenticated, { team: Row<'teams'> }>) => db.selectFrom('members').where('team_id', '=', ctx.params.team.nope),
      key: 'id',
      columns: { name: column('name') },
    });
  });
});


class SetRole {
  handle(_row: { readonly id: number }, _ctx: unknown, _input: { readonly role: 'admin' | 'member' }) {}
}
class SetRoles {
  handle(_rows: readonly { readonly id: number }[], _ctx: unknown, _input: { readonly role: 'admin' | 'member' }) {}
}
class WantsInput {
  handle(_row: { readonly id: number }, _ctx: unknown, _input: { readonly role: string }) {}
}
class WantsOtherInput {
  handle(_row: { readonly id: number }, _ctx: unknown, _input: { readonly team: number }) {}
}

const roleInput = r.object({ role: r.in(['admin', 'member']) });

const WithInput = defineTable({
  name: 'with-input',
  query: (db, ctx: TableContext<Authenticated>) => db.selectFrom('members').where('team_id', '=', Number(ctx.user.id)),
  key: 'id',
  columns: { name: column('name') },
  actions: { setRole: action(SetRole).input(roleInput), plain: action(Deactivate), built: action(SetRole).input(async () => roleInput) },
  bulk: { setRole: bulk(SetRoles).input(roleInput), plain: bulk(DeactivateMany) },
});

describe('actions with input', () => {
  type Props = TableProps<typeof WithInput>;
  type Inputs = NonNullable<Props['~inputs']>;

  it('carries the schema\'s input type per action that takes one — a function building the schema too', () => {
    expectTypeOf<Inputs['actions']>().toEqualTypeOf<{ setRole: { role: 'admin' | 'member' }; built: { role: 'admin' | 'member' } }>();
    expectTypeOf<keyof Inputs['bulk']>().toEqualTypeOf<'setRole'>();
  });

  it('leaves input optional on an untyped controller — run(name, row) and runBulk(name) still compile', () => {
    const untyped = undefined as unknown as TableController;
    const row = undefined as unknown as AnyTableData['rows'][number];
    void untyped.run('anything', row);
    void untyped.runBulk('anything');
    void untyped.run('anything', row, { input: { any: 1 } });
    void untyped.runBulk('anything', { input: 1 });
  });

  it('serializes to props the client takes', () => {
    const takes = (_data: AnyTableData) => {};
    takes(undefined as unknown as Serialize<Props>);
  });

  it('requires the input of an action that has one, and refuses it for one that has none (client)', () => {
    const table = undefined as unknown as TableController<Props>;
    const row = undefined as unknown as Props['rows'][number];
    void table.run('setRole', row, { input: { role: 'admin' } });
    void table.run('plain', row);
    void table.runBulk('setRole', { input: { role: 'member' } });
    void table.runBulk('plain', { confirm: 'sure?' });
    // @ts-expect-error — the action takes an input
    void table.run('setRole', row);
    // @ts-expect-error — a role that is none
    void table.run('setRole', row, { input: { role: 'owner' } });
    // @ts-expect-error — the action takes no input
    void table.run('plain', row, { input: { role: 'admin' } });
    // @ts-expect-error — the bulk action takes an input
    void table.runBulk('setRole');
    // @ts-expect-error — the bulk action takes no input
    void table.runBulk('plain', { input: {} });
  });

  it('checks the handler\'s input against the schema\'s output, and refuses a handler that wants one the action has not', () => {
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
      // @ts-expect-error — the handler takes a team, the schema gives a role
      actions: { setRole: action(WantsOtherInput).input(roleInput) },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
      // @ts-expect-error — the handler takes an input, the action has no .input()
      actions: { setRole: action(WantsInput) },
    });
    defineTable({
      name: 'x',
      query: (db) => db.selectFrom('members'),
      key: 'id',
      columns: { name: column('name') },
      // @ts-expect-error — the handler takes an input, the bulk action has no .input()
      bulk: { setRole: bulk(SetRoles) },
    });
    defineTable({ name: 'x', query: (db) => db.selectFrom('members'), key: 'id', columns: { name: column('name') }, actions: { ok: action(WantsInput).input(r.object({ role: r.string() })) } });
  });

  it('takes a schema or a function building one, and nothing else', () => {
    // @ts-expect-error — a number is no schema
    action(Deactivate).input(42);
  });
});
