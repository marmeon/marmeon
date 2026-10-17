import { ConsoleLogger, env, type Container } from '@marmeon/core';
import type { Generated, Kysely } from 'kysely';
import { expectTypeOf, it } from 'vitest';
import type { ModuleDefinition } from '@marmeon/core';
import type { Selectable } from 'kysely';
import { defineRoutes } from '@marmeon/router';
import { define, UserFactory } from './__fixtures__/factories.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Connections, Factories, Repository, Database, defineConnection, defineMigration, type Decimal, type Generated as DbGenerated, type JsonColumn, type ModuleDatabase, type QueryEvent, type Tables, type Timestamp } from './index.ts';

// Type guarantees — checked by the compiler (`pnpm typecheck`); the test body only runs trivially.
interface Shop {
  orders: { id: Generated<number>; total: number };
}

it('types connections, configuration and the query log', () => {
  const connections = new Connections({ connections: {}, root: '/', logger: new ConsoleLogger() });
  const shop = () => connections.get<Shop>('shop');
  expectTypeOf(shop).returns.toEqualTypeOf<Kysely<Shop>>();
  // @ts-expect-error — unknown table
  void (() => shop().selectFrom('customers'));
  // @ts-expect-error — wrong column type on insert
  void (() => shop().insertInto('orders').values({ total: '12' }));

  // The token resolves the default connection with every (generated) table — and `Database`
  // without a module name is exactly that: module boundaries are opt-in.
  const fromContainer = (container: Container) => container.make(Database);
  expectTypeOf(fromContainer).returns.toEqualTypeOf<Kysely<Tables>>();
  expectTypeOf<Database>().toEqualTypeOf<Kysely<Tables>>();

  defineConnection('reporting', { env: env({ URL: env.string() }), resolve: (e) => ({ driver: 'pgsql', url: e.URL }) });
  // Postgres in parts, or a URL that may be missing — the parts then make it.
  defineConnection('parts', {
    env: env({ URL: env.string().optional(), HOST: env.string(), PORT: env.port() }),
    resolve: (e) => ({ driver: 'pgsql', url: e.URL, host: e.HOST, port: e.PORT, database: 'reports', username: 'report', password: 'secret' }),
  });
  // @ts-expect-error — a port is a number (env.port() parses it)
  defineConnection('d', { env: env({}), resolve: () => ({ driver: 'pgsql', host: 'db', port: '5432', database: 'app' }) });
  // @ts-expect-error — unknown driver
  defineConnection('a', { env: env({}), resolve: () => ({ driver: 'mysql', url: 'x' }) });
  // @ts-expect-error — SQLite needs a database file
  defineConnection('b', { env: env({}), resolve: () => ({ driver: 'sqlite' }) });
  // @ts-expect-error — env is typed by the schema
  defineConnection('c', { env: env({ URL: env.string() }), resolve: (e) => ({ driver: 'pgsql', url: e.DB_URL }) });

  connections.onQuery((query) => {
    expectTypeOf(query).toEqualTypeOf<QueryEvent>();
    // @ts-expect-error — events are read-only
    query.sql = 'changed';
  });
});

it('types migrations: defaults match the column, references come before on-delete rules', () => {
  defineMigration({
    up: (schema) =>
      schema.create('invoices', (table) => {
        table.id();
        table.boolean('paid').default(false);
        table.string('note').nullable().default(null);
        table.json('meta').default({});
        table.timestamp('due_at').useCurrent();
        table.foreignId('customer_id').constrained().cascadeOnDelete();
        // @ts-expect-error — a default must fit the column
        table.boolean('sent').default('yes');
        // @ts-expect-error — NULL only for nullable columns
        table.string('title').default(null);
        // @ts-expect-error — on-delete rules need a reference first
        table.foreignId('owner_id').cascadeOnDelete();
        table.foreignId('approver_id').constrained('users').nullOnDelete().inverse('approved_invoices').nullable();
        // @ts-expect-error — an inverse name needs a reference first
        table.foreignId('reviewer_id').inverse('reviewed_invoices');
        // @ts-expect-error — `.nullable()` goes last: it keeps a plain column
        table.foreignId('auditor_id').constrained('users').nullable().inverse('audited_invoices');
        // @ts-expect-error — only timestamps default to the current time
        table.string('slug').useCurrent();
      }),
  });
  // @ts-expect-error — a migration needs up()
  defineMigration({ down: (schema) => schema.drop('invoices') });
  // @ts-expect-error — a module's migrations are a directory (URL or path)
  void ({ name: 'billing', migrations: 42 } satisfies ModuleDefinition);
});

// Generated-style tables of two modules — passed as parameters, because augmenting `Tables` in a test
// file would change it for the whole package compilation.
interface AppTables {
  users: { id: DbGenerated<number>; name: string; email: string; password_hash: string; balance: DbGenerated<Decimal>; settings: JsonColumn | null; created_at: DbGenerated<Timestamp> };
  login_activity: { user_id: number; last_login_at: Timestamp };
  audit_log: { id: DbGenerated<number>; message: string };
}
interface Owners {
  users: 'auth';
  login_activity: 'user-profile';
  audit_log: 'audit';
}
interface Exposed {
  users: true;
}
declare const auth: ModuleDatabase<AppTables, Owners, Exposed, 'auth'>;
declare const profile: ModuleDatabase<AppTables, Owners, Exposed, 'user-profile'>;

// The bodies below are only compiled, never run (`declare const` has no runtime value).
it('types generated tables: selection is the type, the database fills in generated columns', () => void (async () => {
  const user = await auth.selectFrom('users').select(['id', 'name', 'created_at', 'balance', 'settings']).executeTakeFirstOrThrow();
  expectTypeOf(user).toEqualTypeOf<{ id: number; name: string; created_at: string; balance: string; settings: import('./index.ts').Json | null }>();
  // id, balance, created_at are generated; settings is nullable — all optional on insert. Dates may be `Date`.
  await auth.insertInto('users').values({ name: 'Ada', email: 'a@x', password_hash: 'h', created_at: new Date() }).execute();
  // @ts-expect-error — not selected → not in the result: password_hash cannot leak into view props
  void user.password_hash;
  // @ts-expect-error — unknown column
  await auth.selectFrom('users').select('nmae').execute();
  // @ts-expect-error — wrong column type on insert
  await auth.insertInto('users').values({ name: 1, email: 'a@x', password_hash: 'h' }).execute();
  // @ts-expect-error — a required column is missing
  await auth.insertInto('users').values({ name: 'Ada', password_hash: 'h' }).execute();
  // @ts-expect-error — JSON is written as a string
  await auth.updateTable('users').set({ settings: { theme: 'dark' } }).execute();
}));

it('enforces module boundaries', () => void (async () => {
  // Own table: everything. Exposed `users`: reading and joins.
  const rows = await profile
    .selectFrom('login_activity')
    .innerJoin('users', 'users.id', 'login_activity.user_id')
    .select(['users.name', 'login_activity.last_login_at'])
    .execute();
  expectTypeOf(rows).toEqualTypeOf<{ name: string; last_login_at: string }[]>();
  await profile.insertInto('login_activity').values({ user_id: 1, last_login_at: new Date() }).execute();
  await profile.updateTable('login_activity').set({ last_login_at: new Date() }).where('user_id', 'in', (eb) => eb.selectFrom('users').select('id')).execute();
  await profile.transaction().execute((trx) => trx.deleteFrom('login_activity').where('user_id', '=', 1).execute());

  // @ts-expect-error — another module's table that is not exposed is invisible
  await profile.selectFrom('audit_log').selectAll().execute();
  // @ts-expect-error — the exposed table cannot be inserted into…
  await profile.insertInto('users').values({ name: 'A', email: 'a@x', password_hash: 'h' }).execute();
  // @ts-expect-error — …updated…
  await profile.updateTable('users').set({ name: 'B' }).execute();
  // @ts-expect-error — …or deleted from
  await profile.deleteFrom('users').execute();
  // @ts-expect-error — not inside a transaction either
  await profile.transaction().execute((trx) => trx.deleteFrom('users').execute());
  // @ts-expect-error — the owner sees nothing of the other module that was not exposed
  await auth.selectFrom('login_activity').selectAll().execute();
}));

it('types tables Marmeon does not know on a module database, for reading only', () => void (async () => {
  const legacy = profile.withTables<{ legacy_orders: { id: number; user_id: number; total: string } }>();
  const rows = await legacy
    .selectFrom('legacy_orders')
    .innerJoin('login_activity', 'login_activity.user_id', 'legacy_orders.user_id')
    .select(['legacy_orders.total', 'login_activity.last_login_at'])
    .execute();
  expectTypeOf(rows).toEqualTypeOf<{ total: string; last_login_at: string }[]>();
  await legacy.insertInto('login_activity').values({ user_id: 1, last_login_at: new Date() }).execute();
  await legacy.withTables<{ other: { id: number }; reports: { id: number } }>().selectFrom('legacy_orders').select('id').execute();
  await legacy.transaction().execute((trx) => trx.selectFrom('legacy_orders').selectAll().execute());

  // @ts-expect-error — not writable: insert…
  await legacy.insertInto('legacy_orders').values({ id: 1, user_id: 1, total: '1' }).execute();
  // @ts-expect-error — …update…
  await legacy.updateTable('legacy_orders').set({ total: '2' }).execute();
  // @ts-expect-error — …delete…
  await legacy.deleteFrom('legacy_orders').execute();
  // @ts-expect-error — …not inside a transaction either
  await legacy.transaction().execute((trx) => trx.deleteFrom('legacy_orders').execute());
  // @ts-expect-error — the table is not there before it is declared
  await profile.selectFrom('legacy_orders').selectAll().execute();
  // @ts-expect-error — a table the schema knows cannot be declared again: audit_log is another module's and not exposed
  profile.withTables<{ audit_log: { id: number; message: string } }>();
  // @ts-expect-error — nor the exposed one, to write it
  profile.withTables<{ users: { id: number } }>();
  // @ts-expect-error — nor an own table, whose columns would be redeclared
  profile.withTables<{ login_activity: { user_id: number } }>();
  // @ts-expect-error — declared on top of another declaration, the known names stay closed
  legacy.withTables<{ audit_log: { id: number } }>();
  // @ts-expect-error — an index signature is every name, the known ones too
  profile.withTables<Record<string, { id: number; message: string }>>();
  // @ts-expect-error — so is a pattern of names
  profile.withTables<{ [name: `${string}_log`]: { id: number; message: string } }>();
  // @ts-expect-error — a schema-qualified name is read as the table behind it
  profile.withTables<{ 'main.audit_log': { id: number; message: string } }>();
  // @ts-expect-error — so is an aliased one
  profile.withTables<{ 'audit_log as a': { id: number; message: string } }>();
  // @ts-expect-error — SQLite matches table names without regard to case
  profile.withTables<{ AUDIT_LOG: { id: number; message: string } }>();
  // @ts-expect-error — a pattern of names is not one table
  profile.withTables<{ [name: `legacy_${string}`]: { id: number } }>();
  // @ts-expect-error — `never` names no table
  profile.withTables<never>();
  // @ts-expect-error — `any` names every table
  profile.withTables<any>();
  // @ts-expect-error — a table is an object of columns
  profile.withTables<{ legacy_orders: number }>();
}));

class Users extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}
class Mislabeled extends Repository<'users', FixtureTables> {
  static table = 'articles' as const;
}

it('types repositories by their table', () => void (async (users: Users) => {
  expectTypeOf(users.findOrFail(1)).resolves.toEqualTypeOf<Selectable<FixtureTables['users']>>();
  expectTypeOf(users.using).returns.toEqualTypeOf<Users>();
  await users.insert({ name: 'Ada', email: 'ada@example.com', created_at: new Date() });

  // @ts-expect-error — the id is a number
  await users.find('1');
  // @ts-expect-error — a required column is missing
  await users.insert({ name: 'Ada' });
  // @ts-expect-error — wrong type on update
  await users.update(1, { is_admin: 'yes' });
  // @ts-expect-error — not a column of the row
  void (await users.findOrFail(1)).password_hash;
  const body = { name: 'Ada', bio: 'a renamed column' }; // a variable: no excess-property check for literals applies
  // @ts-expect-error — an unknown column in a variable (e.g. ctx.body after a migration renamed it)
  await users.update(1, body);
  // @ts-expect-error — the same for insert
  await users.insert({ ...body, email: 'a@x' });
}));

it('types factories against the insert type of their table', () => void (async (factories: Factories) => {
  expectTypeOf(factories.for(UserFactory).create()).resolves.toEqualTypeOf<Selectable<FixtureTables['users']>>();
  expectTypeOf(factories.for(UserFactory).count(3).create()).resolves.toEqualTypeOf<Selectable<FixtureTables['users']>[]>();
  await factories.for(UserFactory).state('admin').create({ name: 'Ada' });

  // @ts-expect-error — a definition must fill every required column (email is missing)
  define('users', ({ sequence }) => ({ name: `User ${sequence}` }));
  // @ts-expect-error — a column value of the wrong type
  define('users', () => ({ name: 'Ada', email: 'a@x', is_admin: 'yes' }));
  // @ts-expect-error — a state the factory does not define
  factories.for(UserFactory).state('banned');
  // @ts-expect-error — an override of the wrong type
  await factories.for(UserFactory).create({ balance: true });
}));

it('types relations: keys are columns, the selection is the type, module boundaries hold', () => void (async (db: import('kysely').Kysely<FixtureTables>) => {
  const [user] = await db
    .selectFrom('users')
    .select('users.id')
    .withRelation('articles', { table: 'articles', foreignKey: 'user_id' }, (q) => q.select(['articles.title']))
    .execute();
  expectTypeOf(user!.articles).toEqualTypeOf<{ title: string }[]>();
  // @ts-expect-error — only the selected columns exist on related rows
  void user!.articles[0]!.id;

  // @ts-expect-error — the foreign key must be a column of the related table
  await db.selectFrom('users').withRelation('a', { table: 'articles', foreignKey: 'author_id' }).execute();
  // @ts-expect-error — the local key must be a column of the outer query
  await db.selectFrom('users').withRelation('a', { table: 'articles', foreignKey: 'user_id', localKey: 'uuid' }).execute();
  // @ts-expect-error — unknown related table
  await db.selectFrom('articles').withRelation('author', { table: 'authors', foreignKey: 'id', localKey: 'user_id', one: true }).execute();
  // user-profile cannot even load a relation to a table it cannot see
  // @ts-expect-error — audit_log belongs to another module and is not exposed
  await profile.selectFrom('login_activity').withRelation('log', { table: 'audit_log', foreignKey: 'id', localKey: 'user_id' }).execute();
}));

it('binds route parameters to rows of the repository’s table', () => {
  defineRoutes((Route) => {
    Route.bind('user', Users).get('/users/:user', (ctx) => {
      expectTypeOf(ctx.params.user).toEqualTypeOf<Selectable<FixtureTables['users']>>();
      return null;
    });
    // @ts-expect-error — `static table = 'articles'` on a Repository<'users'> — caught where the class is passed
    Route.bind('user', Mislabeled).get('/users/:user', () => null);
  });
});
