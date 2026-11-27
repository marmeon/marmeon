import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { printable } from '@marmeon/core/internal';

import { sql } from 'kysely';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appOf as fakeApp, drivers, freshConnections, freshDatabase, silent, withMysql } from './__fixtures__/databases.ts';
import type { ConnectionOptions } from './config.ts';
import { Connections, DatabaseHealthCheck, MigrationStateError, Migrator } from './index.ts';
import { tableColumns } from './introspection.ts';
import { INTERRUPTION_COLUMNS, createMigrationsTable, readInterruption } from './migration-state.ts';
import { migratorConnection } from './migrator-connection.ts';
import { SchemaRequirements } from './schema-requirements.ts';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';

// A row in `migration_interruption` means a migration started and has not finished; the table exists on MySQL only. The MySQL cases run in
// `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL, and are skipped without it; the cases on `drivers` prove that SQLite and Postgres
// keep that name for the app. Every marker row here is written by hand.

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
const accounts: ModuleDefinition = { name: 'accounts', migrations: fixtures('accounts') };
const named: ModuleDefinition = { name: 'named', migrations: fixtures('interruption-name') };

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
      expect((error as Error).message, name).toContain('does not start until that is resolved.');
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
});
