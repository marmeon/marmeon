import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Application, createApplication, HealthChecks, Logger, type ServiceProviderClass } from '@marmeon/core';
import { sql } from 'kysely';
import type { CommandInput } from 'marmeon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { drivers, freshConnections, freshDatabase, silent } from './__fixtures__/databases.ts';
import { MakeUpgradeMigrationsCommand } from './commands/make-upgrade-migrations.ts';
import { Connections } from './connections.ts';
import { DatabaseHealthCheck } from './health.ts';
import { DatabaseServiceProvider } from './provider.ts';
import { Schema } from './schema/schema.ts';
import { collectUpgrades, SchemaRequirements, type MigrationUpgrade } from './upgrades.ts';

const upgrade = (revision: number, name = `upgrade_widgets_${revision}`, set = 'widgets'): MigrationUpgrade => ({
  set,
  revision,
  name,
  createdBy: ['create_widgets_table'],
  contents: `// @marmeon-stub ${set} ${revision}\nexport default {};\n`,
});

function provider(name: string, upgrades: readonly MigrationUpgrade[]): ServiceProviderClass {
  return Object.defineProperty(class { static migrationUpgrades = upgrades }, 'name', { value: name }) as unknown as ServiceProviderClass;
}

const MODULE = "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'system', migrations: new URL('./migrations/', import.meta.url) });\n";

/** An app directory whose `system` module has the migration that created the widgets, at `revision` (none: written by hand). */
function appAt(revision: number | undefined, ...files: string[]): string {
  const root = tempDir('marmeon-upgrades-');
  mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
  writeFileSync(join(root, 'modules/system/index.ts'), MODULE);
  const mark = revision === undefined ? '' : `// @marmeon-stub widgets ${revision}\n`;
  writeFileSync(join(root, 'modules/system/migrations/2026_01_01_000000_create_widgets_table.ts'), `${mark}export default {};\n`);
  for (const file of files) writeFileSync(join(root, 'modules/system/migrations', file), 'export default {};\n');
  return root;
}

function run(root: string, providers: readonly ServiceProviderClass[], options: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const push = (prefix: string) => (line = '') => lines.push(`${prefix}${line}`);
  const output = { success: push('✓ '), warn: push('! '), error: push('✗ '), line: push('') };
  const command = new MakeUpgradeMigrationsCommand({ providers } as unknown as Application);
  const code = command.handle({ root, args: [], options, output } as unknown as CommandInput);
  return { code, lines, files: readdirSync(join(root, 'modules/system/migrations')).sort() };
}

describe('marmeon make:upgrade-migrations', () => {
  const providers = [provider('WidgetsProvider', [upgrade(2), upgrade(3)])];

  it('writes every revision above the stub, in the module of the migration that created the set, one second apart', () => {
    const root = appAt(1);
    expect(run(root, providers, { check: true }).code, '--check before').toBe(1);
    const { code, files } = run(root, providers);
    expect(code).toBe(0);
    expect(files).toHaveLength(3);
    const written = files.filter((file) => !file.startsWith('2026_01_01_000000_'));
    expect(written.map((file) => file.replace(/^\d{4}_\d{2}_\d{2}_\d{6}_/, ''))).toEqual(['upgrade_widgets_2.ts', 'upgrade_widgets_3.ts']);
    expect(written[0]! < written[1]!, 'timestamps ascend').toBe(true);
    expect(readFileSync(join(root, 'modules/system/migrations', written[1]!), 'utf8')).toBe(upgrade(3).contents);

    expect(run(root, providers).files, 'second run').toEqual(files);
    expect(run(root, providers, { check: true }).code, '--check after').toBe(0);
  });

  it('treats a migration without the line as the first revision', () => {
    expect(run(appAt(undefined), providers, { check: true }).code).toBe(1);
  });

  it('writes nothing for an app whose stub is at the installed revision', () => {
    const root = appAt(3);
    const { code, files } = run(root, providers);
    expect(code).toBe(0);
    expect(files).toHaveLength(1);
  });

  it('writes nothing for a set the app does not use', () => {
    const root = tempDir('marmeon-upgrades-');
    mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/system/migrations/2026_01_01_000000_create_other_table.ts'), 'export default {};\n');
    expect(run(root, providers, { check: true }).code).toBe(0);
  });

  it('refuses to write a revision behind one that is there, and names the missing one', () => {
    const root = appAt(1, '2026_02_01_000000_upgrade_widgets_3.ts');
    for (const options of [{}, { check: true }]) {
      const { code, lines, files } = run(root, providers, options);
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/Revision 3 of the "widgets" tables is in your app, but revision 2 is not/);
      expect(files).toHaveLength(2);
    }
  });

  it('refuses a mark above the highest revision the installed packages know, with --check too', () => {
    const root = appAt(5);
    for (const options of [{}, { check: true }]) {
      const { code, lines, files } = run(root, providers, options);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('revision 5 of widgets, the installed packages know up to 3');
      expect(files).toHaveLength(1);
    }
  });

  it('refuses a mark that names another set', () => {
    const root = appAt(1);
    writeFileSync(join(root, 'modules/system/migrations/2026_01_01_000000_create_widgets_table.ts'), '// @marmeon-stub gadgets 1\nexport default {};\n');
    for (const options of [{}, { check: true }]) {
      const { code, lines } = run(root, providers, options);
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('is marked for the "gadgets" tables, not "widgets"');
    }
  });

  it('finds a migration by its whole name, not by how it ends', () => {
    const root = appAt(1, '2026_02_01_000000_old_upgrade_widgets_2.ts');
    expect(run(root, providers, { check: true }).code).toBe(1);
  });
});

describe('the upgrades a provider lists', () => {
  it('stops the start on a name that is a path', () => {
    expect(() => collectUpgrades([provider('Bad', [upgrade(2, '../../escape')])])).toThrow(/Bad lists the migration upgrade "\.\.\/\.\.\/escape".*without timestamp or path/);
  });

  it('stops on a createdBy that is a path', () => {
    expect(() => collectUpgrades([provider('Bad', [{ ...upgrade(2), createdBy: ['../x'] }])])).toThrow(/createdBy must list file names/);
  });

  it('stops on a revision below 2 and on contents that carry another mark', () => {
    expect(() => collectUpgrades([provider('Bad', [upgrade(1)])])).toThrow(/revision must be an integer from 2/);
    expect(() => collectUpgrades([provider('Bad', [{ ...upgrade(2), contents: '// @marmeon-stub widgets 3\n' }])])).toThrow(/must start with the line "\/\/ @marmeon-stub widgets 2"/);
  });

  it('stops on the same revision of a set from two providers, and names both', () => {
    expect(() => collectUpgrades([provider('First', [upgrade(2)]), provider('Second', [upgrade(2, 'upgrade_other')])])).toThrow(/First and Second both list revision 2 of the "widgets" tables/);
  });

  it('is checked when the app starts', async () => {
    const root = tempDir('marmeon-upgrades-');
    const bad = provider('Bad', [upgrade(2, '../escape')]);
    await expect(
      createApplication({ root, discover: false, providers: [DatabaseServiceProvider, bad] }, { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, override: (container) => container.instance(Logger, silent) }),
    ).rejects.toThrow(/without timestamp or path/);
  });

  it('makes a provider with nothing else a valid one', async () => {
    const root = tempDir('marmeon-upgrades-');
    await using app = await createApplication(
      { root, discover: false, providers: [DatabaseServiceProvider, provider('Tables', [upgrade(2)])] },
      { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' }, override: (container) => container.instance(Logger, silent) },
    );
    expect(app.providers).toHaveLength(2);
  });
});

describe.each(drivers)('schema.rename with indexes on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
  });
  afterAll(() => close());

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
    const schema = new Schema(connections.get(), driver);
    await build(schema, 'old_things');
    await build(schema, 'fresh_things');
    await schema.rename('old_things', 'fresh_things_renamed', { indexes: true });
    const renamed = await describeTable('fresh_things_renamed');
    await build(schema, 'fresh_things_made');
    const made = await describeTable('fresh_things_made');
    const alike = (value: object, from: string, to: string) => JSON.parse(JSON.stringify(value).replaceAll(from, to));
    expect(alike(renamed, 'fresh_things_renamed', 'T')).toEqual(alike(made, 'fresh_things_made', 'T'));
    expect(renamed.indexes.every((name) => name.startsWith('fresh_things_renamed_') || name.startsWith('sqlite_autoindex_'))).toBe(true);
  });

  it('renames each name once when the new name begins with the old one', async () => {
    const schema = new Schema(connections.get(), driver);
    await build(schema, 'jobs');
    await schema.rename('jobs', 'jobs_archive', { indexes: true });
    const renamed = await describeTable('jobs_archive');
    await build(schema, 'jobs_archive_made');
    const made = await describeTable('jobs_archive_made');
    expect(JSON.stringify(renamed).replaceAll('jobs_archive', 'T')).toBe(JSON.stringify(made).replaceAll('jobs_archive_made', 'T'));
    expect([...renamed.indexes, ...renamed.constraints, ...renamed.sequences].some((name) => name.includes('archive_archive'))).toBe(false);
  });

  it('keeps the names of the indexes without the option', async () => {
    const schema = new Schema(connections.get(), driver);
    await build(schema, 'plain_old');
    await schema.rename('plain_old', 'plain_new');
    const { indexes, constraints } = await describeTable('plain_new');
    expect(indexes).toContain('plain_old_owner_id_index');
    expect(indexes.some((name) => name.startsWith('plain_new_'))).toBe(false);
    expect(constraints.some((name) => name.startsWith('plain_new_'))).toBe(false);
  });
});

describe.each(drivers)('the readiness check of the framework tables on %s', (driver) => {
  it('is red while a table lacks a column, and says which, and green when it has them', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      const requirements = new SchemaRequirements();
      requirements.require({ connection: 'default', table: 'widgets', columns: ['id', 'label'], set: 'widgets' });
      const check = new DatabaseHealthCheck(connections, requirements);
      const schema = new Schema(connections.get(), driver);
      await schema.create('widgets', (table) => {
        table.id();
      });
      await expect(check.handle()).rejects.toThrow('widgets lacks label — run marmeon make:upgrade-migrations, then marmeon migrate');
      await schema.alter('widgets', (table) => {
        table.string('label').nullable();
      });
      await expect(check.handle()).resolves.toBe('default');
    } finally {
      await close();
    }
  });

  it('turns green when another process has migrated since', async () => {
    const root = tempDir('marmeon-upgrades-');
    const fresh = driver === 'sqlite' ? { options: { driver: 'sqlite', database: join(root, 'app.sqlite') } as const, drop: async () => {} } : await freshDatabase('pgsql');
    const here = new Connections({ connections: { default: fresh.options }, root, logger: silent });
    const there = new Connections({ connections: { default: fresh.options }, root, logger: silent });
    try {
      await new Schema(there.get(), driver).create('widgets', (table) => {
        table.id();
      });
      const requirements = new SchemaRequirements();
      requirements.require({ connection: 'default', table: 'widgets', columns: ['id', 'label'], set: 'widgets' });
      const check = new DatabaseHealthCheck(here, requirements);
      await expect(check.handle()).rejects.toThrow('widgets lacks label');
      await new Schema(there.get(), driver).alter('widgets', (table) => {
        table.string('label').nullable();
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
      requirements.require({ connection: 'default', table: 'nothing_here', columns: [], set: 'widgets' });
      await expect(new DatabaseHealthCheck(connections, requirements).handle()).rejects.toThrow('nothing_here is missing — run marmeon make:upgrade-migrations');
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
    app.container.make(SchemaRequirements).require({ connection: 'default', table: 'missing_things', columns: ['id'], set: 'things' });
    const report = await app.container.make(HealthChecks).run(app.container);
    expect(report.ok).toBe(false);
    expect((report.checks[0]!.error as Error).message).toBe('missing_things is missing — run marmeon make:upgrade-migrations, then marmeon migrate');
  });
});
