import { can, Gate, type Auth, type Authenticated } from '@marmeon/auth';
import { createApplication, defineModule, Logger, Translator, type Application } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Repository, sql, type QueryEvent } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { Controller, defineRequest, HttpServiceProvider, type ContextOf } from '@marmeon/http';
import { IncomingRequest, PROTOCOL_VERSION } from '@marmeon/http/internal';
import { defineMiddleware, type HttpContext } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { rules as r } from '@marmeon/validation';
import { action, bulk, column, defineTable, exportCsv, filter, DataTables, TableServiceProvider, type DataTable, type TableContext, type TableExportInfo } from '../index.ts';
import { EmailPolicy, MemberPolicy } from './policies.ts';
import { openRoutes } from '../test-helpers/open-routes.ts';
import './schema.ts';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`). */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
export const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);
export type TestDriver = (typeof drivers)[number];

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;

export interface TestUser {
  id: number;
  name: string;
  email: string;
  team: number;
  admin?: boolean;
  exporter?: boolean;
}

/** Who acts (the `x-test-user` header): Ada and Alan of team 1 (Ada an admin), Edsger exports without seeing e-mails, Mallory of team 2. */
export const USERS: Readonly<Record<number, TestUser>> = {
  1: { id: 1, name: 'Ada', email: 'ada@example.com', team: 1, admin: true },
  2: { id: 2, name: 'Alan', email: 'alan@example.com', team: 1 },
  4: { id: 4, name: 'Edsger', email: 'edsger@example.com', team: 1, exporter: true },
  9: { id: 9, name: 'Mallory', email: 'mallory@example.com', team: 2 },
};

/** The request's user, from `x-test-user` — and the team in the URL must be theirs (the tenant). */
export const acting = defineMiddleware<Authenticated & { team: number }>('acting', (ctx, next) => {
  const user = USERS[Number(ctx.request.headers.get('x-test-user'))];
  if (!user) return new Response('Unauthorized', { status: 401 });
  const team = Number((ctx.params as { team?: string }).team);
  if (team !== user.team) return new Response('Not Found', { status: 404 });
  return next({ user: user as never, team });
}, { adds: ['user', 'team'] });

/** What the actions did — one per app (the container's singleton). */
export class Recorder {
  readonly deactivated: unknown[] = [];
  readonly batches: unknown[][] = [];
  /** What the actions with input got: `[the keys, the validated input]`. */
  readonly inputs: [unknown[], unknown][] = [];
  /** What the export recorder got: `[the info, the request's route parameters]`. */
  readonly exports: [TableExportInfo, unknown][] = [];
  /** Makes the export recorder throw. */
  failExport = false;
}

/** A row action: records the row's key. */
export class Deactivate {
  readonly #recorder: Recorder;

  constructor(recorder: Recorder) {
    this.#recorder = recorder;
  }

  handle(row: { readonly id: number }) {
    this.#recorder.deactivated.push(row.id);
  }
}

/** An export recorder: writes down what it was told, and fails when the test says so. */
export class RecordExport {
  readonly #recorder: Recorder;

  constructor(recorder: Recorder) {
    this.#recorder = recorder;
  }

  async handle(info: TableExportInfo, ctx: { params: unknown }) {
    await Promise.resolve(); // an audit log is written asynchronously
    if (this.#recorder.failExport) throw new Error('the audit log is down');
    this.#recorder.exports.push([info, ctx.params]);
  }
}

/** A bulk action: records the keys it got. */
export class DeactivateMany {
  readonly #recorder: Recorder;

  constructor(recorder: Recorder) {
    this.#recorder = recorder;
  }

  handle(rows: readonly { readonly id: number }[]) {
    this.#recorder.batches.push(rows.map((row) => row.id));
    return { last: rows.at(-1)?.id };
  }
}

type TeamContext = TableContext<Authenticated & { team: number }>;

/** The teams — what `exists` asks for an action's input. */
export class TeamRepository extends Repository<'teams'> {
  static table = 'teams' as const;
}

/** A row action with input: writes the role it was given. */
export class SetRole {
  readonly #recorder: Recorder;
  readonly #connections: Connections;

  constructor(recorder: Recorder, connections: Connections) {
    this.#recorder = recorder;
    this.#connections = connections;
  }

  async handle(row: { readonly id: number }, _ctx: unknown, input: { readonly role: 'admin' | 'member' }) {
    this.#recorder.inputs.push([[row.id], input]);
    await this.#connections.get().updateTable('members').set({ role: input.role }).where('id', '=', row.id).execute();
  }
}

/** A bulk action with input: writes the role it was given to every row. */
export class SetRoles {
  readonly #recorder: Recorder;
  readonly #connections: Connections;

  constructor(recorder: Recorder, connections: Connections) {
    this.#recorder = recorder;
    this.#connections = connections;
  }

  async handle(rows: readonly { readonly id: number }[], _ctx: unknown, input: { readonly role: 'admin' | 'member' }) {
    const ids = rows.map((row) => row.id);
    this.#recorder.inputs.push([ids, input]);
    await this.#connections.get().updateTable('members').set({ role: input.role }).where('id', 'in', ids).execute();
  }
}

/** A bulk action whose input names a team: writes it as the rows' team. */
export class MoveToTeam {
  readonly #recorder: Recorder;
  readonly #connections: Connections;

  constructor(recorder: Recorder, connections: Connections) {
    this.#recorder = recorder;
    this.#connections = connections;
  }

  async handle(rows: readonly { readonly id: number }[], _ctx: unknown, input: { readonly team: number }) {
    const ids = rows.map((row) => row.id);
    this.#recorder.inputs.push([ids, input]);
    await this.#connections.get().updateTable('members').set({ team_id: input.team }).where('id', 'in', ids).execute();
  }
}

/** A row action of the text-keyed table: records the key. */
export class DeactivateByEmail {
  readonly #recorder: Recorder;

  constructor(recorder: Recorder) {
    this.#recorder = recorder;
  }

  handle(row: { readonly email: string }) {
    this.#recorder.deactivated.push(row.email);
    // A handler's own response reaches the client as it is.
    if (row.email === 'edsger@example.com') return new Response('teapot', { status: 418 });
  }
}

/** The team's members — the tenant is the base query. */
export const MembersTable = defineTable({
  name: 'members',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: {
    name: column('members.name').sortable().searchable(),
    email: column('members.email').visible(MemberPolicy, 'viewEmails').sortable().searchable(),
    role: column('members.role'),
    joined: column('members.created_at').sortable(),
    seen: column('members.last_seen_at').sortable(),
  },
  filters: { role: filter.select('members.role', ['admin', 'member']), joined: filter.dateRange('members.created_at') },
  defaultSort: 'name',
  pagination: { perPage: [2, 10] },
  actions: { deactivate: action(Deactivate).visible(MemberPolicy, 'manage').authorize(MemberPolicy, 'deactivate').confirm() },
  bulk: { deactivate: bulk(DeactivateMany).visible(MemberPolicy, 'manage').authorize(MemberPolicy, 'deactivate').max(5) },
  export: { csv: exportCsv().authorize(MemberPolicy, 'export') },
});

/** The same members, paged by an encrypted cursor ("load more"). */
const feed = (name: string) =>
  defineTable({
    name,
    prefix: 'feed',
    query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
    key: 'members.id',
    columns: { name: column('members.name').sortable(), seen: column('members.last_seen_at').sortable() },
    defaultSort: '-seen',
    pagination: { perPage: 2, cursor: true },
  });
export const FeedTable = feed('feed');

/** Another list with the same order and the same keys: a cursor of the feed is no cursor of this one. */
export const FeedCopyTable = feed('feed-copy');

/** A base query that selects a column itself (it should not): the props still carry only the visible columns. */
export const LeakyTable = defineTable({
  name: 'leaky',
  query: (db, ctx: TeamContext) => db.selectFrom('members').select(['members.email']).where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: {
    name: column('members.name').sortable(),
    email: column('members.email').visible(MemberPolicy, 'viewEmails'),
    joined: column('members.created_at').visible(MemberPolicy, 'viewEmails'),
  },
  // A filter without a visibility of its own, on a column some may not see (named without its table): hidden with the column.
  filters: { since: filter.dateRange('created_at') },
});

/** One column of every cell form the CSV export writes: text, integer, decimal, boolean, time, JSON, a formula-like text. */
export const LedgerTable = defineTable({
  name: 'ledger',
  query: (db, _ctx: TeamContext) => db.selectFrom('ledger'),
  key: 'ledger.id',
  columns: {
    note: column('ledger.note').label('Note').sortable(),
    qty: column('ledger.qty'),
    amount: column('ledger.amount'),
    paid: column('ledger.paid'),
    booked: column('ledger.booked_at'),
    meta: column('ledger.meta'),
    formula: column('ledger.formula'),
  },
  defaultSort: 'note',
  export: {
    csv: exportCsv().authorize(() => true),
    semicolon: exportCsv().authorize(() => true).delimiter(';'),
    tab: exportCsv().authorize(() => true).delimiter('\t'),
  },
});

/** Headings in the request's language (`x-test-locale`), and the separator that follows it: a semicolon for German. */
export const LocalizedTable = defineTable({
  name: 'localized',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: {
    name: column('members.name').label((t) => t('columns.name')).sortable(),
    // A translation that is a formula: the heading goes through the same escape as a cell.
    role: column('members.role').label((t) => t('columns.role')),
    plain: column('members.email').label('E-mail'),
    bare: column('members.created_at'),
  },
  defaultSort: 'name',
  export: {
    csv: exportCsv().authorize(() => true).delimiter((_ctx, _resolve, translator) => (translator?.locale === 'de' ? ';' : ',')),
    // From the request's own context: administrators get a semicolon.
    byUser: exportCsv().authorize(() => true).delimiter((ctx) => (ctx.user.admin ? ';' : ',')),
    wrong: exportCsv().authorize(() => true).delimiter(() => '|' as never).onExport(RecordExport),
  },
});

export const LocalizedRequest = defineRequest({ query: LocalizedTable.query });

export class LocalizedPage extends Controller {
  static request = LocalizedRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof LocalizedRequest> & Authenticated & { team: number }) {
    return this.json({ localized: await this.#tables.resolve(LocalizedTable, ctx) });
  }
}

/** Exports of at most three rows — the limit refuses, it never cuts. */
export const SmallExportTable = defineTable({
  name: 'small',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable() },
  export: { csv: exportCsv().max(3).authorize(() => true) },
});

/** Exports that record themselves: one of any size, one limited to three rows. */
export const AuditedTable = defineTable({
  name: 'audited',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable().searchable(), email: column('members.email').visible(MemberPolicy, 'viewEmails') },
  filters: { role: filter.select('members.role', ['admin', 'member']) },
  export: {
    csv: exportCsv().authorize(MemberPolicy, 'export').onExport(RecordExport),
    small: exportCsv().max(3).authorize(() => true).onExport(RecordExport),
  },
});

/** Sorted by a boolean column (with NULLs) — exported in batches by its keyset. */
export const ActiveTable = defineTable({
  name: 'active',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable().searchable(), active: column('members.active').sortable() },
  export: { csv: exportCsv().authorize(() => true) },
});

/** Only admins see it: the table's own `authorize` is a policy's ability, asked by `can()`. */
export const GuardedTable = defineTable({
  name: 'guarded',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable() },
  authorize: can(MemberPolicy, 'viewAny'),
  actions: { deactivate: action(Deactivate).authorize(MemberPolicy, 'deactivate') },
  bulk: { deactivate: bulk(DeactivateMany).authorize(MemberPolicy, 'deactivate').max(5) },
  export: { csv: exportCsv().authorize(() => true) },
});

export const GuardedRequest = defineRequest({ query: GuardedTable.query });

export class GuardedPage extends Controller {
  static request = GuardedRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof GuardedRequest> & Authenticated & { team: number }) {
    return this.json({ guarded: await this.#tables.resolve(GuardedTable, ctx) });
  }
}

/** How often an input schema was built — a factory that runs for a request that was not let on has told it something. */
export const inputFactories = { calls: 0 };

/** Actions that take input: a role from a list, and a team the request's own team has to be (`exists` with a `where` on the request). */
export const InputTable = defineTable({
  name: 'input',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable(), role: column('members.role') },
  defaultSort: 'name',
  // Edsger is refused by the table itself.
  authorize: (ctx) => (ctx as unknown as { user: { id: number } }).user.id !== 4,
  actions: {
    // Visible to administrators only; its schema is built per request and counted.
    hiddenRole: action(SetRole)
      .authorize(MemberPolicy, 'act')
      .visible((ctx: { user: { admin?: boolean } }) => ctx.user.admin === true)
      .input(() => {
        inputFactories.calls++;
        return r.object({ role: r.in(['admin', 'member']) });
      }),
    setRole: action(SetRole).authorize(MemberPolicy, 'act').input(r.object({ role: r.in(['admin', 'member']) })),
    deactivate: action(Deactivate).authorize(MemberPolicy, 'act'),
  },
  bulk: {
    setRole: bulk(SetRoles).authorize(MemberPolicy, 'act').input(r.object({ role: r.in(['admin', 'member']) })).max(5),
    moveToTeam: bulk(MoveToTeam)
      .authorize(MemberPolicy, 'act')
      .input(() => {
        inputFactories.calls++;
        return r.object({
          team: r.integer().exists(TeamRepository, 'id', { where: (query, ctx: HttpContext<Authenticated & { team: number }>) => query.where('id', '=', ctx.team) }),
        });
      })
      .max(5),
    hiddenMove: bulk(MoveToTeam)
      .authorize(MemberPolicy, 'act')
      .visible((ctx: { user: { admin?: boolean } }) => ctx.user.admin === true)
      .input(() => {
        inputFactories.calls++;
        return r.object({ team: r.integer().exists(TeamRepository, 'id') });
      }),
    deactivate: bulk(DeactivateMany).authorize(MemberPolicy, 'act'),
  },
});

/** Keyed by text (the e-mail): keys are parsed as text, never as numbers. */
export const ByEmailTable = defineTable({
  name: 'by-email',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: { column: 'members.email', type: 'string' },
  columns: { name: column('members.name').sortable() },
  actions: { deactivate: action(DeactivateByEmail).authorize(EmailPolicy, 'deactivate') },
});

/** A base query that loads a relation: the table pages it like any other query. */
export const WithTeamTable = defineTable({
  name: 'with-team',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team).with('team', (team) => team.select('name')),
  key: 'members.id',
  columns: { name: column('members.name').sortable() },
  defaultSort: 'name',
});

/** The teams with their number of members — values the base query selects (`withCount`), shown and sorted by their names. */
export const TeamsTable = defineTable({
  name: 'teams',
  query: (db, _ctx: TeamContext) =>
    db
      .selectFrom('teams')
      .withCount('members', { as: 'size' })
      .withCount('members', { as: 'admins' }, (members) => members.where('role', '=', 'admin')),
  key: 'teams.id',
  columns: {
    name: column('teams.name').sortable(),
    size: column('size').sortable(),
    admins: column('admins').visible(MemberPolicy, 'viewEmails').sortable(),
  },
  defaultSort: 'name',
  export: { csv: exportCsv().authorize(MemberPolicy, 'export') },
});

/** How often the options below were computed, and with which route parameters — computed for a request that was not let on, they have told it something. */
export const filterOptions = { calls: 0, params: [] as unknown[] };

/**
 * Teams filtered by the members they have: the options are the names of the request's own team, so another team's member is no option.
 * The role filter offers `admin` to administrators only.
 */
export const TeamFilterTable = defineTable({
  name: 'team-filter',
  query: (db, _ctx: TeamContext) => db.selectFrom('teams'),
  key: 'teams.id',
  columns: { name: column('teams.name').sortable() },
  defaultSort: 'name',
  authorize: (ctx) => (ctx as unknown as { user: { id: number } }).user.id !== 4,
  filters: {
    member: filter.has(
      'members',
      async (resolve, ctx: TeamContext & { params: { team: string } }) => {
        filterOptions.calls++;
        filterOptions.params.push(ctx.params.team);
        const rows = await resolve(Connections).get().selectFrom('members').select(['name', 'email', 'team_id']).where('team_id', '=', ctx.team).orderBy('name').execute();
        // A row spread into the option: what else it carries (the e-mail) must not reach the props.
        return rows.map((row) => ({ ...row, value: row.name, label: `Member ${row.name}` }));
      },
      { column: 'name' },
    ),
    ada: filter.has('members', ['Ada', 'Mallory'], { column: 'name' }),
    role: filter.has('members', (_resolve, ctx: TeamContext) => ((ctx.user as unknown as TestUser).admin ? ['admin', 'member'] : ['member']), { column: 'role' }),
    hidden: filter.has('members', ['Ada'], { column: 'name' }).visible((ctx: { user: { admin?: boolean } }) => ctx.user.admin === true),
  },
  bulk: { touch: bulk(DeactivateMany).authorize(MemberPolicy, 'act').max(5) },
  export: { csv: exportCsv().authorize(() => true) },
});

/** Members filtered by an own-team option list on a column of the table itself (`select` with options per request). */
export const RoleOptionsTable = defineTable({
  name: 'role-options',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable(), role: column('members.role') },
  defaultSort: 'name',
  filters: { role: filter.select('members.role', (_resolve, ctx: TeamContext) => ((ctx.user as unknown as TestUser).admin ? [{ value: 'admin', label: 'Administrators' }, 'member'] : ['member'])) },
});

/** An action, a bulk action and an export that each decide for themselves — registered with middleware per endpoint. */
export const ProbedTable = defineTable({
  name: 'probed',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable() },
  actions: { deactivate: action(Deactivate).authorize(MemberPolicy, 'deactivate') },
  bulk: { deactivate: bulk(DeactivateMany).authorize(MemberPolicy, 'deactivate').max(5) },
  export: { csv: exportCsv().authorize(MemberPolicy, 'export').onExport(RecordExport) },
});

export const MembersRequest = defineRequest({ query: MembersTable.query });
export const FeedRequest = defineRequest({ query: FeedTable.query });
export const LeakyRequest = defineRequest({ query: LeakyTable.query });
export const WithTeamRequest = defineRequest({ query: WithTeamTable.query });
export const TeamsRequest = defineRequest({ query: TeamsTable.query });
export const TeamFilterRequest = defineRequest({ query: TeamFilterTable.query });
export const RoleOptionsRequest = defineRequest({ query: RoleOptionsTable.query });

/** The page: the table as JSON (the page protocol is the http package's — here the prop alone). */
export class MembersPage extends Controller {
  static request = MembersRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof MembersRequest> & Authenticated & { team: number }) {
    return this.json({ members: await this.#tables.resolve(MembersTable, ctx) });
  }
}

export class FeedPage extends Controller {
  static request = FeedRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof FeedRequest> & Authenticated & { team: number }) {
    return this.json({ feed: await this.#tables.resolve(FeedTable, ctx) });
  }
}

export class FeedCopyPage extends Controller {
  static request = FeedRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof FeedRequest> & Authenticated & { team: number }) {
    return this.json({ feed: await this.#tables.resolve(FeedCopyTable, ctx) });
  }
}

export class LeakyPage extends Controller {
  static request = LeakyRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof LeakyRequest> & Authenticated & { team: number }) {
    return this.json({ leaky: await this.#tables.resolve(LeakyTable, ctx) });
  }
}

export class WithTeamPage extends Controller {
  static request = WithTeamRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof WithTeamRequest> & Authenticated & { team: number }) {
    return this.json({ members: await this.#tables.resolve(WithTeamTable, ctx) });
  }
}

export class TeamFilterPage extends Controller {
  static request = TeamFilterRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof TeamFilterRequest> & Authenticated & { team: number }) {
    return this.json({ teams: await this.#tables.resolve(TeamFilterTable, ctx) });
  }
}

export class RoleOptionsPage extends Controller {
  static request = RoleOptionsRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof RoleOptionsRequest> & Authenticated & { team: number }) {
    return this.json({ members: await this.#tables.resolve(RoleOptionsTable, ctx) });
  }
}

export class TeamsPage extends Controller {
  static request = TeamsRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof TeamsRequest> & Authenticated & { team: number }) {
    return this.json({ teams: await this.#tables.resolve(TeamsTable, ctx) });
  }
}

/** The export, answered from inside a transaction the controller opened — its later batches run after it finished. */
export class ExportInTransaction extends Controller {
  readonly #tables: DataTables;
  readonly #connections: Connections;

  constructor(tables: DataTables, connections: Connections) {
    super();
    this.#tables = tables;
    this.#connections = connections;
  }

  handle(ctx: HttpContext<Authenticated & { team: number }>) {
    return this.#connections.transaction(() => this.#tables.export(MembersTable.definition, 'csv', ctx as unknown as HttpContext));
  }
}

/** A page that forgot the table's query schema. */
export class NoSchemaPage extends Controller {
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: HttpContext<Authenticated & { team: number }>) {
    return this.json({ members: await this.#tables.resolve(MembersTable, ctx) });
  }
}

/** The members table on a page whose request, not its registrar, holds the admin check: the endpoints have to carry it. */
export const AdminMembersRequest = defineRequest({
  query: MembersTable.query,
  authorize: (ctx) => (ctx as unknown as { user: TestUser }).user.admin === true,
});

export class AdminMembersPage extends Controller {
  static request = AdminMembersRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof AdminMembersRequest> & Authenticated & { team: number }) {
    return this.json({ members: await this.#tables.resolve(MembersTable, ctx) });
  }
}

/** No `.authorize()` on its action, bulk action or export, and none on the table: the page's request alone says who may use it. */
export const AdminOnlyTable = defineTable({
  name: 'admin-only',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable() },
  actions: { deactivate: action(Deactivate) },
  bulk: { deactivate: bulk(DeactivateMany).max(5) },
  export: { csv: exportCsv().onExport(RecordExport) },
});

/** The admin check sits in the request of the page alone — not on the registrar, not on the table. */
export const AdminOnlyRequest = defineRequest({
  query: AdminOnlyTable.query,
  authorize: (ctx) => (ctx as unknown as { user: TestUser }).user.admin === true,
});

export class AdminOnlyPage extends Controller {
  static request = AdminOnlyRequest;
  readonly #tables: DataTables;

  constructor(tables: DataTables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof AdminOnlyRequest> & Authenticated & { team: number }) {
    return this.json({ adminOnly: await this.#tables.resolve(AdminOnlyTable, ctx) });
  }
}

/** A page that shows nothing: it only gives a table with endpoints a route to hang them on. */
export class StubPage extends Controller {
  handle() {
    return this.json({});
  }
}

/** The pages the tables are attached to in the app, by the table's name — the endpoints are under them. */
const PAGE_PATHS: Readonly<Record<string, string>> = {
  members: '/members',
  feed: '/feed',
  'feed-copy': '/feed-copy',
  leaky: '/leaky',
  'with-team': '/with-team',
  teams: '/teams',
  'team-filter': '/team-filter',
  'role-options': '/role-options',
  ledger: '/ledger',
  small: '/small',
  audited: '/audited',
  'by-email': '/by-email',
  localized: '/localized',
  guarded: '/guarded',
  active: '/active',
  input: '/input',
  probed: '/probed',
  'admin-only': '/admin-only',
};

/** The URL of an endpoint of `table` in the app, for the page the table is attached to: `endpoint(MembersTable, 'action', 'deactivate')`. */
export function endpoint(table: DataTable, kind: 'action' | 'bulk' | 'export', name: string, team = 1): string {
  const page = PAGE_PATHS[table.definition.name];
  if (page === undefined) throw new Error(`The fixture app has no page for the table '${table.definition.name}'.`);
  const segment = kind === 'action' ? 'actions' : kind === 'bulk' ? 'bulk' : 'export';
  return `/teams/${team}${page}/_tables/${table.definition.name}/${segment}/${name}`;
}

const routes = openRoutes((Route) => {
  const team = Route.prefix('/teams/:team').middleware(acting);
  team.get('/members', MembersPage).attach(MembersTable.endpoints());
  // The same table on a second page, whose request decides who may see it: its endpoints answer only an admin of the team.
  team.prefix('/in/:role').get('/members', AdminMembersPage).attach(MembersTable.endpoints());
  team.get('/feed', FeedPage).attach(FeedTable.endpoints());
  team.get('/feed-copy', FeedCopyPage).attach(FeedCopyTable.endpoints());
  team.get('/leaky', LeakyPage).attach(LeakyTable.endpoints());
  team.get('/with-team', WithTeamPage).attach(WithTeamTable.endpoints());
  team.get('/teams', TeamsPage).attach(TeamsTable.endpoints());
  team.get('/team-filter', TeamFilterPage).attach(TeamFilterTable.endpoints());
  team.get('/role-options', RoleOptionsPage).attach(RoleOptionsTable.endpoints());
  // Reads the table without a query schema in its request.
  team.get('/no-schema', NoSchemaPage).attach(MembersTable.endpoints());
  team.get('/export-in-transaction', ExportInTransaction);
  team.get('/ledger', StubPage).attach(LedgerTable.endpoints());
  team.get('/small', StubPage).attach(SmallExportTable.endpoints());
  team.get('/audited', StubPage).attach(AuditedTable.endpoints());
  team.get('/by-email', StubPage).attach(ByEmailTable.endpoints());
  team.get('/localized', LocalizedPage).attach(LocalizedTable.endpoints());
  team.get('/guarded', GuardedPage).attach(GuardedTable.endpoints());
  team.get('/active', StubPage).attach(ActiveTable.endpoints());
  team.get('/input', StubPage).attach(InputTable.endpoints());
  // A parameter in the page's path: the endpoints under it carry it, too.
  team.get('/views/:view', MembersPage).attach(MembersTable.endpoints());
  team.get('/admin-only', AdminOnlyPage).attach(AdminOnlyTable.endpoints());
  team.middleware(traced('registrar')).get('/probed', StubPage).attach(
    ProbedTable.endpoints({
      export: { middleware: [traced('export-first'), traced('export-second')] },
      bulk: { middleware: [traced('bulk')] },
      action: { middleware: [traced('action')] },
    }),
  );
  // A path that holds the word `export`: the middleware follows the kind of endpoint, not the path. `all` runs on every kind.
  team.prefix('/export').middleware(traced('registrar')).get('/', StubPage).attach(ProbedTable.endpoints({ middleware: [traced('all')], export: { middleware: [traced('export-first')] } }));
});

export interface TableTestApp {
  readonly application: Application;
  readonly connections: Connections;
  readonly recorder: Recorder;
  /** Every query since the app started (or since `queries.length = 0`). */
  readonly queries: QueryEvent[];
  request(path: string, init?: { user?: number; method?: string; json?: unknown; action?: boolean; form?: string; headers?: Record<string, string> }): Promise<Response>;
  insert(rows: readonly Partial<{ id: number; team_id: number; name: string; email: string; role: string; created_at: string; last_seen_at: string | null; active: boolean | null }>[]): Promise<void>;
  close(): Promise<void>;
}

/** A fresh database per app: SQLite in memory, or a new Postgres database (dropped by `close()`). */
async function freshDatabase(driver: TestDriver): Promise<{ env: Record<string, string>; drop: () => Promise<void> }> {
  if (driver === 'sqlite') return { env: { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:' }, drop: async () => {} };
  const name = `marmeon_test_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  return {
    env: { DB_MANAGED: 'false', DB_DRIVER: 'pgsql', DB_URL: url.href, DB_POOL_MAX: '3' },
    drop: async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    },
  };
}

/** Which middleware ran for a request to the endpoints of `ProbedTable`, in order. Cleared by the test that reads it. */
export const endpointTrace: string[] = [];

/**
 * Middleware that writes its name to `endpointTrace`; answers 429 when `x-test-block` names it and throws when `x-test-throw` does.
 */
export const traced = (name: string) =>
  defineMiddleware(`traced-${name}`, (ctx, next) => {
    endpointTrace.push(name);
    if (ctx.request.headers.get('x-test-block') === name) return new Response('Too Many Requests', { status: 429 });
    if (ctx.request.headers.get('x-test-throw') === name) throw new Error(`${name} failed`);
    return next();
  });

/** The team members of every test: Ada, Alan, Grace (protected by the policy) and Edsger in team 1, Mallory in team 2. */
export const MEMBERS = [
  { id: 1, team_id: 1, name: 'Ada', email: 'ada@example.com', role: 'admin', created_at: '2026-01-10 09:00:00', last_seen_at: '2026-10-01 10:00:00' },
  { id: 2, team_id: 1, name: 'Alan', email: 'alan@example.com', role: 'member', created_at: '2026-02-10 09:00:00', last_seen_at: null },
  { id: 3, team_id: 1, name: 'Grace', email: 'grace@example.com', role: 'member', created_at: '2026-03-10 09:00:00', last_seen_at: '2026-10-03 10:00:00' },
  { id: 4, team_id: 1, name: 'Edsger', email: 'edsger@example.com', role: 'member', created_at: '2026-03-20 09:00:00', last_seen_at: null },
  { id: 9, team_id: 2, name: 'Mallory', email: 'mallory@example.com', role: 'admin', created_at: '2026-01-01 09:00:00', last_seen_at: '2026-10-02 10:00:00' },
];

/** `translator: false` leaves the app without a `Translator`, as one without @marmeon/i18n. */
export async function tableApp(driver: TestDriver, options: { readonly translator?: boolean } = {}): Promise<TableTestApp> {
  const database = await freshDatabase(driver);
  const recorder = new Recorder();
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, DatabaseServiceProvider, TableServiceProvider],
    modules: [defineModule({ name: 'table-test', routes })],
  }, {
    env: { ...database.env, APP_KEY: KEY, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    override: (container) => {
      container.instance(Logger, silent);
      container.instance(Recorder, recorder);
      // A translator speaking the request's `x-test-locale` (English without it).
      if (options.translator !== false) container.scoped(Translator, (scope) => {
        const locale = scope.make(IncomingRequest).headers.get('x-test-locale') ?? 'en';
        const messages: Record<string, Record<string, string>> = {
          en: { 'columns.name': 'Name', 'columns.role': 'Role' },
          de: { 'columns.name': 'Name', 'columns.role': '=Rolle' },
        };
        return { locale, has: (key) => key in messages[locale]!, text: (key) => messages[locale]![key] ?? key };
      });
      // The request's user for the policies: from the same header the `acting` middleware reads.
      container.scoped(Gate, (scope) => {
        const auth = { user: async () => USERS[Number(scope.make(IncomingRequest).headers.get('x-test-user'))] } as unknown as Auth;
        return new Gate(auth, (Class) => scope.make(Class));
      });
    },
  });
  const connections = application.container.make(Connections);
  await runMigration(connections, {
    up: (schema) =>
      schema.create('teams', (table) => {
        table.id();
        table.string('name');
      }),
  });
  await connections.get().insertInto('teams').values([{ id: 1, name: 'Team one' }, { id: 2, name: 'Team two' }]).execute();
  await runMigration(connections, {
    up: (schema) =>
      schema.create('members', (table) => {
        table.id();
        table.foreignId('team_id').constrained();
        table.string('name');
        table.string('email');
        table.string('role');
        table.string('password').default('secret-hash');
        table.timestamp('created_at');
        table.timestamp('last_seen_at').nullable();
        table.boolean('active').nullable();
      }),
  });
  await runMigration(connections, {
    up: (schema) =>
      schema.create('ledger', (table) => {
        table.id();
        table.string('note');
        table.integer('qty');
        table.decimal('amount', 10, 2);
        table.boolean('paid');
        table.timestamp('booked_at');
        table.json('meta');
        table.string('formula');
      }),
  });
  const queries: QueryEvent[] = [];
  connections.onQuery((query) => void queries.push(query));
  const db = connections.get();
  const insert: TableTestApp['insert'] = async (rows) => {
    if (rows.length === 0) return;
    for (let at = 0; at < rows.length; at += 200) await db.insertInto('members').values(rows.slice(at, at + 200) as never).execute();
    if (driver === 'pgsql') await sql`select setval(pg_get_serial_sequence('members', 'id'), (select max(id) from members))`.execute(db);
  };
  await insert(MEMBERS);
  queries.length = 0;
  const kernel = createHttpKernel(application);
  return {
    application,
    connections,
    recorder,
    queries,
    request: async (path, init = {}) =>
      kernel.request(path, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(init.user === undefined ? {} : { 'x-test-user': String(init.user) }),
          ...(init.action ? { 'x-marmeon': PROTOCOL_VERSION, 'x-marmeon-action': 'true' } : {}),
          ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          ...init.headers,
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        ...(init.form === undefined ? {} : { body: init.form }),
      }),
    insert,
    close: async () => {
      await application.shutdown();
      await database.drop();
    },
  };
}
