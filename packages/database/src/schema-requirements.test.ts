import { join } from 'node:path';
import { createApplication, HealthChecks, Logger } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { drivers, freshConnections, freshDatabase, silent } from './__fixtures__/databases.ts';
import { Connections } from './connections.ts';
import { DatabaseHealthCheck } from './health.ts';
import { DatabaseServiceProvider } from './provider.ts';
import { runMigration } from './migrations/run.ts';
import type { Schema } from './schema/schema.ts';
import { SchemaRequirements } from './schema-requirements.ts';

describe.each(drivers)('schema.rename with indexes on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
  });
  afterAll(() => close());

  const run = (up: (schema: Schema) => void) => runMigration(connections, { up });

  const build = (schema: Schema, name: string) =>
    schema.create(name, (table) => {
      table.id();
      table.string('email').unique();
      table.integer('owner_id');
      table.index('owner_id');
      table.index(['owner_id', 'email']);
    });

  /** Everything a table is known by: its columns, and the names of its indexes, constraints and sequences. */
  async function describeTable(name: string) {
    const db = connections.get<any>();
    const columns = (await db.introspection.getTables()).find((table: { name: string }) => table.name === name)!.columns.map((column: { name: string; dataType: string }) => `${column.name}:${column.dataType}`);
    const names = async (query: ReturnType<typeof sql<{ name: string }>>) => (await query.execute(db)).rows.map((row) => row.name).sort();
    if (driver === 'sqlite') {
      return { columns, indexes: await names(sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = ${name}`), constraints: [], sequences: [] };
    }
    const table = sql`t.relname = ${name} and t.relnamespace = (select oid from pg_namespace where nspname = current_schema())`;
    return {
      columns,
      indexes: await names(sql<{ name: string }>`select i.relname as name from pg_index x join pg_class t on t.oid = x.indrelid join pg_class i on i.oid = x.indexrelid where ${table}`),
      constraints: await names(sql<{ name: string }>`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid where ${table}`),
      sequences: await names(sql<{ name: string }>`select s.relname as name from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i') join pg_class t on t.oid = d.refobjid where s.relkind = 'S' and ${table}`),
    };
  }

  it('leaves a table as one created under the new name', async () => {
    await run((schema) => {
      build(schema, 'old_things');
      build(schema, 'fresh_things');
      schema.rename('old_things', 'fresh_things_renamed', { indexes: true });
    });
    const renamed = await describeTable('fresh_things_renamed');
    await run((schema) => build(schema, 'fresh_things_made'));
    const made = await describeTable('fresh_things_made');
    const alike = (value: object, from: string, to: string) => JSON.parse(JSON.stringify(value).replaceAll(from, to));
    expect(alike(renamed, 'fresh_things_renamed', 'T')).toEqual(alike(made, 'fresh_things_made', 'T'));
    expect(renamed.indexes.every((name) => name.startsWith('fresh_things_renamed_') || name.startsWith('sqlite_autoindex_'))).toBe(true);
  });

  it('renames each name once when the new name begins with the old one', async () => {
    await run((schema) => {
      build(schema, 'jobs');
      schema.rename('jobs', 'jobs_archive', { indexes: true });
    });
    const renamed = await describeTable('jobs_archive');
    await run((schema) => build(schema, 'jobs_archive_made'));
    const made = await describeTable('jobs_archive_made');
    expect(JSON.stringify(renamed).replaceAll('jobs_archive', 'T')).toBe(JSON.stringify(made).replaceAll('jobs_archive_made', 'T'));
    expect([...renamed.indexes, ...renamed.constraints, ...renamed.sequences].some((name) => name.includes('archive_archive'))).toBe(false);
  });

  it('keeps the names of the indexes without the option', async () => {
    await run((schema) => {
      build(schema, 'plain_old');
      schema.rename('plain_old', 'plain_new');
    });
    const { indexes, constraints } = await describeTable('plain_new');
    expect(indexes).toContain('plain_old_owner_id_index');
    expect(indexes.some((name) => name.startsWith('plain_new_'))).toBe(false);
    expect(constraints.some((name) => name.startsWith('plain_new_'))).toBe(false);
  });

  // Postgres cuts a name at 63 bytes without a word; a name that long is refused there (SQLite keeps any length).
  const long = 'a_table_with_a_long_name_to_come';
  const columns = (table: { string(name: string): void; index(columns: string[]): void }) => {
    table.string('first_long_column_name');
    table.string('second_long_column_name');
    table.index(['first_long_column_name', 'second_long_column_name']);
  };

  it('refuses to rename an index to a name Postgres would cut, and changes nothing', async () => {
    await run((schema) => schema.create('short', columns));
    const renamed = run((schema) => schema.rename('short', long, { indexes: true }));
    if (driver === 'sqlite') return void (await expect(renamed).resolves.toBeUndefined());
    await expect(renamed).rejects.toThrow(/\[marmeon:D5\].*a_table_with_a_long_name_to_come_/);
    // The migration's transaction took the rename back: the table and its index are as they were.
    expect((await describeTable('short')).indexes).toEqual(['short_first_long_column_name_second_long_column_name_index']);
    expect((await connections.get<any>().introspection.getTables()).map((table: { name: string }) => table.name)).not.toContain(long);
  });

  it('refuses to create an index whose default name Postgres would cut, and accepts one given a name', async () => {
    const create = run((schema) => schema.create('another_long_table_name_here', columns));
    if (driver === 'sqlite') return void (await expect(create).resolves.toBeUndefined());
    await expect(create).rejects.toThrow(/\[marmeon:D5\]/);
    await run((schema) =>
      schema.create('named_long', (table) => {
        table.string('first_long_column_name');
        table.string('second_long_column_name');
        table.index(['first_long_column_name', 'second_long_column_name'], 'named_long_columns_index');
      }),
    );
    expect((await describeTable('named_long')).indexes).toEqual(['named_long_columns_index']);
  });
});

describe.each(drivers)('the readiness check of the framework tables on %s', (driver) => {
  it('is red while a table lacks a column, and says which, and green when it has them', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      const requirements = new SchemaRequirements();
      requirements.require({ connection: 'default', table: 'widgets', columns: ['id', 'label'] });
      const check = new DatabaseHealthCheck(connections, requirements);
      await runMigration(connections, {
        up: (schema) =>
          schema.create('widgets', (table) => {
            table.id();
          }),
      });
      await expect(check.handle()).rejects.toThrow('[marmeon:D6] widgets lacks label — a migration is missing: marmeon publish writes the ones of your packages, then marmeon migrate');
      await runMigration(connections, {
        up: (schema) =>
          schema.alter('widgets', (table) => {
            table.string('label').nullable();
          }),
      });
      await expect(check.handle()).resolves.toBe('default');
    } finally {
      await close();
    }
  });

  it('turns green when another process has migrated since', async () => {
    const root = tempDir('marmeon-upgrades-');
    const fresh = driver === 'sqlite' ? { options: { driver: 'sqlite', database: join(root, 'app.sqlite'), managed: false } as const, drop: async () => {} } : await freshDatabase('pgsql', { managed: false });
    const here = new Connections({ connections: { default: fresh.options }, root, logger: silent });
    const there = new Connections({ connections: { default: fresh.options }, root, logger: silent });
    try {
      await runMigration(there, {
        up: (schema) =>
          schema.create('widgets', (table) => {
            table.id();
          }),
      });
      const requirements = new SchemaRequirements();
      requirements.require({ connection: 'default', table: 'widgets', columns: ['id', 'label'] });
      const check = new DatabaseHealthCheck(here, requirements);
      await expect(check.handle()).rejects.toThrow('widgets lacks label');
      await runMigration(there, {
        up: (schema) =>
          schema.alter('widgets', (table) => {
            table.string('label').nullable();
          }),
      });
      await expect(check.handle()).resolves.toBe('default');
    } finally {
      await here.destroy();
      await there.destroy();
      await fresh.drop();
    }
  });

  it('fails for a table that is not there, even when no column is required', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      const requirements = new SchemaRequirements();
      requirements.require({ connection: 'default', table: 'nothing_here', columns: [] });
      await expect(new DatabaseHealthCheck(connections, requirements).handle()).rejects.toThrow('[marmeon:D6] nothing_here is missing — a migration is missing: marmeon publish writes the ones of your packages, then marmeon migrate');
    } finally {
      await close();
    }
  });
});

describe('readiness with a requirement', () => {
  it("fails the app's health checks with the same words", async () => {
    const root = tempDir('marmeon-upgrades-');
    await using app = await createApplication(
      { root, discover: false, providers: [DatabaseServiceProvider] },
      { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, override: (container) => container.instance(Logger, silent) },
    );
    app.container.make(SchemaRequirements).require({ connection: 'default', table: 'missing_things', columns: ['id'] });
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report.ok).toBe(false);
    expect((report.checks[0]!.error as Error).message).toBe('[marmeon:D6] missing_things is missing — a migration is missing: marmeon publish writes the ones of your packages, then marmeon migrate');
  });
});
