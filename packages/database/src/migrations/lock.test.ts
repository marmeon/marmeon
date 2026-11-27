import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drivers, freshConnections, freshDatabase, PGSQL_URL, silent, withMysql } from '../__fixtures__/databases.ts';
import { MigrateCommand, MigrateFreshCommand, MigrateResetCommand, MigrateRollbackCommand } from '../commands/migrate.ts';
import { Connections, MigrationLockLostError, MigrationLockTimeoutError, Migrator } from '../index.ts';
import type { TypeGenerator } from '../types-gen/generator.ts';
import { createMigrationsTable } from '../migration-state.ts';
import { inspectionConnection, migratorConnection } from '../migrator-connection.ts';
import { ADVISORY_KEY, LOCK_TABLE, MigrationLock, mysqlLockName, ownerOf, STALE_AFTER_MS, type LockOptions } from './lock.ts';
import { PAUSE, type Pause } from '../__fixtures__/migrations/state-pause/2026_01_31_000000_create_paused_table.ts';
import { tempDir } from '../../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`../__fixtures__/migrations/${name}/`, import.meta.url);
const auth: ModuleDefinition = { name: 'auth', migrations: fixtures('auth') };
const blog: ModuleDefinition = { name: 'blog', migrations: fixtures('blog') };

const migrator = (connections: Connections) => new Migrator({ modules: [auth, blog], root: '/' } as unknown as Application, connections);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a command prints, and the options it was given. */
function input(options: Record<string, string | boolean> = {}) {
  const printed: string[] = [];
  const say = (kind: string) => (text: string) => void printed.push(`${kind}: ${text}`);
  const output = { line: say('line'), info: say('info'), success: say('success'), warn: say('warn'), error: say('error'), table: () => {} };
  return { printed, input: { options, output, root: '/' } as unknown as CommandInput };
}

/** The lock of `connections`' default connection. */
function lockOf(connections: Connections) {
  const options = connections.options();
  return (extra: Omit<LockOptions, 'driver' | 'url'> = {}) =>
    MigrationLock.acquire(connections.get<any>(), { driver: options.driver, ...(options.driver === 'pgsql' || options.driver === 'mysql' ? { url: options.url } : {}), ...extra });
}

describe.each(drivers)('the migration lock on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  const db = () => connections.get<any>();
  const acquire = (options: Omit<LockOptions, 'driver' | 'url'> = {}) => lockOf(connections)(options);

  beforeAll(async () => ({ connections, close } = await freshConnections(driver)));
  afterAll(() => close());

  it('runs every migration exactly once when two migrators start together, one after the other', async () => {
    const [first, second] = await Promise.all([migrator(connections).migrate(), migrator(connections).migrate()]);
    const names = [...first, ...second].map((run) => run.name).sort();
    expect(names).toEqual([
      '2026_01_01_000000_create_users_table',
      '2026_01_02_000000_create_posts_table',
      '2026_01_03_000000_add_slug_to_posts_table',
    ]);
    expect(first.length === 0 || second.length === 0).toBe(true); // the one that waited found nothing left
    const batches = await db().selectFrom('migrations').select('batch').distinct().execute();
    expect(batches).toHaveLength(1);
  });

  it('refuses at once with --wait=0 and names the holder', async () => {
    const held = await acquire({ owner: 'build-7:4242' });
    try {
      const { printed, input: command } = input({ wait: '0', force: true });
      const exit = await new MigrateCommand(migrator(connections), {} as TypeGenerator).handle(command);
      expect(exit).toBe(1);
      expect(printed.find((line) => line.startsWith('error:'))).toMatch(/^error: \[marmeon:D8\] Another migration has run since \d{4}-\d\d-\d\dT.+ \(build-7:4242\)\./);
      await expect(migrator(connections).lockWith({ waitSeconds: 0 }).migrate()).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await held.release();
    }
    const free = await acquire({ waitSeconds: 0 });
    await free.release();
  });

  it('says when an abandoned lock counts as free', async () => {
    const held = await acquire({ owner: 'build-7:4242' });
    try {
      const message = await acquire({ waitSeconds: 0 }).then(
        () => '',
        (error: Error) => error.message,
      );
      expect(message).toContain(driver === 'sqlite' ? 'counts as abandoned from' : 'free as soon as the database notices');
    } finally {
      await held.release();
    }
  });

  it('waits for the holder to end, then runs', async () => {
    await migrator(connections).rollback({ steps: 1 });
    const held = await acquire();
    const waiting = migrator(connections).lockWith({ waitSeconds: 10 }).migrate();
    let finished = false;
    void waiting.then(() => (finished = true));
    await pause(500);
    expect(finished).toBe(false);
    await held.release();
    expect((await waiting).map((run) => run.name)).toEqual(['2026_01_03_000000_add_slug_to_posts_table']);
  });

  it('makes a rollback wait while a migration runs', async () => {
    const held = await acquire();
    const rolling = migrator(connections).lockWith({ waitSeconds: 10 }).rollback();
    let finished = false;
    void rolling.then(() => (finished = true));
    await pause(500);
    expect(finished).toBe(false);
    expect(await db().selectFrom('migrations').select('name').execute()).toHaveLength(3);
    await held.release();
    expect((await rolling).length).toBeGreaterThan(0);
    await migrator(connections).migrate();
  });

  it.each([
    ['migrate:rollback', (m: Migrator) => new MigrateRollbackCommand(m)],
    ['migrate:reset', (m: Migrator) => new MigrateResetCommand(m)],
    ['migrate:fresh', (m: Migrator) => new MigrateFreshCommand(m, {} as TypeGenerator, {} as never)],
  ])('%s exits with 1 while another migration holds the lock', async (_name, command) => {
    const held = await acquire({ owner: 'other:1' });
    try {
      const { printed, input: given } = input({ wait: '0', force: true });
      expect(await command(migrator(connections)).handle(given)).toBe(1);
      expect(printed.at(-1)).toContain('(other:1)');
    } finally {
      await held.release();
    }
    expect(await db().selectFrom('migrations').select('name').execute()).toHaveLength(3); // nothing was undone or dropped
  });

  it('rejects a --wait that is not a number of seconds', async () => {
    const { input: given } = input({ wait: 'soon', force: true });
    // A wrong call: `marmeon` ends with 2 for this error.
    await expect(new MigrateCommand(migrator(connections), {} as TypeGenerator).handle(given)).rejects.toMatchObject({
      name: 'CommandArgumentsError',
      message: '--wait must be a whole number of seconds, 0 or more.',
    });
  });

  it('keeps the lock across migrate:fresh and lets go at the end', async () => {
    await migrator(connections).fresh();
    const free = await acquire({ waitSeconds: 0 });
    await free.release();
    expect((await db().selectFrom('migrations').select('name').execute()).length).toBe(3);
  });

  it('shows the error of the work, not of letting go after it', async () => {
    const lock = migrator(connections);
    await expect(
      lock.locked(async () => {
        // Whatever makes letting go fail: here SQLite loses its table, Postgres its connection.
        if (driver === 'sqlite') await sql`drop table ${sql.table(LOCK_TABLE)}`.execute(db());
        else await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name like 'marmeon-migrate:%' and datname = current_database() and pid <> pg_backend_pid()`.execute(db());
        throw new Error('the migration failed');
      }),
    ).rejects.toThrow('the migration failed');
    // Hold the lock again afterwards: nothing is left behind.
    await (await acquire({ waitSeconds: 5 })).release();
  });

  it('does not drop anything while another migration holds the lock', async () => {
    await migrator(connections).fresh();
    const held = await acquire({ owner: 'fresh:3' });
    try {
      await migrator(connections).lockWith({ waitSeconds: 0 }).dropAllTables().then(
        () => expect.unreachable('another migration holds the lock'),
        (error: unknown) => expect(error).toBeInstanceOf(MigrationLockTimeoutError),
      );
    } finally {
      await held.release();
    }
    await migrator(connections).dropAllTables();
    await (await acquire({ waitSeconds: 0 })).release();
  });
});

it('carries the code D22 and says what to do', () => {
  expect(new MigrationLockLostError('the connection ended').message).toMatch(/^\[marmeon:D22\] .*look at the database before migrating again/);
});

describe('the SQLite lock row', () => {
  let connections: Connections;
  let close: () => Promise<void>;
  let clock = Date.parse('2026-10-01T12:00:00Z');
  const now = () => new Date(clock);
  const acquire = (options: Omit<LockOptions, 'driver' | 'url' | 'now'> = {}) => lockOf(connections)({ now, ...options });

  beforeAll(async () => ({ connections, close } = await freshConnections('sqlite')));
  afterAll(() => close());

  it('takes over a row nobody refreshed for ten minutes, with the dead holder named', async () => {
    const dead = await acquire({ owner: 'gone:9' });
    clock += STALE_AFTER_MS - 1000;
    await expect(acquire({ waitSeconds: 0 })).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    clock += 2000;
    const taken: string[] = [];
    const lock = await acquire({ waitSeconds: 0, owner: 'new:1', onTakeover: (previous) => taken.push(previous.owner) });
    expect(taken).toEqual(['gone:9']);
    await dead.release(); // no longer the holder: leaves the new row alone
    await expect(acquire({ waitSeconds: 0 })).rejects.toThrow('new:1');
    await lock.release();
  });

  it('writes control characters of the holder out in the timeout message and in the takeover warning', async () => {
    const owner = 'evil\x1b]8;;https://evil.test\x07:1';
    const dead = await acquire({ owner });
    try {
      // Held now: the message names the holder.
      const timeout = await acquire({ waitSeconds: 0 }).catch((error: unknown) => error);
      expect(timeout).toBeInstanceOf(MigrationLockTimeoutError);
      expect((timeout as Error).message).toContain('evil\\u001b]8;;https://evil.test\\u0007:1');
      expect((timeout as Error).message).not.toMatch(/[^\P{Cc}\n]/u);
      expect((timeout as MigrationLockTimeoutError).holder.owner).toBe(owner);
      // Ten minutes later by the real clock, the row counts as abandoned: the command takes it over and says whose it was.
      const stale = new Migrator({ modules: [auth], root: '/' } as unknown as Application, connections);
      vi.spyOn(stale, 'migrate').mockResolvedValue([]);
      const { printed, input: given } = input({ force: true });
      expect(await new MigrateCommand(stale, {} as TypeGenerator).handle(given)).toBe(0);
      const warning = printed.find((line) => line.startsWith('warn:'))!;
      expect(warning).toContain('Took over the migration lock of evil\\u001b]8;;https://evil.test\\u0007:1');
      expect(warning).not.toMatch(/[^\P{Cc}\n]/u);
    } finally {
      await dead.release();
    }
  });

  it('counts a heartbeat as a sign of life', async () => {
    const lock = await acquire({ owner: 'busy:2' });
    clock += STALE_AFTER_MS - 1000;
    await lock.heartbeat();
    clock += STALE_AFTER_MS - 1000;
    await expect(acquire({ waitSeconds: 0 })).rejects.toThrow('busy:2');
    await lock.release();
  });

  it('lets the holder that was taken over find out at its next heartbeat', async () => {
    const slow = await acquire({ owner: 'slow:4' });
    clock += STALE_AFTER_MS + 1000;
    const thief = await acquire({ waitSeconds: 0, owner: 'quick:5' });
    await expect(slow.heartbeat()).rejects.toBeInstanceOf(MigrationLockLostError);
    await expect(slow.heartbeat()).rejects.toThrow('another migration took it over');
    await thief.heartbeat(); // the new holder is fine
    await thief.release();
  });

  it('keeps its row when migrate:fresh drops every table', async () => {
    const running = migrator(connections);
    await running.locked(async () => {
      await running.dropAllTables();
      expect(await connections.get<any>().selectFrom(LOCK_TABLE).select('owner').execute()).toHaveLength(1);
    });
    expect(await connections.get<any>().selectFrom(LOCK_TABLE).select('owner').execute()).toHaveLength(0);
  });

  it('stops a command that lost its lock, with exit code 1 and the reason', async () => {
    const lost = new Migrator({ modules: [auth], root: '/' } as unknown as Application, connections);
    vi.spyOn(lost, 'migrate').mockRejectedValueOnce(new MigrationLockLostError('another migration took it over'));
    const { printed, input: given } = input({ force: true });
    expect(await new MigrateCommand(lost, {} as TypeGenerator).handle(given)).toBe(1);
    expect(printed.at(-1)).toContain('The migration lock was lost: another migration took it over');
  });

  it('takes a lock at once whose process ran on this host and is gone', async () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    const gone = await acquire({ owner: ownerOf(child.pid!) });
    const taken: string[] = [];
    const lock = await acquire({ waitSeconds: 0, owner: 'next:1', onTakeover: (previous) => taken.push(previous.owner) });
    expect(taken).toEqual([ownerOf(child.pid!)]);
    await gone.release();
    await lock.release();
  });

  it('does not trust a pid of another pid namespace, even on the same host name', async () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    const foreign = await acquire({ owner: `${hostname()}:${child.pid}#1` });
    await expect(acquire({ waitSeconds: 0 })).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    await foreign.release();
  });

  it('leaves a lock whose process runs on this host alone', async () => {
    const alive = await acquire({ owner: ownerOf(process.pid) });
    await expect(acquire({ waitSeconds: 0 })).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    await alive.release();
  });

  it('waits for the write lock of another connection to the file instead of failing after the driver’s 5 s', async () => {
    const file = join(tempDir('marmeon-lock-'), 'app.sqlite');
    const options = { driver: 'sqlite', database: file } as const;
    const [one, other] = [1, 2].map(() => new Connections({ connections: { default: options }, root: '/', logger: silent }));
    try {
      await createMigrationsTable(migratorConnection(one!), 'sqlite');
      await sql`create table t (x integer)`.execute(one!.get<any>());
      let waiting: Promise<{ release(): Promise<void> }> | undefined;
      await one!.get<any>().transaction().execute(async (trx) => {
        await sql`insert into t values (1)`.execute(trx);
        // The other connection's first wait for the write lock blocks the thread for the driver's whole 5 s (Node's SQLite is
        // synchronous), then fails with SQLITE_BUSY: the lock keeps waiting instead.
        waiting = lockOf(other!)({ waitSeconds: 30 });
        await pause(1000);
      });
      await (await waiting!).release();
    } finally {
      await one!.destroy();
      await other!.destroy();
    }
  }, 40_000);
});

describe.skipIf(PGSQL_URL === undefined)('the Postgres lock', () => {
  let connections: Connections;
  let close: () => Promise<void>;
  const acquire = (options: Omit<LockOptions, 'driver' | 'url'> = {}) => lockOf(connections)(options);

  beforeAll(async () => ({ connections, close } = await freshConnections('pgsql')));
  afterAll(() => close());

  it('is free again when the holder’s connection ends', async () => {
    // A holder that is not this process: its connection, taken without our code, then ended like a crash would.
    const { default: pg } = await import('pg');
    const holder = new pg.Client({ connectionString: (connections.options() as { url: string }).url });
    await holder.connect();
    await holder.query(`select set_config('application_name', 'marmeon-migrate:crashed:5', false)`);
    await holder.query('select pg_advisory_lock($1::bigint)', [String(ADVISORY_KEY)]);
    await expect(acquire({ waitSeconds: 0 })).rejects.toThrow('crashed:5');
    await holder.end();
    const next = await acquire({ waitSeconds: 5 });
    await next.release();
  });

  it('does not take the lock when the app parses booleans as strings: the answer \'f\' is not a lock', async () => {
    const { default: pg } = await import('pg');
    const BOOL = 16;
    const holder = await acquire({ waitSeconds: 0 });
    // The app's own parser for booleans, global to `pg`: it gives back the text of the answer.
    const original = pg.types.getTypeParser(BOOL);
    pg.types.setTypeParser(BOOL, (value: string) => value);
    try {
      await expect(acquire({ waitSeconds: 0 })).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      pg.types.setTypeParser(BOOL, original);
      await holder.release();
    }
  });

  it('takes a free lock when the app parses booleans as strings: the answer \'t\' is no reason to wait', async () => {
    const { default: pg } = await import('pg');
    const BOOL = 16;
    const original = pg.types.getTypeParser(BOOL);
    pg.types.setTypeParser(BOOL, (value: string) => value);
    try {
      const lock = await acquire({ waitSeconds: 0 });
      await lock.release();
    } finally {
      pg.types.setTypeParser(BOOL, original);
    }
  });

  it('does not take a connection of the app’s pool: migrates with a pool of one', async () => {
    const fresh = await freshDatabase('pgsql');
    const small = new Connections({ connections: { default: { ...fresh.options, poolMax: 1 } as never }, root: '/', logger: silent });
    try {
      expect((await migrator(small).migrate()).length).toBe(3);
    } finally {
      await small.destroy();
      await fresh.drop();
    }
  }, 15_000);

  it('stops the run, with a clear error, when the connection that holds the lock ends', async () => {
    const lock = await acquire({ owner: 'victim:8' });
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'marmeon-migrate:victim:8' and datname = current_database()`.execute(connections.get<any>());
    let error: unknown;
    for (let attempt = 0; attempt < 40 && !error; attempt++) {
      await pause(50);
      error = await lock.heartbeat().then(() => undefined, (e: unknown) => e);
    }
    expect(error).toBeInstanceOf(MigrationLockLostError);
    expect((error as Error).message).toMatch(/^\[marmeon:D22\] /);
    expect((error as Error).message).toContain('its database connection ended');
    await lock.release(); // nothing to let go of, and no throw
  });

  it('is held by an open transaction, so a second holder never shares it — also behind a pooler in transaction mode', async () => {
    const first = await acquire({ owner: 'first:1' });
    try {
      const state = await sql<{ state: string }>`select state from pg_stat_activity where application_name = 'marmeon-migrate:first:1' and datname = current_database()`.execute(connections.get<any>());
      expect(state.rows.map((row) => row.state)).toEqual(['idle in transaction']);
      await expect(acquire({ waitSeconds: 0, owner: 'second:2' })).rejects.toThrow('first:1');
      await first.heartbeat();
    } finally {
      await first.release();
    }
    await (await acquire({ waitSeconds: 0 })).release();
  });
});

/** A migration that loses the lock while it runs commits nothing and records nothing — on its own connection or another. */
describe.each(drivers)('a migration that loses the lock on %s', (driver) => {
  const lockLost: ModuleDefinition = { name: 'lock-lost', migrations: fixtures('lock-lost') };
  const elsewhere: ModuleDefinition = { name: 'lock-lost-elsewhere', migrations: fixtures('lock-lost-elsewhere') };
  let connections: Connections;
  let drops: (() => Promise<void>)[];
  const loses = (hook: ((db: any) => Promise<void>) | undefined) => ((globalThis as { loseMigrationLock?: unknown }).loseMigrationLock = hook);

  /** Takes the lock away from the run: SQLite loses its row, Postgres the connection that holds it. */
  const takeAway = async (db: any) => {
    // Without the plugins of the data step, which refuse raw SQL that names a table of the migrator.
    if (driver === 'sqlite') await sql`delete from ${sql.table(LOCK_TABLE)}`.execute(db.withoutPlugins());
    else {
      await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name like 'marmeon-migrate:%' and datname = current_database() and pid <> pg_backend_pid()`.execute(connections.get<any>());
      await pause(500);
    }
  };
  const tablesOf = async (name: string) => (await connections.get<any>(name).introspection.getTables()).map((t) => t.name);
  // The record is made with the first migration: when that is rolled back, there is none.
  const recorded = async () =>
    (await tablesOf('default')).includes('migrations') ? (await connections.get<any>().selectFrom('migrations').select('name').execute()).map((row) => row.name) : [];
  const app = (...modules: ModuleDefinition[]) =>
    new Migrator({ modules, root: '/', container: { make: () => 'system' } } as unknown as Application, connections);

  beforeAll(async () => {
    const [main, other] = [await freshDatabase(driver), await freshDatabase(driver)];
    drops = [main.drop, other.drop];
    connections = new Connections({ connections: { default: main.options, system: other.options }, root: '/', logger: silent });
  });
  afterAll(async () => {
    loses(undefined);
    await connections.destroy();
    for (const drop of drops) await drop();
  });

  it('rolls back the migration and records nothing', async () => {
    loses((db) => takeAway(db));
    await expect(app(lockLost).migrate()).rejects.toBeInstanceOf(MigrationLockLostError);
    loses(undefined);
    expect(await tablesOf('default')).not.toContain('doomed');
    expect(await recorded()).toEqual([]);
  });

  it('rolls back a migration on another connection before it commits', async () => {
    loses((db) => takeAway(driver === 'sqlite' ? connections.get<any>() : db));
    await expect(app(elsewhere).migrate()).rejects.toBeInstanceOf(MigrationLockLostError);
    loses(undefined);
    expect(await tablesOf('system')).not.toContain('doomed_elsewhere');
    expect(await recorded()).toEqual([]);
  });

  it('keeps a migration done and recorded when the lock is lost while it is undone', async () => {
    await app(lockLost).migrate();
    expect(await recorded()).toEqual(['2026_01_09_000000_create_doomed_table']);
    loses((db) => takeAway(db));
    await expect(app(lockLost).rollback()).rejects.toBeInstanceOf(MigrationLockLostError);
    loses(undefined);
    expect(await tablesOf('default')).toContain('doomed');
    expect(await recorded()).toEqual(['2026_01_09_000000_create_doomed_table']);
  });
});

// MySQL runs in `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL.
withMysql('the MySQL lock', () => {
  let connections: Connections;
  let close: () => Promise<void>;
  const db = () => connections.get<any>();
  const acquire = (options: Omit<LockOptions, 'driver' | 'url'> = {}) => lockOf(connections)(options);
  const paused: ModuleDefinition = { name: 'state-pause', migrations: fixtures('state-pause') };
  const auth_: ModuleDefinition = auth;

  /** The connection ids of the locks that wait or hold on this server, by the owner they announced. */
  const holders = async (owner: string) =>
    (await sql<{ id: string }>`select processlist_id as id from performance_schema.session_connect_attrs where attr_name = 'program_name' and attr_value = ${`marmeon-migrate:${owner}`}`.execute(db())).rows.map((row) => Number(row.id));

  beforeAll(async () => ({ connections, close } = await freshConnections('mysql')));
  afterAll(() => close());

  it('is held by one migrator at a time: the second times out with D8 and names the holder', async () => {
    const held = await acquire({ owner: 'build-7:4242' });
    try {
      const error = await acquire({ waitSeconds: 0, owner: 'second:2' }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MigrationLockTimeoutError);
      expect((error as Error).message).toMatch(/^\[marmeon:D8\] Another migration has run since an unknown time \(build-7:4242\)\./);
      expect((error as MigrationLockTimeoutError).holder).toEqual({ owner: 'build-7:4242', since: undefined });
      await expect(migrator(connections).lockWith({ waitSeconds: 0 }).migrate()).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await held.release();
    }
    await (await acquire({ waitSeconds: 0 })).release();
  });

  it('waits for the holder to end, then takes the lock', async () => {
    const held = await acquire();
    const waiting = acquire({ waitSeconds: 10 });
    let finished = false;
    void waiting.then(() => (finished = true));
    await pause(700);
    expect(finished).toBe(false);
    await held.release();
    await (await waiting).release();
  });

  it('times out when the seconds it was given have run out', async () => {
    const held = await acquire();
    try {
      await expect(acquire({ waitSeconds: 1 })).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await held.release();
    }
  });

  it('does not make a migrator on another database of the same server wait', async () => {
    const other = await freshConnections('mysql');
    const held = await acquire({ owner: 'here:1' });
    try {
      // Any competition for the same lock would be D8 at once.
      const there = await lockOf(other.connections)({ waitSeconds: 0, owner: 'there:2' });
      await there.release();
    } finally {
      await held.release();
      await other.close();
    }
  });

  it('keeps the lock while the run goes on: a connection that went back to the pool did not take it along', async () => {
    // The first migration ends, its pinned connection is reset and goes back; the second one is paused in its data step with the lock held.
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    (globalThis as Record<symbol, Pause | undefined>)[PAUSE] = { entered: () => entered.resolve(), released: released.promise };
    const first = migrator(connections).lockWith({ waitSeconds: 10 });
    const running = new Migrator({ modules: [auth_, paused], root: '/' } as unknown as Application, connections).lockWith({ waitSeconds: 10 }).migrate();
    try {
      await entered.promise;
      await expect(first.lockWith({ waitSeconds: 0 }).migrate()).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      released.resolve();
      delete (globalThis as Record<symbol, Pause | undefined>)[PAUSE];
    }
    expect((await running).map((run) => run.name)).toEqual(['2026_01_01_000000_create_users_table', '2026_01_31_000000_create_paused_table']);
    await (await acquire({ waitSeconds: 0 })).release();
  });

  it('throws D22 at the next heartbeat when the connection that holds the lock was killed, and lets go without a fuss', async () => {
    const held = await acquire({ owner: 'doomed:9' });
    await held.heartbeat();
    const [id] = await holders('doomed:9');
    expect(id).toBeGreaterThan(0);
    await sql.raw(`kill ${id}`).execute(db());
    const error = await held.heartbeat().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MigrationLockLostError);
    expect((error as Error).message).toMatch(/^\[marmeon:D22\] The migration lock was lost: its database connection ended/);
    await held.release();
    // The server let the lock go with the connection.
    await (await acquire({ waitSeconds: 0 })).release();
  });

  it('is free again when the connection that holds it ends without a release', async () => {
    const crashed = await acquire({ owner: 'crashed:5' });
    const [id] = await holders('crashed:5');
    await expect(acquire({ waitSeconds: 0 })).rejects.toThrow('crashed:5');
    await sql.raw(`kill ${id}`).execute(db());
    const next = await acquire({ waitSeconds: 5 });
    await next.release();
    await crashed.release();
  });

  it('stops a run whose lock was lost, records nothing for the migration that was running and says why', async () => {
    const lockLost: ModuleDefinition = { name: 'lock-lost', migrations: fixtures('lock-lost') };
    const own = await freshConnections('mysql');
    const rows = own.connections.get<any>();
    // The lock of another database on the server, which this run must not take away.
    const stranger = await freshConnections('mysql');
    const foreign = await lockOf(stranger.connections)({ waitSeconds: 0, owner: 'stranger:7' });
    try {
      (globalThis as { loseMigrationLock?: unknown }).loseMigrationLock = async () => {
        const [killed] = (await sql<{ id: string }>`select a.processlist_id as id from performance_schema.session_connect_attrs a join information_schema.processlist p on p.id = a.processlist_id where a.attr_name = 'program_name' and a.attr_value like 'marmeon-migrate:%' and p.db = database() and a.processlist_id <> connection_id()`.execute(rows)).rows;
        await sql.raw(`kill ${killed!.id}`).execute(rows);
        await pause(300);
      };
      await expect(new Migrator({ modules: [lockLost], root: '/' } as unknown as Application, own.connections).migrate()).rejects.toBeInstanceOf(MigrationLockLostError);
      // The app's connection refuses every query while the migration is marked: look as the server has it.
      const looked = inspectionConnection(own.connections);
      expect((await sql<{ n: number }>`select count(*) as n from migrations`.execute(looked)).rows[0]?.n).toBe(0);
      // What the migration made stays, and the marker says it stopped halfway.
      expect((await sql<{ name: string }>`select name from migration_interruption`.execute(looked)).rows).toEqual([{ name: '2026_01_09_000000_create_doomed_table' }]);
      await foreign.heartbeat(); // the lock of the other database is still held
    } finally {
      delete (globalThis as { loseMigrationLock?: unknown }).loseMigrationLock;
      await foreign.release();
      await stranger.close();
      await own.close();
    }
  });

  it('says a server that cannot be reached with D11, and a missing url with the TypeError of the lock', async () => {
    await expect(MigrationLock.acquire(db(), { driver: 'mysql', url: 'mysql://app:secret@127.0.0.1:1/x', connectTimeoutMs: 500 })).rejects.toThrow(/^\[marmeon:D11\] Could not connect to the database connection "default"/);
    await expect(MigrationLock.acquire(db(), { driver: 'mysql' })).rejects.toThrow(new TypeError('The MySQL migration lock needs the connection’s url.'));
  });

  it('names the holder unknown when the account that waits may not read performance_schema', async () => {
    const options = connections.options();
    if (options.driver !== 'mysql') throw new Error('a MySQL connection');
    const database = decodeURIComponent(new URL(options.url).pathname.slice(1));
    // An account of the whole server, not of the test database: named with the tag of this checkout like its databases, so a run that was cut off shows what it left.
    const account = `mlim_${(process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged').slice(0, 12)}_${Math.random().toString(36).slice(2, 8)}`; // at most 32 characters
    const password = ['limited', Math.random().toString(36).slice(2)].join('-');
    await sql.raw(`create user '${account}'@'%' identified by '${password}'`).execute(db());
    try {
      await sql.raw(`grant all on \`${database}\`.* to '${account}'@'%'`).execute(db());
      const limited = new URL(options.url);
      limited.username = account;
      limited.password = password;
      const held = await acquire({ owner: 'seen:1' });
      try {
        const error = await MigrationLock.acquire(db(), { driver: 'mysql', url: limited.href, waitSeconds: 0 }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(MigrationLockTimeoutError);
        expect((error as MigrationLockTimeoutError).holder).toEqual({ owner: 'unknown', since: undefined });
        // The account that may read it names the holder.
        await expect(acquire({ waitSeconds: 0 })).rejects.toThrow('seen:1');
      } finally {
        await held.release();
      }
    } finally {
      await sql.raw(`drop user if exists '${account}'@'%'`).execute(db());
    }
  });
});

describe('the name of the MySQL lock', () => {
  it('differs for two databases whose names differ only in case (a server may tell them apart), and fits the 64 characters GET_LOCK allows', () => {
    expect(mysqlLockName('Orders')).not.toBe(mysqlLockName('orders'));
    expect(mysqlLockName('orders')).toBe(mysqlLockName('orders'));
    expect(mysqlLockName('orders')).toMatch(/^marmeon-migrate:[0-9a-f]{40}$/);
  });
});
