import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ErrorSolutions, type Logger, type ModuleDefinition } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appOf as fakeApp, createLegacyTables, drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import { PAUSE, type Pause } from './__fixtures__/migrations/state-pause/2026_01_31_000000_create_paused_table.ts';
import { inspectionConnection, migratorConnection } from './migrator-connection.ts';
import type { ConnectionOptions } from './config.ts';
import { Connections, DatabaseHealthCheck, MigrationStateError, Migrator, Repository } from './index.ts';
import { dropAllTables } from './migrations/drop-all.ts';
import { databaseSolutions } from './solutions.ts';
import { SchemaRequirements } from './schema-requirements.ts';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
const accounts: ModuleDefinition = { name: 'accounts', migrations: fixtures('accounts') };
const root = workspaceTempDir('marmeon-migration-state-');
const appOf = (modules: ModuleDefinition[]) => fakeApp(modules, root);

const ACCOUNTS = ['2026_01_05_000000_create_accounts_table', '2026_01_06_000000_add_recovery_code_to_accounts_table'];

class Accounts extends Repository<'accounts', any> {
  static table = 'accounts' as const;
}

describe.each(drivers)('what the app does when the database lacks migrations, on %s', (driver) => {
  let options: ConnectionOptions;
  let drop: () => Promise<void>;
  const opened: Connections[] = [];
  const messages: string[] = [];
  const logger = { debug() {}, info: (message: string) => void messages.push(message), warn() {}, error() {}, child: () => logger } as unknown as Logger;

  /** A process of the app whose code has `modules`' migrations. */
  const processOf = (modules: ModuleDefinition[]) => {
    const connections = new Connections({ connections: { default: options }, root, logger, app: appOf(modules) });
    opened.push(connections);
    return connections;
  };
  const migrate = (modules: ModuleDefinition[]) => new Migrator(appOf(modules), processOf(modules)).migrate();
  const select = (connections: Connections, table: string) => connections.get<any>().selectFrom(table).select('id').execute();

  beforeAll(async () => {
    ({ options, drop } =
      driver === 'sqlite'
        ? { options: { driver: 'sqlite', database: join(tempDir('marmeon-migration-state-db-'), 'app.sqlite') }, drop: async () => {} }
        : await freshDatabase(driver));
  });
  beforeEach(async () => {
    messages.length = 0;
    // Every test starts from a database nothing ran on.
    const scratch = new Connections({ connections: { default: options }, root, logger: silent });
    opened.push(scratch);
    await dropAllTables(inspectionConnection(scratch), driver);
  });
  afterAll(async () => {
    for (const connections of opened) await connections.destroy();
    await drop();
  });

  it('refuses every query of a process whose code has migrations the database lacks — a table without secrets as well', async () => {
    await migrate([auth]);
    const behind = processOf([auth, accounts]);
    for (const query of [
      () => select(behind, 'users'),
      () => behind.get<any>().selectFrom('accounts').selectAll().execute(),
      () => sql`select 1`.execute(behind.get()),
      () => new Accounts(behind).query().execute(),
    ]) {
      const error = await query().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MigrationStateError);
      expect(error).toMatchObject({ reason: 'pending', connection: 'default', missing: ACCOUNTS });
      expect((error as Error).message).toMatch(/^\[marmeon:D2\] .*2026_01_05_000000_create_accounts_table.*marmeon migrate/s);
    }
  });

  it('gives a solution for it on the error page: how many migrations are missing, and the command', async () => {
    await migrate([auth]);
    const error = await select(processOf([auth, accounts]), 'users').then(() => undefined, (e: unknown) => e);
    const found = await new ErrorSolutions(databaseSolutions).find(error as Error);
    expect(found.map((solution) => [solution.code, solution.title, solution.command])).toEqual([['D2', 'Run the 2 pending migrations', 'marmeon migrate']]);
  });

  it('is red on readiness with the code, and green once the migrations ran', async () => {
    await migrate([auth]);
    const behind = processOf([auth, accounts]);
    const check = new DatabaseHealthCheck(behind, new SchemaRequirements());
    await expect(check.handle()).rejects.toThrow(/^\[marmeon:D2\] The database connection "default" failed: .*lacks 2 migrations/s);
    await migrate([auth, accounts]);
    await sleep(1100);
    await expect(check.handle()).resolves.toBe('default');
  });

  it('asks the database again within a second of the last time — not on every query', async () => {
    await migrate([auth]);
    const behind = processOf([auth, accounts]);
    for (let attempt = 0; attempt < 5; attempt++) await expect(select(behind, 'users')).rejects.toMatchObject({ reason: 'pending' });
    // `migrate` in another process; this one is ready without a restart, when a second has passed.
    await migrate([auth, accounts]);
    await expect(select(behind, 'users')).rejects.toBeInstanceOf(MigrationStateError);
    await sleep(1100);
    await expect(select(behind, 'users')).resolves.toEqual([]);
    expect([...(behind.metadata().secrets.get('accounts') ?? [])].sort()).toEqual(['password', 'recovery_code', 'totp_secret']);
  });

  it('keeps running when the database has migrations the code does not know, says so once, and knows only what the code was built for', async () => {
    await migrate([auth, accounts]);
    const older = processOf([auth]);
    await expect(select(older, 'users')).resolves.toEqual([]);
    await select(older, 'users');
    expect(messages.filter((message) => message.startsWith('The database has migrations this version of the code does not know'))).toHaveLength(1);
    expect(older.metadata().kinds.has('accounts')).toBe(false);
  });

  it('refuses a record of migrations with other columns — and so do migrate, rollback, status and migrate:fresh', async () => {
    await migrate([auth]);
    const newer = processOf([auth]);
    await sql`alter table migrations add column note varchar(64)`.execute(migratorConnection(newer));
    newer.metadata().reload();
    await expect(select(newer, 'users')).rejects.toMatchObject({ reason: 'newer', message: expect.stringMatching(/^\[marmeon:D1\] .*note/s) });
    for (const run of [(m: Migrator) => m.migrate(), (m: Migrator) => m.rollback(), (m: Migrator) => m.status(), (m: Migrator) => m.fresh()]) {
      await expect(run(new Migrator(appOf([auth]), newer))).rejects.toMatchObject({ reason: 'newer' });
    }
    // migrate:fresh dropped nothing.
    expect((await sql<{ name: string }>`select name from migrations`.execute(migratorConnection(newer))).rows).toHaveLength(1);
  });

  it('refuses a database that has tables and no record of migrations', async () => {
    const scratch = processOf([auth]);
    await sql`create table stranger (id integer primary key)`.execute(inspectionConnection(scratch));
    await expect(select(scratch, 'stranger')).rejects.toMatchObject({ reason: 'unmigrated', message: expect.stringMatching(/^\[marmeon:D1\] .*stranger.*managed: false/s) });
  });

  it('keeps the schema in memory when the connections have no app, and when a migrator hands it over: nothing is written under the root', async () => {
    const alone = workspaceTempDir('marmeon-migration-state-root-');
    const connections = new Connections({ connections: { default: options }, root: alone, logger });
    opened.push(connections);
    await new Migrator(fakeApp([auth, accounts], alone), connections).migrate();
    expect([...connections.metadata().secrets.keys()]).toEqual(['accounts']);
    await select(connections, 'users');
    expect(existsSync(join(alone, '.marmeon'))).toBe(false);
  });

  it('is ready on a database nothing ran on when the code has no migrations', async () => {
    const empty = processOf([]);
    await expect(sql`select 1`.execute(empty.get())).resolves.toBeDefined();
    await expect(select(empty, 'anything')).rejects.not.toBeInstanceOf(MigrationStateError);
  });

  describe('another connection', () => {
    const reportingFile = () => ({ driver: 'sqlite' as const, database: join(tempDir('marmeon-migration-state-reporting-'), 'reporting.sqlite') });
    const twoConnections = (modules: ModuleDefinition[], defaults: ConnectionOptions = options) => {
      const connections = new Connections({ connections: { default: defaults, reporting: reportingFile() }, root, logger, app: appOf(modules) });
      opened.push(connections);
      return connections;
    };

    it('takes the refusal of default: its own database holds no record of migrations', async () => {
      await migrate([auth]);
      const behind = twoConnections([auth, accounts]);
      await expect(sql`select 1`.execute(behind.get('reporting'))).rejects.toMatchObject({ reason: 'pending', missing: ACCOUNTS });
    });

    it('is refused when default is managed: false, because nothing tells which migrations ran', async () => {
      const connections = twoConnections([auth], { ...options, managed: false });
      await expect(sql`select 1`.execute(connections.get('reporting'))).rejects.toMatchObject({ reason: 'unmigrated', connection: 'reporting', message: expect.stringMatching(/^\[marmeon:D1\] .*"default".*managed: false/s) });
    });

    it.runIf(driver === 'sqlite')('does not wait for default while a transaction holds it and the connection holds its own lock', async () => {
      await migrate([auth]);
      const connections = twoConnections([auth]);
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => (inside = resolve));
      let proceed!: () => void;
      const go = new Promise<void>((resolve) => (proceed = resolve));
      // The transaction holds default's one connection; reporting's first query takes reporting's and must not ask default.
      const transaction = connections.transaction(async (trx) => {
        await (trx as any).selectFrom('users').select('id').execute();
        inside();
        await go;
        await sql`select 1`.execute(connections.get('reporting'));
      });
      await entered;
      const first = sql`select 1`.execute(connections.get('reporting'));
      await sleep(100);
      proceed();
      const finished = await Promise.race([Promise.all([transaction, first]).then(() => 'done'), sleep(5000).then(() => 'deadlock')]);
      expect(finished).toBe('done');
    });
  });

  it('lets a data step read a table the same plan created, with its soft-delete mark and secret column', async () => {
    const state = [{ name: 'state', migrations: fixtures('state-data') }];
    const connections = processOf(state);
    await new Migrator(appOf(state), connections).migrate();
    const [seen] = await connections.get<any>().selectFrom('seen').selectAll().execute();
    // One of two rows is visible; the row the step selected leaves out the secret column (id, name, deleted_at).
    expect(seen).toMatchObject({ visible: 1, columns: 3 });
  });

  it.runIf(driver === 'pgsql')('shows the schema before a migration to the other connections of the process while it is open — and does not make them wait', async () => {
    await migrate([auth]);
    const state = [auth, { name: 'paused', migrations: fixtures('state-pause') }];
    const connections = processOf(state);
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const pause: Pause = { entered, released: new Promise<void>((resolve) => (release = resolve)) };
    (globalThis as Record<symbol, Pause | undefined>)[PAUSE] = pause;
    try {
      const migrating = new Migrator(appOf(state), connections).migrate();
      await inside;
      // The transaction is open on one connection of the pool: this query runs on another, with the schema the database has.
      // The migration is held until `release()` below, so a query that waited for it would never answer.
      await select(connections, 'users');
      expect(connections.metadata().softDeletes.has('paused')).toBe(false);
      expect(connections.metadata().fresh).toBe(false);
      release();
      await migrating;
      expect(connections.metadata().softDeletes.has('paused')).toBe(true);
      expect(connections.metadata().fresh).toBe(true);
    } finally {
      delete (globalThis as Record<symbol, Pause | undefined>)[PAUSE];
      release();
    }
  });

  it('is ready with fewer migrations after a rollback, and a process that starts then lacks them', async () => {
    const modules = [auth, accounts];
    const connections = processOf(modules);
    const migrator = new Migrator(appOf(modules), connections);
    await migrator.migrate();
    expect(connections.metadata().kinds.has('accounts')).toBe(true);
    await migrator.rollback({ steps: 2 });
    expect(connections.metadata().kinds.has('accounts')).toBe(false);
    expect(connections.metadata().kinds.has('users')).toBe(true);
    await expect(select(connections, 'users')).resolves.toEqual([]);
    // Another process, started afterwards with the code that still has them.
    await expect(select(processOf(modules), 'users')).rejects.toMatchObject({ reason: 'pending', missing: ACCOUNTS });
  });

  it('hides a secret column the projection marks when the tables of 0.3 beside it are empty — the runtime does not read them', async () => {
    const connections = processOf([auth, accounts]);
    await new Migrator(appOf([auth, accounts]), connections).migrate();
    await createLegacyTables(migratorConnection(connections));
    // A process that starts now: the migration files and the record of migrations, nothing else.
    const started = processOf([auth, accounts]);
    await started.get<any>().insertInto('accounts').values({ email: 'ada@example.com', password: 'hash' }).execute();
    const [row] = await started.get<any>().selectFrom('accounts').selectAll().execute();
    expect(Object.keys(row!)).not.toContain('password');
    expect(Object.keys(row!)).toContain('email');
    await expect(started.get<any>().selectFrom('accounts').select('password').execute()).rejects.toThrow(/\[marmeon:D9\]/);
    expect([...started.metadata().softDeletes]).toEqual(['users']);
  });
});
