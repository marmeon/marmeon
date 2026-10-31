import { setTimeout } from 'node:timers/promises';
import { afterCommit, defineModule, Logger, outsideTransaction, TransactionError, type ApplicationDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, defineFactory, sql, type Generated, type SeedContext } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, SharedData } from '@marmeon/http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { guarded, type GuardedTables } from './__fixtures__/guarded.ts';
import { workshops, type WorkshopTables } from './__fixtures__/workshops.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { createTestApp, type TestApp } from './index.ts';

interface NotesTables {
  notes: { id: Generated<number>; title: string; pinned: Generated<boolean> };
}
const NoteFactory = defineFactory<'notes', NotesTables>('notes', ({ sequence }) => ({ title: `Note ${sequence}` }));

class WelcomeNoteSeeder {
  async handle({ factory }: SeedContext) {
    await factory(NoteFactory).create({ title: 'Welcome', pinned: true });
  }
}

/** A page whose lazy shared prop throws: the response is a 500, and what ran for the page may outlive it. */
class BoomController extends Controller {
  readonly #shared: SharedData;
  readonly #connections: Connections;
  constructor(shared: SharedData, connections: Connections) {
    super();
    this.#shared = shared;
    this.#connections = connections;
  }
  handle() {
    // Still holding a connection when the other prop fails.
    this.#shared.share('slow' as never, (() => this.#connections.transaction(() => setTimeout(100))) as never);
    this.#shared.share('boom' as never, (() => {
      throw new Error('boom');
    }) as never);
    return this.view('boom/Show', {});
  }
}
const boomRoutes = openRoutes((Route) => {
  Route.get('/boom', BoomController);
});

const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);
const SEATS = 2;
const GUESTS = 5;

/** The warnings a test app raised about transactions that took turns. */
const turns: Error[] = [];
process.on('warning', (warning) => {
  if ((warning as NodeJS.ErrnoException).code === 'MARMEON_SERIAL_TRANSACTIONS') turns.push(warning);
});

describe.each(drivers)('a test app on its real pool on %s', (driver) => {
  const env = { APP_KEY: generateKey(), ...(driver === 'pgsql' ? { DB_DRIVER: 'pgsql', DB_URL: PGSQL_URL } : { DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' }) };
  const definition: ApplicationDefinition = {
    root: workspaceTempDir('marmeon-testing-isolated-'),
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider],
    modules: [
      defineModule({ name: 'notes', migrations: new URL('./__fixtures__/migrations/', import.meta.url), seeders: [WelcomeNoteSeeder] }),
      workshops,
      defineModule({ name: 'boom', routes: boomRoutes }),
    ],
  };

  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const open = async (database: 'refresh' | 'isolated', seed = false) => (app = await createTestApp(definition, { env, database, ...(seed ? { seed } : {}) }));

  /** Opens a workshop with `SEATS` seats, and sends `GUESTS` booking requests at the same time. */
  async function race(path: '/book/locked' | '/book/unlocked') {
    await app!.make(Connections).get<WorkshopTables>().insertInto('workshops').values({ capacity: SEATS }).execute();
    const responses = await Promise.all(Array.from({ length: GUESTS }, () => app!.post(path)));
    const booked = await app!.make(Connections).get<WorkshopTables>().selectFrom('bookings').select('id').execute();
    return { statuses: responses.map((response) => response.status), booked: booked.length };
  }

  it('empties the tables when it starts and when it closes, and the ids start over', async () => {
    const first = await open('isolated');
    await first.factory(NoteFactory).count(2).create();
    // A foreign key between the tables: emptied in any order, with the checks of SQLite switched back on afterwards.
    await first.make(Connections).get<WorkshopTables>().insertInto('workshops').values({ capacity: SEATS }).execute();
    await first.make(Connections).get<WorkshopTables>().insertInto('bookings').values({ workshop_id: 1, guest: 'Ada' }).execute();
    await first.close();
    const second = await open('isolated');
    await second.assertDatabaseCount<'notes', NotesTables>('notes', 0);
    const note = await second.factory(NoteFactory).create();
    expect(note.id).toBe(1);
    await second.assertDatabaseCount<'workshops', WorkshopTables>('workshops', 0);
    await second.assertDatabaseCount<'bookings', WorkshopTables>('bookings', 0);
    if (driver === 'sqlite') {
      const { rows } = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(second.make(Connections).get());
      expect(rows[0]!.foreign_keys).toBe(1);
    }
  });

  it('empties a database that an app closed without emptying before a refreshed app uses it', async () => {
    const abandoned = await open('isolated');
    await abandoned.factory(NoteFactory).create({ title: 'Left behind' });
    await abandoned.make(Connections).destroy();
    await abandoned.close().catch(() => {});
    app = undefined;
    const refreshed = await open('refresh');
    await refreshed.assertDatabaseCount<'notes', NotesTables>('notes', 0);
  });

  describe.runIf(driver === 'pgsql')('Postgres', () => {
    it('closes cleanly under refresh after a page failed on a lazy shared prop', async () => {
      const errors: unknown[] = [];
      const onError = (reason: unknown) => errors.push(reason);
      process.on('unhandledRejection', onError);
      try {
        await open('refresh');
        expect((await app!.get('/boom')).status).toBe(500);
        await expect(app!.close()).resolves.toBeUndefined();
        app = undefined;
        await setTimeout(250);
      } finally {
        process.off('unhandledRejection', onError);
      }
      expect(errors.map(String)).toEqual([]);
    });

    const second = () => {
      const options = app!.make(Connections).options();
      if (options.driver !== 'pgsql') throw new Error('These tests need Postgres.');
      return new Connections({ connections: { default: { driver: 'pgsql', url: options.url, poolMax: 1 } }, root: definition.root, logger: app!.make(Logger) });
    };

    it('commits for real: a second connection sees the rows at once — under refresh it never does', async () => {
      await open('isolated');
      await app!.factory(NoteFactory).create({ title: 'Committed' });
      const reader = await second();
      try {
        expect((await reader.get<NotesTables>().selectFrom('notes').select('title').execute()).map((row) => row.title)).toEqual(['Committed']);
      } finally {
        await reader.destroy();
      }
      await app!.close();

      await open('refresh');
      await app!.factory(NoteFactory).create({ title: 'Rolled back' });
      const other = await second();
      try {
        expect(await other.get<NotesTables>().selectFrom('notes').select('title').execute()).toEqual([]);
      } finally {
        await other.destroy();
      }
    });

    it('finds its tables when a schema named like the role comes first on the search path', async () => {
      await open('isolated');
      const role = (await sql<{ name: string }>`select current_user as name`.execute(app!.make(Connections).get())).rows[0]!.name;
      await sql`create schema ${sql.id(role)}`.execute(app!.make(Connections).get());
      try {
        await app!.factory(NoteFactory).count(2).create();
        const reader = second();
        await app!.close();
        try {
          expect((await sql`select id from notes`.execute(reader.get())).rows).toHaveLength(0);
        } finally {
          await sql`drop schema if exists ${sql.id(role)}`.execute(reader.get());
          await reader.destroy();
        }
      } finally {
        app = undefined;
      }
    });

    it('lets a second transaction wait for the row the first one locked', async () => {
      await open('isolated');
      const connections = app!.make(Connections);
      await connections.get<WorkshopTables>().insertInto('workshops').values({ capacity: SEATS }).execute();
      const events: string[] = [];
      const lock = (name: string, hold: number) =>
        connections.transaction(async () => {
          await connections.get<WorkshopTables>().selectFrom('workshops').select('id').where('id', '=', 1).forUpdate().execute();
          events.push(`${name} locked`);
          await setTimeout(hold);
          events.push(`${name} done`);
        });
      const first = lock('first', 150);
      await setTimeout(30);
      await Promise.all([first, lock('second', 0)]);
      expect(events).toEqual(['first locked', 'first done', 'second locked', 'second done']);
    });

    // The finding: a test of a lock must be able to fail. Without the lock, requests that run together overbook the workshop; under
    // `refresh` they do not, because the transactions take turns — a missing lock passes there.
    it('overbooks without the lock, and holds with it', async () => {
      await open('isolated');
      const unlocked = await race('/book/unlocked');
      expect(unlocked.booked, 'every guest read the free seats before one of them booked').toBe(GUESTS);
      await app!.close();

      await open('isolated');
      const locked = await race('/book/locked');
      expect(locked.booked).toBe(SEATS);
      expect(locked.statuses.filter((status) => status === 201)).toHaveLength(SEATS);
      expect(locked.statuses.filter((status) => status === 409)).toHaveLength(GUESTS - SEATS);
    });

    it('does not overbook under refresh, with the lock or without: the transactions take turns', async () => {
      await open('refresh');
      const unlocked = await race('/book/unlocked');
      expect(unlocked.booked, 'a test of a lock cannot fail here').toBe(SEATS);
    });

    it('warns once under refresh when transactions took turns, and never when they did not', async () => {
      turns.length = 0;
      await open('refresh');
      await app!.make(Connections).get<WorkshopTables>().insertInto('workshops').values({ capacity: SEATS }).execute();
      for (let i = 0; i < GUESTS; i++) await app!.post('/book/unlocked');
      await setTimeout(10);
      expect(turns, 'one request after the other waits for nobody').toHaveLength(0);

      await Promise.all(Array.from({ length: GUESTS }, () => app!.post('/book/unlocked')));
      await Promise.all(Array.from({ length: GUESTS }, () => app!.post('/book/locked')));
      await setTimeout(10);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.message).toContain("database: 'isolated'");
      expect(turns[0]!.message).toContain('docs/database-testing.md#testing-a-lock');
      await app!.close();

      // A new isolation says it again.
      await open('refresh');
      await Promise.all(Array.from({ length: 2 }, () => app!.post('/book/unlocked')));
      await setTimeout(10);
      expect(turns).toHaveLength(2);
    });

    it('does not warn under isolated: there the requests compete for real', async () => {
      turns.length = 0;
      await open('isolated');
      await race('/book/locked');
      await setTimeout(10);
      expect(turns).toHaveLength(0);
    });
  });

  describe.each(['refresh', 'isolated'] as const)('after-commit work under %s', (database) => {
    const titles = async () => (await app!.make(Connections).get<NotesTables>().selectFrom('notes').select('title').orderBy('id').execute()).map((row) => row.title);
    const add = async (title: string) => void (await app!.make(Connections).get<NotesTables>().insertInto('notes').values({ title }).execute());

    it('may open a transaction of its own: the transaction has given up its turn', { timeout: 5000 }, async () => {
      await open(database);
      const connections = app!.make(Connections);
      const seen: string[] = [];
      await connections.transaction(async () => {
        await add('outer');
        await afterCommit(async () => {
          await connections.transaction(async () => {
            await add('from the hook');
            // A savepoint of the hook's transaction, with after-commit work of its own.
            await connections.transaction(() => afterCommit(() => void seen.push('nested hook')));
          });
          seen.push('hook done');
        });
        seen.push('callback done');
      });
      expect(seen).toEqual(['callback done', 'nested hook', 'hook done']);
      expect(await titles()).toEqual(['outer', 'from the hook']);
    });

    it('runs the hooks in order, drops them on a rollback, and warns of no turns', { timeout: 5000 }, async () => {
      turns.length = 0;
      await open(database);
      const connections = app!.make(Connections);
      const seen: string[] = [];
      const insert = (title: string) =>
        connections.transaction(async () => {
          await add(title);
          seen.push(title);
        });
      await connections.transaction(async () => {
        await afterCommit(() => insert('first'));
        await afterCommit(() => insert('second'));
      });
      await connections
        .transaction(async () => {
          await afterCommit(() => insert('never'));
          throw new Error('rolled back');
        })
        .catch(() => undefined);
      expect(seen).toEqual(['first', 'second']);
      expect(await titles()).toEqual(['first', 'second']);
      await setTimeout(10);
      expect(turns).toHaveLength(0);
    });

    it('throws the error of a hook after the commit, and the next transaction still runs', { timeout: 5000 }, async () => {
      await open(database);
      const connections = app!.make(Connections);
      await expect(
        connections.transaction(async () => {
          await add('kept');
          await afterCommit(() => connections.transaction(() => Promise.reject(new Error('hook failed'))));
        }),
      ).rejects.toThrow('hook failed');
      await connections.transaction(async () => {
        await add('next');
      });
      expect(await titles()).toEqual(['kept', 'next']);
    });

    // SQLite and a test's pinned Postgres connection are one connection the transaction holds; an isolated Postgres test has a pool, where outsideTransaction() gets a connection of its own.
    it.runIf(driver === 'sqlite' || database === 'refresh')('fails at once instead of waiting for a transaction that outsideTransaction stepped out of', { timeout: 5000 }, async () => {
      await open(database);
      const connections = app!.make(Connections);
      await expect(
        connections.transaction(() =>
          outsideTransaction(() =>
            connections.transaction(async () => {
              await add('x');
            }),
          ),
        ),
      ).rejects.toThrow(TransactionError);
    });
  });

  it('runs on SQLite too, where one writer takes the place of the row lock', async () => {
    if (driver !== 'sqlite') return;
    await open('isolated');
    const locked = await race('/book/locked');
    expect(locked.booked).toBe(SEATS);
  });
});

it('types the modes', () =>
  void (async (definition: ApplicationDefinition) => {
    await createTestApp(definition, { database: 'isolated' });
    await createTestApp(definition, { database: 'refresh', seed: true });
    // @ts-expect-error — (1) only 'refresh' and 'isolated'
    await createTestApp(definition, { database: 'fresh' });
    // @ts-expect-error — (2) not a boolean
    await createTestApp(definition, { database: true });
  }));

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

describe.each(drivers)('a table a trigger guards, on %s', (driver) => {
  const env = { APP_KEY: generateKey(), ...(driver === 'pgsql' ? { DB_DRIVER: 'pgsql', DB_URL: PGSQL_URL } : { DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' }) };
  const definition: ApplicationDefinition = {
    root: workspaceTempDir('marmeon-testing-guarded-'),
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider],
    modules: [guarded],
  };

  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const open = async (database: 'refresh' | 'isolated') => (app = await createTestApp(definition, { env, database }));
  const db = () => app!.make(Connections).get<GuardedTables>();
  const log = (entry: string) => db().insertInto('audit_logs').values({ entry }).execute();
  const triggerStates = async () =>
    (await sql<{ name: string; enabled: string }>`select tgname::text as name, tgenabled::text as enabled from pg_trigger where tgrelid = 'audit_logs'::regclass and not tgisinternal order by tgname`.execute(db())).rows;

  it('empties an append-only log when the app starts and when it closes, and the ids start over', async () => {
    const first = await open('isolated');
    await log('one');
    await log('two');
    await first.close();
    const second = await open('isolated');
    await second.assertDatabaseCount<'audit_logs', GuardedTables>('audit_logs', 0);
    await log('again');
    expect((await db().selectFrom('audit_logs').select('id').execute()).map((row) => row.id)).toEqual([1]);
  });

  it('puts the guard back: a statement of the test meets it again', async () => {
    await open('isolated');
    await log('kept');
    await expect(sql`delete from audit_logs`.execute(db())).rejects.toThrow('append-only');
    if (driver === 'sqlite') {
      const { rows } = await sql<{ name: string }>`select name from sqlite_master where type = 'trigger' order by name`.execute(db());
      expect(rows.map((row) => row.name)).toEqual(['audit_logs_no_change', 'orders_trail']);
      return;
    }
    await expect(sql`truncate audit_logs`.execute(db())).rejects.toThrow('append-only');
    await expect(sql`update audit_logs set entry = 'changed'`.execute(db())).rejects.toThrow('append-only');
    expect(await triggerStates()).toEqual([
      { name: 'audit_logs_no_change', enabled: 'O' },
      { name: 'audit_logs_no_truncate', enabled: 'O' },
    ]);
  });

  it.runIf(driver === 'sqlite')('does not let a trigger of another table write while the tables are emptied', async () => {
    await open('isolated');
    await sql`insert into orders default values`.execute(db());
    await sql`insert into orders default values`.execute(db());
    await app!.close();
    await open('isolated');
    await app!.assertDatabaseCount<'orders', GuardedTables>('orders', 0);
    await app!.assertDatabaseCount<'order_trail', GuardedTables>('order_trail', 0);
    await sql`insert into orders default values`.execute(db());
    await sql`delete from orders`.execute(db());
    await app!.assertDatabaseCount<'order_trail', GuardedTables>('order_trail', 1);
  });

  it('empties it before a refreshed app uses a database an isolated app left behind', async () => {
    const abandoned = await open('isolated');
    await log('left behind');
    await abandoned.make(Connections).destroy();
    await abandoned.close().catch(() => {});
    app = undefined;
    const refreshed = await open('refresh');
    await refreshed.assertDatabaseCount<'audit_logs', GuardedTables>('audit_logs', 0);
  });

  describe.runIf(driver === 'pgsql')('Postgres', () => {
    const other = () => {
      const options = app!.make(Connections).options();
      if (options.driver !== 'pgsql') throw new Error('These tests need Postgres.');
      return new Connections({ connections: { default: { driver: 'pgsql', url: options.url, poolMax: 1 } }, root: definition.root, logger: app!.make(Logger) });
    };

    it('brings a trigger back in the mode it had: always stays always, a switched-off one stays off', async () => {
      await open('isolated');
      await sql`alter table audit_logs enable always trigger audit_logs_no_truncate`.execute(db());
      await sql`alter table audit_logs disable trigger audit_logs_no_change`.execute(db());
      // Statement triggers of the kind the emptying meets: one switched off, one that fires only in the replica role.
      await sql`create trigger audit_logs_truncate_off before truncate on audit_logs for each statement execute function refuse_audit_changes()`.execute(db());
      await sql`alter table audit_logs disable trigger audit_logs_truncate_off`.execute(db());
      await sql`create trigger audit_logs_truncate_replica before truncate on audit_logs for each statement execute function refuse_audit_changes()`.execute(db());
      await sql`alter table audit_logs enable replica trigger audit_logs_truncate_replica`.execute(db());
      try {
        await log('kept');
        const reader = other();
        try {
          // The close empties the table; what the table looks like afterwards is what the reader sees.
          await app!.close();
          const states = (await sql<{ name: string; enabled: string }>`select tgname::text as name, tgenabled::text as enabled from pg_trigger where tgrelid = 'audit_logs'::regclass and not tgisinternal order by tgname`.execute(reader.get())).rows;
          expect(states).toEqual([
            { name: 'audit_logs_no_change', enabled: 'D' },
            { name: 'audit_logs_no_truncate', enabled: 'A' },
            { name: 'audit_logs_truncate_off', enabled: 'D' },
            { name: 'audit_logs_truncate_replica', enabled: 'R' },
          ]);
          expect((await sql`select 1 from audit_logs`.execute(reader.get())).rows).toHaveLength(0);
        } finally {
          await sql`drop trigger audit_logs_truncate_off on audit_logs`.execute(reader.get());
          await sql`drop trigger audit_logs_truncate_replica on audit_logs`.execute(reader.get());
          await sql`alter table audit_logs enable trigger audit_logs_no_truncate`.execute(reader.get());
          await sql`alter table audit_logs enable trigger audit_logs_no_change`.execute(reader.get());
          await reader.destroy();
        }
      } finally {
        app = undefined;
      }
    });

    /** A connection to the server as the role the URL names, for what the test does outside the app. */
    const as = (url: string) => new Connections({ connections: { default: { driver: 'pgsql', url, poolMax: 1 } }, root: definition.root, logger: silent });
    const states = async (connections: Connections) =>
      (await sql<{ enabled: string }>`select tgenabled::text as enabled from pg_trigger where tgrelid = 'audit_logs'::regclass and not tgisinternal order by tgname`.execute(connections.get())).rows.map((row) => row.enabled);

    // An app whose start fails closes itself, which empties again and fails the same way: the error that comes out is the first.
    it('rolls back with the guard on when the emptying fails half way', async () => {
      // Every connection of this app gives up waiting for a lock after a moment.
      const url = new URL(PGSQL_URL!);
      url.searchParams.set('options', '-c lock_timeout=300');
      const options = { env: { ...env, DB_URL: url.href }, database: 'isolated' } as const;
      const first = await createTestApp(definition, options);
      const workerUrl = (first.make(Connections).options() as { url: string }).url;
      await first.close();
      const holder = as(workerUrl);
      try {
        await holder.transaction(async (trx) => {
          await sql`lock table orders in access exclusive mode`.execute(trx);
          await expect(createTestApp(definition, options)).rejects.toThrow(/lock timeout/);
        });
        // The guard was put aside before the truncate failed, and came back with the rollback.
        expect(await states(holder)).toEqual(['O', 'O']);
      } finally {
        await holder.destroy();
      }
    });

    describe('as a role that is not a superuser', () => {
      const role = `marmeon_guard_${process.pid}`;
      const admin = () => new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL!, poolMax: 1 } }, root: definition.root, logger: silent });
      const roleUrl = () => {
        const url = new URL(PGSQL_URL!);
        url.username = role;
        url.password = 'guard';
        return url.href;
      };
      const databasesOfTheRole = async (connections: Connections) =>
        (await sql<{ name: string }>`select datname::text as name from pg_database where datdba = (select oid from pg_roles where rolname = ${role})`.execute(connections.get())).rows.map((row) => row.name);

      beforeAll(async () => {
        const server = admin();
        try {
          await sql.raw(`create role ${role} login createdb password 'guard'`).execute(server.get());
        } finally {
          await server.destroy();
        }
      });
      afterAll(async () => {
        const server = admin();
        try {
          for (const name of await databasesOfTheRole(server)) await sql`drop database if exists ${sql.id(name)} with (force)`.execute(server.get());
          await sql.raw(`drop role if exists ${role}`).execute(server.get());
        } finally {
          await server.destroy();
        }
      });

      // Its own root, so its own database: the role cannot drop one that another role created.
      const owned: ApplicationDefinition = { ...definition, root: workspaceTempDir('marmeon-testing-guarded-role-') };
      const start = () => createTestApp(owned, { env: { ...env, DB_URL: roleUrl() }, database: 'isolated' });

      it('says which table the role may not truncate, and empties nothing', async () => {
        const first = await start();
        const owner = as((first.make(Connections).options() as { url: string }).url);
        const rows = as((first.make(Connections).options() as { url: string }).url);
        try {
          await sql`revoke truncate on audit_logs from current_user`.execute(owner.get());
          await first.make(Connections).get<GuardedTables>().insertInto('audit_logs').values({ entry: 'kept' }).execute();
          await first.make(Connections).destroy();
          await first.close().catch(() => {});
          await expect(start()).rejects.toThrow(/may not truncate `audit_logs` there.*docs\/database-testing\.md#testing-a-lock/s);
          expect((await sql`select 1 from audit_logs`.execute(rows.get())).rows).toHaveLength(1);
          expect(await states(rows)).toEqual(['O', 'O']);
        } finally {
          await sql`grant truncate on audit_logs to current_user`.execute(owner.get());
          await owner.destroy();
          await rows.destroy();
        }
      });

      it('says which table with a guard the role does not own', async () => {
        const first = await start();
        const server = admin();
        const owner = as(roleUrl());
        try {
          await first.close();
          const name = (await databasesOfTheRole(server)).find((database) => database.includes('_test_'))!;
          const url = new URL(PGSQL_URL!);
          url.pathname = `/${name}`;
          const inside = as(url.href);
          try {
            await sql.raw(`alter table audit_logs owner to ${new URL(PGSQL_URL!).username}`).execute(inside.get());
            await sql.raw(`grant truncate on audit_logs to ${role}`).execute(inside.get());
            await expect(start()).rejects.toThrow(/does not own `audit_logs`, whose truncate trigger it has to put aside/);
            expect(await states(inside)).toEqual(['O', 'O']);
          } finally {
            await sql.raw(`alter table audit_logs owner to ${role}`).execute(inside.get());
            await inside.destroy();
          }
        } finally {
          await owner.destroy();
          await server.destroy();
        }
      });
    });
  });
});
