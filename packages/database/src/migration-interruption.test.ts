import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { printable } from '@marmeon/core/internal';

import { sql } from 'kysely';
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { appOf as fakeApp, drivers, freshConnections, freshDatabase, silent, withMysql } from './__fixtures__/databases.ts';
import type { ConnectionOptions } from './config.ts';
import { Connections, DatabaseHealthCheck, MigrationLockLostError, MigrationLockTimeoutError, MigrationStateError, Migrator } from './index.ts';
import { tableColumns } from './introspection.ts';
import { INTERRUPTION_COLUMNS, createMigrationsTable, readInterruption } from './migration-state.ts';
import { inspectionConnection, migratorConnection } from './migrator-connection.ts';
import { SchemaRequirements } from './schema-requirements.ts';
import { SchemaError } from './schema/schema.ts';
import { UnsupportedDriverError } from './supported-driver.ts';
import { CommandArgumentsError } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import type { TypeGenerator } from './types-gen/generator.ts';
import { MigrateCommand, MigrateFreshCommand, MigrateResetCommand, MigrateRollbackCommand, MigrateStatusCommand } from './commands/migrate.ts';
import { migrationChecksum } from './migrations/checksum.ts';
import { PAUSE, type Pause } from './__fixtures__/migrations/state-pause/2026_01_31_000000_create_paused_table.ts';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';

// A row in `migration_interruption` means a migration started and has not finished; the table exists on MySQL only. The MySQL cases run in
// `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL, and are skipped without it; the cases on `drivers` prove that SQLite and Postgres
// keep that name for the app. Every marker row here is written by hand.

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
const accounts: ModuleDefinition = { name: 'accounts', migrations: fixtures('accounts') };
const named: ModuleDefinition = { name: 'named', migrations: fixtures('interruption-name') };
const moduleOf = (name: string): ModuleDefinition => ({ name, migrations: fixtures(`interruption-${name}`) });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Made once a test needs it: a file whose tests are all skipped (no MySQL in the run) does not remove what its top level made.
let root = '';
const appOf = (modules: ModuleDefinition[]) => fakeApp(modules, root);

/** A migrator that only needs the app's modules and root. */
const migratorOn = (connections: Connections, ...modules: ModuleDefinition[]) => new Migrator({ modules, root: '/' } as unknown as Application, connections);

const ACCOUNTS = '2026_01_05_000000_create_accounts_table';
const MARKER = { name: ACCOUNTS, module: 'accounts', connection_name: 'default', direction: 'up', batch: 2, started_at: '2026-11-27T10:00:00.000Z', owner: 'web-1:4242' };

/** The row a migration that stopped halfway would leave, written through the migrator's connection. */
const mark = (connections: Connections, values: Partial<typeof MARKER> = {}) => migratorConnection(connections).insertInto('migration_interruption').values({ ...MARKER, ...values }).execute();

describe.each(drivers)('a table of the app named migration_interruption on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(() => {
    root ||= workspaceTempDir('marmeon-migration-interruption-');
  });
  beforeEach(async () => ({ connections, close } = await freshConnections(driver)));
  afterEach(() => close());

  const tables = async () => (await connections.get<any>().introspection.getTables()).map((table) => table.name).sort();

  it('is created by a migration, written and read by the app, and migrates again: the name is not the migrator’s here', async () => {
    const run = migratorOn(connections, named);
    expect((await run.migrate()).map((entry) => entry.name)).toEqual(['2026_05_01_000000_create_interruption_table']);
    const db = connections.get<any>();
    await db.insertInto('migration_interruption').values({ note: 'mine' }).execute();
    expect(await db.selectFrom('migration_interruption').select('note').execute()).toEqual([{ note: 'mine' }]);
    expect(await run.migrate()).toEqual([]);
    expect((await run.status()).map((entry) => entry.batch)).toEqual([1]);
  });

  it('is refused on the migrator’s own connection like any table of the app', async () => {
    await migratorOn(connections, named).migrate();
    const books = migratorConnection(connections);
    const refusal = /^The migrator's connection reads and writes the migrator's tables only; "migration_interruption" is not one of them\.$/;
    await expect(books.selectFrom('migration_interruption').selectAll().execute()).rejects.toThrow(refusal);
    await expect(books.insertInto('migration_interruption').values({ note: 'x' }).execute()).rejects.toThrow(refusal);
  });

  it('is an app table to the state check: with no record, it is tables and no record', async () => {
    // A process of the app: its own connections on a database that has the table and no record of migrations.
    const { options, drop } =
      driver === 'sqlite'
        ? { options: { driver: 'sqlite', database: join(tempDir('marmeon-migration-interruption-db-'), 'app.sqlite') } satisfies ConnectionOptions, drop: async () => {} }
        : await freshDatabase(driver);
    const process = new Connections({ connections: { default: options }, root, logger: silent, app: appOf([]) });
    try {
      await sql`create table migration_interruption (id integer primary key, note varchar(10))`.execute(migratorConnection(process));
      const error = await process.get<any>().selectFrom('migration_interruption').select('id').execute().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(MigrationStateError);
      expect(error).toMatchObject({ reason: 'unmigrated' });
      expect((error as Error).message).toMatch(/^\[marmeon:D1\] The database connection "default" has tables \(migration_interruption\) and no record of migrations/);
    } finally {
      await process.destroy();
      await drop();
    }
  });

  it('runs a plain migrate when `retrying` names a row that is not there: no marker table is touched, no interruption reported', async () => {
    const left: unknown[] = [];
    const runs = await migratorOn(connections, auth).migrate({ retrying: [{ name: '2026_01_01_000000_create_users_table', startedAt: '2026-11-27T10:00:00.000Z' }], onInterrupted: (found) => left.push(found) });
    expect(runs.map((entry) => entry.name)).toEqual(['2026_01_01_000000_create_users_table']);
    expect(left).toEqual([]);
    expect(await tables()).toContain('users');
  });

  it.each(['retry', 'done'])('has nothing to resolve for migrate --interrupted=%s: exit 1, and nothing is migrated', async (how) => {
    const printed: string[] = [];
    const output = { line() {}, info() {}, success() {}, warn() {}, error: (text: string) => void printed.push(text), table() {} };
    const input = { options: { interrupted: how }, output, root: '/' } as unknown as CommandInput;
    expect(await new MigrateCommand(migratorOn(connections, auth), {} as TypeGenerator).handle(input)).toBe(1);
    expect(printed).toEqual(['Nothing to resolve: no migration of the database connection "default" stopped halfway (only MySQL marks one). Nothing was migrated.']);
    expect(await tables()).not.toContain('users');
  });

  it('is not made by a migration of the migrator’s own tables: migrate creates no migration_interruption', async () => {
    await migratorOn(connections, auth).migrate();
    expect(await tables()).not.toContain('migration_interruption');
  });
});

withMysql('a migration that did not finish, on MySQL', () => {
  let options: ConnectionOptions;
  let drop: () => Promise<void>;
  const opened: Connections[] = [];

  beforeAll(() => {
    root ||= workspaceTempDir('marmeon-migration-interruption-');
  });
  beforeEach(async () => {
    ({ options, drop } = await freshDatabase('mysql'));
    const scratch = connectionsOf([]);
    await createMigrationsTable(migratorConnection(scratch), 'mysql');
  });
  // The pools a test opened are closed with it: kept until the suite ends they would exhaust the server's connections.
  afterEach(async () => {
    for (const connections of opened.splice(0)) await connections.destroy();
    await drop();
  });

  /** A process of the app whose code has `modules`' migrations. */
  function connectionsOf(modules: ModuleDefinition[], extra: Record<string, ConnectionOptions> = {}): Connections {
    const connections = new Connections({ connections: { default: options, ...extra }, root, logger: silent, app: appOf(modules) });
    opened.push(connections);
    return connections;
  }
  const migrateWith = (modules: ModuleDefinition[]) => new Migrator(appOf(modules), connectionsOf(modules));
  const select = (connections: Connections, table = 'users') => connections.get<any>().selectFrom(table).select('id').execute();
  const failure = (work: () => Promise<unknown>) => work().then(() => undefined, (error: unknown) => error);
  const catalog = async (connections: Connections) =>
    (await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(migratorConnection(connections))).rows.map((row) => row.name);
  const recorded = async (connections: Connections) => migratorConnection(connections).selectFrom('migrations').select(['name', 'batch']).orderBy('id').execute();
  const markerRows = async (connections: Connections) => (await migratorConnection(connections).selectFrom('migration_interruption').select('name').execute()).length;

  it('refuses every query of a new process, with D32 and not with the pending migrations', async () => {
    await migrateWith([auth]).migrate();
    await mark(connectionsOf([]));
    const error = await failure(() => select(connectionsOf([auth, accounts])));
    expect(error).toBeInstanceOf(MigrationStateError);
    expect(error).toMatchObject({ reason: 'interrupted', connection: 'default' });
    expect((error as Error).message).toMatch(/^\[marmeon:D32\] Migration 2026_01_05_000000_create_accounts_table \(module "accounts"\) started its up\(\) on the database connection "default" at 2026-11-27T10:00:00\.000Z \(web-1:4242\) and has not finished/);
    expect((error as Error).message).toContain('Every query on the connection "default" is refused until that is resolved.');
  });

  it('refuses a process whose code has nothing pending too: the state that is ready, with the code of the database', async () => {
    await migrateWith([auth]).migrate();
    await mark(connectionsOf([]));
    const error = await failure(() => select(connectionsOf([auth])));
    expect(error).toMatchObject({ reason: 'interrupted' });
    expect((error as Error).message).toMatch(/^\[marmeon:D32\] Migration /);
  });

  it('refuses the next connection of the process and readiness, which names the code', async () => {
    await migrateWith([auth]).migrate();
    await mark(connectionsOf([]));
    const process = connectionsOf([auth], { other: options });
    const error = await failure(() => sql`select 1`.execute(process.get('other')));
    expect(error).toMatchObject({ reason: 'interrupted' });
    const health = await failure(() => new DatabaseHealthCheck(connectionsOf([auth]), new SchemaRequirements()).handle());
    expect(health).toBeInstanceOf(AggregateError);
    expect((health as AggregateError).message).toMatch(/^\[marmeon:D32\] The database connection "default" failed: Migration 2026_01_05_000000_create_accounts_table/);
  });

  it('refuses migrate, rollback and reset, and changes nothing', async () => {
    await migrateWith([auth, accounts]).migrate();
    await mark(connectionsOf([]), { name: '2026_01_06_000000_add_recovery_code_to_accounts_table', direction: 'down' });
    const before = { tables: await catalog(connectionsOf([])), rows: await recorded(connectionsOf([])) };
    expect(before.rows).toHaveLength(3);
    for (const [name, run] of [
      ['migrate', () => migrateWith([auth, accounts, named]).migrate()],
      ['rollback', () => migrateWith([auth, accounts]).rollback()],
      ['reset', () => migrateWith([auth, accounts]).reset()],
    ] as const) {
      const error = await failure(run);
      expect(error, name).toBeInstanceOf(MigrationStateError);
      expect(error, name).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message, name).toMatch(/^\[marmeon:D32\] Migration 2026_01_06_000000_add_recovery_code_to_accounts_table \(module "accounts"\) started its down\(\)/);
      expect((error as Error).message, name).toContain('runs no migration until that is resolved.');
    }
    expect({ tables: await catalog(connectionsOf([])), rows: await recorded(connectionsOf([])) }).toEqual(before);
    expect(await markerRows(connectionsOf([]))).toBe(1);
  });

  it('shows what a row holds escaped, so a name cannot redraw the terminal', async () => {
    await migrateWith([auth]).migrate();
    const name = `bad${String.fromCharCode(27)}[2Jname`;
    await mark(connectionsOf([]), { name, owner: `me${String.fromCharCode(7)}` });
    const message = ((await failure(() => select(connectionsOf([auth])))) as Error).message;
    expect(message).toContain(printable(name));
    expect(message).toContain(`(me\\u0007)`);
    expect(message).not.toContain(String.fromCharCode(27));
    expect(message).not.toContain(String.fromCharCode(7));
  });

  it('refuses a table of interruptions with other columns, with D1 naming them, in every command, and keeps its rows', async () => {
    await migrateWith([auth]).migrate();
    await mark(connectionsOf([]));
    await sql`alter table migration_interruption add column note varchar(10)`.execute(migratorConnection(connectionsOf([])));
    const columns = /^\[marmeon:D1\] The table of interrupted migrations \(migration_interruption\) of the database connection "default" has the columns batch, connection_name, direction, module, name, note, owner, started_at, /;
    for (const [name, run] of [
      ['query', () => select(connectionsOf([auth]))],
      ['migrate', () => migrateWith([auth, accounts]).migrate()],
      ['rollback', () => migrateWith([auth]).rollback()],
      ['status', () => migrateWith([auth]).status()],
      ['fresh', () => migrateWith([auth]).fresh()],
    ] as const) {
      const error = await failure(run);
      expect(error, name).toBeInstanceOf(MigrationStateError);
      expect(error, name).toMatchObject({ reason: 'newer' });
      expect((error as Error).message, name).toMatch(columns);
    }
    expect(await markerRows(connectionsOf([]))).toBe(1);
    expect(await catalog(connectionsOf([]))).toContain('users');
  });

  it('cannot tell when the record is there and the table of interruptions is not, and refuses with D32', async () => {
    await migrateWith([auth]).migrate();
    await sql`drop table migration_interruption`.execute(migratorConnection(connectionsOf([])));
    for (const [name, run] of [
      ['query', () => select(connectionsOf([auth]))],
      ['migrate', () => migrateWith([auth, accounts]).migrate()],
    ] as const) {
      const error = await failure(run);
      expect(error, name).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message, name).toMatch(/^\[marmeon:D32\] The database connection "default" has the record of migrations \(migrations\) but this role does not see migration_interruption/);
    }
  });

  it('migrates a database without any table and without a record: nothing to tell yet', async () => {
    // The fresh database of this suite has both tables; one with neither is the first `migrate` on an empty database.
    const empty = await freshConnections('mysql', { record: false });
    try {
      // The server's own answer for a table that is not there, not a refusal of Marmeon's.
      const error = await failure(() => select(empty.connections, 'users'));
      expect(error).not.toBeInstanceOf(MigrationStateError);
      expect((error as Error).message).toMatch(/users.*doesn't exist/i);
      await migratorOn(empty.connections, auth).migrate();
      expect((await empty.connections.get<any>().selectFrom('migration_interruption').select('name').execute()).length).toBe(0);
    } finally {
      await empty.close();
    }
  });

  it('drops the table of interruptions with everything else on fresh, and starts over with a new one', async () => {
    await migrateWith([auth]).migrate();
    await mark(connectionsOf([]));
    expect((await migrateWith([auth]).fresh()).map((run) => run.name)).toEqual(['2026_01_01_000000_create_users_table']);
    expect(await markerRows(connectionsOf([]))).toBe(0);
    expect(await select(connectionsOf([auth]))).toEqual([]);
  });

  it('creates the record and the table of interruptions together, in the binary collation, and goes on from a database that has only the table', async () => {
    const empty = await freshConnections('mysql', { record: false });
    try {
      const books = migratorConnection(empty.connections);
      await createMigrationsTable(books, 'mysql');
      const collations = async () =>
        (await sql<{ name: string; collation: string }>`select table_name as name, table_collation as collation from information_schema.tables where table_schema = database() order by 1`.execute(books)).rows;
      expect(await collations()).toEqual([
        { name: 'migration_interruption', collation: 'utf8mb4_0900_bin' },
        { name: 'migrations', collation: 'utf8mb4_0900_bin' },
      ]);
      const columns = (await sql<{ name: string }>`select column_name as name from information_schema.columns where table_schema = database() and table_name = 'migration_interruption' order by 1`.execute(books)).rows;
      expect(columns.map((column) => column.name)).toEqual([...INTERRUPTION_COLUMNS]);
      // The process stopped between the two creates: only the table of interruptions is there.
      await sql`drop table migrations`.execute(books);
      await createMigrationsTable(books, 'mysql');
      expect((await collations()).map((table) => table.name)).toEqual(['migration_interruption', 'migrations']);
    } finally {
      await empty.close();
    }
  });

  it('does not take the table of interruptions for a table of the app: without the record, a query on a missing table gets the server’s error', async () => {
    const books = migratorConnection(connectionsOf([]));
    await sql`drop table migrations`.execute(books);
    const error = await failure(() => select(connectionsOf([]), 'users'));
    expect(error).not.toBeInstanceOf(MigrationStateError);
    expect((error as Error).message).toMatch(/users.*doesn't exist/i);
  });

  it('names the first of two rows by when it started and then by name, and reads its batch as a number', async () => {
    await migrateWith([auth]).migrate();
    const first = { name: 'b_second_by_name', started_at: '2026-11-27T09:00:00.000Z', batch: 3 };
    await mark(connectionsOf([]), { name: 'z_later', started_at: '2026-11-27T10:00:00.000Z', batch: 9 });
    await mark(connectionsOf([]), { ...first, name: 'c_same_time' });
    await mark(connectionsOf([]), first);
    const error = await failure(() => select(connectionsOf([auth])));
    expect((error as Error).message).toMatch(/^\[marmeon:D32\] Migration b_second_by_name \(module "accounts"\) started its up\(\) on the database connection "default" at 2026-11-27T09:00:00\.000Z/);
    const books = migratorConnection(connectionsOf([]));
    const run = async <R>(text: string) => (await sql.raw<R>(text).execute(books)).rows;
    const columns = new Map([...(await tableColumns(run, 'mysql')).types].map(([table, found]) => [table, [...found.keys()]]));
    expect(await readInterruption(run, columns, 'default')).toEqual({ name: 'b_second_by_name', module: 'accounts', connection: 'default', direction: 'up', batch: 3, startedAt: '2026-11-27T09:00:00.000Z', owner: 'web-1:4242' });
  });

  describe('a plan that names the table of interruptions', () => {
    const run = (name: string) => migratorOn(connectionsOf([]), { name: 'named', migrations: fixtures(name) });

    it('is refused with D4 before anything runs, and creates nothing', async () => {
      const connections = connectionsOf([]);
      const before = { tables: await catalog(connections), rows: await recorded(connections) };
      const error = await failure(() => run('interruption-name').migrate());
      expect((error as Error).message).toMatch(/^\[marmeon:D4\] Migration 2026_05_01_000000_create_interruption_table \(module "named"\): Cannot create the table "migration_interruption": the name belongs to the migrator on MySQL/);
      expect({ tables: await catalog(connections), rows: await recorded(connections) }).toEqual(before);
      expect(await markerRows(connections)).toBe(0);
    });

    it('is refused for a rename to it, in any case', async () => {
      const error = await failure(() => run('interruption-name-rename').migrate());
      expect((error as Error).message).toMatch(/^\[marmeon:D4\] Migration 2026_05_04_000000_rename_to_interruption_table \(module "named"\): Cannot rename a table to "Migration_Interruption"/);
    });

    it('is refused in a data step that writes to it, and in raw SQL that names it', async () => {
      expect((await failure(() => run('interruption-name-data').migrate())) as Error).toMatchObject({ message: expect.stringMatching(/^\[marmeon:D4\] Cannot write to "migration_interruption": the table belongs to the migrator/) });
      const raw = (await failure(() => run('interruption-name-raw').migrate())) as Error;
      expect(raw.message).toMatch(/^\[marmeon:D4\] Migration 2026_05_03_000000_raw_on_interruption_table \(module "named"\): The raw SQL names "migration_interruption", a table of the migrator on MySQL/);
    });

    it.each([
      ['a drop', 'interruption-drop', '2026_05_05_000000_drop_interruption_table', 'drop the table "migration_interruption"'],
      ['a drop with the database in front', 'interruption-drop-qualified', '2026_05_06_000000_drop_qualified_interruption_table', 'drop the table "app.migration_interruption"'],
      ['a drop of a three-part name, which Kysely sends as database and table', 'interruption-drop-three-parts', '2026_05_11_000000_drop_three_part_interruption_table', 'drop the table "app.migration_interruption.x"'],
      ['a dropIfExists with the database in front, in another case', 'interruption-drop-if-exists-qualified', '2026_05_07_000000_drop_qualified_interruption_table_if_exists', 'drop the table "app.Migration_Interruption"'],
    ])('is refused for %s, and the marker stays', async (_what, fixture, migration, what) => {
      const connections = connectionsOf([]);
      const error = await failure(() => run(fixture).migrate());
      expect((error as Error).message).toMatch(new RegExp(`^\\[marmeon:D4\\] Migration ${migration} \\(module "named"\\): Cannot ${what.replaceAll('.', '\\.')}: the name belongs to the migrator on MySQL`));
      expect(await catalog(connections)).toContain('migration_interruption');
    });

    it.each([
      ['a down() that drops it', 'interruption-down-drop', '2026_05_08_000000_down_drops_interruption_table', 'drop the table "migration_interruption"'],
      ['a down() that alters it', 'interruption-down-alter', '2026_05_09_000000_down_alters_interruption_table', 'alter the table "migration_interruption"'],
      ['a down() that renames it', 'interruption-down-rename', '2026_05_10_000000_down_renames_interruption_table', 'rename the table "migration_interruption"'],
    ])('is refused on rollback for %s, before it drops or changes anything', async (_what, fixture, migration, what) => {
      const connections = connectionsOf([]);
      const migrator = run(fixture);
      expect((await migrator.migrate()).map((entry) => entry.name)).toEqual([migration]);
      const before = { tables: await catalog(connections), rows: await recorded(connections) };
      const error = await failure(() => migrator.rollback());
      expect((error as Error).message).toMatch(new RegExp(`^\\[marmeon:D4\\] Migration ${migration} \\(module "named"\\): Cannot ${what}: the name belongs to the migrator on MySQL`));
      expect({ tables: await catalog(connections), rows: await recorded(connections) }).toEqual(before);
    });
  });

  describe('a migration that writes its marker', () => {
    const counter = moduleOf('counter');
    const multiply = moduleOf('multiply');
    const halfway = moduleOf('halfway');
    const gadgets = moduleOf('down');
    const paused = moduleOf('paused');
    /** Reads as the server has it: the app's connection refuses every query while a marker is there. */
    const look = (connections: Connections) => inspectionConnection(connections);
    const counterN = async (connections: Connections) => (await sql<{ n: number }>`select n from counter`.execute(look(connections))).rows.map((row) => Number(row.n));
    const markers = (connections: Connections) => migratorConnection(connections).selectFrom('migration_interruption').selectAll().execute();
    const hasTable = async (connections: Connections, table: string) => (await catalog(connections)).includes(table);
    const hasColumn = async (connections: Connections, table: string, column: string) =>
      Number((await sql<{ n: number }>`select count(*) as n from information_schema.columns where table_schema = database() and table_name = ${table} and column_name = ${column}`.execute(look(connections))).rows[0]!.n) > 0;
    const migratorOf = (modules: ModuleDefinition[]) => {
      const connections = connectionsOf(modules);
      return { connections, migrator: new Migrator(appOf(modules), connections) };
    };
    /** Ends the migration lock's connection of this database from another process, as a network cut would, and waits for the server to notice. */
    const loseLock = (killer: Connections) => {
      (globalThis as { loseMigrationLock?: unknown }).loseMigrationLock = async () => {
        const [killed] = (
          await sql<{ id: string }>`select a.processlist_id as id from performance_schema.session_connect_attrs a join information_schema.processlist p on p.id = a.processlist_id where a.attr_name = 'program_name' and a.attr_value like 'marmeon-migrate:%' and p.db = database() and a.processlist_id <> connection_id()`.execute(look(killer))
        ).rows;
        await sql.raw(`kill ${killed!.id}`).execute(look(killer));
        await pause(300);
      };
      onTestFinished(() => void delete (globalThis as { loseMigrationLock?: unknown }).loseMigrationLock);
    };

    it('runs a migration of rows alone in one transaction with its record: a lock lost after the update leaves 1, and the rerun ends at 100, not 10000', async () => {
      await migrateWith([counter]).migrate();
      loseLock(connectionsOf([]));
      await expect(migratorOf([counter, multiply]).migrator.migrate()).rejects.toBeInstanceOf(MigrationLockLostError);
      const after = connectionsOf([]);
      expect(await counterN(after)).toEqual([1]);
      expect((await recorded(after)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
      expect(await markerRows(after)).toBe(0);
      delete (globalThis as { loseMigrationLock?: unknown }).loseMigrationLock;
      expect((await migrateWith([counter, multiply]).migrate()).map((run) => run.name)).toEqual(['2026_05_02_000000_multiply_the_counter']);
      expect(await counterN(after)).toEqual([100]);
      expect(await migrateWith([counter, multiply]).migrate()).toEqual([]);
      expect(await counterN(after)).toEqual([100]);
    });

    it('leaves 100 when a data step is followed by a statement that fails, marks it once, and refuses the next run instead of making it 10000', async () => {
      await migrateWith([counter]).migrate();
      const left: unknown[] = [];
      const { connections, migrator } = migratorOf([counter, halfway]);
      await expect(migrator.migrate({ onInterrupted: (found) => left.push(found) })).rejects.toThrow(/Duplicate column name 'note'/);
      expect(left).toEqual([{ name: '2026_05_02_000000_multiply_then_fail', module: 'halfway', connection: 'default', direction: 'up' }]);
      expect(await counterN(connections)).toEqual([100]);
      expect(await hasColumn(connections, 'counter', 'note')).toBe(true);
      expect(await markers(connections)).toEqual([
        { name: '2026_05_02_000000_multiply_then_fail', module: 'halfway', connection_name: 'default', direction: 'up', batch: 2, started_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/), owner: expect.stringMatching(/:\d+/) },
      ]);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
      const again = await failure(() => migrateWith([counter, halfway]).migrate());
      expect(again).toMatchObject({ reason: 'interrupted' });
      expect((again as Error).message).toMatch(/^\[marmeon:D32\] Migration 2026_05_02_000000_multiply_then_fail \(module "halfway"\) started its up\(\)/);
      expect(await counterN(connections)).toEqual([100]);
    });

    it('refuses the queries of the process that ran the failed migration', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, halfway]);
      await expect(migrator.migrate()).rejects.toThrow(/Duplicate column name/);
      const error = await failure(() => select(connections, 'counter'));
      expect(error).toBeInstanceOf(MigrationStateError);
      expect(error).toMatchObject({ reason: 'interrupted' });
    });

    it('commits the marker before the first statement, outside the transaction of the first step: a new process sees it while that step waits, and the run clears it', async () => {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      (globalThis as Record<symbol, Pause | undefined>)[PAUSE] = { entered: () => entered.resolve(), released: released.promise };
      onTestFinished(() => void delete (globalThis as Record<symbol, Pause | undefined>)[PAUSE]);
      await migrateWith([auth]).migrate();
      const running = migrateWith([auth, paused]).migrate();
      try {
        await entered.promise;
        const process = connectionsOf([auth, paused]);
        expect(await markers(process)).toEqual([expect.objectContaining({ name: '2026_05_04_000000_pause_first', direction: 'up', connection_name: 'default' })]);
        const error = await failure(() => select(process));
        expect(error).toMatchObject({ reason: 'interrupted' });
        expect((error as Error).message).toMatch(/^\[marmeon:D32\] Migration 2026_05_04_000000_pause_first /);
      } finally {
        released.resolve();
      }
      expect((await running).map((run) => run.name)).toEqual(['2026_05_04_000000_pause_first']);
      expect(await markerRows(connectionsOf([]))).toBe(0);
      expect(await select(connectionsOf([auth, paused]))).toEqual([]);
    });

    it('removes the marker in the transaction of the record: a record that cannot be written keeps it', async () => {
      const books = migratorConnection(connectionsOf([]));
      await sql`create trigger refuse_record before insert on migrations for each row signal sqlstate '45000' set message_text = 'record refused'`.execute(books);
      const { connections, migrator } = migratorOf([counter]);
      await expect(migrator.migrate()).rejects.toThrow(/record refused/);
      expect(await hasTable(connections, 'counter')).toBe(true);
      expect(await markers(connections)).toEqual([expect.objectContaining({ name: '2026_05_01_000000_create_counter_table' })]);
    });

    it('removes the marker only in the transaction of the record: a marker that cannot be deleted leaves no record', async () => {
      const books = migratorConnection(connectionsOf([]));
      await sql`create trigger refuse_clear before delete on migration_interruption for each row signal sqlstate '45000' set message_text = 'clear refused'`.execute(books);
      const { connections, migrator } = migratorOf([counter]);
      await expect(migrator.migrate()).rejects.toThrow(/clear refused/);
      expect(await hasTable(connections, 'counter')).toBe(true);
      expect(await recorded(connections)).toEqual([]);
      expect(await markerRows(connections)).toBe(1);
    });

    it('leaves a marker of direction down when a down() fails after its first statement, and refuses the next rollback', async () => {
      const { migrator } = migratorOf([gadgets]);
      await migrator.migrate();
      const left: unknown[] = [];
      const rollback = migratorOf([gadgets]);
      await expect(rollback.migrator.rollback({ onInterrupted: (found) => left.push(found) })).rejects.toThrow(/no_such_table/);
      expect(left).toEqual([{ name: '2026_05_03_000000_create_gadgets_table', module: 'down', connection: 'default', direction: 'down' }]);
      expect(await hasTable(rollback.connections, 'gizmos')).toBe(false);
      expect(await hasTable(rollback.connections, 'gadgets')).toBe(true);
      expect((await recorded(rollback.connections)).map((row) => row.name)).toEqual(['2026_05_03_000000_create_gadgets_table']);
      expect(await markers(rollback.connections)).toEqual([expect.objectContaining({ direction: 'down', batch: 1 })]);
      const again = await failure(() => migratorOf([gadgets]).migrator.rollback());
      expect(again).toMatchObject({ reason: 'interrupted' });
      expect((again as Error).message).toMatch(/started its down\(\)/);
    });

    it('marks every migration that runs, the one of rows alone inside its own transaction too, and leaves no marker after a good run', async () => {
      const sent: string[] = [];
      const { connections, migrator } = migratorOf([counter, multiply]);
      connections.onQuery((query) => void sent.push(query.sql));
      await migrator.migrate();
      expect(await markerRows(connections)).toBe(0);
      const written = (verb: RegExp) => sent.filter((text) => /migration_interruption/.test(text) && verb.test(text));
      expect(written(/^\s*insert/i)).toHaveLength(2);
      expect(written(/^\s*delete/i)).toHaveLength(2);
    });

    it('keeps the marker of a migration of rows alone when a statement commits on its own: the rows stay at 100, and the next run is refused instead of making it 10000', async () => {
      await migrateWith([counter]).migrate();
      const implicit = moduleOf('implicit');
      const left: unknown[] = [];
      const { connections, migrator } = migratorOf([counter, implicit]);
      // The driver reports the transaction the prepared statement ended (D24).
      await expect(migrator.migrate({ onInterrupted: (found) => left.push(found) })).rejects.toThrow(/^\[marmeon:D24\]/);
      expect(left).toEqual([{ name: '2026_05_07_000000_prepare_a_create', module: 'implicit', connection: 'default', direction: 'up' }]);
      expect(await counterN(connections)).toEqual([100]);
      expect(await hasTable(connections, 'sneaked')).toBe(true);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
      expect(await markers(connections)).toEqual([expect.objectContaining({ name: '2026_05_07_000000_prepare_a_create', direction: 'up' })]);
      expect(await failure(() => migrateWith([counter, implicit]).migrate())).toMatchObject({ reason: 'interrupted' });
      expect(await counterN(connections)).toEqual([100]);
    });

    it('does not let a callback that rejects replace the error of the migration', async () => {
      await migrateWith([counter]).migrate();
      const { migrator } = migratorOf([counter, halfway]);
      await expect(migrator.migrate({ onInterrupted: async () => Promise.reject(new Error('the callback failed later')) })).rejects.toThrow(/Duplicate column name 'note'/);
    });

    it('writes no marker for a migration on another MySQL connection that sends MySQL no statement, whatever fails after it', async () => {
      const other = await freshDatabase('mysql');
      try {
        const modules = [moduleOf('system-quiet')];
        const connections = connectionsOf(modules, { system: other.options });
        const books = migratorConnection(connections);
        await sql`create trigger refuse_record before insert on migrations for each row signal sqlstate '45000' set message_text = 'record refused'`.execute(books);
        const left: unknown[] = [];
        await expect(new Migrator(appOf(modules), connections).migrate({ onInterrupted: (found) => left.push(found) })).rejects.toThrow(/record refused/);
        expect(await markers(connections)).toEqual([]);
        expect(left).toEqual([]);
      } finally {
        await other.drop();
      }
    });

    it('does not report a migration of rows alone that a lost lock rolled back: nothing was committed, so nothing is marked', async () => {
      await migrateWith([counter]).migrate();
      loseLock(connectionsOf([]));
      const left: unknown[] = [];
      await expect(migratorOf([counter, multiply]).migrator.migrate({ onInterrupted: (found) => left.push(found) })).rejects.toBeInstanceOf(MigrationLockLostError);
      expect(left).toEqual([]);
    });

    it('treats a raw step with `mysql: null` as rows: a lock lost after the update rolls the whole migration back', async () => {
      await migrateWith([counter]).migrate();
      loseLock(connectionsOf([]));
      const { connections, migrator } = migratorOf([counter, moduleOf('rawnull')]);
      await expect(migrator.migrate()).rejects.toBeInstanceOf(MigrationLockLostError);
      expect(await counterN(connections)).toEqual([1]);
      expect(await markerRows(connections)).toBe(0);
    });

    it('does not let what a callback throws replace the error of the migration', async () => {
      await migrateWith([counter]).migrate();
      const { migrator } = migratorOf([counter, halfway]);
      await expect(
        migrator.migrate({
          onInterrupted: () => {
            throw new Error('the callback failed');
          },
        }),
      ).rejects.toThrow(/Duplicate column name 'note'/);
    });

    it('writes the marker of a migration on another MySQL connection beside the record, naming that connection', async () => {
      const other = await freshDatabase('mysql');
      try {
        const modules = [moduleOf('system-fail')];
        const connections = connectionsOf(modules, { system: other.options });
        const left: unknown[] = [];
        await expect(new Migrator(appOf(modules), connections).migrate({ onInterrupted: (found) => left.push(found) })).rejects.toThrow(/no_such_table/);
        expect(left).toEqual([{ name: '2026_05_10_000000_create_audit_then_fail', module: 'system-fail', connection: 'system', direction: 'up' }]);
        expect(await markers(connections)).toEqual([expect.objectContaining({ name: '2026_05_10_000000_create_audit_then_fail', connection_name: 'system' })]);
        const tablesOfOther = await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by 1`.execute(inspectionConnection(connections, 'system'));
        expect(tablesOfOther.rows.map((row) => row.name)).toEqual(['audit']);
      } finally {
        await other.drop();
      }
    });

    it('keeps the record when the marker cannot be deleted on a rollback: the down() ran, the record row stays, the marker too', async () => {
      await migrateWith([counter]).migrate();
      const books = migratorConnection(connectionsOf([]));
      await sql`create trigger refuse_clear before delete on migration_interruption for each row signal sqlstate '45000' set message_text = 'clear refused'`.execute(books);
      const { connections, migrator } = migratorOf([counter]);
      await expect(migrator.rollback()).rejects.toThrow(/clear refused/);
      expect(await hasTable(connections, 'counter')).toBe(false);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
      expect(await markers(connections)).toEqual([expect.objectContaining({ direction: 'down' })]);
    });

    it('rolls a down() of rows alone back with its record: no marker is left, and a marker that cannot be deleted undoes the rows too', async () => {
      const both = [counter, moduleOf('data-down')];
      await migrateWith([counter]).migrate();
      await migrateWith(both).migrate();
      expect(await counterN(connectionsOf([]))).toEqual([100]);
      await migrateWith(both).rollback();
      const after = connectionsOf([]);
      expect(await counterN(after)).toEqual([1]);
      expect(await markerRows(after)).toBe(0);
      expect((await recorded(after)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
      await migrateWith(both).migrate();
      const books = migratorConnection(connectionsOf([]));
      await sql`create trigger refuse_clear before delete on migration_interruption for each row signal sqlstate '45000' set message_text = 'clear refused'`.execute(books);
      await expect(migrateWith(both).rollback()).rejects.toThrow(/clear refused/);
      expect(await counterN(after)).toEqual([100]);
      expect((await recorded(after)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table', '2026_05_09_000000_multiply_and_divide']);
      expect(await markerRows(after)).toBe(0);
    });

    it('reports an interrupted migration through `migrate`', async () => {
      await migrateWith([counter]).migrate();
      const say = () => {
        const printed: string[] = [];
        const line = (kind: string) => (text: string) => void printed.push(`${kind}: ${text}`);
        const output = { line: line('line'), info: line('info'), success: line('success'), warn: line('warn'), error: line('error'), table: () => {} };
        return { printed, input: { options: { force: true }, output, root: '/' } as unknown as CommandInput };
      };
      const migrate = say();
      await expect(new MigrateCommand(migratorOf([counter, halfway]).migrator, {} as TypeGenerator).handle(migrate.input)).rejects.toThrow(/Duplicate column name/);
      expect(migrate.printed.filter((line) => line.startsWith('error:'))).toEqual([
        'error: Migration 2026_05_02_000000_multiply_then_fail (module "halfway") stopped during its up() on the database connection "default" and is marked as not finished: every query of a process that starts is refused, and `migrate` (without `--interrupted`), `migrate:rollback` and `migrate:reset` run no migration, until you resolve that: undo what it did and run "marmeon migrate --interrupted=retry", or finish it by hand and run "marmeon migrate --interrupted=done". See docs/migrations.md#a-migration-that-stopped-halfway.',
      ]);
    });

    it('reports an interrupted migration through `migrate:fresh` too', async () => {
      const printed: string[] = [];
      const output = { line() {}, info() {}, success() {}, warn() {}, error: (text: string) => void printed.push(text), table() {} };
      const input = { options: { force: true }, output, root: '/' } as unknown as CommandInput;
      await expect(new MigrateFreshCommand(migratorOf([counter, halfway]).migrator, {} as TypeGenerator, {} as never).handle(input)).rejects.toThrow(/Duplicate column name/);
      expect(printed).toEqual([expect.stringMatching(/^Migration 2026_05_02_000000_multiply_then_fail \(module "halfway"\) stopped during its up\(\)/)]);
    });

    it.each([
      ['migrate:rollback', MigrateRollbackCommand],
      ['migrate:reset', MigrateResetCommand],
    ])('reports an interrupted down() through %s', async (_name, Command) => {
      await migrateWith([gadgets]).migrate();
      const printed: string[] = [];
      const output = { line() {}, info() {}, success() {}, warn() {}, error: (text: string) => void printed.push(text), table() {} };
      const input = { options: { force: true }, output, root: '/' } as unknown as CommandInput;
      await expect(new Command(migratorOf([gadgets]).migrator).handle(input)).rejects.toThrow(/no_such_table/);
      expect(printed).toEqual([expect.stringMatching(/^Migration 2026_05_03_000000_create_gadgets_table \(module "down"\) stopped during its down\(\) on the database connection "default" and is marked/)]);
    });
  });

  describe('migrate --interrupted', () => {
    const counter = moduleOf('counter');
    const flaky = moduleOf('flaky');
    const widgets = moduleOf('create');
    const later = moduleOf('later');
    const early = moduleOf('early');
    const quiet = moduleOf('quiet');
    const halfway = moduleOf('halfway');
    const gadgets = moduleOf('down');
    const FLAKY = '2026_05_12_000000_multiply_then_maybe_fail';
    const GADGETS = '2026_05_03_000000_create_gadgets_table';
    const look = (connections: Connections) => inspectionConnection(connections);
    const hasTable = async (connections: Connections, table: string) => (await catalog(connections)).includes(table);
    const counterN = async (connections: Connections) => (await sql<{ n: number }>`select n from counter`.execute(look(connections))).rows.map((row) => Number(row.n));
    const markers = (connections: Connections) => migratorConnection(connections).selectFrom('migration_interruption').selectAll().execute();
    const migratorOf = (modules: ModuleDefinition[]) => {
      const connections = connectionsOf(modules);
      return { connections, migrator: new Migrator(appOf(modules), connections) };
    };
    const failing = (on: boolean) => {
      (globalThis as { interruptionFails?: boolean }).interruptionFails = on;
      onTestFinished(() => void delete (globalThis as { interruptionFails?: boolean }).interruptionFails);
    };
    /** What a command prints, and the input that makes it print there. */
    const inputOf = (options: Record<string, unknown>) => {
      const printed: string[] = [];
      const line = (kind: string) => (text: string) => void printed.push(`${kind}: ${text}`);
      const output = { line: line('line'), info: line('info'), success: line('success'), warn: line('warn'), error: line('error'), table: () => {}, json: (value: unknown) => void printed.push(`json: ${JSON.stringify(value)}`) };
      return { printed, input: { options, output, root: '/' } as unknown as CommandInput };
    };
    const run = (migrator: Migrator, options: Record<string, unknown>) => {
      const { printed, input } = inputOf(options);
      return new MigrateCommand(migrator, {} as TypeGenerator).handle(input).then((exit) => ({ exit, printed }));
    };

    /** The state a failed `up()` leaves: n at 100, the marker of the flaky migration (batch 2), the migration not recorded. */
    async function failedUp() {
      await migrateWith([counter]).migrate();
      failing(true);
      await expect(migratorOf([counter, flaky]).migrator.migrate()).rejects.toThrow(/no_such_table/);
      failing(false);
    }
    /** The state a failed `down()` leaves: `gizmos` dropped, `gadgets` there, the marker of direction down, the record row still in place. */
    async function failedDown() {
      await migrateWith([gadgets]).migrate();
      await expect(migratorOf([gadgets]).migrator.rollback()).rejects.toThrow(/no_such_table/);
    }

    it('retries an up(): the marker is gone, the migration ran again once and is recorded, and the rows are changed once', async () => {
      await failedUp();
      const { connections, migrator } = migratorOf([counter, flaky]);
      expect(await counterN(connections)).toEqual([100]);
      // Undone by hand: the data step of the failed run committed its rows.
      await sql`update counter set n = 1`.execute(look(connections));
      const { exit, printed } = await run(migrator, { interrupted: 'retry' });
      expect(exit).toBe(0);
      expect(printed).toContain(`info: ${FLAKY} is run again if the checks pass; each row stays until its migration starts.`);
      expect(printed.some((line) => line.startsWith(`success: Migrated ${FLAKY} (flaky)`))).toBe(true);
      expect(await markers(connections)).toEqual([]);
      expect((await migrator.status()).map((entry) => [entry.name, entry.batch])).toEqual([['2026_05_01_000000_create_counter_table', 1], [FLAKY, 2]]);
      expect(await counterN(connections)).toEqual([100]);
    });

    it('marks an up() as done: the record has the batch of the marker and the checksum of the file as it is now, in the same transaction as the marker, and the pending migrations wait', async () => {
      await failedUp();
      const { connections, migrator } = migratorOf([counter, flaky, auth]);
      const file = migrator.files().find((entry) => entry.name === FLAKY)!;
      const { exit, printed } = await run(migrator, { interrupted: 'done' });
      expect(exit).toBe(0);
      expect(printed.filter((line) => line.startsWith('success:'))).toEqual([`success: Recorded ${FLAKY} (flaky) as ran in batch 2, with the checksum of its file as it is now. Run migrate for the migrations that are pending.`]);
      expect(await markers(connections)).toEqual([]);
      const row = await migratorConnection(connections).selectFrom('migrations').selectAll().where('name', '=', FLAKY).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ module: 'flaky', batch: 2, checksum: migrationChecksum(readFileSync(file.path)) });
      expect(await counterN(connections)).toEqual([100]);
      expect(await hasTable(connections, 'users')).toBe(false);
      expect((await migrator.status()).find((entry) => entry.name === FLAKY)!.batch).toBe(2);
    });

    it('records nothing when the marker cannot be deleted: `done` is one transaction', async () => {
      await failedUp();
      const books = migratorConnection(connectionsOf([]));
      await sql`create trigger refuse_clear before delete on migration_interruption for each row signal sqlstate '45000' set message_text = 'clear refused'`.execute(books);
      const { connections, migrator } = migratorOf([counter, flaky]);
      await expect(run(migrator, { interrupted: 'done' })).rejects.toThrow(/clear refused/);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
      expect(await markers(connections)).toHaveLength(1);
    });

    it('resolves a down() as done: the record row and the marker are gone, and the pending migrations of other modules did not run', async () => {
      await failedDown();
      const { connections, migrator } = migratorOf([gadgets, auth]);
      await sql`drop table gadgets`.execute(look(connections));
      const { exit, printed } = await run(migrator, { interrupted: 'done' });
      expect(exit).toBe(0);
      expect(printed.filter((line) => line.startsWith('success:'))).toEqual([`success: Recorded ${GADGETS} (down) as rolled back.`]);
      expect(await markers(connections)).toEqual([]);
      expect(await recorded(connections)).toEqual([]);
      expect(await hasTable(connections, 'users')).toBe(false);
      expect(await hasTable(connections, 'gadgets')).toBe(false);
    });

    it('keeps the record row when the marker cannot be deleted after a down(): `done` is one transaction there too', async () => {
      await failedDown();
      const books = migratorConnection(connectionsOf([]));
      await sql`create trigger refuse_clear before delete on migration_interruption for each row signal sqlstate '45000' set message_text = 'clear refused'`.execute(books);
      const { connections, migrator } = migratorOf([gadgets]);
      await expect(run(migrator, { interrupted: 'done' })).rejects.toThrow(/clear refused/);
      expect((await recorded(connections)).map((row) => row.name)).toEqual([GADGETS]);
      expect(await markers(connections)).toHaveLength(1);
    });

    it('resolves a down() as retry: the marker is gone, the record row stays, and nothing else ran', async () => {
      await failedDown();
      const { connections, migrator } = migratorOf([gadgets, auth]);
      await sql`create table gizmos (id bigint primary key)`.execute(look(connections));
      const { exit, printed } = await run(migrator, { interrupted: 'retry' });
      expect(exit).toBe(0);
      expect(printed.filter((line) => line.startsWith('success:'))).toEqual([`success: ${GADGETS} (down) counts as ran again; run migrate:rollback to roll it back.`]);
      expect(await markers(connections)).toEqual([]);
      expect((await recorded(connections)).map((row) => row.name)).toEqual([GADGETS]);
      expect(await hasTable(connections, 'users')).toBe(false);
      // The rollback is allowed again: it reaches the down() (which fails by design) instead of being refused.
      expect((await failure(() => migrator.rollback())) as Error).toMatchObject({ message: expect.stringMatching(/no_such_table/) });
    });

    it('takes the migration lock: a resolution that finds it held waits, gives up and changes nothing', async () => {
      await failedUp();
      const holder = migratorOf([counter, flaky]).migrator;
      const { connections, migrator } = migratorOf([counter, flaky]);
      await holder.locked(async () => {
        migrator.lockWith({ waitSeconds: 0 });
        expect(await failure(() => migrator.resolveInterruption('done'))).toBeInstanceOf(MigrationLockTimeoutError);
      });
      expect(await markers(connections)).toHaveLength(1);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
    });

    it('refuses a value that is not retry or done before it reads anything, and leaves the marker', async () => {
      await failedUp();
      const { connections, migrator } = migratorOf([counter, flaky]);
      await expect(run(migrator, { interrupted: 'maybe' })).rejects.toBeInstanceOf(CommandArgumentsError);
      await expect(run(migrator, { interrupted: 'maybe' })).rejects.toThrow('--interrupted must be retry or done.');
      expect(await markers(connections)).toHaveLength(1);
    });

    it('says there is nothing to resolve without a marker, exits 1 and migrates nothing', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, auth]);
      for (const how of ['retry', 'done']) {
        const { exit, printed } = await run(migrator, { interrupted: how });
        expect(exit).toBe(1);
        expect(printed).toContain('error: Nothing to resolve: no migration of the database connection "default" stopped halfway (only MySQL marks one). Nothing was migrated.');
      }
      expect(await hasTable(connections, 'users')).toBe(false);
    });

    it('asks for --force in a protected environment, like the other destructive flags, and leaves the marker', async () => {
      await failedUp();
      vi.stubEnv('NODE_ENV', 'production');
      onTestFinished(() => void vi.unstubAllEnvs());
      const { connections, migrator } = migratorOf([counter, flaky]);
      const refused = await run(migrator, { interrupted: 'done' });
      expect(refused.exit).toBe(1);
      expect(refused.printed.some((line) => line.startsWith('error: The application is protected') && line.includes('Pass --force to resolve the interrupted migration'))).toBe(true);
      expect(await markers(connections)).toHaveLength(1);
      expect((await run(migrator, { interrupted: 'done', force: true })).exit).toBe(0);
      expect(await markers(connections)).toEqual([]);
    });

    it('refuses a direction this release does not know with D1 and changes nothing', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, flaky]);
      await mark(connections, { name: FLAKY, module: 'flaky', direction: 'side' });
      for (const how of ['retry', 'done'] as const) {
        const error = await failure(() => migrator.resolveInterruption(how));
        expect(error).toBeInstanceOf(MigrationStateError);
        expect(error).toMatchObject({ reason: 'newer' });
        expect((error as Error).message).toMatch(/^\[marmeon:D1\] The marker of migration 2026_05_12_000000_multiply_then_maybe_fail names the direction "side"/);
      }
      expect(await markers(connections)).toHaveLength(1);
    });

    it('refuses `done` and `retry` after an up() whose file is gone with D32, and keeps the marker', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter]);
      await mark(connections, { name: FLAKY, module: 'flaky' });
      const error = await failure(() => migrator.resolveInterruption('done'));
      expect(error).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message).toMatch(/^\[marmeon:D32\] Migration 2026_05_12_000000_multiply_then_maybe_fail \(module "flaky"\) has no file in any module/);
      expect(await markers(connections)).toHaveLength(1);
      expect(await recorded(connections)).toHaveLength(1);
      const retried = await failure(() => migrator.resolveInterruption('retry'));
      expect(retried).toMatchObject({ reason: 'interrupted' });
      expect((retried as Error).message).toMatch(/has no file in any module/);
      expect(await markers(connections)).toHaveLength(1);
      // With the file, `retry` of an up() deletes nothing: the row goes when the migration starts again.
      expect(await migratorOf([counter, flaky]).migrator.resolveInterruption('retry')).toMatchObject({ name: FLAKY });
      expect(await markers(connections)).toHaveLength(1);
    });

    it('lets a process that starts afterwards query again once the marker is resolved', async () => {
      await failedUp();
      const { migrator } = migratorOf([counter, flaky]);
      expect(await failure(() => select(connectionsOf([counter, flaky]), 'counter'))).toMatchObject({ reason: 'interrupted' });
      await migrator.resolveInterruption('done');
      expect(await select(connectionsOf([counter, flaky]), 'counter')).toHaveLength(1);
    });

    it('records the batch the marker names, not a batch of its own', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, flaky]);
      await mark(connections, { name: FLAKY, module: 'flaky', batch: 7 });
      expect((await run(migrator, { interrupted: 'done' })).exit).toBe(0);
      expect(await recorded(connections)).toEqual([expect.objectContaining({ batch: 1 }), { name: FLAKY, batch: 7 }]);
    });

    it('refuses `done` while the schema the migration makes is not there, and records it once it is', async () => {
      await migrateWith([counter]).migrate();
      failing(false);
      const { connections, migrator } = migratorOf([counter, halfway]);
      await expect(migrator.migrate()).rejects.toThrow(/Duplicate column name 'note'/);
      // Undone by hand, although `done` says it was finished.
      await sql`alter table counter drop column note`.execute(look(connections));
      const error = await failure(() => migrator.resolveInterruption('done'));
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as Error).message).toMatch(/^\[marmeon:D3\] Migration 2026_05_02_000000_multiply_then_fail \(module "halfway"\) is not done: the database connection "default" lacks the column counter\.note/);
      expect((error as Error).message).toContain('Nothing was changed.');
      expect(await markers(connections)).toHaveLength(1);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
      await sql`alter table counter add column note varchar(10)`.execute(look(connections));
      expect(await migrator.resolveInterruption('done')).toMatchObject({ name: '2026_05_02_000000_multiply_then_fail' });
      expect(await markers(connections)).toEqual([]);
    });

    it('refuses `done` after a down() while a table that must remain is gone', async () => {
      await migrateWith([counter, gadgets]).migrate();
      await expect(migratorOf([counter, gadgets]).migrator.rollback()).rejects.toThrow(/no_such_table/);
      const { connections, migrator } = migratorOf([counter, gadgets]);
      await sql`drop table gadgets`.execute(look(connections));
      await sql`drop table counter`.execute(look(connections));
      const error = await failure(() => migrator.resolveInterruption('done'));
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as Error).message).toContain('lacks the table counter');
      expect(await markers(connections)).toHaveLength(1);
      expect(await recorded(connections)).toHaveLength(2);
    });

    it('refuses a record with other columns with D1, for retry and for done, and changes nothing', async () => {
      await failedUp();
      await sql`alter table migrations add column extra integer`.execute(migratorConnection(connectionsOf([])));
      const { connections, migrator } = migratorOf([counter, flaky]);
      for (const how of ['retry', 'done'] as const) {
        const error = await failure(() => migrator.resolveInterruption(how));
        expect(error, how).toMatchObject({ reason: 'newer' });
        expect((error as Error).message, how).toMatch(/^\[marmeon:D1\] /);
      }
      expect(await markers(connections)).toHaveLength(1);
    });

    it('keeps the row of a retried up() while a table the migration creates is still there, and replaces it when the run starts', async () => {
      await migrateWith([counter]).migrate();
      failing(true);
      await expect(migratorOf([counter, widgets]).migrator.migrate()).rejects.toThrow(/no_such_table/);
      failing(false);
      const { connections, migrator } = migratorOf([counter, widgets]);
      expect(await hasTable(connections, 'widgets')).toBe(true);
      const refused = await run(migrator, { interrupted: 'retry' }).then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(SchemaError);
      expect((refused as Error).message).toMatch(/^\[marmeon:D3\] The database connection "default" already has the table widgets/);
      expect(await markers(connections)).toHaveLength(1);
      expect(await recorded(connections)).toHaveLength(1);
      await sql`drop table widgets`.execute(look(connections));
      const { exit } = await run(migratorOf([counter, widgets]).migrator, { interrupted: 'retry' });
      expect(exit).toBe(0);
      expect(await markers(connections)).toEqual([]);
      expect(await hasTable(connections, 'widgets')).toBe(true);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table', '2026_05_13_000000_create_widgets_then_maybe_fail']);
    });

    it('runs the other pending migrations around the retried one in the order of their names, and the row survives until its own turn', async () => {
      await failedUp();
      await sql`update counter set n = 1`.execute(look(connectionsOf([])));
      const { connections, migrator } = migratorOf([counter, auth, flaky, later]);
      const { exit, printed } = await run(migrator, { interrupted: 'retry' });
      expect(exit).toBe(0);
      expect(printed.filter((line) => line.startsWith('success: Migrated')).map((line) => line.split(' ')[2])).toEqual(['2026_01_01_000000_create_users_table', FLAKY, '2026_05_20_000000_create_later_table']);
      expect(await markers(connections)).toEqual([]);
    });

    it('refuses `retry` with D32 when the retried migration is recorded already, and runs nothing', async () => {
      await failedUp();
      const { connections, migrator } = migratorOf([counter, flaky, auth]);
      await migratorConnection(connections).insertInto('migrations').values({ name: FLAKY, module: 'flaky', batch: 2, checksum: null }).execute();
      const error = await run(migrator, { interrupted: 'retry' }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message).toMatch(/^\[marmeon:D32\] Migration 2026_05_12_000000_multiply_then_maybe_fail \(module "flaky"\) is recorded as ran/);
      expect(await markers(connections)).toHaveLength(1);
      expect(await hasTable(connections, 'users')).toBe(false);
    });

    it('refuses a run with D32 and runs nothing when a migration it is to retry is not pending, whatever else is pending', async () => {
      await failedUp();
      const { connections, migrator } = migratorOf([counter, flaky, auth]);
      const row = (await markers(connections))[0]!;
      await migratorConnection(connections).insertInto('migrations').values({ name: FLAKY, module: 'flaky', batch: 2, checksum: null }).execute();
      const error = await failure(() => migrator.migrate({ retrying: [{ name: row.name, startedAt: row.started_at }] }));
      expect(error).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message).toMatch(/^\[marmeon:D32\] Migration 2026_05_12_000000_multiply_then_maybe_fail is not pending .* Nothing was run\./);
      expect(await markers(connections)).toHaveLength(1);
      expect(await hasTable(connections, 'users')).toBe(false);
    });

    const COUNTER = '2026_05_01_000000_create_counter_table';
    it.each([
      ['a row of a down()', { name: COUNTER, module: 'counter', direction: 'down' }, /^\[marmeon:D32\] Migration 2026_05_01_000000_create_counter_table \(module "counter"\) stopped during its down\(\)/],
      ['a row of a migration that is recorded', { name: COUNTER, module: 'counter', direction: 'up' }, /^\[marmeon:D32\] Migration 2026_05_01_000000_create_counter_table \(module "counter"\) is recorded as ran/],
    ])('refuses `retry` beside %s, even when the retried row is the oldest, and keeps both rows', async (_name, other, message) => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, flaky, auth]);
      await mark(connections, { name: FLAKY, module: 'flaky', started_at: '2026-11-27T10:00:00.000Z' });
      await mark(connections, { ...other, started_at: '2026-11-27T11:00:00.000Z' });
      const error = await run(migrator, { interrupted: 'retry' }).then(() => undefined, (caught: unknown) => caught);
      expect(error).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message).toMatch(message);
      expect((await markers(connections)).map((row) => row.name).sort()).toEqual([COUNTER, FLAKY].sort());
      expect(await hasTable(connections, 'users')).toBe(false);
      expect((await recorded(connections)).map((row) => row.name)).toEqual([COUNTER]);
    });

    it('refuses a run that retries only some of the rows: the run takes the list it was given and no more', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, flaky, auth]);
      await mark(connections, { name: FLAKY, module: 'flaky', started_at: '2026-11-27T10:00:00.000Z' });
      await mark(connections, { name: ACCOUNTS, module: 'accounts', started_at: '2026-11-27T11:00:00.000Z' });
      const error = await failure(() => migrator.migrate({ retrying: [{ name: FLAKY, startedAt: '2026-11-27T10:00:00.000Z' }] }));
      expect(error).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message).toMatch(/^\[marmeon:D32\] Migration 2026_01_05_000000_create_accounts_table /);
      expect(await markers(connections)).toHaveLength(2);
      expect(await hasTable(connections, 'users')).toBe(false);
    });

    it('lets a second retry take both rows when a migration that sorts first stopped during the first one', async () => {
      await migrateWith([counter]).migrate();
      failing(true);
      await expect(migratorOf([counter, flaky]).migrator.migrate()).rejects.toThrow(/no_such_table/);
      // The retry starts `early` first, which sorts before the flaky migration and stops too: its row joins the first one.
      await expect(run(migratorOf([counter, early, flaky]).migrator, { interrupted: 'retry' })).rejects.toThrow(/no_such_table/);
      const { connections, migrator } = migratorOf([counter, early, flaky]);
      expect((await markers(connections)).map((row) => row.name).sort()).toEqual(['2026_05_11_000000_create_early_then_maybe_fail', FLAKY]);
      // Both undone by hand.
      await sql`drop table early`.execute(look(connections));
      await sql`update counter set n = 1`.execute(look(connections));
      failing(false);
      const { exit, printed } = await run(migrator, { interrupted: 'retry' });
      expect(exit).toBe(0);
      expect(printed.filter((line) => line.startsWith('success: Migrated')).map((line) => line.split(' ')[2])).toEqual(['2026_05_11_000000_create_early_then_maybe_fail', FLAKY]);
      expect(await markers(connections)).toEqual([]);
      expect(await counterN(connections)).toEqual([100]);
    });

    it('judges the record before the marker for rollback and reset: other columns and no table of interruptions is D1, not D32', async () => {
      await migrateWith([counter]).migrate();
      const books = migratorConnection(connectionsOf([]));
      await sql`alter table migrations add column extra integer`.execute(books);
      await sql`drop table migration_interruption`.execute(books);
      for (const command of ['rollback', 'reset'] as const) {
        const error = await failure(() => migratorOf([counter]).migrator[command]());
        expect(error, command).toMatchObject({ reason: 'newer' });
        expect((error as Error).message, command).toMatch(/^\[marmeon:D1\] /);
      }
    });

    it('refuses an argument that is neither retry nor done, and leaves the marker', async () => {
      await failedUp();
      const { connections, migrator } = migratorOf([counter, flaky]);
      await expect(migrator.resolveInterruption('maybe' as never)).rejects.toBeInstanceOf(TypeError);
      expect(await markers(connections)).toHaveLength(1);
      expect((await recorded(connections)).map((row) => row.name)).toEqual([COUNTER]);
    });

    it('takes the row only as it was read: the same name started at another time refuses the run', async () => {
      await failedUp();
      const { connections, migrator } = migratorOf([counter, flaky]);
      const read = (await migrator.resolveInterruption('retry'))!;
      await migratorConnection(connections).deleteFrom('migration_interruption').execute();
      await mark(connections, { name: FLAKY, module: 'flaky', started_at: '2026-11-27T12:00:00.000Z' });
      const error = await failure(() => migrator.migrate({ retrying: read.retrying }));
      expect(error).toMatchObject({ reason: 'interrupted' });
      expect(await markers(connections)).toHaveLength(1);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
    });

    it('ignores a `retrying` whose row is gone: a plain migrate, with nothing pending and no refusal', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter]);
      expect(await migrator.migrate({ retrying: [{ name: '2026_05_01_000000_create_counter_table', startedAt: '2026-11-27T10:00:00.000Z' }] })).toEqual([]);
      expect(await markers(connections)).toEqual([]);
    });

    it('deletes the row of a retried migration that sends MySQL no statement, with its record', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, quiet]);
      await mark(connections, { name: '2026_05_14_000000_say_nothing', module: 'quiet', batch: 2 });
      expect((await run(migrator, { interrupted: 'retry' })).exit).toBe(0);
      expect(await markers(connections)).toEqual([]);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table', '2026_05_14_000000_say_nothing']);
    });

    it('refuses `retry` after a down() while what it dropped is still gone, and resolves it once that is back', async () => {
      await failedDown();
      const { connections, migrator } = migratorOf([gadgets]);
      const error = await failure(() => migrator.resolveInterruption('retry'));
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as Error).message).toMatch(/^\[marmeon:D3\] Migration 2026_05_03_000000_create_gadgets_table \(module "down"\) is not undone: the database connection "default" lacks the table gizmos/);
      expect((error as Error).message).toContain('Nothing was changed.');
      expect(await markers(connections)).toHaveLength(1);
      await sql`create table gizmos (id bigint primary key)`.execute(look(connections));
      expect(await migrator.resolveInterruption('retry')).toMatchObject({ direction: 'down' });
      expect(await markers(connections)).toEqual([]);
      expect(await recorded(connections)).toHaveLength(1);
    });

    it.each([
      ['retry', 'up'],
      ['retry', 'down'],
      ['done', 'up'],
      ['done', 'down'],
    ] as const)('refuses `%s` after an %s() when the file runs on another connection than the row says, and changes nothing', async (how, direction) => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, flaky]);
      await mark(connections, { name: FLAKY, module: 'flaky', connection_name: 'system', direction });
      const error = await failure(() => migrator.resolveInterruption(how));
      expect(error).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message).toMatch(/^\[marmeon:D32\] The row of migration 2026_05_12_000000_multiply_then_maybe_fail \(module "flaky"\) says it ran on the database connection "system", and its file runs on "default" now/);
      expect(await markers(connections)).toHaveLength(1);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
    });

    it('resolves one row per call, the one that started first, and leaves the other', async () => {
      await migrateWith([counter]).migrate();
      const { connections, migrator } = migratorOf([counter, flaky]);
      await mark(connections, { name: FLAKY, module: 'flaky', started_at: '2026-11-27T10:00:00.000Z' });
      await mark(connections, { name: '2026_05_01_000000_create_counter_table', module: 'counter', direction: 'down', started_at: '2026-11-27T11:00:00.000Z' });
      expect(await migrator.resolveInterruption('done')).toMatchObject({ name: FLAKY });
      expect((await markers(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
      expect(await migrator.resolveInterruption('retry')).toMatchObject({ name: '2026_05_01_000000_create_counter_table', direction: 'down' });
      expect(await markers(connections)).toEqual([]);
    });

    it('changes nothing when the lock is lost before the resolution: no record, the marker stays', async () => {
      await failedUp();
      const killer = connectionsOf([]);
      const { connections, migrator } = migratorOf([counter, flaky]);
      const error = await failure(() =>
        migrator.locked(async () => {
          const [killed] = (
            await sql<{ id: string }>`select a.processlist_id as id from performance_schema.session_connect_attrs a join information_schema.processlist p on p.id = a.processlist_id where a.attr_name = 'program_name' and a.attr_value like 'marmeon-migrate:%' and p.db = database() and a.processlist_id <> connection_id()`.execute(look(killer))
          ).rows;
          await sql.raw(`kill ${killed!.id}`).execute(look(killer));
          await pause(300);
          return migrator.resolveInterruption('done');
        }),
      );
      expect(error).toBeInstanceOf(MigrationLockLostError);
      expect(await markers(connections)).toHaveLength(1);
      expect((await recorded(connections)).map((row) => row.name)).toEqual(['2026_05_01_000000_create_counter_table']);
    });

    it('does not resolve while the types file is of a newer Marmeon for retry, which migrates, and resolves for done, which does not', async () => {
      await failedUp();
      vi.stubEnv('NODE_ENV', 'development');
      onTestFinished(() => void vi.unstubAllEnvs());
      const { connections, migrator } = migratorOf([counter, flaky]);
      const generator = { fileFormat: () => 'newer', path: '/app/bootstrap/database.d.ts', relationsRefusal: async () => undefined } as unknown as TypeGenerator;
      const go = (options: Record<string, unknown>) => {
        const { printed, input } = inputOf({ ...options, 'no-types': false });
        return new MigrateCommand(migrator, generator).handle(input).then((exit) => ({ exit, printed }));
      };
      const retried = await go({ interrupted: 'retry' });
      expect(retried.exit).toBe(1);
      expect(retried.printed.some((line) => line.includes('[marmeon:D7]'))).toBe(true);
      expect(await markers(connections)).toHaveLength(1);
      expect((await go({ interrupted: 'done' })).exit).toBe(0);
      expect(await markers(connections)).toEqual([]);
    });

    it('fails migrate:status with D32 when the role sees the record and not migration_interruption', async () => {
      await migrateWith([counter]).migrate();
      await sql`drop table migration_interruption`.execute(migratorConnection(connectionsOf([])));
      const { input } = inputOf({ json: true });
      const error = await failure(() => new MigrateStatusCommand(migratorOf([counter]).migrator).handle(input));
      expect(error).toMatchObject({ reason: 'interrupted' });
      expect((error as Error).message).toMatch(/^\[marmeon:D32\] The database connection "default" has the record of migrations/);
    });

    it('shows the marker in migrate:status: the key `interrupted` in the document, null without one, and a warning in the text', async () => {
      await migrateWith([counter]).migrate();
      const status = async (migrator: Migrator, options: Record<string, unknown>) => {
        const { printed, input } = inputOf(options);
        await new MigrateStatusCommand(migrator).handle(input);
        return printed;
      };
      const quiet = migratorOf([counter, flaky]).migrator;
      expect(JSON.parse((await status(quiet, { json: true }))[0]!.slice('json: '.length))).toMatchObject({ format: 1, interrupted: null });
      failing(true);
      await expect(migratorOf([counter, flaky]).migrator.migrate()).rejects.toThrow(/no_such_table/);
      const left = migratorOf([counter, flaky]).migrator;
      const document = JSON.parse((await status(left, { json: true }))[0]!.slice('json: '.length));
      expect(document).toMatchObject({ format: 1, warnings: [], interrupted: { name: FLAKY, module: 'flaky', direction: 'up', startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/) } });
      expect(Object.keys(document.interrupted).sort()).toEqual(['direction', 'module', 'name', 'startedAt']);
      expect((await status(left, {})).some((line) => line.startsWith(`warn: ${FLAKY} started its up() at `) && line.includes('--interrupted=retry|done'))).toBe(true);
    });
  });

  describe('a MySQL connection beside a default that is not MySQL', () => {
    it('is refused with D29 before anything runs, by migrate and by fresh, which drops nothing', async () => {
      const file = join(tempDir('marmeon-interruption-'), 'default.sqlite');
      const connections = new Connections({ connections: { default: { driver: 'sqlite', database: file }, system: options }, root, logger: silent, app: appOf([auth, moduleOf('system')]) });
      opened.push(connections);
      const books = migratorConnection(connections);
      await createMigrationsTable(books, 'sqlite');
      await sql`create table keepsake (id integer)`.execute(books);
      const migrator = new Migrator(appOf([auth, moduleOf('system')]), connections);
      const error = await failure(() => migrator.migrate());
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toMatch(/^\[marmeon:D29\] Migration 2026_05_06_000000_create_audit_table \(module "system"\) runs on the MySQL connection "system", and "default" is sqlite: /);
      expect((error as Error).message).toContain('Nothing was run.');
      const fresh = await failure(() => migrator.fresh());
      expect(fresh).toBeInstanceOf(UnsupportedDriverError);
      expect((fresh as Error).message).toContain('Nothing was dropped.');
      expect((await sql<{ name: string }>`select name from sqlite_master where name = 'keepsake'`.execute(books)).rows).toHaveLength(1);
      expect(await catalog(connectionsOf([]))).toEqual(['migration_interruption', 'migrations']);
    });

    it.each(['rollback', 'reset'] as const)('is refused with D29 by %s before its down() runs, and the record stays', async (command) => {
      const file = join(tempDir('marmeon-interruption-'), 'default.sqlite');
      const modules = [moduleOf('system')];
      const connections = new Connections({ connections: { default: { driver: 'sqlite', database: file }, system: options }, root, logger: silent, app: appOf(modules) });
      opened.push(connections);
      const books = migratorConnection(connections);
      await createMigrationsTable(books, 'sqlite');
      await books.insertInto('migrations').values({ name: '2026_05_06_000000_create_audit_table', module: 'system', batch: 1, checksum: null }).execute();
      await sql`create table keepsake (id integer)`.execute(books);
      const error = await failure(() => new Migrator(appOf(modules), connections)[command]());
      expect(error).toBeInstanceOf(UnsupportedDriverError);
      expect((error as Error).message).toMatch(/^\[marmeon:D29\] Migration 2026_05_06_000000_create_audit_table \(module "system"\) runs on the MySQL connection "system", and "default" is sqlite: /);
      expect((error as Error).message).toContain('Nothing was run.');
      expect((await sql<{ name: string }>`select name from migrations`.execute(books)).rows).toEqual([{ name: '2026_05_06_000000_create_audit_table' }]);
      expect((await sql<{ name: string }>`select name from sqlite_master where name = 'keepsake'`.execute(books)).rows).toHaveLength(1);
    });
  });
});
