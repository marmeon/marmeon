import { setTimeout } from 'node:timers/promises';
import { afterCommit, defineModule, Logger, outsideTransaction, TransactionError, type ApplicationDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, defineFactory, sql, type Generated, type SeedContext } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { workshops, type WorkshopTables } from './__fixtures__/workshops.ts';
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
