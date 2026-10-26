import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshConnections, freshDatabase, silent } from './__fixtures__/databases.ts';
import { Connections, Migrator } from './index.ts';
import { projectMigrations } from './schema/projection.ts';
import { LOCK_TABLE } from './migrations/lock.ts';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
const blog: ModuleDefinition = { name: 'blog', migrations: fixtures('blog') };
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
