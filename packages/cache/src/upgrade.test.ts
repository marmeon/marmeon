import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, HealthChecks, Logger } from '@marmeon/core';
import { SchemaRequirements } from '@marmeon/database/internal';
import { Connections, DatabaseServiceProvider, Migrator, Schema, sql, type Migration } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { databaseConnections, freshTarget, PGSQL_URL, silent, type StoreTarget } from './__fixtures__/stores.ts';
import { CACHE_MIGRATION, RENAME_MIGRATION } from './commands/make-cache-table.ts';
import { CacheServiceProvider } from './index.ts';

/** The migration the first stub wrote, as apps have it. */
const LEGACY = new URL('./__fixtures__/legacy/create_cache_table_rev1.ts', import.meta.url);

const load = async (file: URL) => ((await import(file.href)) as { default: Migration }).default;

/** Everything the two tables are known by: columns, and the names of indexes and constraints, by their full names. */
async function describeTables(connections: Connections, prefix: string) {
  const db = connections.get<any>();
  const driver = connections.options().driver;
  const found: Record<string, unknown> = {};
  const introspected = await db.introspection.getTables();
  for (const name of ['cache', 'cache_locks']) {
    const full = `${prefix}${name}`;
    const columns = introspected.find((table: { name: string }) => table.name === full)!.columns.map((column: { name: string; dataType: string; isNullable: boolean }) => `${column.name}:${column.dataType}:${column.isNullable}`);
    const names = async (query: ReturnType<typeof sql<{ name: string }>>) => (await query.execute(db)).rows.map((row) => row.name).sort();
    if (driver === 'sqlite') {
      found[name] = { columns, indexes: await names(sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = ${full} and name not like 'sqlite_autoindex%'`) };
      continue;
    }
    const table = sql`t.relname = ${full} and t.relnamespace = (select oid from pg_namespace where nspname = current_schema())`;
    found[name] = {
      columns,
      indexes: await names(sql<{ name: string }>`select i.relname as name from pg_index x join pg_class t on t.oid = x.indrelid join pg_class i on i.oid = x.indexrelid where ${table}`),
      constraints: await names(sql<{ name: string }>`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid where ${table}`),
    };
  }
  return found;
}

const kinds: readonly ('sqlite' | 'pgsql')[] = ['sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : [])];

describe.each(kinds)('the upgrade of the cache tables on %s', (kind) => {
  async function open() {
    const { target, drop } = await freshTarget(kind);
    const shared = target as Extract<StoreTarget, { kind: 'sqlite' | 'pgsql' }>;
    const connections = databaseConnections(shared.kind === 'sqlite' ? { driver: 'sqlite', database: shared.file } : { driver: 'pgsql', url: shared.url, poolMax: 2 });
    return { connections, schema: new Schema(connections.get(), connections.options().driver), drop };
  }

  it('leaves a database made with the first revision identical to one made with the current one, and the entries and locks stay', async () => {
    const fresh = await open();
    const old = await open();
    try {
      // `fresh` was made by the current stub; `old` by the first revision, with a row in each table.
      await (await load(CACHE_MIGRATION)).down!(old.schema);
      await (await load(LEGACY)).up(old.schema);
      await sql`insert into cache (key, value, expiration) values ('k', '"old"', null)`.execute(old.connections.get());
      await sql`insert into cache_locks (key, owner, expiration) values ('l', 'owner', 9999999999999)`.execute(old.connections.get());
      const before = await describeTables(old.connections, '');

      const upgrade = await load(RENAME_MIGRATION);
      await upgrade.up(old.schema);
      expect(await describeTables(old.connections, 'marmeon_')).toEqual(await describeTables(fresh.connections, 'marmeon_'));
      const kept = (table: string, column: string) =>
        sql<{ value: string }>`select ${sql.id(column)} as value from ${sql.table(table)}`.execute(old.connections.get()).then(({ rows }) => rows.map((row) => row.value));
      expect(await kept('marmeon_cache', 'key')).toEqual(['k']);
      expect(await kept('marmeon_cache_locks', 'owner')).toEqual(['owner']);

      await upgrade.down!(old.schema);
      expect(await describeTables(old.connections, ''), 'down restores the first revision').toEqual(before);
    } finally {
      await fresh.connections.destroy();
      await old.connections.destroy();
      await fresh.drop();
      await old.drop();
    }
  });
});

async function appWith(env: Record<string, string>) {
  return createApplication(
    { root: '/tmp', discover: false, providers: [DatabaseServiceProvider, CacheServiceProvider] },
    { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', ...env }, override: (container) => container.instance(Logger, silent) },
  );
}

describe('a database that still has cache and cache_locks', () => {
  it('makes /up/ready red, and says what to run', async () => {
    await using application = await appWith({ CACHE_DRIVER: 'database' });
    // A first migrate writes the empty bookkeeping; the tables then are the old release's.
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await (await load(LEGACY)).up(new Schema(connections.get(), connections.options().driver));
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
    expect(messages).toContainEqual(expect.stringMatching(/marmeon_cache is missing; marmeon_cache_locks is missing — run marmeon make:upgrade-migrations, then marmeon migrate$/));
  });
});

describe('the tables readiness waits for', () => {
  const required = async (env: Record<string, string>) => {
    await using application = await appWith(env);
    return application.container.make(SchemaRequirements).all().map((requirement) => requirement.table);
  };

  it('are both for the database cache', async () => {
    expect(await required({ CACHE_DRIVER: 'database' })).toEqual(['marmeon_cache', 'marmeon_cache_locks']);
  });

  it('are none for any other driver', async () => {
    expect(await required({ CACHE_DRIVER: 'memory' })).toEqual([]);
    expect(await required({ CACHE_DRIVER: 'file' })).toEqual([]);
  });
});

describe('the revision the cache lists', () => {
  it('is revision 2 of the cache set, for apps that created the tables with the first stub', () => {
    const [upgrade] = CacheServiceProvider.migrationUpgrades;
    expect(upgrade).toMatchObject({ set: 'cache', revision: 2, name: 'rename_cache_tables_to_marmeon', createdBy: ['create_cache_table'] });
    expect(upgrade!.contents).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    expect(readFileSync(CACHE_MIGRATION, 'utf8')).toMatch(/^\/\/ @marmeon-stub cache 2\n/);
    expect(readFileSync(LEGACY, 'utf8')).toMatch(/^\/\/ @marmeon-stub cache 1\n/);
  });
});

describe('the migrations in the apps', () => {
  it("the web app's tables of the cache come from the first stub and the rename, the blank app's and the starter's have none", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /cache_table|cache_tables/.test(file));
    const web = 'apps/web-app/modules/system/migrations/';
    const files = filesOf(web);
    expect(files).toEqual(['2026_10_02_195920_create_cache_table.ts', expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_rename_cache_tables_to_marmeon\.ts$/)]);
    expect(readFileSync(new URL(web + files[0], repo), 'utf8')).toBe(readFileSync(LEGACY, 'utf8'));
    expect(readFileSync(new URL(web + files[1], repo), 'utf8')).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    for (const dir of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(filesOf(dir), dir).toEqual([]);
  });
});
