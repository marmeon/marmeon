import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, HealthChecks, Logger, type ModuleDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, Schema, sql, type ConnectionOptions, type Migration } from '@marmeon/database';
import { SchemaRequirements } from '@marmeon/database/internal';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { Members, PGSQL_URL, silent, Welcome } from './__fixtures__/app.ts';
import { NOTIFICATIONS_MIGRATION, RENAME_MIGRATION } from './commands.ts';
import { NotificationServiceProvider } from './index.ts';

/** The migration the first stub wrote, as apps have it. */
const LEGACY = new URL('./__fixtures__/legacy/create_notifications_table_rev1.ts', import.meta.url);

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

describe.each(kinds)('the upgrade of the notifications table on %s', (kind) => {
  /** An empty database: a file of its own, or a new Postgres database. */
  async function open() {
    if (kind === 'sqlite') {
      const connections = connect({ driver: 'sqlite', database: join(tempDir('marmeon-notifications-upgrade-'), 'app.sqlite') });
      return { connections, schema: new Schema(connections.get(), 'sqlite'), drop: async () => connections.destroy() };
    }
    const name = `marmeon_notifications_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
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

  it('leaves a database made with the first revision identical to one made with the current one, and the rows stay', async () => {
    const fresh = await open();
    const old = await open();
    try {
      await (await load(NOTIFICATIONS_MIGRATION)).up(fresh.schema);
      await (await load(LEGACY)).up(old.schema);
      await sql`insert into notifications (id, recipient_type, recipient_id, type, data, read_at, created_at)
        values ('7b0b2a54-6d0e-4a8d-9d57-4a3b59a0f001', 'member', '1', 'shop.welcome', ${JSON.stringify({ code: 'a' })}, '2026-01-02 03:04:05', '2026-01-01 00:00:00')`.execute(old.connections.get());
      const before = await describeTable(old.connections, 'notifications');

      const upgrade = await load(RENAME_MIGRATION);
      await upgrade.up(old.schema);
      expect(await describeTable(old.connections, 'marmeon_notifications')).toEqual(await describeTable(fresh.connections, 'marmeon_notifications'));
      const { rows } = await sql<{ id: string; type: string; read_at: unknown }>`select id, type, read_at from marmeon_notifications`.execute(old.connections.get());
      expect(rows.map((found) => [found.id, found.type, found.read_at !== null])).toEqual([['7b0b2a54-6d0e-4a8d-9d57-4a3b59a0f001', 'shop.welcome', true]]);

      await upgrade.down!(old.schema);
      expect(await describeTable(old.connections, 'notifications'), 'down restores the first revision').toEqual(before);
    } finally {
      await fresh.drop();
      await old.drop();
    }
  });
});

/** A notification that only sends mail: nothing of it reaches the table. */
class MailOnly {
  static readonly notification = 'shop.mail-only';
  static readonly schema = v.object({});

  via() {
    return ['mail'] as const;
  }

  toMail() {
    return {} as never;
  }
}

describe('a database that still has notifications', () => {
  const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test' };
  const open = (modules: ModuleDefinition[]) =>
    createApplication({ root: '/tmp', discover: false, providers: [DatabaseServiceProvider, NotificationServiceProvider], modules }, { env, override: (container) => container.instance(Logger, silent) });
  const shop = [{ name: 'shop', notifications: [Welcome], recipients: { member: Members } }];

  it('makes /up/ready red, and says what to run', async () => {
    await using application = await open(shop);
    // A first migrate writes the empty bookkeeping; the table then is the old release's.
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await (await load(LEGACY)).up(new Schema(connections.get(), connections.options().driver));
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
    expect(messages).toContainEqual(expect.stringMatching(/marmeon_notifications is missing — run marmeon make:upgrade-migrations, then marmeon migrate$/));
  });

  it('is a table readiness waits for when a notification has `static database` — one that only sends mail needs none', async () => {
    const required = async (modules: ModuleDefinition[]) => {
      await using application = await open(modules);
      return application.container.make(SchemaRequirements).all().map((requirement) => requirement.table);
    };
    expect(await required(shop)).toEqual(['marmeon_notifications']);
    expect(await required([])).toEqual([]);
    expect(await required([{ name: 'shop', notifications: [MailOnly as never], recipients: { member: Members } }])).toEqual([]);
  });
});

describe('the revision the notifications list', () => {
  it('is revision 2 of the notifications set, for apps that created the table with the first stub', () => {
    const [upgrade] = NotificationServiceProvider.migrationUpgrades;
    expect(upgrade).toMatchObject({ set: 'notifications', revision: 2, name: 'rename_notifications_table_to_marmeon', createdBy: ['create_notifications_table'] });
    expect(upgrade!.contents).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    expect(readFileSync(NOTIFICATIONS_MIGRATION, 'utf8')).toMatch(/^\/\/ @marmeon-stub notifications 2\n/);
    expect(readFileSync(LEGACY, 'utf8')).toMatch(/^\/\/ @marmeon-stub notifications 1\n/);
  });
});

describe('the migrations in the apps', () => {
  it("the web app's table of the notifications comes from the first stub and the rename, the blank app's and the starter's have none", () => {
    const repo = new URL('../../../', import.meta.url);
    const filesOf = (dir: string) => readdirSync(new URL(dir, repo)).filter((file) => /notifications_table/.test(file));
    const web = 'apps/web-app/modules/system/migrations/';
    const files = filesOf(web);
    expect(files).toEqual(['2026_10_03_094821_create_notifications_table.ts', expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_rename_notifications_table_to_marmeon\.ts$/)]);
    expect(readFileSync(new URL(web + files[0], repo), 'utf8')).toBe(readFileSync(LEGACY, 'utf8'));
    expect(readFileSync(new URL(web + files[1], repo), 'utf8')).toBe(readFileSync(RENAME_MIGRATION, 'utf8'));
    for (const dir of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(filesOf(dir), dir).toEqual([]);
  });
});
