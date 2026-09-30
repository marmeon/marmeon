import { ConsoleLogger, type Container } from '@bespokecore/core';
import type { Generated, Kysely } from 'kysely';
import * as v from 'valibot';
import { expectTypeOf, it } from 'vitest';
import type { ModuleDefinition } from '@bespokecore/core';
import type { Selectable } from 'kysely';
import type { FixtureTables } from './__fixtures__/tables.ts';
import {
  Connections,
  Repository,
  type RepositoryClass,
  type RowOf,
  Database,
  defineConnection,
  defineMigration,
  type Decimal,
  type Generated as DbGenerated,
  type JsonColumn,
  type ModuleDatabase,
  type QueryEvent,
  type Tables,
  type Timestamp,
} from './index.ts';

// Type guarantees of step 1 — checked by the compiler (`pnpm typecheck`); the test body only runs trivially.
interface Shop {
  orders: { id: Generated<number>; total: number };
}

it('types connections, configuration and the query log', () => {
  const connections = new Connections({ connections: {}, root: '/', logger: new ConsoleLogger() });
  const shop = () => connections.get<Shop>('shop');
  expectTypeOf(shop).returns.toEqualTypeOf<Kysely<Shop>>();
  // @ts-expect-error — (1) unknown table
  void (() => shop().selectFrom('customers'));
  // @ts-expect-error — (2) wrong column type on insert
  void (() => shop().insertInto('orders').values({ total: '12' }));

  // The token resolves the default connection with every (generated) table.
  const fromContainer = (container: Container) => container.make(Database);
  expectTypeOf(fromContainer).returns.toEqualTypeOf<Kysely<Tables>>();

  defineConnection('reporting', { env: v.object({ URL: v.string() }), resolve: (env) => ({ driver: 'pgsql', url: env.URL }) });
  // @ts-expect-error — (3) unknown driver
  defineConnection('a', { env: v.object({}), resolve: () => ({ driver: 'mysql', url: 'x' }) });
  // @ts-expect-error — (4) SQLite needs a database file
  defineConnection('b', { env: v.object({}), resolve: () => ({ driver: 'sqlite' }) });
  // @ts-expect-error — (5) env is typed by the schema
  defineConnection('c', { env: v.object({ URL: v.string() }), resolve: (env) => ({ driver: 'pgsql', url: env.DB_URL }) });

  connections.onQuery((query) => {
    expectTypeOf(query).toEqualTypeOf<QueryEvent>();
    // @ts-expect-error — (6) events are read-only
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
        // @ts-expect-error — (7) a default must fit the column
        table.boolean('sent').default('yes');
        // @ts-expect-error — (8) NULL only for nullable columns
        table.string('title').default(null);
        // @ts-expect-error — (9) on-delete rules need a reference first
        table.foreignId('owner_id').cascadeOnDelete();
        // @ts-expect-error — (10) only timestamps default to the current time
        table.string('slug').useCurrent();
      }),
  });
  // @ts-expect-error — (11) a migration needs up()
  defineMigration({ down: (schema) => schema.drop('invoices') });
  // @ts-expect-error — (12) a module's migrations are a directory (URL or path)
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
  // @ts-expect-error — (13) not selected → not in the result: password_hash cannot leak into view props (E6)
  void user.password_hash;
  // @ts-expect-error — (14) unknown column
  await auth.selectFrom('users').select('nmae').execute();
  // @ts-expect-error — (15) wrong column type on insert
  await auth.insertInto('users').values({ name: 1, email: 'a@x', password_hash: 'h' }).execute();
  // @ts-expect-error — (16) a required column is missing
  await auth.insertInto('users').values({ name: 'Ada', password_hash: 'h' }).execute();
  // @ts-expect-error — (17) JSON is written as a string
  await auth.updateTable('users').set({ settings: { theme: 'dark' } }).execute();
}));

it('enforces module boundaries (E20)', () => void (async () => {
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

  // @ts-expect-error — (18) another module's table that is not exposed is invisible
  await profile.selectFrom('audit_log').selectAll().execute();
  // @ts-expect-error — (19) the exposed table cannot be inserted into…
  await profile.insertInto('users').values({ name: 'A', email: 'a@x', password_hash: 'h' }).execute();
  // @ts-expect-error — (20) …updated…
  await profile.updateTable('users').set({ name: 'B' }).execute();
  // @ts-expect-error — (21) …or deleted from
  await profile.deleteFrom('users').execute();
  // @ts-expect-error — (22) not inside a transaction either
  await profile.transaction().execute((trx) => trx.deleteFrom('users').execute());
  // @ts-expect-error — (23) the owner sees nothing of the other module that was not exposed
  await auth.selectFrom('login_activity').selectAll().execute();
}));

class Users extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}
class Mislabeled extends Repository<'users', FixtureTables> {
  static table = 'articles' as const;
}

it('types repositories by their table', () => void (async (users: Users) => {
  expectTypeOf(users.findOrFail(1)).resolves.toEqualTypeOf<Selectable<FixtureTables['users']>>();
  expectTypeOf<RowOf<Users>>().toEqualTypeOf<Selectable<FixtureTables['users']>>();
  expectTypeOf(users.using).returns.toEqualTypeOf<Users>();
  const ok: RepositoryClass<Users> = Users;
  void ok;
  await users.insert({ name: 'Ada', email: 'ada@example.com', created_at: new Date() });

  // @ts-expect-error — (24) the id is a number
  await users.find('1');
  // @ts-expect-error — (25) a required column is missing
  await users.insert({ name: 'Ada' });
  // @ts-expect-error — (26) wrong type on update
  await users.update(1, { is_admin: 'yes' });
  // @ts-expect-error — (27) not a column of the row
  void (await users.findOrFail(1)).password_hash;
  // @ts-expect-error — (28) `static table` names another table than Repository<'users'>
  const mislabeled: RepositoryClass<Mislabeled> = Mislabeled;
  void mislabeled;
}));
