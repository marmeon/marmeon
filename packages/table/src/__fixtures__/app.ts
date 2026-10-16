import { Gate, type Auth, type Authenticated } from '@marmeon/auth';
import { createApplication, defineModule, Logger, type Application } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Schema, sql, type QueryEvent } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { Controller, defineRequest, HttpServiceProvider, type ContextOf } from '@marmeon/http';
import { IncomingRequest } from '@marmeon/http/internal';
import { defineMiddleware, type HttpContext } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { action, bulk, column, defineTable, exportCsv, filter, Tables, tableRoutes, TableServiceProvider, type TableContext } from '../index.ts';
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
});

/** What the actions did — one per app (the container's singleton). */
export class Recorder {
  readonly deactivated: unknown[] = [];
  readonly batches: unknown[][] = [];
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

/** Exports of at most three rows — the limit refuses, it never cuts. */
export const SmallExportTable = defineTable({
  name: 'small',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable() },
  export: { csv: exportCsv().max(3).authorize(() => true) },
});

/** Sorted by a boolean column (with NULLs) — exported in batches by its keyset. */
export const ActiveTable = defineTable({
  name: 'active',
  query: (db, ctx: TeamContext) => db.selectFrom('members').where('members.team_id', '=', ctx.team),
  key: 'members.id',
  columns: { name: column('members.name').sortable().searchable(), active: column('members.active').sortable() },
  export: { csv: exportCsv().authorize(() => true) },
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

export const MembersRequest = defineRequest({ query: MembersTable.query });
export const FeedRequest = defineRequest({ query: FeedTable.query });
export const LeakyRequest = defineRequest({ query: LeakyTable.query });
export const WithTeamRequest = defineRequest({ query: WithTeamTable.query });
export const TeamsRequest = defineRequest({ query: TeamsTable.query });

/** The page: the table as JSON (the page protocol is the http package's — here the prop alone). */
export class MembersPage extends Controller {
  static request = MembersRequest;
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof MembersRequest> & Authenticated & { team: number }) {
    return this.json({ members: await this.#tables.resolve(MembersTable, ctx) });
  }
}

export class FeedPage extends Controller {
  static request = FeedRequest;
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof FeedRequest> & Authenticated & { team: number }) {
    return this.json({ feed: await this.#tables.resolve(FeedTable, ctx) });
  }
}

export class FeedCopyPage extends Controller {
  static request = FeedRequest;
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof FeedRequest> & Authenticated & { team: number }) {
    return this.json({ feed: await this.#tables.resolve(FeedCopyTable, ctx) });
  }
}

export class LeakyPage extends Controller {
  static request = LeakyRequest;
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof LeakyRequest> & Authenticated & { team: number }) {
    return this.json({ leaky: await this.#tables.resolve(LeakyTable, ctx) });
  }
}

export class WithTeamPage extends Controller {
  static request = WithTeamRequest;
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof WithTeamRequest> & Authenticated & { team: number }) {
    return this.json({ members: await this.#tables.resolve(WithTeamTable, ctx) });
  }
}

export class TeamsPage extends Controller {
  static request = TeamsRequest;
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: ContextOf<typeof TeamsRequest> & Authenticated & { team: number }) {
    return this.json({ teams: await this.#tables.resolve(TeamsTable, ctx) });
  }
}

/** The export, answered from inside a transaction the controller opened — its later batches run after it finished. */
export class ExportInTransaction extends Controller {
  readonly #tables: Tables;
  readonly #connections: Connections;

  constructor(tables: Tables, connections: Connections) {
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
  readonly #tables: Tables;

  constructor(tables: Tables) {
    super();
    this.#tables = tables;
  }

  async handle(ctx: HttpContext<Authenticated & { team: number }>) {
    return this.json({ members: await this.#tables.resolve(MembersTable, ctx) });
  }
}

const routes = openRoutes((Route) => {
  const team = Route.prefix('/teams/:team').middleware(acting);
  team.get('/members', MembersPage);
  tableRoutes(team, MembersTable);
  team.get('/feed', FeedPage);
  team.get('/feed-copy', FeedCopyPage);
  team.get('/leaky', LeakyPage);
  team.get('/with-team', WithTeamPage);
  team.get('/teams', TeamsPage);
  tableRoutes(team, TeamsTable);
  team.get('/no-schema', NoSchemaPage);
  team.get('/export-in-transaction', ExportInTransaction);
  tableRoutes(team, SmallExportTable);
  tableRoutes(team, ByEmailTable);
  tableRoutes(team, ActiveTable);
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
  if (driver === 'sqlite') return { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, drop: async () => {} };
  const name = `marmeon_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  return {
    env: { DB_CONNECTION: 'pgsql', DB_URL: url.href, DB_POOL_MAX: '3' },
    drop: async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    },
  };
}

/** The team members of every test: Ada, Alan, Grace (protected by the policy) and Edsger in team 1, Mallory in team 2. */
export const MEMBERS = [
  { id: 1, team_id: 1, name: 'Ada', email: 'ada@example.com', role: 'admin', created_at: '2026-01-10 09:00:00', last_seen_at: '2026-10-01 10:00:00' },
  { id: 2, team_id: 1, name: 'Alan', email: 'alan@example.com', role: 'member', created_at: '2026-02-10 09:00:00', last_seen_at: null },
  { id: 3, team_id: 1, name: 'Grace', email: 'grace@example.com', role: 'member', created_at: '2026-03-10 09:00:00', last_seen_at: '2026-10-03 10:00:00' },
  { id: 4, team_id: 1, name: 'Edsger', email: 'edsger@example.com', role: 'member', created_at: '2026-03-20 09:00:00', last_seen_at: null },
  { id: 9, team_id: 2, name: 'Mallory', email: 'mallory@example.com', role: 'admin', created_at: '2026-01-01 09:00:00', last_seen_at: '2026-10-02 10:00:00' },
];

export async function tableApp(driver: TestDriver): Promise<TableTestApp> {
  const database = await freshDatabase(driver);
  const recorder = new Recorder();
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    env: { ...database.env, APP_KEY: KEY, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, DatabaseServiceProvider, TableServiceProvider],
    modules: [defineModule({ name: 'table-test', routes })],
    override: (container) => {
      container.instance(Logger, silent);
      container.instance(Recorder, recorder);
      // The request's user for the policies: from the same header the `acting` middleware reads.
      container.scoped(Gate, (scope) => {
        const auth = { user: async () => USERS[Number(scope.make(IncomingRequest).headers.get('x-test-user'))] } as unknown as Auth;
        return new Gate(auth, (Class) => scope.make(Class));
      });
    },
  });
  const connections = application.container.make(Connections);
  const schema = new Schema(connections.get(), connections.options().driver);
  await schema.create('teams', (table) => {
    table.id();
    table.string('name');
  });
  await connections.get().insertInto('teams').values([{ id: 1, name: 'Team one' }, { id: 2, name: 'Team two' }]).execute();
  await schema.create('members', (table) => {
    table.id();
    table.foreignId('team_id').constrained();
    table.string('name');
    table.string('email');
    table.string('role');
    table.string('password').default('secret-hash');
    table.timestamp('created_at');
    table.timestamp('last_seen_at').nullable();
    table.boolean('active').nullable();
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
          ...(init.action ? { 'x-marmeon-action': 'true' } : {}),
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
