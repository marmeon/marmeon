import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, HealthChecks, Logger, type Application } from '@marmeon/core';
import { SchemaRequirements } from '@marmeon/database/internal';
import { Connections, DatabaseServiceProvider, Migrator, Schema, sql, type Migration } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { databaseConnections, freshTarget, PGSQL_URL, silent, type StoreTarget } from './__fixtures__/stores.ts';
import { RENAME_MIGRATION, SESSIONS_MIGRATION } from './commands/make-session-table.ts';
import { SessionServiceProvider } from './index.ts';

/** The migration the first stub wrote, as apps have it. */
const LEGACY = new URL('./__fixtures__/legacy/create_sessions_table_rev1.ts', import.meta.url);

const load = async (file: URL) => ((await import(file.href)) as { default: Migration }).default;

/** Everything the table is known by: columns, and the names of indexes and constraints, by their full names. */
async function describeTable(connections: Connections, name: string) {
  const db = connections.get<any>();
  const introspected = await db.introspection.getTables();
  const columns = introspected.find((table: { name: string }) => table.name === name)!.columns.map((column: { name: string; dataType: string; isNullable: boolean }) => `${column.name}:${column.dataType}:${column.isNullable}`);
  const names = async (query: ReturnType<typeof sql<{ name: string }>>) => (await query.execute(db)).rows.map((row) => row.name).sort();
  if (connections.options().driver === 'sqlite') {
    return { columns, indexes: await names(sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = ${name} and name not like 'sqlite_autoindex%'`) };
  }
  const table = sql`t.relname = ${name} and t.relnamespace = (select oid from pg_namespace where nspname = current_schema())`;
  return {
    columns,
    indexes: await names(sql<{ name: string }>`select i.relname as name from pg_index x join pg_class t on t.oid = x.indrelid join pg_class i on i.oid = x.indexrelid where ${table}`),
    constraints: await names(sql<{ name: string }>`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid where ${table}`),
  };
}

const kinds: readonly ('sqlite' | 'pgsql')[] = ['sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : [])];

describe.each(kinds)('the upgrade of the sessions table on %s', (kind) => {
  async function open() {
    const { target, drop } = await freshTarget(kind);
    const shared = target as Extract<StoreTarget, { kind: 'sqlite' | 'pgsql' }>;
    const connections = databaseConnections(shared.kind === 'sqlite' ? { driver: 'sqlite', database: shared.file } : { driver: 'pgsql', url: shared.url, poolMax: 2 });
    return { connections, schema: new Schema(connections.get(), connections.options().driver), drop };
  }

  it('leaves a database made with the first revision identical to one made with the current one, and the rows stay', async () => {
    const fresh = await open();
    const old = await open();
    try {
      // `fresh` was made by the current stub; `old` by the first revision, with a row.
      await (await load(SESSIONS_MIGRATION)).down!(old.schema);
      await (await load(LEGACY)).up(old.schema);
      await sql`insert into sessions (id, user_id, payload, last_activity, version) values ('a', 'u', 'old payload', 1, 1)`.execute(old.connections.get());
      const before = await describeTable(old.connections, 'sessions');

      const upgrade = await load(RENAME_MIGRATION);
      await upgrade.up(old.schema);
      expect(await describeTable(old.connections, 'marmeon_sessions')).toEqual(await describeTable(fresh.connections, 'marmeon_sessions'));
      const { rows } = await sql<{ payload: string }>`select payload from marmeon_sessions`.execute(old.connections.get());
      expect(rows.map((row) => row.payload)).toEqual(['old payload']);

      await upgrade.down!(old.schema);
      expect(await describeTable(old.connections, 'sessions'), 'down restores the first revision').toEqual(before);
    } finally {
      await fresh.connections.destroy();
      await old.connections.destroy();
      await fresh.drop();
      await old.drop();
    }
  });
});

describe('the payload after the rename', () => {
  it('stays out of every selectAll() of marmeon_sessions', async () => {
    const directory = tempDir('marmeon-sessions-upgrade-');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: join(directory, 'app.sqlite') } }, root: '/', logger: silent });
    try {
      const migrator = new Migrator({ modules: [{ name: 'system', migrations: new URL('./__fixtures__/upgrade/', import.meta.url) }], root: '/' } as unknown as Application, connections).onOneConnection();
      await migrator.migrate();
      // The app is on the first revision, with a signed-in session; then the rename runs.
      await migrator.rollback({ steps: 1 });
      const db = connections.get<any>();
      await sql`insert into sessions (id, user_id, payload, last_activity, version) values ('a', 'u', 'secret payload', 1, 1)`.execute(db);
      expect(Object.keys(await db.selectFrom('sessions').selectAll().executeTakeFirstOrThrow()).sort()).toEqual(['id', 'last_activity', 'user_id', 'version']);
      await migrator.migrate();
      const row = await db.selectFrom('marmeon_sessions').selectAll().executeTakeFirstOrThrow();
      expect(row).not.toHaveProperty('payload');
      expect(Object.keys(row).sort()).toEqual(['id', 'last_activity', 'user_id', 'version']);
    } finally {
      await connections.destroy();
    }
  });
});

describe('a database that still has sessions', () => {
  it('makes /up/ready red, and says what to run', async () => {
    await using application = await createApplication(
      { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, SessionServiceProvider] },
      { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', SESSION_DRIVER: 'database' }, override: (container) => container.instance(Logger, silent) },
    );
    // A first migrate writes the empty bookkeeping; the table then is the old release's.
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await (await load(LEGACY)).up(new Schema(connections.get(), connections.options().driver));
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
    expect(messages).toContainEqual(expect.stringMatching(/marmeon_sessions is missing — run marmeon make:upgrade-migrations, then marmeon migrate$/));
  });
});

describe('the table readiness waits for', () => {
  const required = async (env: Record<string, string>) => {
    await using application = await createApplication(
      { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, SessionServiceProvider] },
      { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', ...env }, override: (container) => container.instance(Logger, silent) },
    );
    return application.container.make(SchemaRequirements).all().map((requirement) => requirement.table);
  };

  it('is marmeon_sessions for the database driver', async () => {
    expect(await required({ SESSION_DRIVER: 'database' })).toEqual(['marmeon_sessions']);
  });

  it('is none for any other driver', async () => {
    expect(await required({ SESSION_DRIVER: 'memory' })).toEqual([]);
    expect(await required({ SESSION_DRIVER: 'file' })).toEqual([]);
  });
});

describe('the revision the sessions list', () => {
  it('is revision 2 of the session set, for apps that created the table with the first stub', () => {
    const [upgrade] = SessionServiceProvider.migrationUpgrades;
    expect(upgrade).toMatchObject({ set: 'session', revision: 2, name: 'rename_sessions_table_to_marmeon', createdBy: ['create_sessions_table'] });
    expect(upgrade!.contents).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    expect(readFileSync(SESSIONS_MIGRATION, 'utf8')).toMatch(/^\/\/ @marmeon-stub session 2\n/);
    expect(readFileSync(LEGACY, 'utf8')).toMatch(/^\/\/ @marmeon-stub session 1\n/);
  });
});

describe('the migrations in the apps', () => {
  it("the web app's table of the sessions come from the first stub and the rename, the blank app's and the starter's have none", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /sessions_table/.test(file));
    const web = 'apps/web-app/modules/system/migrations/';
    const files = filesOf(web);
    expect(files).toEqual(['2026_10_02_203103_create_sessions_table.ts', expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_rename_sessions_table_to_marmeon\.ts$/)]);
    expect(readFileSync(new URL(web + files[0], repo), 'utf8')).toBe(readFileSync(LEGACY, 'utf8'));
    expect(readFileSync(new URL(web + files[1], repo), 'utf8')).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    for (const dir of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(filesOf(dir), dir).toEqual([]);
  });
});
