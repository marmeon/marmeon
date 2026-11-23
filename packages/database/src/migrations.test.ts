import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshConnections, freshDatabase, silent, withMysql } from './__fixtures__/databases.ts';
import { Connections, Migrator } from './index.ts';
import { projectMigrations } from './schema/projection.ts';
import { LOCK_TABLE } from './migrations/lock.ts';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
const blog: ModuleDefinition = { name: 'blog', migrations: fixtures('blog') };
const views: ModuleDefinition = { name: 'views', migrations: fixtures('views') };
const routines: ModuleDefinition = { name: 'routines', migrations: fixtures('routines') };
const broken: ModuleDefinition = { name: 'broken', migrations: fixtures('broken') };

/** The migrator only needs the app's modules and root. */
const migrator = (connections: Connections, ...modules: ModuleDefinition[]) =>
  new Migrator({ modules, root: '/' } as unknown as Application, connections);

/** Table → the module whose migration created it. */
const owners = (projection: Awaited<ReturnType<typeof projectMigrations>>) => Object.fromEntries([...projection.tables.values()].map((table) => [table.name, table.module]));

const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describe.each(drivers)('migrations on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  const db = () => connections.get<any>();
  // SQLite keeps its lock in a table of its own; Postgres holds it on a connection.
  const tables = async () => (await db().introspection.getTables()).map((t) => t.name).filter((name) => name !== LOCK_TABLE).sort();

  beforeAll(async () => ({ connections, close } = await freshConnections(driver)));
  afterAll(() => close());

  it('runs pending migrations across modules in timestamp order, one batch per run', async () => {
    const ran: string[] = [];
    expect((await migrator(connections, auth).migrate({ onRun: (run) => ran.push(`${run.module}/${run.name}`) })).length).toBe(1);
    await migrator(connections, auth, blog).migrate({ onRun: (run) => ran.push(`${run.module}/${run.name}`) });
    expect(ran).toEqual([
      'auth/2026_01_01_000000_create_users_table',
      'blog/2026_01_02_000000_create_posts_table',
      'blog/2026_01_03_000000_add_slug_to_posts_table',
    ]);
    expect(await migrator(connections, auth, blog).migrate()).toEqual([]);
    expect((await migrator(connections, auth, blog).status()).map((m) => [m.name, m.module, m.batch])).toEqual([
      ['2026_01_01_000000_create_users_table', 'auth', 1],
      ['2026_01_02_000000_create_posts_table', 'blog', 2],
      ['2026_01_03_000000_add_slug_to_posts_table', 'blog', 2],
    ]);
    expect(await tables()).toEqual(['articles', 'migrations', 'users']);
  });

  it('knows which module owns each table from the migrations — renames included', async () => {
    expect(owners(await projectMigrations(migrator(connections, auth, blog).files()))).toEqual({ users: 'auth', articles: 'blog' });
  });

  it('creates columns that read back the same on every driver: NOT NULL by default, defaults, timestamps', async () => {
    const user = await db().insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).returningAll().executeTakeFirstOrThrow();
    expect(user).toEqual({
      id: 1,
      name: 'Ada',
      email: 'ada@example.com',
      is_admin: false,
      settings: null,
      balance: '0.00',
      born_on: null,
      created_at: expect.stringMatching(ISO_UTC),
      updated_at: expect.stringMatching(ISO_UTC),
      deleted_at: null,
    });
    const rich = await db().updateTable('users').set({ balance: 12.5, is_admin: true, settings: JSON.stringify({ a: [1] }) }).where('id', '=', 1).returning(['balance', 'is_admin', 'settings']).executeTakeFirstOrThrow();
    expect(rich).toEqual({ balance: '12.50', is_admin: true, settings: { a: [1] } });
    await expect(db().insertInto('users').values({ name: 'Ada 2', email: 'ada@example.com' }).execute()).rejects.toThrow(/unique/i);
    await expect(db().insertInto('users').values({ email: 'x@example.com' }).execute()).rejects.toThrow(/not.null|null value/i);

    const article = await db()
      .insertInto('articles')
      .values({ user_id: 1, title: 'Hello', slug: 'hello', content: 'Text', published_at: new Date('2026-10-01T08:00:00Z') })
      .returning(['id', 'content', 'published_at'])
      .executeTakeFirstOrThrow();
    expect(article).toEqual({ id: 1, content: 'Text', published_at: '2026-10-01T08:00:00.000Z' });
    await expect(db().insertInto('articles').values({ user_id: 99, title: 'Orphan' }).execute()).rejects.toThrow(/foreign key/i);
    await db().deleteFrom('users').where('id', '=', 1).execute();
    expect(await db().selectFrom('articles').selectAll().execute()).toEqual([]); // cascadeOnDelete
  });

  it('rolls back the last batch, then by steps, and undoes renames', async () => {
    const both = migrator(connections, auth, blog);
    const rolledBack = (await both.rollback()).map((run) => run.name);
    expect(rolledBack).toEqual(['2026_01_03_000000_add_slug_to_posts_table', '2026_01_02_000000_create_posts_table']);
    expect(await tables()).toEqual(['migrations', 'users']);
    expect(owners(await projectMigrations(both.files(), { only: new Set((await both.status()).filter((m) => m.batch !== undefined).map((m) => m.name)) }))).toEqual({ users: 'auth' });

    await both.migrate();
    expect((await both.rollback({ steps: 1 })).map((run) => run.name)).toEqual(['2026_01_03_000000_add_slug_to_posts_table']);
    const posts = (await db().introspection.getTables()).find((t) => t.name === 'posts')!;
    expect(posts.columns.map((c) => c.name)).toEqual(['id', 'user_id', 'title', 'body', 'published_at']);
    expect((await both.reset()).length).toBe(2);
    expect(await tables()).toEqual(['migrations']);
  });

  it('rolls back a batch in the reverse of the order it ran, not of the names', async () => {
    const own = await freshConnections(driver);
    try {
      const dir = mkdtempSync(join(tempDir('marmeon-migrations-'), 'm-'));
      for (const name of ['a_b', 'ab']) {
        writeFileSync(
          join(dir, `2026_01_01_000000_${name}.ts`),
          `export default { up: () => {}, down: () => { (globalThis as any).__downs.push('${name}'); } };`,
        );
      }
      const ownMigrator = migrator(own.connections, { name: 'x', migrations: dir });
      await ownMigrator.migrate();
      const rows = own.connections.get<any>();
      await rows.updateTable('migrations').set({ id: 99 }).where('name', '=', '2026_01_01_000000_a_b').execute();
      await rows.updateTable('migrations').set({ id: 1 }).where('name', '=', '2026_01_01_000000_ab').execute();
      await rows.updateTable('migrations').set({ id: 2 }).where('name', '=', '2026_01_01_000000_a_b').execute();
      const downs: string[] = ((globalThis as any).__downs = []);
      await ownMigrator.rollback();
      expect(downs).toEqual(['a_b', 'ab']);
    } finally {
      delete (globalThis as any).__downs;
      await own.close();
    }
  });

  it.runIf(driver === 'pgsql')('rolls back a oneOf(column, values) change to the old list through a renamed column, with one constraint', async () => {
    const own = await freshConnections(driver);
    try {
      const dir = mkdtempSync(join(tempDir('marmeon-migrations-'), 'm-'));
      const file = (name: string, up: string, down: string) =>
        writeFileSync(join(dir, `2026_01_0${name}.ts`), `export default { up: (schema: any) => { ${up} }, down: (schema: any) => { ${down} } };`);
      file('1_000000_create', "schema.create('memberships', (t: any) => { t.id(); t.string('role').oneOf('admin', 'member'); });", "schema.drop('memberships');");
      file('2_000000_rename', "schema.alter('memberships', (t: any) => t.renameColumn('role', 'kind'));", "schema.alter('memberships', (t: any) => t.renameColumn('kind', 'role'));");
      file('3_000000_widen', "schema.alter('memberships', (t: any) => t.oneOf('kind', ['admin', 'member', 'owner']));", "schema.alter('memberships', (t: any) => t.oneOf('kind', ['admin', 'member']));");
      const own_ = migrator(own.connections, { name: 'x', migrations: dir });
      await own_.migrate();
      const rows = own.connections.get<any>();
      await rows.insertInto('memberships').values({ kind: 'owner' }).execute();
      await rows.deleteFrom('memberships').execute();
      await own_.rollback({ steps: 1 });
      const checks = await sql<{ conname: string }>`select conname from pg_constraint where conrelid = 'memberships'::regclass and contype = 'c'`.execute(rows);
      expect(checks.rows.map((row) => row.conname)).toEqual(['memberships_role_check']);
      await rows.insertInto('memberships').values({ kind: 'member' }).execute();
      await expect(rows.insertInto('memberships').values({ kind: 'owner' }).execute()).rejects.toThrow(/memberships_role_check/);
    } finally {
      await own.close();
    }
  });

  it('names the file that cannot be loaded or rolled back, with its code', async () => {
    const own = await freshConnections(driver);
    try {
      const dir = mkdtempSync(join(tempDir('marmeon-migrations-'), 'm-'));
      writeFileSync(join(dir, '2026_01_01_000000_no_up.ts'), 'export default {};');
      await expect(migrator(own.connections, { name: 'x', migrations: dir }).migrate()).rejects.toThrow(/^\[marmeon:D14\] Migration 2026_01_01_000000_no_up \(module "x"\) must/);
      rmSync(join(dir, '2026_01_01_000000_no_up.ts'));

      writeFileSync(join(dir, '2026_01_02_000000_one_way.ts'), 'export default { up: () => {} };');
      const ownMigrator = migrator(own.connections, { name: 'x', migrations: dir });
      await ownMigrator.migrate();
      await expect(ownMigrator.rollback()).rejects.toThrow('[marmeon:D16] Cannot roll back "2026_01_02_000000_one_way" (module "x"): it has no down().');
      rmSync(join(dir, '2026_01_02_000000_one_way.ts'));
      await expect(ownMigrator.rollback()).rejects.toThrow('[marmeon:D16] Cannot roll back "2026_01_02_000000_one_way" (module "x"): its file is gone.');
    } finally {
      await own.close();
    }
  });

  it.each([
    ['a migration without down()', 'down-order', /^\[marmeon:D16\] Cannot roll back "2026_03_30_000000_create_first_table" \(module "down-order"\): it has no down\(\)/, 'second_with_down'],
    ['a down() the driver cannot run', 'down-checked', driver === 'sqlite' ? /^\[marmeon:D18\] schema\.alter\('first_checked'\) cannot make the column "name" NOT NULL on SQLite/ : /^\[marmeon:D5\] The index name "i+" is 70 bytes/, 'second_checked'],
  ])('stops a rollback with %s before it undoes anything', async (_name, fixture, error, newer) => {
    const own = await freshConnections(driver);
    try {
      const run = migrator(own.connections, { name: fixture, migrations: fixtures(fixture) });
      await run.migrate();
      await expect(run.rollback()).rejects.toThrow(error);
      expect((await own.connections.get<any>().introspection.getTables()).map((t) => t.name)).toContain(newer);
      expect((await own.connections.get<any>().selectFrom('migrations').select('name').execute()).map((row: { name: string }) => row.name)).toHaveLength(2);
    } finally {
      await own.close();
    }
  });

  it.each([
    ['sqlite', "/* ' */ update migrations set name = 'changed'"],
    ['sqlite', "/* it's */ update migrations set name = 'changed' /* don't */"],
    ['sqlite', "-- it's\nupdate migrations set name = 'changed'"],
    ['sqlite', 'with "--" as (select 1) update migrations set name = \'changed\''],
    ['sqlite', 'with [it\'s] as (select 1) update migrations set name = \'changed\''],
    ['pgsql', "/* ' */ update migrations set name = 'changed'"],
    ['pgsql', 'with "--" as (select 1) update migrations set name = \'changed\''],
    ['pgsql', "do $$ begin update migrations set name = 'changed'; end $$"],
    ['pgsql', "select $$ ' $$; update migrations set name = 'changed'"],
    ['pgsql', "/* outer /* inner */ ' */ update migrations set name = 'changed'"],
    ['pgsql', "/* /* */ ' */ delete from migrations /* ' */"],
    ['pgsql', '-- x\rdelete from migrations'],
    ['pgsql', "with x as (select 1 \u00e9$$, ' $$ ') delete from migrations /* ' */"],
    ['pgsql', `select $${'t'.repeat(300)}$ ' $${'t'.repeat(300)}$; delete from migrations; select '`],
    ['pgsql', 'delete from U&"migr\\0061tions"'],
    ['pgsql', 'delete from U&"migr!0061tions" /* /* */ */ uescape \'!\''],
    ['pgsql', `select '"'; delete from migrations; -- "'`],
    ['sqlite', "delete from 'migrations'"],
    ['sqlite', "with x as (select $a(')) delete from migrations where $a(') is null"],
    ['sqlite', "with x as (select @a(')) delete from migrations where @a(') is null"],
    ['sqlite', "with x as (select $a(\u00a0'), 'a'' /* ' ) delete from migrations /* x */"],
    ['sqlite', "with x as (select @a(\u3000'), 'a'' /* ' ) delete from migrations /* x */"],
  ].filter(([only]) => only === driver))('keeps a data step that hides a write to the migrator tables from the guard from changing them: %s %s', async (only, statement) => {
    expect(only).toBe(driver);
    const own = await freshConnections(driver);
    try {
      (globalThis as { guardedStatement?: string }).guardedStatement = statement;
      await expect(migrator(own.connections, { name: 'guard', migrations: fixtures('mysql-guard') }).migrate()).rejects.toThrow(/^\[marmeon:D4\]/);
      expect((await own.connections.get<any>().selectFrom('migrations').select('name').execute()).map((row: { name: string }) => row.name)).toEqual(['2026_03_20_000000_create_ledger_table']);
    } finally {
      delete (globalThis as { guardedStatement?: string }).guardedStatement;
      await own.close();
    }
  });

  it.each(['cte', 'appended'] as const)('keeps a data step from reaching the migrator through the builder: %s', async (form) => {
    const own = await freshConnections(driver);
    try {
      (globalThis as { guardedStatement?: unknown }).guardedStatement = (sqlTag: typeof sql, on: any) =>
        form === 'cte'
          ? on.with('gone', (d: any) => d.deleteFrom('migrations')).selectFrom('gone').selectAll().execute()
          : on.selectNoFrom(sqlTag.lit(1).as('x')).modifyEnd(sqlTag.raw('; drop table ledger')).execute();
      await expect(migrator(own.connections, { name: 'guard', migrations: fixtures('mysql-guard') }).migrate()).rejects.toThrow(/^\[marmeon:D4\]/);
      expect((await own.connections.get<any>().selectFrom('migrations').select('name').execute()).map((row: { name: string }) => row.name)).toEqual(['2026_03_20_000000_create_ledger_table']);
      expect((await own.connections.get<any>().selectFrom('ledger').select('amount').execute()).map((row: { amount: number }) => row.amount)).toEqual([10, 20]);
    } finally {
      delete (globalThis as { guardedStatement?: unknown }).guardedStatement;
      await own.close();
    }
  });

  it.runIf(driver === 'sqlite')('keeps a data step from deleting the migrator\'s record by naming the table with a literal', async () => {
    const own = await freshConnections(driver);
    try {
      (globalThis as { guardedStatement?: () => ReturnType<typeof sql> }).guardedStatement = () => sql`delete from ${sql.lit('migrations')}`;
      await expect(migrator(own.connections, { name: 'guard', migrations: fixtures('mysql-guard') }).migrate()).rejects.toThrow(/^\[marmeon:D4\]/);
      expect((await own.connections.get<any>().selectFrom('migrations').select('name').execute()).map((row: { name: string }) => row.name)).toEqual(['2026_03_20_000000_create_ledger_table']);
    } finally {
      delete (globalThis as { guardedStatement?: unknown }).guardedStatement;
      await own.close();
    }
  });

  it('undoes a failing migration completely and does not record it', async () => {
    const withBroken = migrator(connections, auth, broken);
    const sent: string[] = [];
    connections.onQuery((query) => void sent.push(query.sql));
    await expect(withBroken.migrate()).rejects.toThrow('this migration is broken');
    expect(sent.some((text) => /create table "half"/.test(text))).toBe(true); // it was made, and is undone
    expect(await tables()).toEqual(['migrations', 'users']); // `half` is gone; users (earlier file) stays
    expect((await withBroken.status()).map((m) => [m.name, m.batch])).toEqual([
      ['2026_01_01_000000_create_users_table', 1],
      ['2026_01_04_000000_create_half_table', undefined],
    ]);
  });

  it('migrate:fresh drops every table — migrated or not — and runs everything again', async () => {
    await sql`create table stray (x integer)`.execute(db());
    const runs = await migrator(connections, auth, blog).fresh();
    expect(runs.map((run) => run.name)).toHaveLength(3);
    expect(await tables()).toEqual(['articles', 'migrations', 'users']);
    expect((await migrator(connections, auth, blog).status()).every((m) => m.batch === 1)).toBe(true);
  });

  it('migrate:fresh drops a view that sorts before its table, run after run', async () => {
    const own = await freshConnections(driver);
    try {
      const withView = migrator(own.connections, views);
      await withView.migrate();
      expect((await withView.fresh()).length).toBe(1);
      expect((await withView.fresh()).length).toBe(1);
      await sql`select * from aa_zebras`.execute(own.connections.get<any>());
    } finally {
      await own.close();
    }
  });

  it.runIf(driver === 'pgsql')('migrate:fresh drops functions, types and sequences a migration made, so it runs again', async () => {
    const own = await freshConnections(driver);
    try {
      const withRoutines = migrator(own.connections, routines);
      await withRoutines.migrate();
      expect((await withRoutines.fresh()).length).toBe(1);
      const left = await sql<{ n: number }>`select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = current_schema() and p.proname = 'stamp_ticket'`.execute(own.connections.get<any>());
      expect(left.rows[0]?.n).toBe(2);
    } finally {
      await own.close();
    }
  });

  it.runIf(driver === 'pgsql')('migrate:fresh leaves a function in a schema without tables of the app, extensions and objects of other roles', async () => {
    const own = await freshConnections(driver);
    const rows = own.connections.get<any>();
    const role = `marmeon_other_${Math.random().toString(36).slice(2, 10)}`;
    await sql.raw(`create role ${role}`).execute(rows);
    try {
      await sql`create schema elsewhere_fns`.execute(rows);
      await sql`create function elsewhere_fns.keep() returns integer language sql as 'select 1'`.execute(rows);
      await sql`create extension if not exists pg_trgm`.execute(rows);
      await sql`create function theirs() returns integer language sql as 'select 2'`.execute(rows);
      await sql.raw(`alter function theirs() owner to ${role}`).execute(rows);
      await sql`create type their_mood as enum ('calm')`.execute(rows);
      await sql.raw(`alter type their_mood owner to ${role}`).execute(rows);
      await migrator(own.connections, auth).fresh();
      expect((await sql<{ keep: number }>`select elsewhere_fns.keep() as keep`.execute(rows)).rows[0]?.keep).toBe(1);
      expect((await sql<{ n: number }>`select count(*)::int as n from pg_extension where extname = 'pg_trgm'`.execute(rows)).rows[0]?.n).toBe(1);
      expect((await sql<{ s: number }>`select similarity('a', 'a') as s`.execute(rows)).rows[0]?.s).toBe(1);
      expect((await sql<{ theirs: number }>`select theirs() as theirs`.execute(rows)).rows[0]?.theirs).toBe(2);
      expect((await sql<{ n: number }>`select count(*)::int as n from pg_type where typname = 'their_mood'`.execute(rows)).rows[0]?.n).toBe(1);
    } finally {
      try {
        await sql`drop schema if exists elsewhere_fns cascade`.execute(rows);
        await sql.raw(`drop owned by ${role}`).execute(rows);
        await sql.raw(`drop role if exists ${role}`).execute(rows);
      } finally {
        await own.close();
      }
    }
  });

  it.runIf(driver === 'pgsql')('migrate:fresh drops a table whose name contains a dot', async () => {
    const own = await freshConnections(driver);
    const rows = own.connections.get<any>();
    try {
      await sql`create table "a.b" (id integer)`.execute(rows);
      await migrator(own.connections, auth).fresh();
      expect((await sql<{ n: number }>`select count(*)::int as n from pg_class where relname = 'a.b'`.execute(rows)).rows[0]?.n).toBe(0);
    } finally {
      await own.close();
    }
  });
});

describe.each(drivers)('migrations on another connection (%s)', (driver) => {
  const system: ModuleDefinition = { name: 'system', migrations: fixtures('system') };
  let connections: Connections;
  let drops: (() => Promise<void>)[];
  /** The app: its modules, and a container that tells the migration its connection — like `c.make(CacheConfig).connection`. */
  const on = (...modules: ModuleDefinition[]) =>
    new Migrator({ modules, root: '/', container: { make: () => 'system' } } as unknown as Application, connections);
  const tablesOf = async (name: string) => (await connections.get<any>(name).introspection.getTables()).map((t) => t.name).filter((table) => table !== LOCK_TABLE).sort();

  beforeAll(async () => {
    const [app, other] = [await freshDatabase(driver), await freshDatabase(driver)];
    drops = [app.drop, other.drop];
    connections = new Connections({ connections: { default: app.options, system: other.options }, root: '/', logger: silent });
  });
  afterAll(async () => {
    await connections.destroy();
    for (const drop of drops) await drop();
  });

  it('creates the tables on their connection, keeps the record on default, and knows their owner and secrets from the migrations', async () => {
    const ran = await on(auth, system).migrate();
    expect(ran.map((run) => run.name)).toEqual(['2026_01_01_000000_create_users_table', '2026_01_07_000000_create_counters_table', '2026_01_08_000000_create_audit_table']);
    expect(await tablesOf('default')).toEqual(['migrations', 'users']);
    expect(await tablesOf('system')).toEqual(['audit', 'counters']);
    expect((await on(auth, system).status()).map((m) => [m.name, m.batch])).toEqual([
      ['2026_01_01_000000_create_users_table', 1],
      ['2026_01_07_000000_create_counters_table', 1],
      ['2026_01_08_000000_create_audit_table', 1],
    ]);
    expect(owners(await projectMigrations(on(auth, system).files()))).toEqual({ users: 'auth', counters: 'system', audit: 'system' });
    // The secret column is known where the table is: a selectAll() there never returns it.
    await connections.get<any>('system').insertInto('counters').values({ key: 'k', n: 1, owner_token: 'secret' }).execute();
    expect(await connections.get<any>('system').selectFrom('counters').selectAll().execute()).toEqual([{ key: 'k', n: 1 }]);
    expect(await on(auth, system).migrate()).toEqual([]);
  });

  it('rolls back on the connection the migration ran on', async () => {
    const rolledBack = await on(auth, system).rollback({ steps: 1 });
    expect(rolledBack.map((run) => run.name)).toEqual(['2026_01_08_000000_create_audit_table']);
    expect(await tablesOf('system')).toEqual(['counters']);
    expect((await on(auth, system).status()).at(-1)?.batch).toBeUndefined();
    await on(auth, system).migrate();
    expect(await tablesOf('system')).toEqual(['audit', 'counters']);
  });

  it('drops the tables of every connection a migration runs on for a fresh start', async () => {
    await on(auth, system).migrate();
    await connections.get<any>('system').insertInto('audit').values({ what: 'before' }).execute();
    expect(await on(auth, system).connections()).toEqual(['default', 'system']);
    const ran = await on(auth, system).fresh();
    expect(ran).toHaveLength(3);
    expect(await tablesOf('system')).toEqual(['audit', 'counters']);
    expect(await connections.get<any>('system').selectFrom('counters').selectAll().execute()).toEqual([]);
    expect(await connections.get<any>('system').selectFrom('audit').selectAll().execute()).toEqual([]);
  });

  it('refuses a connection that is not configured — with the migration', async () => {
    await expect(on({ name: 'elsewhere', migrations: fixtures('elsewhere') }).migrate()).rejects.toThrow(
      '[marmeon:D14] Migration 2026_01_09_000000_create_reports_table (module "elsewhere") runs on the database connection "reporting", which is not configured. Known: default, system.',
    );
  });
});

// MySQL runs in `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL. A migration there has no transaction (DDL commits as it runs), so what a
// failure leaves is the DDL that ran; the rows of a data step go with the transaction it has to itself.
withMysql('migrations on MySQL', () => {
  const mysqlModule = (name: string): ModuleDefinition => ({ name, migrations: fixtures(name) });
  let connections: Connections;
  let close: () => Promise<void>;
  const db = () => connections.get<any>();
  const tables = async () =>
    (await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(db())).rows.map((row) => row.name);
  const columns = async (table: string) =>
    (await sql<{ name: string }>`select column_name as name from information_schema.columns where table_schema = database() and table_name = ${table} order by ordinal_position`.execute(db())).rows.map((row) => row.name);

  beforeAll(async () => ({ connections, close } = await freshConnections('mysql')));
  afterAll(() => close());

  it('creates, alters, renames and drops tables across modules, in one batch per run', async () => {
    const ran: string[] = [];
    expect((await migrator(connections, auth).migrate({ onRun: (run) => ran.push(run.name) })).length).toBe(1);
    await migrator(connections, auth, blog).migrate({ onRun: (run) => ran.push(run.name) });
    expect(ran).toEqual(['2026_01_01_000000_create_users_table', '2026_01_02_000000_create_posts_table', '2026_01_03_000000_add_slug_to_posts_table']);
    expect(await migrator(connections, auth, blog).migrate()).toEqual([]);
    expect((await migrator(connections, auth, blog).status()).map((m) => [m.name, m.batch])).toEqual([
      ['2026_01_01_000000_create_users_table', 1],
      ['2026_01_02_000000_create_posts_table', 2],
      ['2026_01_03_000000_add_slug_to_posts_table', 2],
    ]);
    expect(await tables()).toEqual(['articles', 'migrations', 'users']);
    expect(await columns('articles')).toEqual(['id', 'user_id', 'title', 'content', 'published_at', 'slug']);
  });

  it('gives every table the binary collation, so a value is the same value in any case it was written in', async () => {
    const collations = (await sql<{ collation: string }>`select table_collation as collation from information_schema.tables where table_schema = database()`.execute(db())).rows;
    expect(collations).toHaveLength(3);
    expect(new Set(collations.map((row) => row.collation))).toEqual(new Set(['utf8mb4_0900_bin']));
    await db().insertInto('users').values({ name: 'Ada', email: 'Ada@Example.com' }).execute();
    await db().insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).execute(); // not a duplicate
    await expect(db().insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).execute()).rejects.toThrow(/duplicate/i);
    const [row] = (await sql<{ created_at: string; is_admin: boolean }>`select created_at, is_admin from users order by id limit 1`.execute(db())).rows;
    expect(row).toEqual({ created_at: expect.stringMatching(ISO_UTC), is_admin: false });
    expect((await sql<{ same: number }>`select 'A' = 'a' as same`.execute(db())).rows[0]?.same).toBe(0);
  });

  it('creates foreign keys that hold: an orphan is refused, and a delete cascades', async () => {
    await db().insertInto('articles').values({ user_id: 1, title: 'Hello', slug: 'hello' }).execute();
    await expect(db().insertInto('articles').values({ user_id: 99, title: 'Orphan' }).execute()).rejects.toThrow(/foreign key/i);
    await db().deleteFrom('users').where('id', '=', 1).execute();
    expect((await sql<{ n: number }>`select count(*) as n from articles`.execute(db())).rows[0]?.n).toBe(0);
  });

  it('rolls back the last batch, undoing renames and dropping an index by the table it is on', async () => {
    const both = migrator(connections, auth, blog);
    expect((await both.rollback()).map((run) => run.name)).toEqual(['2026_01_03_000000_add_slug_to_posts_table', '2026_01_02_000000_create_posts_table']);
    expect(await tables()).toEqual(['migrations', 'users']);
    await both.migrate();
    expect((await both.rollback({ steps: 1 })).map((run) => run.name)).toEqual(['2026_01_03_000000_add_slug_to_posts_table']);
    expect(await columns('posts')).toEqual(['id', 'user_id', 'title', 'body', 'published_at']);
    expect((await both.reset()).length).toBe(2);
    expect(await tables()).toEqual(['migrations']);
  });

  it('leaves the rows of a data step that throws unchanged, and does not record the migration', async () => {
    const own = await freshConnections('mysql');
    try {
      const data = migrator(own.connections, mysqlModule('mysql-data'));
      await expect(data.migrate()).rejects.toThrow('the backfill failed');
      const rows = own.connections.get<any>();
      expect((await sql<{ amount: number }>`select amount from ledger order by id`.execute(rows)).rows).toEqual([{ amount: 10 }, { amount: 20 }]);
      expect((await data.status()).map((m) => [m.name, m.batch])).toEqual([
        ['2026_03_01_000000_create_ledger_table', 1],
        ['2026_03_02_000000_raise_the_ledger', undefined],
      ]);
    } finally {
      await own.close();
    }
  });

  it.each([
    ['a # comment in front of a create', '# note\ncreate table smuggled (id integer)'],
    ['a create in an executable comment', '/*! create table smuggled (id integer) */'],
    ['a truncate', 'truncate table ledger'],
    ['a rename table', 'rename table ledger to smuggled'],
    ['a lock tables', 'lock tables ledger write'],
    ['a check table', 'check table ledger'],
    // For an account that does not exist: a statement that got through must not change the password of the account the test runs as.
    ['a set password', "set password for 'marmeon_nobody'@'%' = 'x'"],
    ['a commit', 'commit'],
    ['a commit and chain', 'commit and chain'],
    ['a rollback', 'rollback'],
  ])('stops %s in a data step with D4 and keeps what the step changed from being committed', async (_name, statement) => {
    const own = await freshConnections('mysql');
    const rows = own.connections.get<any>();
    try {
      (globalThis as { guardedStatement?: string }).guardedStatement = statement;
      await expect(migrator(own.connections, mysqlModule('mysql-guard')).migrate()).rejects.toThrow(/^\[marmeon:D4\] Cannot run this statement in a schema\.data\(\) step: it ends or steers the transaction of the step, which the migrator controls, and a schema change would be missing from the plan of the migration\. /);
      expect((await sql<{ amount: number }>`select amount from ledger order by id`.execute(rows)).rows).toEqual([{ amount: 10 }, { amount: 20 }]);
      expect((await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(rows)).rows.map((row) => row.name)).toEqual(['ledger', 'migrations']);
    } finally {
      delete (globalThis as { guardedStatement?: string }).guardedStatement;
      await own.close();
    }
  });

  it('plans every rollback before it runs the first: a batch with a refused down() leaves the newer migration done', async () => {
    const own = await freshConnections('mysql');
    try {
      const run = migrator(own.connections, mysqlModule('mysql-down-two'));
      await run.migrate();
      await expect(run.rollback()).rejects.toThrow(/^\[marmeon:D18\] Migration 2026_03_10_000000_create_older_table \(module "mysql-down-two"\) has a schema\.raw\(\) step/);
      expect((await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(own.connections.get<any>())).rows.map((row) => row.name)).toEqual(['migrations', 'newer', 'older']);
      expect((await run.status()).map((m) => m.batch)).toEqual([1, 1]);
    } finally {
      await own.close();
    }
  });

  it('makes the record with the first migration of an empty database, and leaves it with the tables of a first migration that fails', async () => {
    const fresh = await freshConnections('mysql', { record: false });
    try {
      const rows = fresh.connections.get<any>();
      await migrator(fresh.connections, auth).migrate();
      expect((await sql<{ name: string; batch: number }>`select name, batch from migrations`.execute(rows)).rows).toEqual([{ name: '2026_01_01_000000_create_users_table', batch: 1 }]);
    } finally {
      await fresh.close();
    }
    const failing = await freshConnections('mysql', { record: false });
    try {
      const rows = failing.connections.get<any>();
      await expect(migrator(failing.connections, broken).migrate()).rejects.toThrow('this migration is broken');
      // MySQL cannot undo the table the migration made, and the record is made before the first migration: it is empty.
      expect((await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(rows)).rows.map((row) => row.name)).toEqual(['half', 'migrations']);
      expect((await sql<{ n: number }>`select count(*) as n from migrations`.execute(rows)).rows[0]?.n).toBe(0);
    } finally {
      await failing.close();
    }
  });

  it('creates the defaults as the server reads them back, and a foreign key added later that cascades', async () => {
    const own = await freshConnections('mysql');
    const rows = own.connections.get<any>();
    try {
      await migrator(own.connections, mysqlModule('mysql-defaults')).migrate();
      await sql`insert into defaults () values ()`.execute(rows);
      const [row] = (await sql<Record<string, unknown>>`select note, settings, opened_at, stamped, kind from defaults`.execute(rows)).rows;
      expect(row).toEqual({
        note: 'it\'s a \\ back\\slash \'quoted\' and "double"',
        settings: { list: ["q'uote", 'back\\slash', 1], on: true },
        opened_at: '2026-10-01T08:00:00.123Z',
        stamped: expect.stringMatching(ISO_UTC),
        kind: 'plain',
      });
      await sql`insert into owners (name) values ('Ada')`.execute(rows);
      await sql`insert into pets (name, owner_id) values ('Rex', 1)`.execute(rows);
      await expect(sql`insert into pets (name, owner_id) values ('Stray', 99)`.execute(rows)).rejects.toThrow(/foreign key/i);
      await sql`delete from owners where id = 1`.execute(rows);
      expect((await sql`select id from pets`.execute(rows)).rows).toEqual([]);
    } finally {
      await own.close();
    }
  });

  it('refuses a raw step without a statement for MySQL before the first statement of the run, naming the migration and the step', async () => {
    const own = await freshConnections('mysql');
    try {
      const sent: string[] = [];
      own.connections.onQuery((query) => void sent.push(query.sql));
      const run = migrator(own.connections, mysqlModule('mysql-raw-refused'));
      await expect(run.migrate()).rejects.toThrow(
        /^\[marmeon:D18\] Migration 2026_03_04_000000_raw_without_mysql \(module "mysql-raw-refused"\) has a schema\.raw\(\) step \(step 1 of its plan\) with a statement for sqlite and pgsql and none for MySQL/,
      );
      // The create of the migration before it did not run either: nothing was sent that changes the schema.
      expect(sent.filter((text) => /^\s*(create|alter|drop|rename)\b/i.test(text))).toEqual([]);
      expect(await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(own.connections.get<any>()).then((result) => result.rows.map((row) => row.name))).toEqual(['migrations']);
    } finally {
      await own.close();
    }
  });

  it('runs the statement of a raw step for MySQL, the plain form too, and nothing for `mysql: null`', async () => {
    const own = await freshConnections('mysql');
    try {
      const run = migrator(own.connections, mysqlModule('mysql-raw'));
      await run.migrate();
      const names = async () => (await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(own.connections.get<any>())).rows.map((row) => row.name);
      expect(await names()).toEqual(['from_both', 'from_mysql', 'migrations']);
      await run.rollback();
      expect(await names()).toEqual(['migrations']);
    } finally {
      await own.close();
    }
  });

  it('refuses a rollback whose raw step has no statement for MySQL before it drops anything', async () => {
    const own = await freshConnections('mysql');
    try {
      const run = migrator(own.connections, mysqlModule('mysql-raw-down'));
      await run.migrate();
      await expect(run.rollback()).rejects.toThrow(/^\[marmeon:D18\] Migration 2026_03_06_000000_create_keeps_down_table \(module "mysql-raw-down"\) has a schema\.raw\(\) step \(step 2 of its plan\)/);
      expect((await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(own.connections.get<any>())).rows.map((row) => row.name)).toEqual(['keeps_down', 'migrations']);
    } finally {
      await own.close();
    }
  });
});

describe('migration files', () => {
  const root = workspaceTempDir('marmeon-migrations-');
  const app = (modules: ModuleDefinition[]) => new Migrator({ modules, root } as unknown as Application, undefined as never);

  it('rejects badly named files, duplicate names and missing directories — with the module', () => {
    const dir = mkdtempSync(join(root, 'm-'));
    writeFileSync(join(dir, 'create_users.ts'), '');
    expect(() => app([{ name: 'shop', migrations: dir }]).files()).toThrow(
      '[marmeon:D14] Migration file name "create_users.ts" (module "shop") must look like 2026_10_01_120000_create_users_table.ts.',
    );
    const twice = [
      { name: 'a', migrations: fixtures('auth') },
      { name: 'b', migrations: fixtures('auth') },
    ];
    expect(() => app(twice).files()).toThrow('[marmeon:D15] Two migrations are named "2026_01_01_000000_create_users_table" (modules "a" and "b").');
    expect(() => app([{ name: 'gone', migrations: 'nope' }]).files()).toThrow(/\[marmeon:D14\] The migrations directory of module "gone" does not exist/);
  });

  it('orders migrations of the same timestamp by code point, whatever the locale', () => {
    const dir = mkdtempSync(join(root, 'm-'));
    for (const name of ['ab', 'a_b', 'a1', 'a_1']) writeFileSync(join(dir, `2026_01_01_000000_${name}.ts`), '');
    expect(
      app([{ name: 'x', migrations: dir }])
        .files()
        .map((file) => file.name.slice('2026_01_01_000000_'.length)),
    ).toEqual(['a1', 'a_1', 'a_b', 'ab']);
  });

  it('ignores declaration and test files, and resolves string paths against the app root', () => {
    const dir = mkdtempSync(join(root, 'm-'));
    writeFileSync(join(dir, '2026_01_01_000000_a.d.ts'), '');
    writeFileSync(join(dir, 'helpers.test.ts'), '');
    writeFileSync(join(dir, 'README.md'), '');
    expect(app([{ name: 'x', migrations: dir.slice(root.length + 1) }]).files()).toEqual([]);
  });
});

// Postgres cuts an identifier at 63 bytes without a word, and the migrations' schema keeps the whole name: such a migration ends in D3,
// which names the possible cause. A long name that lives inside one plan is never lacking.
describe.each(drivers)('names Postgres cuts (%s)', (driver) => {
  const root = workspaceTempDir('marmeon-long-names-');
  const kysely = import.meta.resolve('kysely');
  const letters = (n: number, char = 'c') => char.repeat(n);
  const twoByte = 'é';
  const stamp = '2026_02_01_000000';
  const source = (body: string, down = '') => `import { sql } from '${kysely}';\nexport default {\n  up: (schema: any) => {\n${body}\n  },\n  down: (schema: any) => {\n${down}\n  },\n};\n`;
  const moduleOf = (files: Record<string, string>): ModuleDefinition => {
    const dir = mkdtempSync(join(root, 'm-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.ts`), text);
    return { name: 'cut', migrations: dir };
  };
  const recorded = async (connections: Connections) => (await sql<{ name: string }>`select name from migrations order by id`.execute(connections.get<any>())).rows.map((row) => row.name);
  const tablesOf = async (connections: Connections) => (await connections.get<any>().introspection.getTables()).map((t) => t.name).filter((name) => name !== LOCK_TABLE).sort();
  const create = (table: string, column: string) => `    schema.create(${JSON.stringify(table)}, (table: any) => { table.string(${JSON.stringify(column)}); });`;
  const cause = (name: string) => ` Or the name ${name} is the cause: it is over 63 bytes of UTF-8, and Postgres cuts a name at 63 bytes of the database's encoding without a word. If it cut this one, use a shorter name.`;
  const d3 = (file: string, lacking: string, tail = '') =>
    `[marmeon:D3] Migration ${file} (module "cut") left the database without ${lacking}, which the migrations say is there: a table or column was renamed or dropped with raw SQL, and the schema the migrations describe did not follow. The migration was rolled back. Use schema.alter() (renameColumn, dropColumn) and schema.rename(), which keep it in step. See docs/migrations.md#raw-sql.${tail}`;

  const withDatabase = async (body: (own: Awaited<ReturnType<typeof freshConnections>>) => Promise<void>) => {
    const own = await freshConnections(driver);
    try {
      await body(own);
    } finally {
      await own.close();
    }
  };

  const refused = (name: string, files: Record<string, string>, message: string, before: string[] = [], tablesBefore: string[] = []) =>
    it.runIf(driver === 'pgsql')(name, async () => {
      await withDatabase(async ({ connections }) => {
        const error = await migrator(connections, moduleOf(files)).migrate().then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(message);
        expect(await recorded(connections)).toEqual(before);
        expect(await tablesOf(connections)).toEqual(['migrations', ...tablesBefore].sort());
      });
    });

  const column64 = letters(64);
  refused('ends a migration that leaves a column of 64 bytes in D3 and names the cut as the cause', { [`${stamp}_create_cut_column`]: source(create('items', column64)) }, d3(`${stamp}_create_cut_column`, `the column items.${column64}`, cause(`items.${column64}`)));

  const column32 = letters(32, twoByte);
  refused('counts bytes, not characters: a column of 32 two-byte letters is 64 bytes', { [`${stamp}_create_cut_bytes`]: source(create('items', column32)) }, d3(`${stamp}_create_cut_bytes`, `the column items.${column32}`, cause(`items.${column32}`)));

  const table64 = letters(64, 't');
  refused('ends a migration that creates a table of 64 bytes in D3 and names it', { [`${stamp}_create_cut_table`]: source(create(table64, 'a')) }, d3(`${stamp}_create_cut_table`, `the table ${table64}`, cause(table64)));

  refused(
    'ends a column renamed to a name of 64 bytes in D3, keeps the migration before it',
    {
      [`${stamp}_create_items`]: source(create('items', 'old')),
      '2026_02_02_000000_rename_cut_column': source(`    schema.alter('items', (table: any) => { table.renameColumn('old', '${column64}'); });`),
    },
    d3('2026_02_02_000000_rename_cut_column', `the column items.${column64}`, cause(`items.${column64}`)),
    [`${stamp}_create_items`],
    ['items'],
  );

  refused(
    'ends a table renamed to a name of 64 bytes in D3, keeps the migration before it',
    {
      [`${stamp}_create_items`]: source(create('items', 'a')),
      '2026_02_02_000000_rename_cut_table': source(`    schema.rename('items', '${table64}');`),
    },
    d3('2026_02_02_000000_rename_cut_table', `the table ${table64}`, cause(table64)),
    [`${stamp}_create_items`],
    ['items'],
  );

  // A name that raw SQL renamed away is lacking whatever its length; the sentence belongs to Postgres and to a name over 63 bytes.
  const rawRename = (table: string, column: string) => `${create(table, column)}\n    schema.raw(sql.raw('alter table ${table} rename column ${column} to renamed'));`;
  const lost = (name: string, files: Record<string, string>, expected: string, only: 'pgsql' | 'sqlite') =>
    it.runIf(only === driver)(name, async () => {
      await withDatabase(async ({ connections }) => {
        const error = await migrator(connections, moduleOf(files)).migrate().then(() => undefined, (caught: unknown) => caught);
        expect((error as Error).message).toBe(expected);
        expect(await recorded(connections)).toEqual([]);
      });
    });

  lost('gives D3 without the sentence for a column of exactly 63 bytes that raw SQL renamed away', { [`${stamp}_raw_limit`]: source(rawRename('items', letters(63))) }, d3(`${stamp}_raw_limit`, `the column items.${letters(63)}`), 'pgsql');
  lost('gives D3 without the sentence for a column of 70 bytes that raw SQL renamed away on SQLite', { [`${stamp}_raw_long`]: source(rawRename('items', letters(70))) }, d3(`${stamp}_raw_long`, `the column items.${letters(70)}`), 'sqlite');
  lost(
    'gives D3 without the sentence for a table x.<64 bytes>: a qualified table ends in D3 whatever its length',
    { [`${stamp}_create_dotted_long`]: source(`    schema.raw(sql.raw('create schema x'));\n${create(`x.${table64}`, 'a')}`) },
    d3(`${stamp}_create_dotted_long`, `the table x.${table64}`),
    'pgsql',
  );
  lost(
    'gives D3 without the sentence for a table public.<60 bytes>: a limit of qualified tables, 67 bytes as a whole',
    { [`${stamp}_create_dotted_short`]: source(create(`public.${letters(60, 't')}`, 'a')) },
    d3(`${stamp}_create_dotted_short`, `the table public.${letters(60, 't')}`),
    'pgsql',
  );

  const migrates = (name: string, files: Record<string, string>, then: (own: Awaited<ReturnType<typeof freshConnections>>, run: Migrator) => Promise<void>, only: 'pgsql' | 'sqlite') =>
    it.runIf(only === driver)(name, async () => {
      await withDatabase(async (own) => then(own, migrator(own.connections, moduleOf(files))));
    });

  migrates(
    'keeps the text of D3 for a short name lost to raw SQL',
    { [`${stamp}_raw_rename`]: source(`${create('items', 'a')}\n    schema.raw(sql.raw('alter table items rename column a to b'));`) },
    async ({ connections }, run) => {
      const error = await run.migrate().then(() => undefined, (caught: unknown) => caught);
      expect((error as Error).message).toBe(d3(`${stamp}_raw_rename`, 'the column items.a'));
      expect(await recorded(connections)).toEqual([]);
    },
    'pgsql',
  );

  migrates(
    'runs a migration whose column of 70 bytes lives and is renamed short inside one plan',
    { [`${stamp}_create_local`]: source(`${create('items', letters(70))}\n    schema.alter('items', (table: any) => { table.renameColumn('${letters(70)}', 'short'); });`) },
    async ({ connections }, run) => {
      expect((await run.migrate()).map((ran) => ran.name)).toEqual([`${stamp}_create_local`]);
      expect((await connections.get<any>().introspection.getTables()).find((table) => table.name === 'items')!.columns.map((column) => column.name)).toEqual(['short']);
    },
    'pgsql',
  );

  migrates(
    'runs a migration that creates a column of 70 bytes and drops it with dropColumn() in one plan',
    { [`${stamp}_create_dropped`]: source(`    schema.create('items', (table: any) => { table.string('a'); table.string('${letters(70)}'); });\n    schema.alter('items', (table: any) => { table.dropColumn('${letters(70)}'); });`) },
    async ({ connections }, run) => {
      expect((await run.migrate()).map((ran) => ran.name)).toEqual([`${stamp}_create_dropped`]);
      expect((await connections.get<any>().introspection.getTables()).find((table) => table.name === 'items')!.columns.map((column) => column.name)).toEqual(['a']);
    },
    'pgsql',
  );

  migrates(
    'keeps Postgres its own error for two names that cut alike',
    { [`${stamp}_create_alike`]: source(`    schema.create('items', (table: any) => { table.string('${letters(63)}a'); table.string('${letters(63)}b'); });`) },
    async ({ connections }, run) => {
      const error = await run.migrate().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/specified more than once/);
      expect((error as Error).message).not.toContain('[marmeon:D3]');
      expect(await recorded(connections)).toEqual([]);
    },
    'pgsql',
  );

  migrates(
    'runs a table and a column of exactly 63 bytes',
    { [`${stamp}_create_limit`]: source(create(letters(63, 't'), letters(63))) },
    async ({ connections }, run) => {
      await run.migrate();
      expect(await recorded(connections)).toEqual([`${stamp}_create_limit`]);
      expect(await connections.get<any>().selectFrom(letters(63, 't')).select(letters(63)).execute()).toEqual([]);
    },
    'pgsql',
  );

  migrates(
    'runs, queries and rolls back a table and a column of 70 bytes on SQLite',
    { [`${stamp}_create_long`]: source(create(letters(70, 't'), letters(70)), `    schema.drop('${letters(70, 't')}');`) },
    async ({ connections }, run) => {
      await run.migrate();
      expect(await connections.get<any>().selectFrom(letters(70, 't')).select(letters(70)).execute()).toEqual([]);
      expect((await run.rollback()).map((ran) => ran.name)).toEqual([`${stamp}_create_long`]);
      expect(await tablesOf(connections)).toEqual(['migrations']);
    },
    'sqlite',
  );
});

describe.each(drivers)('the data step a generator writes (%s)', (driver) => {
  const root = workspaceTempDir('marmeon-generated-data-');
  // The example of docs/migrations.md as the page has it; only the package name becomes this checkout's source, which the temporary directory cannot resolve.
  const page = readFileSync(new URL('../../../docs/migrations.md', import.meta.url), 'utf8');
  const example = /```ts title="modules\/notes\/migrations\/(2026_10_05_090000_create_labels_table\.ts)"\n([\s\S]*?)\n```/.exec(page);
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => ({ connections, close } = await freshConnections(driver)));
  afterAll(() => close());

  const rewritten = (source: string) => {
    expect(source).toContain("from '@marmeon/database'");
    // A function replacer: the path may hold `$&` or `$1`.
    return `${source.replace("from '@marmeon/database'", () => `from '${new URL('./index.ts', import.meta.url).href}'`)}\n`;
  };
  const labels = async () => (await connections.get<any>().selectFrom('labels').select(['name', 'text']).orderBy('name').execute()) as { name: string; text: string }[];

  it('runs the example of the page: a __proto__ key of its data reaches the table, and down drops the table again', async () => {
    expect(example).not.toBeNull();
    const [, file, source] = example!;
    expect(source).toContain("JSON.parse('");
    const dir = mkdtempSync(join(root, 'm-'));
    writeFileSync(join(dir, file!), rewritten(source!));
    const run = migrator(connections, { name: 'notes', migrations: dir });
    await run.migrate();
    expect(await labels()).toEqual([
      { name: '__proto__', text: 'Hidden' },
      { name: 'draft', text: 'Not published' },
    ]);
    await run.rollback();
    expect((await connections.get<any>().introspection.getTables()).map((table: { name: string }) => table.name)).not.toContain('labels');
  });

  it('keeps what the recipe of the page writes: JSON.stringify of the JSON text, with a __proto__ key, quotes and backslashes', async () => {
    const [, file, source] = example!;
    // Data as a generator holds it: an own `__proto__` key, which only JSON.parse or Object.fromEntries gives.
    const data: Record<string, string> = Object.fromEntries([
      ['__proto__', "  it's  "],
      ['back\\slash', 'a \\ b'],
      ['draft', ' "quoted" '],
    ]);
    expect(Object.keys(data)).toContain('__proto__');
    const line = /^const labels: .*$/m;
    expect(source).toMatch(line);
    const generated = source!.replace(line, () => `const labels: Record<string, string> = JSON.parse(${JSON.stringify(JSON.stringify(data))});`);
    const dir = mkdtempSync(join(root, 'm-'));
    writeFileSync(join(dir, file!), rewritten(generated));
    const run = migrator(connections, { name: 'notes', migrations: dir });
    await run.migrate();
    expect(await labels()).toEqual([
      { name: '__proto__', text: "it's" },
      { name: 'back\\slash', text: 'a \\ b' },
      { name: 'draft', text: '"quoted"' },
    ]);
    await run.rollback();
  });
});
