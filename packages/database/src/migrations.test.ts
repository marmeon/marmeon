import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections, freshDatabase, MYSQL_URL, PGSQL_URL, silent, withMysql } from './__fixtures__/databases.ts';
import { Connections, Migrator } from './index.ts';
import { inspectionConnection } from './migrator-connection.ts';
import { runMigration } from './migrations/run.ts';
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
    ['a down() the driver cannot run', 'down-checked', driver === 'sqlite' ? /^\[marmeon:D18\] schema\.alter\('first_checked'\) cannot make the column "name" NOT NULL on SQLite/ : /^\[marmeon:D5\] The index name "i+" is longer than Postgres's 63 bytes in this database's encoding/, 'second_checked'],
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
  const markers = async (on: Connections) => (await sql<{ name: string }>`select name from migration_interruption order by name`.execute(inspectionConnection(on))).rows.map((row) => row.name);

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
    expect(await tables()).toEqual(['articles', 'migration_interruption', 'migrations', 'users']);
    expect(await columns('articles')).toEqual(['id', 'user_id', 'title', 'content', 'published_at', 'slug']);
  });

  it('gives every table the binary collation, so a value is the same value in any case it was written in', async () => {
    const collations = (await sql<{ collation: string }>`select table_collation as collation from information_schema.tables where table_schema = database()`.execute(db())).rows;
    expect(collations).toHaveLength(4);
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
    expect(await tables()).toEqual(['migration_interruption', 'migrations', 'users']);
    await both.migrate();
    expect((await both.rollback({ steps: 1 })).map((run) => run.name)).toEqual(['2026_01_03_000000_add_slug_to_posts_table']);
    expect(await columns('posts')).toEqual(['id', 'user_id', 'title', 'body', 'published_at']);
    expect((await both.reset()).length).toBe(2);
    expect(await tables()).toEqual(['migration_interruption', 'migrations']);
  });

  it('runs the schema changes and the data steps that follow a data step that succeeded, on the connection its transaction ended on', async () => {
    const own = await freshConnections('mysql');
    try {
      const ran = await migrator(own.connections, mysqlModule('mysql-data-ok')).migrate();
      expect(ran.map((run) => run.name)).toEqual(['2026_04_01_000000_fill_and_extend_the_ledger']);
      expect((await sql<{ amount: number; note: string }>`select amount, note from ledger order by id`.execute(own.connections.get<any>())).rows).toEqual([
        { amount: 10, note: 'raised' },
        { amount: 20, note: 'raised' },
      ]);
    } finally {
      await own.close();
    }
  });

  it('leaves the rows of a data step that throws unchanged, and does not record the migration', async () => {
    const own = await freshConnections('mysql');
    try {
      const data = migrator(own.connections, mysqlModule('mysql-data'));
      await expect(data.migrate()).rejects.toThrow('the backfill failed');
      // As the server has it: the app's connection refuses every query while the migration is marked.
      const rows = inspectionConnection(own.connections);
      expect((await sql<{ amount: number }>`select amount from ledger order by id`.execute(rows)).rows).toEqual([{ amount: 10 }, { amount: 20 }]);
      expect((await data.status()).map((m) => [m.name, m.batch])).toEqual([
        ['2026_03_01_000000_create_ledger_table', 1],
        ['2026_03_02_000000_raise_the_ledger', undefined],
      ]);
      // The migration changed a table before its step failed: MySQL keeps that, so the marker says it did not finish.
      expect(await markers(own.connections)).toEqual(['2026_03_02_000000_raise_the_ledger']);
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
      expect((await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(rows)).rows.map((row) => row.name)).toEqual(['ledger', 'migration_interruption', 'migrations']);
      // A migration of rows alone shares its transaction with the record: nothing was committed, so there is nothing to mark.
      expect(await markers(own.connections)).toEqual([]);
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
      expect((await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(own.connections.get<any>())).rows.map((row) => row.name)).toEqual(['migration_interruption', 'migrations', 'newer', 'older']);
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
      const rows = inspectionConnection(failing.connections);
      await expect(migrator(failing.connections, broken).migrate()).rejects.toThrow('this migration is broken');
      // MySQL cannot undo the table the migration made, and the record is made before the first migration: it is empty.
      expect((await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(rows)).rows.map((row) => row.name)).toEqual(['half', 'migration_interruption', 'migrations']);
      expect((await sql<{ n: number }>`select count(*) as n from migrations`.execute(rows)).rows[0]?.n).toBe(0);
      expect(await markers(failing.connections)).toEqual(['2026_01_04_000000_create_half_table']);
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
      const interrupted: unknown[] = [];
      await expect(run.migrate({ onInterrupted: (left) => interrupted.push(left) })).rejects.toThrow(
        /^\[marmeon:D18\] Migration 2026_03_04_000000_raw_without_mysql \(module "mysql-raw-refused"\) has a schema\.raw\(\) step \(step 1 of its plan\) with a statement for sqlite and pgsql and none for MySQL/,
      );
      // The create of the migration before it did not run either: nothing was sent that changes the schema.
      expect(sent.filter((text) => /^\s*(create|alter|drop|rename)\b/i.test(text))).toEqual([]);
      expect(await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(own.connections.get<any>()).then((result) => result.rows.map((row) => row.name))).toEqual(['migration_interruption', 'migrations']);
      // A refusal before the first statement marks nothing, so the next run says the same thing and not D32.
      expect(await markers(own.connections)).toEqual([]);
      expect(interrupted).toEqual([]);
      await expect(migrator(own.connections, mysqlModule('mysql-raw-refused')).migrate()).rejects.toThrow(/^\[marmeon:D18\] /);
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
      expect(await names()).toEqual(['from_both', 'from_mysql', 'migration_interruption', 'migrations']);
      await run.rollback();
      expect(await names()).toEqual(['migration_interruption', 'migrations']);
    } finally {
      await own.close();
    }
  });

  it('refuses a rollback whose raw step has no statement for MySQL before it drops anything', async () => {
    const own = await freshConnections('mysql');
    try {
      const run = migrator(own.connections, mysqlModule('mysql-raw-down'));
      await run.migrate();
      const interrupted: unknown[] = [];
      await expect(run.rollback({ onInterrupted: (left) => interrupted.push(left) })).rejects.toThrow(/^\[marmeon:D18\] Migration 2026_03_06_000000_create_keeps_down_table \(module "mysql-raw-down"\) has a schema\.raw\(\) step \(step 2 of its plan\)/);
      expect((await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(own.connections.get<any>())).rows.map((row) => row.name)).toEqual(['keeps_down', 'migration_interruption', 'migrations']);
      expect(interrupted).toEqual([]);
      expect(await markers(own.connections)).toEqual([]);
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
    'drops and renames a table and a column of 70 bytes by their names on SQLite, which cuts nothing',
    {
      [`${stamp}_create_long`]: source(`    schema.create(${JSON.stringify(letters(70, 't'))}, (table: any) => { table.string(${JSON.stringify(letters(70))}); table.string('other'); });`),
      '2026_02_02_000000_drop_long': source(`    schema.alter(${JSON.stringify(letters(70, 't'))}, (table: any) => { table.renameColumn(${JSON.stringify(letters(70))}, 'short'); });\n    schema.rename(${JSON.stringify(letters(70, 't'))}, 'moved');\n    schema.dropIfExists('moved');`),
    },
    async ({ connections }, run) => {
      expect((await run.migrate()).map((ran) => ran.name)).toEqual([`${stamp}_create_long`, '2026_02_02_000000_drop_long']);
      expect(await tablesOf(connections)).toEqual(['migrations']);
    },
    'sqlite',
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

// In an up(), a name with a dot names a table together with its schema or database, and the migrations do not describe such a table.
describe('a table name with a dot in create() and rename()', () => {
  const root = workspaceTempDir('marmeon-dotted-');
  const kysely = import.meta.resolve('kysely');
  const stamp = '2026_02_01_000000';
  const second = '2026_02_02_000000';
  type Driver = 'sqlite' | 'pgsql' | 'mysql';
  const every: Driver[] = [...drivers, ...(MYSQL_URL === undefined ? [] : (['mysql'] as const))];
  const source = (up: string, down = '') => `import { sql } from '${kysely}';\nexport default {\n  up: (schema: any) => {\n${up}\n  },\n  down: (schema: any) => {\n${down}\n  },\n};\n`;
  const create = (table: string) => `    schema.create(${JSON.stringify(table)}, (table: any) => { table.string('a'); });`;
  const d31 = (action: string, table: string) =>
    `[marmeon:D31] Cannot ${action} "${table}": a name with a dot names a table together with its schema or database, and the migrations do not describe such a table. Use a name without a dot. See docs/migrations.md#what-the-migrations-describe.`;
  const names = (connections: Connections, driver: Driver) =>
    sql<{ name: string }>`${
      driver === 'sqlite'
        ? sql.raw(`select name from sqlite_master where type = 'table' and name not in ('migration_lock', 'sqlite_sequence') order by 1`)
        : driver === 'pgsql'
          ? sql.raw(`select table_schema || '.' || table_name as name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1`)
          : sql.raw(`select concat(table_schema, '.', table_name) as name from information_schema.tables where table_schema not in ('mysql', 'sys', 'information_schema', 'performance_schema') order by 1`)
    }`
      .execute(connections.get<any>())
      .then((result) => result.rows.map((row) => row.name));
  /** The schema or database a table of the connection lies in, as a prefix of a qualified name. */
  const qualifier = async (connections: Connections, driver: Driver) =>
    driver === 'sqlite' ? 'main' : driver === 'pgsql' ? 'public' : (await sql<{ name: string }>`select database() as name`.execute(connections.get<any>())).rows[0]!.name;
  const recorded = async (connections: Connections) => (await sql<{ name: string }>`select name from migrations order by id`.execute(connections.get<any>())).rows.map((row) => row.name);
  const long = (n: number, char = 't') => char.repeat(n);

  type Own = Awaited<ReturnType<typeof freshConnections>>;
  /** Runs the migrations on a fresh database. `files` may need the database (its name), so it is given the connections. */
  const run = async (driver: Driver, files: Record<string, string> | ((connections: Connections) => Promise<Record<string, string>>), then: (error: unknown, own: Own, run: Migrator) => Promise<void>) => {
    const own = await freshConnections(driver);
    try {
      const dir = mkdtempSync(join(root, 'm-'));
      for (const [name, text] of Object.entries(typeof files === 'function' ? await files(own.connections) : files)) writeFileSync(join(dir, `${name}.ts`), text);
      const runner = migrator(own.connections, { name: 'dotted', migrations: dir });
      const error = await runner.migrate().then(() => undefined, (caught: unknown) => caught);
      await then(error, own, runner);
    } finally {
      await own.close();
    }
  };

  it.runIf(PGSQL_URL !== undefined)('refuses x.<64 bytes> on Postgres, where the table would be created and then lacked as D3', async () => {
    await run('pgsql', { [`${stamp}_dotted`]: source(create(`x.${long(64)}`)) }, async (error, { connections }) => {
      expect((error as Error).message).toBe(d31('create the table', `x.${long(64)}`));
      expect(await recorded(connections)).toEqual([]);
      expect(await names(connections, 'pgsql')).toEqual(['public.migrations']);
    });
  });

  it.runIf(PGSQL_URL !== undefined)('refuses public.<60 bytes> on Postgres, a name of 67 bytes that Postgres would not cut', async () => {
    await run('pgsql', { [`${stamp}_dotted`]: source(create(`public.${long(60)}`)) }, async (error, { connections }) => {
      expect((error as Error).message).toBe(d31('create the table', `public.${long(60)}`));
      expect(await recorded(connections)).toEqual([]);
      expect(await names(connections, 'pgsql')).toEqual(['public.migrations']);
    });
  });

  it('refuses main.items on SQLite and creates nothing', async () => {
    await run('sqlite', { [`${stamp}_dotted`]: source(create('main.items')) }, async (error, { connections }) => {
      expect((error as Error).message).toBe(d31('create the table', 'main.items'));
      expect(await recorded(connections)).toEqual([]);
      expect(await names(connections, 'sqlite')).toEqual(['migrations']);
    });
  });

  it('refuses a rename to a name with a dot, keeps the migration that ran before it and its table', async () => {
    for (const driver of every) {
      const own = await freshConnections(driver);
      try {
        const dir = mkdtempSync(join(root, 'm-'));
        const runner = migrator(own.connections, { name: 'dotted', migrations: dir });
        writeFileSync(join(dir, `${stamp}_items.ts`), source(create('items')));
        await runner.migrate();
        // The plans of all pending migrations are built before the first runs, so the migration that renames comes in a run of its own.
        writeFileSync(join(dir, `${second}_rename.ts`), source("    schema.rename('items', 'x.items');"));
        const error = await runner.migrate().then(() => undefined, (caught: unknown) => caught);
        expect((error as Error).message, driver).toBe(d31('rename a table to', 'x.items'));
        expect(await recorded(own.connections), driver).toEqual([`${stamp}_items`]);
        expect((await names(own.connections, driver)).filter((name) => name.endsWith('items')), driver).toEqual([`${driver === 'sqlite' ? '' : `${await qualifier(own.connections, driver)}.`}items`]);
      } finally {
        await own.close();
      }
    }
  });

  it('still runs dropIfExists() of a name with a dot', async () => {
    for (const driver of every) {
      await run(driver, { [`${stamp}_dotted`]: source(`    schema.dropIfExists('a.b');\n${create('items')}`) }, async (error, { connections }) => {
        expect(error, driver).toBeUndefined();
        expect(await recorded(connections), driver).toEqual([`${stamp}_dotted`]);
      });
    }
  });

  it('ends alter() and rename() of a name with a dot in D19, whose hint does not send it to create()', async () => {
    for (const driver of every) {
      for (const change of ["schema.alter('x.items', (table: any) => { table.string('b').nullable(); });", "schema.rename('x.items', 'y');"]) {
        await run(driver, { [`${stamp}_dotted`]: source(`    ${change}`) }, async (error) => {
          expect((error as Error).message, `${driver} ${change}`).toBe(
            `[marmeon:D19] Migration ${stamp}_dotted (module "dotted") changes table "x.items", which no migration created with the blueprint. The migrations do not describe a table named with its schema or database: use drop() or dropIfExists() for it, or schema.raw(). See docs/migrations.md#what-the-migrations-describe.`,
          );
        });
      }
    }
  });

  it('accepts a name with a dot in a down(): it recreates a table another tool made, and the migrations do not check it', async () => {
    for (const driver of every) {
      await run(
        driver,
        async (connections) => ({
          [`${stamp}_legacy`]: source(create('legacy_items')),
          [`${second}_drop`]: source("    schema.drop('legacy_items');", create(`${await qualifier(connections, driver)}.legacy_items`)),
        }),
        async (error, { connections }, runner) => {
          expect(error, driver).toBeUndefined();
          expect((await names(connections, driver)).filter((name) => name.endsWith('legacy_items')), driver).toEqual([]);
          expect((await runner.rollback()).map((ran) => ran.name), driver).toEqual([`${second}_drop`, `${stamp}_legacy`]);
          expect((await names(connections, driver)).filter((name) => name.endsWith('legacy_items')), driver).toHaveLength(1);
        },
      );
    }
  });

  withMysql('on MySQL', () => {
    it('refuses a table of another database and leaves that database alone', async () => {
      const other = `marmeon_test_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_dotted_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
      const own = await freshConnections('mysql');
      try {
        await sql.raw(`create database ${other}`).execute(own.connections.get<any>());
        const dir = mkdtempSync(join(root, 'm-'));
        writeFileSync(join(dir, `${stamp}_dotted.ts`), source(create(`${other}.b`)));
        const error = await migrator(own.connections, { name: 'dotted', migrations: dir }).migrate().then(() => undefined, (caught: unknown) => caught);
        expect((error as Error).message).toBe(d31('create the table', `${other}.b`));
        expect((await names(own.connections, 'mysql')).filter((name) => name.startsWith(`${other}.`))).toEqual([]);
      } finally {
        await sql.raw(`drop database if exists ${other}`).execute(own.connections.get<any>());
        await own.close();
      }
    });
  });
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

// Postgres measures the names itself, in the encoding of the database: the same name is cut in one and kept in another.
describe.runIf(drivers.includes('pgsql' as never))('names Postgres measures in the encoding of the database', () => {
  const root = workspaceTempDir('marmeon-name-encoding-');
  const stamp = (n: number) => `2026_03_0${n}_000000`;
  const moduleOf = (files: Record<string, string>): ModuleDefinition => {
    const dir = mkdtempSync(join(root, 'm-'));
    addFiles(dir, files);
    return { name: 'measured', migrations: dir };
  };
  const addFiles = (dir: string, files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.ts`), text);
  };
  const source = (body: string, down = '') => `export default {\n  up: (schema: any) => {\n${body}\n  },\n  down: (schema: any) => {\n${down}\n  },\n};\n`;
  const withIndex = (table: string, index: string) => `    schema.create(${JSON.stringify(table)}, (table: any) => { table.string('a'); table.index(['a'], ${JSON.stringify(index)}); });`;
  const plain = (table: string) => `    schema.create(${JSON.stringify(table)}, (table: any) => { table.string('a'); });`;
  const tablesOf = async (connections: Connections) => (await connections.get<any>().introspection.getTables()).map((t) => t.name).filter((name) => name !== LOCK_TABLE).sort();
  const indexesOf = async (connections: Connections) => (await sql<{ name: string }>`select indexname as name from pg_indexes where schemaname = 'public' order by indexname`.execute(connections.get<any>())).rows.map((row) => row.name);
  const recordOf = async (connections: Connections) => (await sql<{ name: string }>`select name from migrations order by id`.execute(connections.get<any>())).rows.map((row) => row.name);
  const failure = async (promise: Promise<unknown>): Promise<Error> => {
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  };
  const d5 = (what: string, name: string) => `[marmeon:D5] The ${what} "${name}" is longer than Postgres's 63 bytes in this database's encoding; Postgres would cut it and so change it silently.`;

  describe.each([
    ['UTF8', undefined],
    ['LATIN1', 'LATIN1'],
    ['EUC_JP', 'EUC_JP'],
  ] as const)('a database in %s', (_label, encoding) => {
    let own: Awaited<ReturnType<typeof freshConnections>>;
    // A database per test: what one leaves in the record of migrations is not what the next one starts from.
    beforeEach(async () => void (own = await freshConnections('pgsql', { ...(encoding ? { encoding } : {}) })));
    afterEach(() => own.close());
    const migrate = (files: Record<string, string>) => migrator(own.connections, moduleOf(files)).migrate();

    if (encoding === 'LATIN1') {
      it('keeps an index of 40 letters of two bytes in UTF-8 and one byte in LATIN1', async () => {
        const name = 'é'.repeat(40);
        await migrate({ [`${stamp(1)}_latin`]: source(withIndex('latin_items', name)) });
        expect(await indexesOf(own.connections)).toContain(name);
      });

      it('keeps a table renamed with indexes: true to a name whose index is 38 bytes in LATIN1 and 68 in UTF-8', async () => {
        const to = 'é'.repeat(30);
        await migrate({
          [`${stamp(2)}_create`]: source(withIndex('latin_before', 'latin_before_a_index')),
          [`${stamp(3)}_rename`]: source(`    schema.rename('latin_before', ${JSON.stringify(to)}, { indexes: true });`),
        });
        expect(await indexesOf(own.connections)).toContain(`${to}_a_index`);
      });

      it('drops a table of 40 letters of two bytes in UTF-8 by its name, which LATIN1 keeps whole', async () => {
        const name = 'é'.repeat(40);
        await migrate({ [`${stamp(5)}_create_wide`]: source(plain(name)) });
        expect((await migrate({ [`${stamp(6)}_drop_wide`]: source(`    schema.drop(${JSON.stringify(name)});`) })).map((run) => run.name)).toEqual([`${stamp(6)}_drop_wide`]);
        expect(await tablesOf(own.connections)).toEqual(['migrations']);
      });

      it('refuses a name the encoding cannot hold, names it, and runs nothing', async () => {
        const name = '日本語_index';
        const error = await failure(migrate({ [`${stamp(4)}_cjk`]: source(withIndex('cjk_items', name)) }));
        expect(error.message).toMatch(new RegExp(`^\\[marmeon:D5\\] One of these names cannot be held in this database's encoding: "${name}"`));
        expect(await tablesOf(own.connections)).not.toContain('cjk_items');
      });
    }

    if (encoding === 'EUC_JP') {
      it('refuses an index of 22 letters of three bytes in EUC_JP and runs nothing', async () => {
        const name = 'é'.repeat(22);
        const error = await failure(migrate({ [`${stamp(2)}_eucjp`]: source(withIndex('eucjp_items', name)) }));
        expect(error.message).toContain(d5('index name', name));
        expect(await tablesOf(own.connections)).not.toContain('eucjp_items');
        expect((await indexesOf(own.connections)).filter((name) => !name.startsWith('migrations_'))).toEqual([]);
      });
    }

    if (!encoding) {
      it('creates an index of exactly 63 bytes, and one of 62 bytes in 31 two-byte letters', async () => {
        const exact = 'i'.repeat(63);
        const accents = 'é'.repeat(31);
        await migrate({ [`${stamp(1)}_limit`]: source(withIndex('limit_a', exact) + '\n' + withIndex('limit_b', accents)) });
        expect(await indexesOf(own.connections)).toEqual(expect.arrayContaining([exact, accents]));
      });

      it('refuses a drop by 32 two-byte letters, 64 bytes, which Postgres cuts to the 31 letters of a table that exists', async () => {
        const kept = 'é'.repeat(31);
        const name = 'é'.repeat(32);
        const module = moduleOf({ [`${stamp(9)}_create_kept`]: source(plain(kept)) });
        await migrator(own.connections, module).migrate();
        addFiles(module.migrations as string, { [`2026_03_09_000001_drop_cut`]: source(`    schema.drop(${JSON.stringify(name)});`) });
        const error = await failure(migrator(own.connections, module).migrate());
        expect(error.message).toBe(`[marmeon:D5] The table "${name}" is longer than Postgres's 63 bytes in this database's encoding, so drop() would act on the table its first 63 bytes name. Name the table as Postgres stored it.`);
        expect(await tablesOf(own.connections)).toContain(kept);
      });

      it('refuses an index of 32 two-byte letters, 64 bytes', async () => {
        const name = 'é'.repeat(32);
        const error = await failure(migrate({ [`${stamp(2)}_over`]: source(withIndex('over_items', name)) }));
        expect(error.message).toContain(d5('index name', name));
        expect(await tablesOf(own.connections)).not.toContain('over_items');
      });

      it('refuses an index of 64 bytes before the first migration of a run of two, and leaves no record', async () => {
        const name = 'i'.repeat(64);
        const error = await failure(migrate({ [`${stamp(3)}_first`]: source(plain('first_of_two')), [`${stamp(4)}_second`]: source(withIndex('second_of_two', name)) }));
        expect(error.message).toContain(d5('index name', name));
        expect(await tablesOf(own.connections)).not.toContain('first_of_two');
        expect(await recordOf(own.connections)).toEqual([]);
      });

      it('refuses a table renamed with indexes: true to a name whose index would be cut', async () => {
        const to = 't'.repeat(60);
        const error = await failure(migrate({
          [`${stamp(5)}_create`]: source(withIndex('before_rename', 'before_rename_a_index')),
          [`${stamp(6)}_rename`]: source(`    schema.rename('before_rename', ${JSON.stringify(to)}, { indexes: true });`),
        }));
        // Which of the table's cut names comes first depends on the server's version (it names NOT NULL constraints since 18).
        expect(error.message).toMatch(new RegExp(`^\\[marmeon:D5\\] The name after the rename "${to}_a_\\w+" is longer than Postgres's 63 bytes in this database's encoding`));
        expect(await tablesOf(own.connections)).not.toContain(to);
        // The names of a rename come from the catalog, so they are asked when it runs: it rolls back, the migration before it stays.
        expect(await recordOf(own.connections)).toEqual([`${stamp(5)}_create`]);
      });

      it('refuses a table renamed to 30 two-byte letters, whose index is 68 bytes in UTF-8 (LATIN1 keeps the same)', async () => {
        const to = 'é'.repeat(30);
        const error = await failure(migrate({
          [`${stamp(7)}_create`]: source(withIndex('utf8_before', 'utf8_before_a_index')),
          [`${stamp(8)}_rename`]: source(`    schema.rename('utf8_before', ${JSON.stringify(to)}, { indexes: true });`),
        }));
        // Which of the table's cut names comes first depends on the server's version (it names NOT NULL constraints since 18).
        expect(error.message).toMatch(new RegExp(`^\\[marmeon:D5\\] The name after the rename "${to}_a_\\w+" is longer than Postgres's 63 bytes in this database's encoding`));
        expect(await tablesOf(own.connections)).toEqual(['migrations', 'utf8_before']);
        expect(await recordOf(own.connections)).toEqual([`${stamp(7)}_create`]);
      });

      it('refuses a list oneOf() gives an existing column without one when its constraint name is too long, before the run starts', async () => {
        const table = 'o'.repeat(30);
        const column = 'c'.repeat(30);
        const module = moduleOf({ [`${stamp(1)}_create_listless`]: source(`    schema.create(${JSON.stringify(table)}, (table: any) => { table.string(${JSON.stringify(column)}); });`) });
        await migrator(own.connections, module).migrate();
        const dir = module.migrations as string;
        addFiles(dir, {
          [`${stamp(2)}_harmless`]: source(plain('harmless_one')),
          [`${stamp(3)}_list`]: source(`    schema.alter(${JSON.stringify(table)}, (table: any) => { table.oneOf(${JSON.stringify(column)}, ['a', 'b']); });`),
        });
        const error = await failure(migrator(own.connections, module).migrate());
        expect(error.message).toMatch(/^\[marmeon:D5\] The check constraint name "o+_c+_check" is longer than Postgres's 63 bytes/);
        expect(await tablesOf(own.connections)).not.toContain('harmless_one');
        expect(await recordOf(own.connections)).toEqual([`${stamp(1)}_create_listless`]);
      });

      describe('a name Postgres would cut that a step only acts on', () => {
        const table = 't'.repeat(63);
        const column = 'c'.repeat(63);
        const indexName = 'i'.repeat(63);
        const uniqueName = 'u'.repeat(63);
        const checkName = 'k'.repeat(63);
        const tableFile = `${stamp(1)}_create_kept`;
        const cutFile = `${stamp(4)}_cut`;
        const acting = (kind: string, method: string, name: string) =>
          `[marmeon:D5] The ${kind} "${name}" is longer than Postgres's 63 bytes in this database's encoding, so ${method} would act on the ${kind} its first 63 bytes name. Name the ${kind} as Postgres stored it.`;
        const q = (name: string) => JSON.stringify(name);
        const keeps = `    schema.create(${q(table)}, (table: any) => { table.string(${q(column)}); table.string('other'); table.index(['other'], ${q(indexName)}); table.unique([${q(column)}], ${q(uniqueName)}); table.check(${q(checkName)}, 'true'); });`;
        const alters = (body: string, on = table) => `    schema.alter(${q(on)}, (table: any) => { ${body} });`;
        const columnsOf = async (name: string) => (await own.connections.get<any>().introspection.getTables()).find((t) => t.name === name)!.columns.map((c) => c.name).sort();
        // The indexes and check constraints of the table, as the database holds them.
        const objectsOf = async () => {
          const db = own.connections.get<any>();
          const indexes = (await sql<{ name: string }>`select indexname as name from pg_indexes where tablename = ${table} order by indexname`.execute(db)).rows.map((row) => row.name);
          const checks = (await sql<{ name: string }>`select conname as name from pg_constraint where conrelid = ${sql.lit(table)}::regclass and contype = 'c' order by conname`.execute(db)).rows.map((row) => row.name);
          return { indexes, checks };
        };
        const unchanged = async (before: Awaited<ReturnType<typeof objectsOf>>, record: string[]) => {
          expect(await tablesOf(own.connections)).toEqual(['migrations', table]);
          expect(await columnsOf(table)).toEqual([column, 'other']);
          expect(await objectsOf()).toEqual(before);
          expect(await recordOf(own.connections)).toEqual(record);
        };
        const setup = async (down = '', up = keeps) => {
          const module = moduleOf({ [tableFile]: source(up, down) });
          await migrator(own.connections, module).migrate();
          return module;
        };
        const forward = async (body: string, before?: string) => {
          const module = await setup();
          const objects = await objectsOf();
          addFiles(module.migrations as string, { ...(before ? { [`${stamp(3)}_before`]: source(before) } : {}), [cutFile]: source(body) });
          const error = await failure(migrator(own.connections, module).migrate());
          return { error, objects };
        };
        let moduleFor: ModuleDefinition;
        const rolled = async (down: string, up = keeps) => {
          moduleFor = await setup(down, up);
          const objects = await objectsOf();
          const error = await failure(migrator(own.connections, moduleFor).rollback());
          return { error, objects };
        };
        const d19 = (what: string) => `[marmeon:D19] Migration ${cutFile} (module "measured") changes ${what}, which no migration created with the blueprint. Create it with schema.create(): a change in raw SQL keeps no secret, soft-delete or timestamps mark. See docs/migrations.md#raw-sql.`;

        it.each([
          ['dropIfExists()', `    schema.dropIfExists(${q(`${table}x`)});`, acting('table', 'dropIfExists()', `${table}x`)],
          ['drop()', `    schema.drop(${q(`${table}x`)});`, acting('table', 'drop()', `${table}x`)],
          ['dropColumn()', alters(`table.dropColumn(${q(`${column}x`)});`), acting('column', 'dropColumn()', `${column}x`)],
          ['dropIndex()', alters(`table.dropIndex(${q(`${indexName}x`)});`), acting('index', 'dropIndex()', `${indexName}x`)],
          ['dropUnique()', alters(`table.dropUnique(${q(`${uniqueName}x`)});`), acting('index', 'dropUnique()', `${uniqueName}x`)],
          ['dropIndex() of a name with a dot', alters(`table.dropIndex(${q(`x.${indexName}`)});`), acting('index', 'dropIndex()', `x.${indexName}`)],
        ])('refuses %s by a name Postgres cuts, before the first statement, and changes nothing', async (_name, body, message) => {
          const { error, objects } = await forward(body);
          expect(error.message).toBe(message);
          await unchanged(objects, [tableFile]);
        });

        it('refuses it before the first migration of a run, so an earlier one does not run either', async () => {
          const { error, objects } = await forward(`    schema.dropIfExists(${q(`${table}x`)});`, plain('harmless_two'));
          expect(error.message).toBe(acting('table', 'dropIfExists()', `${table}x`));
          await unchanged(objects, [tableFile]);
        });

        it('runs a drop of the index, unique index and check constraint by the name Postgres stored, and of the column and table', async () => {
          const module = await setup();
          addFiles(module.migrations as string, { [cutFile]: source([alters(`table.dropIndex(${q(indexName)}); table.dropUnique(${q(uniqueName)}); table.dropCheck(${q(checkName)}); table.dropColumn('other');`), `    schema.dropIfExists(${q(table)});`].join('\n')) });
          expect((await migrator(own.connections, module).migrate()).map((run) => run.name)).toEqual([cutFile]);
          expect(await tablesOf(own.connections)).toEqual(['migrations']);
        });

        it.each([
          ['rename()', `    schema.rename(${q(`${table}x`)}, 'moved');`, `table "${table}x"`],
          ['renameColumn()', alters(`table.renameColumn(${q(`${column}x`)}, 'z');`), `column "${table}.${column}x"`],
          ['dropCheck()', alters(`table.dropCheck(${q(`${checkName}x`)});`), `check constraint "${checkName}x" of table "${table}"`],
          ['alter() of the table', alters("table.string('added');", `${table}x`), `table "${table}x"`],
          ['notNull()', alters(`table.notNull(${q(`${column}x`)});`), `column "${table}.${column}x"`],
          ['nullable()', alters(`table.nullable(${q(`${column}x`)});`), `column "${table}.${column}x"`],
          ['oneOf() of an existing column', alters(`table.oneOf(${q(`${column}x`)}, ['a']);`), `column "${table}.${column}x"`],
        ])('ends %s by a cut name in D19 in an up(), where the migrations know the tables, and changes nothing', async (_name, body, what) => {
          const { error, objects } = await forward(body);
          expect(error.message).toBe(d19(what));
          await unchanged(objects, [tableFile]);
        });

        describe('in a down()', () => {
          const rollbackRefused = async (down: string, message: string, up = keeps) => {
            const { error, objects } = await rolled(down, up);
            expect(error.message).toBe(message);
            await unchanged(objects, [tableFile]);
          };
          it('refuses dropIfExists() by a cut name, and leaves the table and the record', () => rollbackRefused(`    schema.dropIfExists(${q(`${table}x`)});`, acting('table', 'dropIfExists()', `${table}x`)));
          it('refuses rename() from a cut name', () => rollbackRefused(`    schema.rename(${q(`${table}x`)}, 'moved');`, acting('table', 'rename()', `${table}x`)));
          it('refuses renameColumn() from a cut name', () => rollbackRefused(alters(`table.renameColumn(${q(`${column}x`)}, 'z');`), acting('column', 'renameColumn()', `${column}x`)));
          it('refuses dropCheck() by a cut name', () => rollbackRefused(alters(`table.dropCheck(${q(`${checkName}x`)});`), acting('check constraint', 'dropCheck()', `${checkName}x`)));
          it('refuses notNull() of a cut name', () => rollbackRefused(alters(`table.notNull(${q(`${column}x`)});`), acting('column', 'notNull()', `${column}x`)));
          it('refuses nullable() of a cut name', () => rollbackRefused(alters(`table.nullable(${q(`${column}x`)});`), acting('column', 'nullable()', `${column}x`)));
          it('refuses dropIndex() by a cut name', () => rollbackRefused(alters(`table.dropIndex(${q(`${indexName}x`)});`), acting('index', 'dropIndex()', `${indexName}x`)));

          it('refuses alter() of a cut table name that an earlier up() made with raw SQL, and the column stays', async () => {
            const rawTable = 'r'.repeat(63);
            const up = `    schema.raw(sql.raw('create table ${rawTable} (c text)'));`;
            moduleFor = moduleOf({ [tableFile]: source(up, alters("table.dropColumn('c');", `${rawTable}x`)) });
            const withSql = readFileSync(join(moduleFor.migrations as string, `${tableFile}.ts`), 'utf8');
            writeFileSync(join(moduleFor.migrations as string, `${tableFile}.ts`), `import { sql } from '${import.meta.resolve('kysely')}';\n${withSql}`);
            await migrator(own.connections, moduleFor).migrate();
            const error = await failure(migrator(own.connections, moduleFor).rollback());
            expect(error.message).toBe(acting('table', 'alter()', `${rawTable}x`));
            expect(await columnsOf(rawTable)).toEqual(['c']);
            expect(await recordOf(own.connections)).toEqual([tableFile]);
          });

          it('runs a down() that renames and drops a table the same plan created, by the long name it gave', async () => {
            const long = 'l'.repeat(70);
            const down = [`    schema.create(${q(long)}, (table: any) => { table.string('a'); });`, `    schema.rename(${q(long)}, 'short_after');`, `    schema.drop('short_after');`, `    schema.drop(${q(table)});`].join('\n');
            moduleFor = await setup(down);
            expect((await migrator(own.connections, moduleFor).rollback()).map((run) => run.name)).toEqual([tableFile]);
            expect(await tablesOf(own.connections)).toEqual(['migrations']);
          });
        });

        describe('what a foreign key points at and the columns of an index', () => {
          const rawSource = (up: string, down = '') => `import { sql } from '${import.meta.resolve('kysely')}';\n${source(up, down)}`;
          const rawTable = 'r'.repeat(63);
          const rawColumn = 'q'.repeat(63);

          it('refuses a foreign key to a table name Postgres cuts, in an up(), and creates nothing', async () => {
            const module = moduleOf({ [tableFile]: rawSource(`    schema.raw(sql.raw('create table ${rawTable} (id bigint primary key)'));`) });
            await migrator(own.connections, module).migrate();
            addFiles(module.migrations as string, { [cutFile]: source(`    schema.create('children', (table: any) => { table.id(); table.foreignId('owner_id').constrained(${q(`${rawTable}x`)}, 'id'); });`) });
            const error = await failure(migrator(own.connections, module).migrate());
            expect(error.message).toBe(acting('table', 'the foreign key', `${rawTable}x`));
            expect(await tablesOf(own.connections)).toEqual(['migrations', rawTable]);
            expect(await recordOf(own.connections)).toEqual([tableFile]);
          });

          it('refuses a foreign key to a column name Postgres cuts, in an up(), and creates nothing', async () => {
            const module = moduleOf({ [tableFile]: rawSource(`    schema.raw(sql.raw('create table ${rawTable} (${rawColumn} bigint primary key)'));`) });
            await migrator(own.connections, module).migrate();
            addFiles(module.migrations as string, { [cutFile]: source(`    schema.create('children', (table: any) => { table.id(); table.foreignId('owner_id').constrained(${q(rawTable)}, ${q(`${rawColumn}x`)}); });`) });
            const error = await failure(migrator(own.connections, module).migrate());
            expect(error.message).toBe(acting('column', 'the foreign key', `${rawColumn}x`));
            expect(await tablesOf(own.connections)).toEqual(['migrations', rawTable]);
            expect(await recordOf(own.connections)).toEqual([tableFile]);
          });

          it('refuses an index on a column name Postgres cuts, in a down(), and makes no index', async () => {
            const module = moduleOf({ [tableFile]: rawSource(`    schema.raw(sql.raw('create table ${rawTable} (${rawColumn} text)'));`, alters(`table.unique([${q(`${rawColumn}x`)}], 'short_uq');`, rawTable)) });
            await migrator(own.connections, module).migrate();
            const error = await failure(migrator(own.connections, module).rollback());
            expect(error.message).toBe(acting('column', 'the index', `${rawColumn}x`));
            const indexes = await sql<{ name: string }>`select indexname as name from pg_indexes where tablename = ${rawTable}`.execute(own.connections.get<any>());
            expect(indexes.rows).toEqual([]);
            expect(await recordOf(own.connections)).toEqual([tableFile]);
          });

          it('runs a foreign key to the table and column as Postgres stored them', async () => {
            const module = moduleOf({ [tableFile]: rawSource(`    schema.raw(sql.raw('create table ${rawTable} (${rawColumn} bigint primary key)'));`) });
            await migrator(own.connections, module).migrate();
            addFiles(module.migrations as string, { [cutFile]: source(`    schema.create('children', (table: any) => { table.id(); table.foreignId('owner_id').constrained(${q(rawTable)}, ${q(rawColumn)}); });`) });
            expect((await migrator(own.connections, module).migrate()).map((run) => run.name)).toEqual([cutFile]);
          });
        });

        it('runs a plan that creates a table of 71 bytes and one that begins like it, and drops both', async () => {
          const staging = `import_staging_${'x'.repeat(56)}`;
          const body = [plain(staging), plain('import_staging'), `    schema.drop(${q(staging)});`, `    schema.drop('import_staging');`].join('\n');
          expect((await migrate({ [`${stamp(2)}_staging`]: source(body) })).map((run) => run.name)).toEqual([`${stamp(2)}_staging`]);
          expect(await tablesOf(own.connections)).toEqual(['migrations']);
        });

        it('runs a plan that creates tables whose names begin alike and drops the shorter', async () => {
          const body = [plain('orders'), plain('orders_archive'), `    schema.drop('orders');`].join('\n');
          expect((await migrate({ [`${stamp(1)}_alike`]: source(body) })).map((run) => run.name)).toEqual([`${stamp(1)}_alike`]);
          expect(await tablesOf(own.connections)).toEqual(['migrations', 'orders_archive']);
        });

        it('runs a plan that creates and drops tables of 80 and 40 bytes that Postgres keeps apart (the first is cut to 62)', async () => {
          const body = [plain('é'.repeat(40)), plain('é'.repeat(20)), `    schema.drop(${q('é'.repeat(40))});`, `    schema.drop(${q('é'.repeat(20))});`, plain('survivor')].join('\n');
          expect((await migrate({ [`${stamp(1)}_wide`]: source(body) })).map((run) => run.name)).toEqual([`${stamp(1)}_wide`]);
          expect(await tablesOf(own.connections)).toEqual(['migrations', 'survivor']);
        });

        it('runs a plan that adds and drops columns of 80 and 40 bytes that Postgres keeps apart', async () => {
          const body = [
            `    schema.create('wide_columns', (table: any) => { table.string(${q('é'.repeat(40))}); table.string(${q('é'.repeat(20))}); table.string('other'); });`,
            alters(`table.dropColumn(${q('é'.repeat(40))}); table.dropColumn(${q('é'.repeat(20))});`, 'wide_columns'),
          ].join('\n');
          expect((await migrate({ [`${stamp(1)}_wide_columns`]: source(body) })).map((run) => run.name)).toEqual([`${stamp(1)}_wide_columns`]);
          expect(await columnsOf('wide_columns')).toEqual(['other']);
        });

        it('runs an alter that adds a long column, indexes it under a short name, and drops it', async () => {
          const long = 'c'.repeat(70);
          const body = [plain('indexed'), alters(`table.string(${q(long)}); table.index([${q(long)}], 'indexed_short_ix'); table.dropColumn(${q(long)});`, 'indexed')].join('\n');
          expect((await migrate({ [`${stamp(1)}_indexed`]: source(body) })).map((run) => run.name)).toEqual([`${stamp(1)}_indexed`]);
          expect(await columnsOf('indexed')).toEqual(['a']);
          expect((await sql<{ name: string }>`select indexname as name from pg_indexes where tablename = 'indexed' and indexname = 'indexed_short_ix'`.execute(own.connections.get<any>())).rows).toEqual([]);
        });

        it.each([
          ['ASCII', 'x'.repeat(70), 'x'.repeat(63)],
          ['non-ASCII (the server measures the bytes)', 'é'.repeat(40), 'é'.repeat(31)],
        ])('refuses a drop by a long name after the plan took its cut for another table, %s, and changes nothing', async (_kind, long, stored) => {
          const body = [plain(long), plain(stored), `    schema.drop(${q(long)});`].join('\n');
          const error = await failure(migrator(own.connections, moduleOf({ [`${stamp(1)}_withdrawn`]: source(body) })).migrate());
          expect(error.message).toBe(acting('table', 'drop()', long));
          expect(await tablesOf(own.connections)).toEqual(['migrations']);
          expect(await recordOf(own.connections)).toEqual([]);
        });

        describe('a qualified table name', () => {
          const schemaName = `marmeon_cutnames_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}`.toLowerCase();
          const inSchema = (name: string) => `${schemaName}.${name}`;
          const rawTable = 'e'.repeat(60);
          const prepare = async () => {
            await sql`create schema ${sql.id(schemaName)}`.execute(own.connections.get<any>());
            await sql`create table ${sql.table(inSchema(rawTable))} (a text)`.execute(own.connections.get<any>());
          };
          const exists = async () => (await sql<{ n: string }>`select tablename as n from pg_tables where schemaname = ${schemaName}`.execute(own.connections.get<any>())).rows.map((row) => row.n);
          afterEach(async () => void (await sql`drop schema if exists ${sql.id(schemaName)} cascade`.execute(own.connections.get<any>())));

          it('drops a table of 60 bytes in a schema, whose joined name is 77 bytes but whose parts fit', async () => {
            await prepare();
            const module = moduleOf({ [`${stamp(1)}_drop_qualified`]: source(`    schema.dropIfExists(${q(inSchema(rawTable))});`) });
            expect((await migrator(own.connections, module).migrate()).map((run) => run.name)).toEqual([`${stamp(1)}_drop_qualified`]);
            expect(await exists()).toEqual([]);
          });

          it('refuses a table part of 64 bytes, and names the part', async () => {
            await prepare();
            const long = 'e'.repeat(64);
            const module = moduleOf({ [`${stamp(2)}_drop_long_part`]: source(`    schema.drop(${q(inSchema(long))});`) });
            const error = await failure(migrator(own.connections, module).migrate());
            expect(error.message).toBe(acting('table', 'drop()', long));
            expect(await exists()).toEqual([rawTable]);
            expect(await recordOf(own.connections)).toEqual([]);
          });

          it('refuses a schema part of 64 bytes, and names the part', async () => {
            await prepare();
            const long = 's'.repeat(64);
            const module = moduleOf({ [`${stamp(3)}_drop_long_schema`]: source(`    schema.drop(${q(`${long}.t`)});`) });
            const error = await failure(migrator(own.connections, module).migrate());
            expect(error.message).toBe(acting('schema', 'drop()', long));
            expect(await exists()).toEqual([rawTable]);
          });
        });

        it('runs a drop and a rename by the long name the same plan gave its table and column, which Postgres cuts the same way', async () => {
          const long = 'l'.repeat(70);
          const longColumn = 'k'.repeat(70);
          const body = [
            `    schema.create(${q(long)}, (table: any) => { table.string(${q(longColumn)}); table.string('other'); });`,
            alters(`table.renameColumn(${q(longColumn)}, 'short'); table.string(${q(`${longColumn}2`)});`, long),
            alters(`table.dropColumn(${q(`${longColumn}2`)});`, long),
            `    schema.rename(${q(long)}, ${q('m'.repeat(70))});`,
            `    schema.drop(${q('m'.repeat(70))});`,
            plain('survivor'),
          ].join('\n');
          expect((await migrate({ [`${stamp(1)}_inside`]: source(body) })).map((run) => run.name)).toEqual([`${stamp(1)}_inside`]);
          expect(await tablesOf(own.connections)).toEqual(['migrations', 'survivor']);
        });
      });

      it('gives an existing column a list whose constraint name fits', async () => {
        const module = moduleOf({ [`${stamp(4)}_create_control`]: source(`    schema.create('control', (table: any) => { table.string('state'); });`) });
        await migrator(own.connections, module).migrate();
        addFiles(module.migrations as string, { [`${stamp(5)}_list_control`]: source(`    schema.alter('control', (table: any) => { table.oneOf('state', ['a', 'b']); });`) });
        expect((await migrator(own.connections, module).migrate()).map((run) => run.name)).toEqual([`${stamp(5)}_list_control`]);
      });

      it('refuses, through runMigration, a list oneOf() gives a listless column whose constraint name is over 63 bytes, and leaves the table', async () => {
        const table = 'p'.repeat(30);
        const column = 'q'.repeat(30);
        await runMigration(own.connections, { up: (schema) => schema.create(table, (blueprint) => blueprint.string(column)) });
        const error = await failure(runMigration(own.connections, { up: (schema) => schema.alter(table, (blueprint) => blueprint.oneOf(column, ['a', 'b'])) }));
        expect(error.message).toContain(d5('check constraint name', `${table}_${column}_check`));
        const constraints = await sql<{ name: string }>`select conname as name from pg_constraint where conrelid = ${sql.lit(table)}::regclass and contype = 'c'`.execute(own.connections.get<any>());
        expect(constraints.rows).toEqual([]);
      });

      it('still finds the columns of a table raw SQL made when the app parses booleans as strings', async () => {
        await sql`create table raw_made (id int, secret text)`.execute(own.connections.get<any>());
        const { default: pg } = await import('pg');
        const BOOL = 16;
        const original = pg.types.getTypeParser(BOOL);
        // The app's own parser for booleans, global to `pg`: it gives back the text of the answer, and 'f' is truthy.
        pg.types.setTypeParser(BOOL, (value: string) => value);
        try {
          const { columns } = await migrator(own.connections).undescribedColumns('default', []);
          expect([...(columns.get('raw_made') ?? [])]).toEqual(['id', 'secret']);
        } finally {
          pg.types.setTypeParser(BOOL, original);
        }
      });

      it('refuses a rollback whose later down() gives a name UTF-8 cuts, before the first down() runs', async () => {
        const name = 'é'.repeat(40);
        const module = moduleOf({
          [`${stamp(1)}_older`]: source(plain('older_one'), withIndex('from_down', name)),
          [`${stamp(2)}_newer`]: source(plain('newer_one'), `    schema.dropIfExists('newer_one');`),
        });
        // The same migrations in the same run, so they share a batch: the rollback undoes both.
        await migrator(own.connections, module).migrate();
        const error = await failure(migrator(own.connections, module).rollback());
        expect(error.message).toContain(d5('index name', name));
        expect(await tablesOf(own.connections)).toEqual(expect.arrayContaining(['newer_one', 'older_one']));
        expect(await recordOf(own.connections)).toEqual(expect.arrayContaining([`${stamp(1)}_older`, `${stamp(2)}_newer`]));
      });
    }
  });
});
