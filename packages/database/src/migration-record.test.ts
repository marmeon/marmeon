import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { ErrorSolutions } from '@marmeon/core';
import { sql, type Kysely } from 'kysely';
import type { CommandInput } from 'marmeon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createLegacyTables, drivers, freshConnections, silent } from './__fixtures__/databases.ts';
import { MigrateCommand } from './commands/migrate.ts';
import { Connections, MigrationStateError, Migrator, Schema, SchemaError } from './index.ts';
import { tableColumns } from './introspection.ts';
import { dropAllTables } from './migrations/drop-all.ts';
import { LOCK_TABLE } from './migrations/lock.ts';
import type { UnknownSchema } from './migrations/migrator.ts';
import { migrationChecksum } from './migrations/checksum.ts';
import { migratorConnection } from './migrator-connection.ts';
import { databaseSolutions } from './solutions.ts';
import type { TypeGenerator } from './types-gen/generator.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
const accounts: ModuleDefinition = { name: 'accounts', migrations: fixtures('accounts') };
const migrator = (connections: Connections, ...modules: ModuleDefinition[]) =>
  new Migrator({ modules: modules.length > 0 ? modules : [auth, accounts], root: '/' } as unknown as Application, connections);
const formats = new URL('./__fixtures__/formats/migrations/', import.meta.url);
const allTables = async (db: Kysely<any>) => (await db.introspection.getTables()).map((table) => table.name).sort();

describe.each(drivers)('the migrator keeps two tables on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => ({ connections, close } = await freshConnections(driver, { record: false })));
  afterEach(() => close());

  it('has `migrations` and, on SQLite, `migration_lock` beside the tables of the app — nothing else', async () => {
    await migrator(connections).migrate();
    const tables = await allTables(connections.get<any>());
    expect(tables.filter((table) => !['accounts', 'users'].includes(table))).toEqual(driver === 'sqlite' ? ['migration_lock', 'migrations'] : ['migrations']);
  });

  it('writes the record with a checksum per migration, which is part of its format', async () => {
    await migrator(connections).migrate();
    const run = async <R>(query: string) => (await sql.raw<R>(query).execute(connections.get())).rows;
    expect([...(await tableColumns(run, driver)).types.get('migrations')!.keys()]).toEqual(['id', 'name', 'module', 'batch', 'checksum']);
    const sum = (directory: string, name: string) => migrationChecksum(readFileSync(new URL(`${name}.ts`, fixtures(directory))));
    expect(await connections.get<any>().selectFrom('migrations').select(['name', 'module', 'batch', 'checksum']).execute()).toEqual([
      { name: '2026_01_01_000000_create_users_table', module: 'auth', batch: 1, checksum: sum('auth', '2026_01_01_000000_create_users_table') },
      { name: '2026_01_05_000000_create_accounts_table', module: 'accounts', batch: 1, checksum: sum('accounts', '2026_01_05_000000_create_accounts_table') },
      { name: '2026_01_06_000000_add_recovery_code_to_accounts_table', module: 'accounts', batch: 1, checksum: sum('accounts', '2026_01_06_000000_add_recovery_code_to_accounts_table') },
    ]);
  });

  it('keeps the record on `default` only: a migration on another connection leaves that database with its own tables', async () => {
    // The record lives on `default` only; a migration on another connection leaves that database with its own tables alone.
    const other = await freshConnections(driver, { record: false });
    try {
      const both = new Connections({ connections: { default: connections.options(), system: other.connections.options() }, root: '/', logger: silent });
      try {
        const system: ModuleDefinition = { name: 'system', migrations: fixtures('system') };
        const app = { modules: [auth, system], root: '/', container: { make: () => 'system' } } as unknown as Application;
        await new Migrator(app, both).migrate();
        expect(await allTables(both.get<any>('system'))).toEqual(['audit', 'counters']);
      } finally {
        await both.destroy();
      }
    } finally {
      await other.close();
    }
  });

  it.each(
    readdirSync(formats)
      .filter((name) => name.endsWith(`-${driver}.sql`))
      .sort(),
  )('migrates the database a release left (%s): the record is taken over as it is, and the same columns stay secret', async (file) => {
    const books = migratorConnection(connections);
    for (const statement of readFileSync(new URL(file, formats), 'utf8').split('\n').filter((line) => line.trim() !== '')) await sql.raw(statement).execute(books);
    const legacy: [string, string[]][] = [];
    const unknown: UnknownSchema[] = [];
    const carried: unknown[] = [];
    const ran = await migrator(connections, accounts).migrate(undefined, {
      onLegacy: (c, tables) => legacy.push([c, [...tables]]),
      onUnknown: (_, found) => unknown.push(found),
      onCarriedOver: (found) => carried.push(found),
    });
    expect(ran.map((run) => run.name)).toEqual(['2026_01_06_000000_add_recovery_code_to_accounts_table']);
    // They are the old tables, not unknown ones.
    expect(unknown).toEqual([]);
    // The migrations say what is secret, whatever the old tables say: the row the release wrote has no password in it.
    const [row] = await connections.get<any>().selectFrom('accounts').selectAll().execute();
    expect(row).toBeDefined();
    expect(Object.keys(row!)).not.toContain('password');
    expect([...connections.metadata().secrets.get('accounts')!].sort()).toEqual(['password', 'recovery_code', 'totp_secret']);
    // The unique index the release made is the one that is there; the migrations did not make another.
    const indexes = driver === 'sqlite'
      ? (await sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = 'accounts'`.execute(books)).rows
      : (await sql<{ name: string }>`select indexname as name from pg_indexes where tablename = 'accounts'`.execute(books)).rows;
    expect(indexes.map((index) => index.name)).toContain('accounts_email_unique');
    const run = async <R>(query: string) => (await sql.raw<R>(query).execute(connections.get())).rows;
    expect([...(await tableColumns(run, driver)).types.get('migrations')!.keys()].sort()).toEqual(['batch', 'checksum', 'id', 'module', 'name']);
    const checksums = Object.fromEntries((await books.selectFrom('migrations').select(['name', 'checksum']).execute()).map((entry) => [entry.name, entry.checksum]));
    const sum = (name: string) => migrationChecksum(readFileSync(new URL(`${name}.ts`, fixtures('accounts'))));
    const version = file.split('-')[0] as 'v1' | 'v2';
    const byVersion: Record<'v1' | 'v2', () => Promise<void>> = {
      // The form of 0.3: the three old tables stay and are named, and the record is carried over in this run.
      v1: async () => {
        expect(legacy).toEqual([['default', ['table_owners', 'secret_columns', 'schema_markers']]]);
        for (const [table, rows] of [['table_owners', 1], ['secret_columns', 2], ['schema_markers', 1]] as const) {
          expect((await sql`select * from ${sql.table(table)}`.execute(books)).rows, table).toHaveLength(rows);
        }
        expect(carried).toEqual([{ recorded: 1, unknown: [] }]);
        expect(checksums).toEqual({ '2026_01_05_000000_create_accounts_table': sum('2026_01_05_000000_create_accounts_table'), '2026_01_06_000000_add_recovery_code_to_accounts_table': sum('2026_01_06_000000_add_recovery_code_to_accounts_table') });
        // Said on every run: the tables stay until someone drops them.
        legacy.length = 0;
        await migrator(connections, accounts).migrate(undefined, { onLegacy: (c, tables) => legacy.push([c, [...tables]]) });
        expect(legacy).toHaveLength(1);
      },
      // Already the current form: nothing is carried over, and the checksum the fixture holds stays.
      v2: async () => {
        expect(legacy).toEqual([]);
        expect(carried).toEqual([]);
        expect(checksums).toEqual({ '2026_01_05_000000_create_accounts_table': `sha256:${'0'.repeat(64)}`, '2026_01_06_000000_add_recovery_code_to_accounts_table': sum('2026_01_06_000000_add_recovery_code_to_accounts_table') });
      },
    };
    if (!(version in byVersion)) expect.fail(`${file} is a record of a format this test does not know`);
    await byVersion[version]();
  });

  it('names the tables of 0.3 on every connection a migration runs on, not only on `default`', async () => {
    const other = await freshConnections(driver, { record: false });
    try {
      const both = new Connections({ connections: { default: connections.options(), system: other.connections.options() }, root: '/', logger: silent });
      try {
        const system: ModuleDefinition = { name: 'system', migrations: fixtures('system') };
        const app = { modules: [auth, system], root: '/', container: { make: () => 'system' } } as unknown as Application;
        await new Migrator(app, both).migrate();
        await createLegacyTables(migratorConnection(both, 'system'));
        const legacy: string[] = [];
        const unknown: [string, UnknownSchema][] = [];
        await new Migrator(app, both).migrate(undefined, { onLegacy: (c) => legacy.push(c), onUnknown: (c, found) => unknown.push([c, found]) });
        expect(legacy).toEqual(['system']);
        expect(unknown).toEqual([]);
      } finally {
        await both.destroy();
      }
    } finally {
      await other.close();
    }
  });

  it('does not take a table for a leftover of 0.3 that has other columns', async () => {
    await migrator(connections, auth).migrate();
    await migratorConnection(connections).schema.createTable('secret_columns').addColumn('id', 'integer').addColumn('title', 'varchar(20)').execute();
    const legacy: string[][] = [];
    const unknown: UnknownSchema[] = [];
    await migrator(connections, auth).migrate(undefined, { onLegacy: (_, tables) => legacy.push([...tables]), onUnknown: (_, found) => unknown.push(found) });
    expect(legacy).toEqual([]);
    expect(unknown).toEqual([{ tables: ['secret_columns'], columns: [] }]);
  });

  it('drops the tables of 0.3 with everything else on `migrate:fresh`', async () => {
    await migrator(connections, auth).migrate();
    await createLegacyTables(migratorConnection(connections));
    await migrator(connections, auth).fresh();
    expect((await allTables(connections.get<any>())).filter((table) => !['users', 'migrations', LOCK_TABLE].includes(table))).toEqual([]);
  });

  it('gives the migrator a connection that reads its own tables only', async () => {
    await migrator(connections).migrate();
    const books = migratorConnection(connections);
    await expect(books.selectFrom('users').selectAll().execute()).rejects.toThrow(/migrator's tables only/);
    await expect(books.deleteFrom('accounts').execute()).rejects.toThrow(/migrator's tables only/);
    expect(await books.selectFrom('migrations').selectAll().execute()).toHaveLength(3);
  });

  it('keeps nothing but the lock when it drops every table, `migrations` included', async () => {
    await migrator(connections).migrate();
    await dropAllTables(connections.get(), driver);
    expect(await allTables(connections.get<any>())).toEqual(driver === 'sqlite' ? [LOCK_TABLE] : []);
  });
});

describe.each(drivers.flatMap((driver) => [[driver, 'alone'], [driver, 'next to a placeholder of the 0.3 record']] as const))('a database migrated by a build that was never released, on %s (%s)', (driver, variant) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver, { record: false }));
    const books = migratorConnection(connections);
    await books.schema.createTable('users').addColumn('id', 'integer').execute();
    await books.schema.createTable('marmeon_migrations').addColumn('id', 'integer').addColumn('name', 'varchar(255)').execute();
    // The build took a database of 0.3 over: a placeholder where the record was.
    if (variant !== 'alone') await books.schema.createTable('migrations').addColumn('moved_to', 'varchar(64)').execute();
  });
  afterEach(() => close());

  it('is refused by `migrate`, which names the way out, and nothing is written', async () => {
    await expect(migrator(connections).migrate()).rejects.toThrow(/\[marmeon:D1\].*marmeon_migrations.*migrate:fresh/s);
    await expect(migrator(connections).migrate()).rejects.toBeInstanceOf(MigrationStateError);
    if (variant === 'alone') expect(await allTables(migratorConnection(connections))).not.toContain('migrations');
  });

  it('refuses every query, as a database with tables and no record does', async () => {
    await expect(connections.get<any>().selectFrom('users').selectAll().execute()).rejects.toMatchObject({ reason: 'unmigrated' });
  });

  it('is started over by `migrate:fresh`', async () => {
    await migrator(connections).fresh();
    expect((await allTables(connections.get<any>())).filter((table) => table.startsWith('marmeon_'))).toEqual([]);
    expect(await connections.get<any>().selectFrom('users').selectAll().execute()).toEqual([]);
  });
});

describe.each(drivers)('a database with tables and no record of migrations, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver, { record: false }));
    await migratorConnection(connections).schema.createTable('stranger').addColumn('id', 'integer').addColumn('note', 'varchar(20)').execute();
  });
  afterEach(() => close());

  it('refuses queries until `migrate` wrote the record — there is no adoption: the tables stay unknown, and are named', async () => {
    await expect(connections.get<any>().selectFrom('stranger').selectAll().execute()).rejects.toMatchObject({ reason: 'unmigrated' });
    const unknown: [string, UnknownSchema][] = [];
    const ran = await migrator(connections, auth).migrate(undefined, { onUnknown: (connection, found) => unknown.push([connection, found]) });
    expect(ran).toHaveLength(1);
    expect(unknown).toEqual([['default', { tables: ['stranger'], columns: [] }]]);
    expect(await connections.get<any>().selectFrom('stranger').selectAll().execute()).toEqual([]);
  });

  it('refuses before it runs anything when a table it creates is there already — and leaves no record behind', async () => {
    await migratorConnection(connections).schema.createTable('users').addColumn('id', 'integer').execute();
    await expect(migrator(connections, auth).migrate()).rejects.toThrow(/\[marmeon:D3\].*already has the table users.*2026_01_01_000000_create_users_table.*is this the database you mean/s);
    expect(await allTables(migratorConnection(connections))).toEqual(driver === 'sqlite' ? ['migration_lock', 'stranger', 'users'] : ['stranger', 'users']);
    // The run gave its schema back: the next query looks at the database like a process that starts.
    await expect(connections.get<any>().selectFrom('stranger').selectAll().execute()).rejects.toMatchObject({ reason: 'unmigrated' });
  });

  it('leaves no record behind when the first migration fails', async () => {
    const broken: ModuleDefinition = { name: 'broken', migrations: fixtures('broken') };
    await expect(migrator(connections, broken).migrate()).rejects.toThrow('this migration is broken');
    expect(await allTables(migratorConnection(connections))).not.toContain('migrations');
    await expect(connections.get<any>().selectFrom('stranger').selectAll().execute()).rejects.toMatchObject({ reason: 'unmigrated' });
  });

  it('is said by `migrate` as a warning that names the tables and the way to know them', async () => {
    const printed: string[] = [];
    const say = (kind: string) => (text: string) => void printed.push(`${kind}: ${text}`);
    const output = { line: say('line'), info: say('info'), success: say('success'), warn: say('warn'), error: say('error'), table: () => {} };
    await createLegacyTables(migratorConnection(connections));
    const command = new MigrateCommand(migrator(connections, auth), {} as TypeGenerator);
    expect(await command.handle({ options: { force: true }, output, root: '/' } as unknown as CommandInput)).toBe(0);
    expect(printed.find((line) => line.startsWith('info:') && /stranger/.test(line))).toMatch(/tables no migration made: stranger.*unprotected.*create a new table with schema\.create\(\) and copy the rows over/);
    expect(printed.find((line) => line.startsWith('info:') && /table_owners/.test(line))).toMatch(/left in place for processes of Marmeon 0\.3; drop them once none runs/);
  });
});

describe.each(drivers)('the record of migrations and the lock, in a form this release does not read, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver));
    await migrator(connections, auth).migrate();
  });
  afterEach(() => close());

  it.each([
    ['one column more', 'alter table migrations add column note varchar(64)'],
    ['a column renamed', 'alter table migrations rename column module to owner'],
  ])('is refused with %s — by migrate, rollback, status and migrate:fresh', async (_name, statement) => {
    await sql.raw(statement).execute(migratorConnection(connections));
    for (const run of [(m: Migrator) => m.migrate(), (m: Migrator) => m.rollback(), (m: Migrator) => m.status(), (m: Migrator) => m.fresh()]) {
      await expect(run(migrator(connections, auth))).rejects.toMatchObject({ reason: 'newer' });
    }
    expect(await allTables(migratorConnection(connections))).toContain('users');
  });

  it.runIf(driver === 'sqlite')('is refused for the lock table too', async () => {
    await sql`alter table migration_lock add column note varchar(20)`.execute(migratorConnection(connections));
    await expect(migrator(connections, auth).migrate()).rejects.toMatchObject({ reason: 'newer', message: expect.stringMatching(/\[marmeon:D1\].*migration_lock.*note/s) });
  });
});

describe.each(drivers)('the record of migrations in the form of 0.3, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  const checksums = async () => Object.fromEntries((await migratorConnection(connections).selectFrom('migrations').select(['name', 'checksum']).execute()).map((row) => [row.name, row.checksum]));
  const columnsOfRecord = async () => {
    const run = async <R>(query: string) => (await sql.raw<R>(query).execute(migratorConnection(connections))).rows;
    return [...(await tableColumns(run, driver)).types.get('migrations')!.keys()].sort();
  };
  const sumOf = (directory: string, name: string) => migrationChecksum(readFileSync(new URL(`${name}.ts`, fixtures(directory))));
  const USERS = '2026_01_01_000000_create_users_table';
  const ACCOUNTS = '2026_01_05_000000_create_accounts_table';
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver));
    await migrator(connections, auth, accounts).migrate();
    // What 0.3 wrote: the same record without the checksum.
    await sql`alter table migrations drop column checksum`.execute(migratorConnection(connections));
  });
  afterEach(() => close());

  it('is refused by the app like a migration that is missing, and read again once `migrate` carried it over', async () => {
    // A process that starts looks at the database for the first time.
    connections.metadata().reload();
    const error = await connections.get<any>().selectFrom('users').selectAll().execute().then(() => undefined, (e: unknown) => e as MigrationStateError);
    expect(error).toMatchObject({ reason: 'pending', missing: [] });
    expect(error!.message).toMatch(/\[marmeon:D2\].*form Marmeon 0\.3 wrote.*marmeon migrate/s);
    const [solution] = await new ErrorSolutions(databaseSolutions).find(error!);
    expect(solution).toMatchObject({ title: 'Carry the record of migrations over', command: 'marmeon migrate', docs: 'docs/migrations.md#how-the-migrator-keeps-track' });
    expect(solution!.text).not.toMatch(/\b0 pending|lacks ,/);
    await migrator(connections, auth, accounts).migrate();
    expect(await connections.get<any>().selectFrom('users').selectAll().execute()).toEqual([]);
  });

  it('is carried over by `migrate` even when no migration is pending: the columns, and the checksum of every file there is', async () => {
    const carried: unknown[] = [];
    expect(await migrator(connections, auth, accounts).migrate(undefined, { onCarriedOver: (found) => carried.push(found) })).toEqual([]);
    expect(await columnsOfRecord()).toEqual(['batch', 'checksum', 'id', 'module', 'name']);
    expect(await checksums()).toMatchObject({ [USERS]: sumOf('auth', USERS), [ACCOUNTS]: sumOf('accounts', ACCOUNTS) });
    expect(carried).toEqual([{ recorded: 3, unknown: [] }]);
  });

  it('leaves a migration without its file unknown, names it, and never fills it in later', async () => {
    await sql`insert into migrations (name, module, batch) values ('2025_12_31_000000_create_gone_table', 'gone', 1)`.execute(migratorConnection(connections));
    const carried: { recorded: number; unknown: readonly string[] }[] = [];
    await migrator(connections, auth, accounts).migrate(undefined, { onCarriedOver: (found) => carried.push(found) });
    expect(carried).toEqual([{ recorded: 3, unknown: ['2025_12_31_000000_create_gone_table'] }]);
    expect((await checksums())['2025_12_31_000000_create_gone_table']).toBeNull();
    // Not carried over again, and not filled in: a migration that ran and has no checksum stays unknown, also when its file comes back.
    await sql`update migrations set checksum = null where name = ${USERS}`.execute(migratorConnection(connections));
    carried.length = 0;
    await migrator(connections, auth, accounts).migrate(undefined, { onCarriedOver: (found) => carried.push(found) });
    expect(carried).toEqual([]);
    expect((await checksums())[USERS]).toBeNull();
  });

  it('is carried over by `migrate:rollback` before the `down()` runs', async () => {
    const carried: unknown[] = [];
    const rolled = await migrator(connections, auth, accounts).rollback({ onCarriedOver: (found) => carried.push(found) });
    expect(rolled.map((run) => run.name)).toHaveLength(3);
    expect(carried).toEqual([{ recorded: 3, unknown: [] }]);
    expect(await columnsOfRecord()).toEqual(['batch', 'checksum', 'id', 'module', 'name']);
  });

  it('is carried over by `migrate:reset` too', async () => {
    const carried: unknown[] = [];
    await migrator(connections, auth, accounts).reset(undefined, { onCarriedOver: (found) => carried.push(found) });
    expect(carried).toEqual([{ recorded: 3, unknown: [] }]);
  });

  it('is only read by `status` and `missing()`: the record keeps its four columns', async () => {
    const run = migrator(connections, auth, accounts);
    expect((await run.status()).every((file) => file.batch === 1)).toBe(true);
    expect(await run.missing()).toEqual([]);
    expect(await columnsOfRecord()).toEqual(['batch', 'id', 'module', 'name']);
  });

  it('is refused as `newer` with one more column', async () => {
    await sql`alter table migrations add column note varchar(64)`.execute(migratorConnection(connections));
    await expect(migrator(connections, auth, accounts).migrate()).rejects.toMatchObject({ reason: 'newer' });
  });
});

describe.each(drivers)('the migration files the migrator reads, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => ({ connections, close } = await freshConnections(driver)));
  afterEach(() => close());

  /** The fixtures of `accounts` as files of a directory of their own, importing the package by its path. */
  const copyOfAccounts = (): string => {
    const directory = tempDir('marmeon-record-');
    for (const file of readdirSync(fixtures('accounts'))) {
      const source = readFileSync(new URL(file, fixtures('accounts')), 'utf8').replace("'../../../index.ts'", JSON.stringify(new URL('./index.ts', import.meta.url).href));
      writeFileSync(join(directory, file), source);
    }
    return directory;
  };
  const canRefuseReading = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.runIf(canRefuseReading)('leaves the record in the form of 0.3 when a file cannot be read while it is carried over, and carries it over in the next run', async () => {
    const directory = copyOfAccounts();
    const module: ModuleDefinition = { name: 'accounts', migrations: directory };
    await migrator(connections, module).migrate();
    const books = migratorConnection(connections);
    await sql`alter table migrations drop column checksum`.execute(books);
    const second = join(directory, '2026_01_06_000000_add_recovery_code_to_accounts_table.ts');
    chmodSync(second, 0o000);
    try {
      await expect(migrator(connections, module).migrate()).rejects.toThrow();
    } finally {
      chmodSync(second, 0o644);
    }
    const run = async <R>(query: string) => (await sql.raw<R>(query).execute(books)).rows;
    expect([...(await tableColumns(run, driver)).types.get('migrations')!.keys()].sort()).toEqual(['batch', 'id', 'module', 'name']);
    await migrator(connections, module).migrate();
    const rows = await books.selectFrom('migrations').select('checksum').execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => /^sha256:[0-9a-f]{64}$/.test(row.checksum))).toBe(true);
  });

  it('stops before anything runs when a file changes while it is read, instead of recording the checksum of another version', async () => {
    const directory = tempDir('marmeon-record-');
    const file = join(directory, '2026_02_01_000000_create_things_table.ts');
    // Evaluating the file edits it: the import reads a file that is not the one whose bytes were hashed.
    writeFileSync(file, `import { appendFileSync } from 'node:fs';\nappendFileSync(import.meta.filename, '// edited\\n');\nexport default { up() {} };\n`);
    const module: ModuleDefinition = { name: 'things', migrations: directory };
    await expect(migrator(connections, module).migrate()).rejects.toThrow(/\[marmeon:D14\].*changed while it was read/);
    expect(await connections.get<any>().selectFrom('migrations').selectAll().execute()).toEqual([]);
  });
});

describe.each(drivers)('the names of the migrator, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver));
    await migrator(connections).migrate();
  });
  afterEach(() => close());

  it('refuses to create, alter, drop or rename `migrations` and `migration_lock`, also qualified', () => {
    const schema = new Schema();
    const qualified = driver === 'pgsql' ? 'public' : 'main';
    for (const name of ['migrations', 'migration_lock', 'MIGRATIONS']) {
      for (const full of [name, `${qualified}.${name}`]) {
        expect(() => schema.create(full, (table) => table.id())).toThrow(SchemaError);
        expect(() => schema.alter(full, (table) => table.string('x'))).toThrow(SchemaError);
        expect(() => schema.drop(full)).toThrow(SchemaError);
        expect(() => schema.dropIfExists(full)).toThrow(SchemaError);
        expect(() => schema.rename(full, 'other')).toThrow(SchemaError);
        expect(() => schema.rename('users', full)).toThrow(SchemaError);
      }
    }
  });

  it('leaves tables with the names of 0.3 and of the unreleased build to the app', () => {
    const schema = new Schema();
    for (const name of ['table_owners', 'secret_columns', 'schema_markers', 'marmeon_migrations', 'marmeon_versions']) {
      expect(() => schema.create(name, (table) => table.id())).not.toThrow();
      expect(() => schema.drop(name)).not.toThrow();
    }
  });

  it('refuses a write to the migrator\'s tables through schema.data() in a migration, and records nothing', async () => {
    const writes: ModuleDefinition = { name: 'writes', migrations: fixtures('writes-record') };
    await expect(migrator(connections, auth, accounts, writes).migrate()).rejects.toThrow(/\[marmeon:D4\].*migration_lock/s);
    expect((await migrator(connections, auth, accounts, writes).status()).filter((file) => file.batch === undefined).map((file) => file.module)).toEqual(['writes']);
  });
});

describe.each(drivers)('the database against the migrations after each one, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver));
    await migrator(connections).migrate();
  });
  afterEach(() => close());

  it.each([
    ['a secret column renamed in raw SQL', 'raw-rename-column', /the column accounts\.password/],
    ['a table with secret columns renamed in raw SQL', 'raw-rename-table', /the table accounts/],
  ])('rolls back a migration that leaves %s, with D3 and the way to do it', async (_name, directory, what) => {
    const hand: ModuleDefinition = { name: 'hand', migrations: fixtures(directory) };
    await expect(migrator(connections, auth, accounts, hand).migrate()).rejects.toThrow(what);
    await expect(migrator(connections, auth, accounts, hand).migrate()).rejects.toThrow(/\[marmeon:D3\].*schema\.alter\(\).*schema\.rename\(\)/s);
    await expect(migrator(connections, auth, accounts, hand).migrate()).rejects.toBeInstanceOf(SchemaError);
    // The transaction went back: the column is still called what it was, and the migration is not recorded.
    await sql`select id, password from accounts`.execute(migratorConnection(connections));
    expect(await connections.get<any>().selectFrom('accounts').selectAll().execute()).toEqual([]);
    expect((await migrator(connections, auth, accounts, hand).status()).filter((file) => file.batch === undefined).map((file) => file.module)).toEqual(['hand']);
  });

  it('does not take what the database has beyond the migrations for an error: a column and a table raw SQL added are named after the run', async () => {
    const hand: ModuleDefinition = { name: 'hand', migrations: fixtures('raw-add') };
    const unknown: [string, UnknownSchema][] = [];
    const ran = await migrator(connections, auth, accounts, hand).migrate(undefined, { onUnknown: (connection, found) => unknown.push([connection, found]) });
    expect(ran).toHaveLength(1);
    expect(unknown).toEqual([['default', { tables: ['made_by_hand'], columns: ['accounts.by_hand'] }]]);
  });

  it('stops before the run when the database already lacks what the migrations that ran say, instead of blaming the first one of the run', async () => {
    await sql`alter table users rename column name to nm`.execute(migratorConnection(connections));
    await expect(migrator(connections, auth, accounts, { name: 'order', migrations: fixtures('order') }).migrate()).rejects.toThrow(
      /\[marmeon:D3\].*already lacks the column users\.name.*before this run.*Nothing was run/s,
    );
    expect(await allTables(migratorConnection(connections))).not.toContain('things');
  });

  it('rolls back a down() that takes more along than the migration made, with D3, and keeps the record', async () => {
    const bad: ModuleDefinition = { name: 'bad', migrations: fixtures('bad-down') };
    await migrator(connections, auth, accounts, bad).migrate();
    await expect(migrator(connections, auth, accounts, bad).rollback()).rejects.toThrow(/\[marmeon:D3\].*the column scratch\.kept/s);
    expect(await allTables(connections.get<any>())).toEqual(expect.arrayContaining(['leftovers', 'scratch']));
    expect((await migrator(connections, auth, accounts, bad).status()).every((file) => file.batch !== undefined)).toBe(true);
    await sql`select kept from scratch`.execute(migratorConnection(connections));
  });

  it('hands the connections back after a rollback or reset that fails: the next query checks the database like a fresh process', async () => {
    const bad: ModuleDefinition = { name: 'bad', migrations: fixtures('bad-down') };
    for (const undo of ['rollback', 'reset'] as const) {
      const run = migrator(connections, auth, accounts, bad);
      await run.migrate();
      await expect(run[undo]()).rejects.toThrow(/\[marmeon:D3\]/);
      // The rollback had handed over the schema without the table it was undoing; the database still has it.
      expect(connections.metadata().ready).toBe(false);
      await connections.get<any>().selectFrom('users').select('id').execute();
      expect(connections.metadata().ready).toBe(true);
    }
  });
});

describe.each(drivers)('an order of the run that the names do not give, on %s', (driver) => {
  const order: ModuleDefinition = { name: 'order', migrations: fixtures('order') };
  const late: ModuleDefinition = { name: 'late', migrations: fixtures('order-late') };
  const independent: ModuleDefinition = { name: 'independent', migrations: fixtures('order-independent') };
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver));
    await migrator(connections, order).migrate();
  });
  afterEach(() => close());

  it('is refused before the first migration runs when the late one touches what the later ran one touched — with the way out', async () => {
    const error = await migrator(connections, order, late).migrate().then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(SchemaError);
    expect(error!.message).toMatch(/^\[marmeon:D3\] .*things.*Rename 2026_04_02_000000_add_z_to_things_table so that its name sorts after 2026_04_03_000000_drop_z_from_things_table/s);
    expect((await migrator(connections, order, late).status()).filter((file) => file.batch === undefined).map((file) => file.module)).toEqual(['late']);
  });

  it('runs a late migration that touches other tables: the schema is the same in either order', async () => {
    const ran = await migrator(connections, order, independent).migrate();
    expect(ran.map((run) => run.name)).toEqual(['2026_04_02_000000_create_extras_table']);
    expect(await allTables(connections.get<any>())).toContain('extras');
    // A process of the new code knows both tables.
    expect([...connections.metadata().kinds.keys()].sort()).toEqual(['extras', 'things']);
  });
});

describe.each(drivers)('`managed: false`, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => ({ connections, close } = await freshConnections(driver, { managed: false })));
  afterEach(() => close());

  it('is read from its catalog and left alone by `migrate`', async () => {
    const books = migratorConnection(connections);
    await books.schema.createTable('stranger').addColumn('id', 'integer').addColumn('note', 'varchar(20)').addColumn('deleted_at', 'timestamp').execute();
    expect(await connections.get<any>().selectFrom('stranger').selectAll().execute()).toEqual([]);
    expect(connections.metadata().secrets.size).toBe(0);
    expect(connections.metadata().softDeletes.size).toBe(0);
    await expect(migrator(connections).migrate()).rejects.toThrow(/not migrated by Marmeon/);
    await expect(migrator(connections).fresh()).rejects.toThrow(/managed: false/);
    expect((await allTables(books)).filter((table) => table !== LOCK_TABLE)).toEqual(['stranger']);
  });

  it.each([['the form of 0.3', false], ['the form with a checksum', true]])('is refused when the database has the record of migrations Marmeon writes after all (%s) — it would hide what the migrations say', async (_form, checksum) => {
    const books = migratorConnection(connections);
    await books.schema.createTable('people').addColumn('id', 'integer').addColumn('hash', 'varchar(20)').execute();
    await books.schema
      .createTable('migrations')
      .addColumn('id', 'integer')
      .addColumn('name', 'varchar(255)')
      .addColumn('module', 'varchar(255)')
      .addColumn('batch', 'integer')
      .$call((table) => (checksum ? table.addColumn('checksum', 'varchar(80)') : table))
      .execute();
    const error = await connections.get<any>().selectFrom('people').selectAll().execute().then(() => undefined, (e: unknown) => e as MigrationStateError);
    expect(error).toMatchObject({ reason: 'unmanaged' });
    expect(error!.message).toMatch(/\[marmeon:D1\].*managed: false.*migrations.*Marmeon migrates this database/s);
  });

  it('reads a table `migrations` of another tool as an ordinary table', async () => {
    await migratorConnection(connections).schema.createTable('migrations').addColumn('id', 'integer').addColumn('migration', 'varchar(20)').addColumn('batch', 'integer').execute();
    expect(await connections.get<any>().selectFrom('migrations').selectAll().execute()).toEqual([]);
  });

  it('reads the tables of 0.3 as ordinary tables', async () => {
    await createLegacyTables(migratorConnection(connections));
    expect(await connections.get<any>().selectFrom('secret_columns').selectAll().execute()).toEqual([]);
  });
});

describe.runIf(drivers.includes('pgsql' as never))('the search path, on Postgres', () => {
  it('sees the tables an unqualified name finds, also when the first schema of the path is an empty one named like the role', async () => {
    const { connections, close } = await freshConnections('pgsql', { record: false });
    try {
      const books = migratorConnection(connections);
      await books.schema.createTable('people').addColumn('id', 'integer').addColumn('hash', 'varchar(20)').execute();
      const { role } = (await sql<{ role: string }>`select current_user as role`.execute(books)).rows[0]!;
      await sql`create schema if not exists ${sql.id(role)}`.execute(books);
      expect((await sql<{ schema: string }>`select current_schema() as schema`.execute(books)).rows[0]!.schema).toBe(role);
      await expect(connections.get<any>().selectFrom('people').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*people/s);
      await migrator(connections, ...([] as ModuleDefinition[])).migrate();
      expect(await connections.get<any>().selectFrom('people').selectAll().execute()).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe.runIf(drivers.includes('pgsql' as never))('tables an extension owns, on Postgres', () => {
  it('count for the relation an unqualified name finds: an extension table in a later schema does not hide an app table of the same name', async () => {
    const { connections, close } = await freshConnections('pgsql', { record: false });
    try {
      const books = migratorConnection(connections);
      const { role } = (await sql<{ role: string }>`select current_user as role`.execute(books)).rows[0]!;
      await sql`create extension if not exists citext`.execute(books);
      await sql`create table public.spatial_ref_sys (srid integer)`.execute(books);
      await sql`alter extension citext add table public.spatial_ref_sys`.execute(books);
      await sql`create schema if not exists ${sql.id(role)}`.execute(books);
      await sql`create table ${sql.id(role)}.spatial_ref_sys (srid integer, hash varchar(20))`.execute(books);
      await expect(connections.get<any>().selectFrom('spatial_ref_sys').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*spatial_ref_sys/s);
    } finally {
      await close();
    }
  });

  it('are no tables of the app: the connection counts as empty, and `migrate` neither refuses it nor names the table', async () => {
    const { connections, close } = await freshConnections('pgsql', { record: false });
    try {
      const books = migratorConnection(connections);
      await sql`create extension if not exists citext`.execute(books);
      await books.schema.createTable('spatial_ref_sys').addColumn('srid', 'integer').execute();
      await sql`alter extension citext add table spatial_ref_sys`.execute(books);
      expect(await connections.get<any>().selectFrom('spatial_ref_sys').selectAll().execute()).toEqual([]);
      const unknown: UnknownSchema[] = [];
      await migrator(connections, auth).migrate(undefined, { onUnknown: (_, found) => unknown.push(found) });
      expect(unknown).toEqual([]);
      expect(await allTables(connections.get<any>())).toContain('migrations');
    } finally {
      await close();
    }
  });
});

describe('the solutions for migrations that are not what the code expects', () => {
  const read = (reason: MigrationStateError['reason'], code: 'D1' | 'D2') =>
    new ErrorSolutions(databaseSolutions).find(new MigrationStateError(reason, 'default', `[marmeon:${code}] text`, reason === 'pending' ? ['2026_01_01_000000_a'] : []));

  it('names the command for a database not yet migrated and for pending migrations, and none for a record it cannot read or `managed: false`', async () => {
    expect(await read('pending', 'D2')).toMatchObject([{ code: 'D2', command: 'marmeon migrate' }]);
    expect(await read('unmigrated', 'D1')).toMatchObject([{ code: 'D1', command: 'marmeon migrate' }]);
    for (const reason of ['newer', 'unmanaged'] as const) {
      const [solution] = await read(reason, 'D1');
      expect(solution).toMatchObject({ code: 'D1' });
      expect(solution).not.toHaveProperty('command');
    }
  });
});
