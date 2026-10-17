import { readFileSync } from 'node:fs';
import { createApplication, HealthChecks, Logger, type Application } from '@marmeon/core';
import { SchemaRequirements } from '@marmeon/database/internal';
import { Connections, DatabaseServiceProvider, Migrator, Schema, sql, type Migration } from '@marmeon/database';
import { EncryptionServiceProvider } from '@marmeon/encryption';
import { RedisServiceProvider } from '@marmeon/redis';
import { CliServiceProvider } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { connectionOptions, databaseConnections, databaseKinds, freshTarget, REDIS_URL, silent, type SharedTarget } from './__fixtures__/targets.ts';
import { QUEUE_MIGRATION, RENAME_MIGRATION } from './commands/failed.ts';
import { QueueWorkCommand } from './commands/work.ts';
import { QueueServiceProvider } from './index.ts';

/** The migration the first stub wrote, as apps have it. */
const LEGACY = new URL('./__fixtures__/legacy/create_jobs_table_rev1.ts', import.meta.url);

const load = async (file: URL) => ((await import(file.href)) as { default: Migration }).default;

/** Everything the two tables are known by: columns, and the names of indexes, constraints and sequences, by their full names. */
async function describeTables(connections: Connections, prefix: string) {
  const db = connections.get<any>();
  const driver = connections.options().driver;
  const found: Record<string, unknown> = {};
  const introspected = await db.introspection.getTables();
  for (const name of ['jobs', 'failed_jobs']) {
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
      sequences: await names(sql<{ name: string }>`select s.relname as name from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i') join pg_class t on t.oid = d.refobjid where s.relkind = 'S' and ${table}`),
    };
  }
  return found;
}

describe.each(databaseKinds)('the upgrade of the queue tables on %s', (kind) => {
  async function open() {
    const { target, drop } = await freshTarget(kind);
    const connections = databaseConnections(connectionOptions(target as SharedTarget));
    return { connections, schema: new Schema(connections.get(), connections.options().driver), drop };
  }

  it('leaves a database made with the first revision identical to one made with the current one, and the rows stay', async () => {
    const fresh = await open();
    const old = await open();
    try {
      // `fresh` was made by the current stub; `old` by the first revision, with a row in each table.
      await (await load(QUEUE_MIGRATION)).down!(old.schema);
      await (await load(LEGACY)).up(old.schema);
      await sql`insert into jobs (queue, payload, attempts, available_at, created_at) values ('default', 'old record', 0, 1, 1)`.execute(old.connections.get());
      await sql`insert into failed_jobs (uuid, connection, queue, job, payload, exception, failed_at) values ('u', 'database', 'default', 'x', 'old record', 'e', 1)`.execute(old.connections.get());
      const before = await describeTables(old.connections, '');

      const upgrade = await load(RENAME_MIGRATION);
      await upgrade.up(old.schema);
      expect(await describeTables(old.connections, 'marmeon_')).toEqual(await describeTables(fresh.connections, 'marmeon_'));
      const kept = (table: string) => sql<{ payload: string }>`select payload from ${sql.table(table)}`.execute(old.connections.get()).then(({ rows }) => rows.map((row) => row.payload));
      expect(await kept('marmeon_jobs')).toEqual(['old record']);
      expect(await kept('marmeon_failed_jobs')).toEqual(['old record']);

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

describe('a database that still has jobs and failed_jobs', () => {
  async function legacyApp(): Promise<Application> {
    const application = await createApplication(
      { root: '/tmp', discover: false, providers: [CliServiceProvider, DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider] },
      {
        env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=', NODE_ENV: 'test' },
        override: (container) => container.instance(Logger, silent),
      },
    );
    // A first migrate writes the empty bookkeeping; the tables then are the old release's.
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await (await load(LEGACY)).up(new Schema(connections.get(), connections.options().driver));
    return application;
  }

  it('makes /up/ready red, and says what to run', async () => {
    await using application = await legacyApp();
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
    expect(messages).toContainEqual(expect.stringMatching(/marmeon_jobs is missing; marmeon_failed_jobs is missing — run marmeon make:upgrade-migrations, then marmeon migrate$/));
  });

  it('keeps queue:work from starting, with the same advice instead of an SQL error', async () => {
    await using application = await legacyApp();
    const lines: string[] = [];
    const output = { success: () => {}, warn: () => {}, line: () => {}, error: (line: string) => lines.push(line) };
    const code = await application.container.make(QueueWorkCommand).handle({ root: '/tmp', args: [], options: { 'stop-when-empty': true }, output, spawn: async () => 0 } as never);
    expect(code).toBe(1);
    expect(lines).toEqual(['The queue tables of the connection "default" are still named jobs and failed_jobs, not marmeon_jobs and marmeon_failed_jobs — run marmeon make:upgrade-migrations, then marmeon migrate.']);
  });
});

describe('the tables readiness waits for', () => {
  async function required(providers: Parameters<typeof createApplication>[0]['providers'], env: Record<string, string>) {
    await using application = await createApplication(
      { root: '/tmp', discover: false, providers },
      { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=', NODE_ENV: 'test', ...env }, override: (container) => container.instance(Logger, silent) },
    );
    return { tables: application.container.make(SchemaRequirements).all().map((requirement) => requirement.table), report: await application.container.make(HealthChecks).run(application.container) };
  }

  it('are none for QUEUE_CONNECTION=sync, so /up/ready stays green without them', async () => {
    const { tables, report } = await required([CliServiceProvider, DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider], { QUEUE_CONNECTION: 'sync' });
    expect(tables).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('are both for the database queue', async () => {
    const { tables } = await required([CliServiceProvider, DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider], {});
    expect(tables).toEqual(['marmeon_jobs', 'marmeon_failed_jobs']);
  });

  it.skipIf(!REDIS_URL)('are the failed-job table alone for a Redis queue that keeps its failures in the database', async () => {
    const { tables } = await required([CliServiceProvider, DatabaseServiceProvider, RedisServiceProvider, EncryptionServiceProvider, QueueServiceProvider], { QUEUE_CONNECTION: 'redis', REDIS_URL: REDIS_URL!, QUEUE_FAILED_DRIVER: 'database' });
    expect(tables).toEqual(['marmeon_failed_jobs']);
  });
});

describe('the revision the queue lists', () => {
  it('is revision 2 of the queue set, for apps that created the tables with the first stub', () => {
    const [upgrade] = QueueServiceProvider.migrationUpgrades;
    expect(upgrade).toMatchObject({ set: 'queue', revision: 2, name: 'rename_queue_tables_to_marmeon', createdBy: ['create_jobs_table'] });
    expect(upgrade!.contents).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    expect(readFileSync(QUEUE_MIGRATION, 'utf8')).toMatch(/^\/\/ @marmeon-stub queue 2\n/);
    expect(readFileSync(LEGACY, 'utf8')).toMatch(/^\/\/ @marmeon-stub queue 1\n/);
  });
});
