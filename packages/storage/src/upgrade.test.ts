import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, HealthChecks, Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, Schema, sql, type ConnectionOptions, type Migration } from '@marmeon/database';
import { SchemaRequirements } from '@marmeon/database/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { StorageServiceProvider, TemporaryUploads } from './index.ts';
import { RENAME_MIGRATION, UPLOADS_MIGRATION } from './uploads/commands.ts';

/** The migration the first stub wrote, as apps have it. */
const LEGACY = new URL('./__fixtures__/legacy/create_temporary_uploads_table_rev1.ts', import.meta.url);
/** The migration the docs show for a table made before the limits on open uploads — it names the old table. */
const INDEX = new URL('../../../apps/web-app/modules/system/migrations/2026_10_16_090000_index_temporary_uploads_table.ts', import.meta.url);

const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;

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

const connect = (options: ConnectionOptions) => new Connections({ connections: { default: { ...options, managed: false } }, root: '/', logger: silent });

describe.each(kinds)('the upgrade of the uploads table on %s', (kind) => {
  /** An empty database: a file of its own, or a new Postgres database. */
  async function open() {
    if (kind === 'sqlite') {
      const connections = connect({ driver: 'sqlite', database: join(tempDir('marmeon-uploads-upgrade-'), 'app.sqlite') });
      return { connections, schema: new Schema(connections.get(), 'sqlite'), drop: async () => connections.destroy() };
    }
    const name = `marmeon_uploads_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = connect({ driver: 'pgsql', url: PGSQL_URL! });
    await sql`create database ${sql.id(name)}`.execute(admin.get());
    const url = new URL(PGSQL_URL!);
    url.pathname = `/${name}`;
    const connections = connect({ driver: 'pgsql', url: url.href, poolMax: 2 });
    return {
      connections,
      schema: new Schema(connections.get(), 'pgsql'),
      drop: async () => {
        await connections.destroy();
        await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
        await admin.destroy();
      },
    };
  }

  const row = (id: string, consumedAt: number | null) =>
    sql`insert into temporary_uploads (id, session, route, field, disk, key, name, max_bytes, size, created_at, expires_at, started_at, uploaded_at, consumed_at)
      values (${id}, 's', 'avatar.update', 'avatar', 'uploads', 'k', 'a.png', 100, 10, 1, 2, 1, 1, ${consumedAt})`;

  it('leaves a database made with the first revision identical to one made with the current one, and the rows stay', async () => {
    const fresh = await open();
    const old = await open();
    try {
      await (await load(UPLOADS_MIGRATION)).up(fresh.schema);
      await (await load(LEGACY)).up(old.schema);
      await row('used', 1_700_000_000_000).execute(old.connections.get());
      await row('open', null).execute(old.connections.get());
      const before = await describeTable(old.connections, 'temporary_uploads');

      const upgrade = await load(RENAME_MIGRATION);
      await upgrade.up(old.schema);
      expect(await describeTable(old.connections, 'marmeon_temporary_uploads')).toEqual(await describeTable(fresh.connections, 'marmeon_temporary_uploads'));
      const { rows } = await sql<{ id: string; consumed_at: number | string | null }>`select id, consumed_at from marmeon_temporary_uploads order by id`.execute(old.connections.get());
      // A token used before the upgrade is still used.
      expect(rows.map((found) => [found.id, found.consumed_at === null ? null : Number(found.consumed_at)])).toEqual([
        ['open', null],
        ['used', 1_700_000_000_000],
      ]);

      await upgrade.down!(old.schema);
      expect(await describeTable(old.connections, 'temporary_uploads'), 'down restores the first revision').toEqual(before);
    } finally {
      await fresh.drop();
      await old.drop();
    }
  });

  it('carries the two indexes of a table that got them from the migration for tables made before the limits', async () => {
    const fresh = await open();
    const old = await open();
    try {
      await (await load(UPLOADS_MIGRATION)).up(fresh.schema);
      // The table of an app from before the limits: without the two indexes of the open uploads, then the docs' migration.
      await (await load(LEGACY)).up(old.schema);
      await sql`drop index temporary_uploads_expires_at_index`.execute(old.connections.get());
      await sql`drop index temporary_uploads_session_expires_at_index`.execute(old.connections.get());
      await (await load(INDEX)).up(old.schema);
      await (await load(RENAME_MIGRATION)).up(old.schema);
      expect(await describeTable(old.connections, 'marmeon_temporary_uploads')).toEqual(await describeTable(fresh.connections, 'marmeon_temporary_uploads'));
    } finally {
      await fresh.drop();
      await old.drop();
    }
  });
});

describe('a database that still has temporary_uploads', () => {
  const providers = [EncryptionServiceProvider, DatabaseServiceProvider, HttpServiceProvider, StorageServiceProvider];
  const env = { APP_KEY: generateKey(), DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', LOG_LEVEL: 'silent' };

  it('makes /up/ready red, and says what to run', async () => {
    await using application = await createApplication({ root: tempDir('marmeon-uploads-ready-'), discover: false, providers }, { env, override: (container) => container.instance(Logger, silent) });
    // A first migrate writes the empty bookkeeping; the table then is the old release's.
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await (await load(LEGACY)).up(new Schema(connections.get(), connections.options().driver));
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
    expect(messages).toContainEqual(expect.stringMatching(/marmeon_temporary_uploads is missing — run marmeon make:upgrade-migrations, then marmeon migrate$/));
  });

  const problems = async (prepare: (schema: Schema) => Promise<void>) => {
    await using application = await createApplication({ root: tempDir('marmeon-uploads-ready-'), discover: false, providers }, { env, override: (container) => container.instance(Logger, silent) });
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await prepare(new Schema(connections.get(), connections.options().driver));
    const report = await application.container.make(HealthChecks).run(application.container);
    return report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
  };

  it('stays ready when neither table exists: the app has no uploads, and an upload says which command makes the table', async () => {
    expect(await problems(async () => {})).toEqual([]);
    await using application = await createApplication({ root: tempDir('marmeon-uploads-ready-'), discover: false, providers }, { env, override: (container) => container.instance(Logger, silent) });
    await application.container.make(Migrator).migrate();
    const uploads = application.container.make(TemporaryUploads);
    await expect(uploads.target({ route: 'avatar.update', field: 'avatar', rule: { maxBytes: 100, mime: undefined }, session: 's', name: 'a.png', size: 10 })).rejects.toThrow(/marmeon_temporary_uploads is missing — run marmeon make:uploads-table, then marmeon migrate/);
  });

  it('is red when the new table lacks a column', async () => {
    const messages = await problems(async (schema) => {
      await schema.create('marmeon_temporary_uploads', (table) => {
        table.string('id', 36).primary();
      });
    });
    expect(messages).toContainEqual(expect.stringMatching(/marmeon_temporary_uploads lacks session, .*consumed_at — run marmeon make:upgrade-migrations/));
  });

  it('is a table readiness waits for once uploads are set up', async () => {
    await using application = await createApplication({ root: tempDir('marmeon-uploads-ready-'), discover: false, providers }, { env, override: (container) => container.instance(Logger, silent) });
    expect(application.container.make(SchemaRequirements).all().map((requirement) => requirement.table)).toEqual(['marmeon_temporary_uploads']);
  });
});

describe('the revision the uploads list', () => {
  it('is revision 2 of the storage set, for apps that created the table with the first stub or added its indexes', () => {
    const [upgrade] = StorageServiceProvider.migrationUpgrades;
    expect(upgrade).toMatchObject({ set: 'storage', revision: 2, name: 'rename_temporary_uploads_table_to_marmeon', createdBy: ['create_temporary_uploads_table', 'index_temporary_uploads_table'] });
    expect(upgrade!.contents).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    expect(readFileSync(UPLOADS_MIGRATION, 'utf8')).toMatch(/^\/\/ @marmeon-stub storage 2\n/);
    expect(readFileSync(LEGACY, 'utf8')).toMatch(/^\/\/ @marmeon-stub storage 1\n/);
  });
});

describe('the migrations in the apps', () => {
  it("the web app's table of the uploads comes from the first stub and the rename, the blank app's and the starter's have none", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /temporary_uploads_table/.test(file) && !file.includes('_index_'));
    const web = 'apps/web-app/modules/system/migrations/';
    const files = filesOf(web);
    expect(files).toEqual(['2026_10_03_111422_create_temporary_uploads_table.ts', expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_rename_temporary_uploads_table_to_marmeon\.ts$/)]);
    expect(readFileSync(new URL(web + files[0], repo), 'utf8')).toBe(readFileSync(LEGACY, 'utf8'));
    expect(readFileSync(new URL(web + files[1], repo), 'utf8')).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    for (const dir of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(filesOf(dir), dir).toEqual([]);
  });
});
