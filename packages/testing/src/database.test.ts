import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineModule, type ApplicationOptions } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, defineFactory, type Generated, type SeedContext } from '@marmeon/database';
import { Controller, defineRoutes, HttpServiceProvider } from '@marmeon/http';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
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

/** Writes in its own transaction — which becomes a savepoint inside the test's. */
class CreateNoteController extends Controller {
  readonly #connections: Connections;
  constructor(connections: Connections) {
    super();
    this.#connections = connections;
  }
  async handle() {
    const db = this.#connections.get<NotesTables>();
    const note = await db.transaction().execute((trx) => trx.insertInto('notes').values({ title: 'From a request' }).returningAll().executeTakeFirstOrThrow());
    return Response.json(note, { status: 201 });
  }
}

const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
const drivers = PGSQL_URL ? (['sqlite', 'pgsql'] as const) : (['sqlite'] as const);

describe.each(drivers)('a refreshed database on %s', (driver) => {
  const definition: ApplicationOptions = {
    root: tmpdir(),
    discover: false,
    env: { APP_KEY: generateKey(), ...(driver === 'pgsql' ? { DB_CONNECTION: 'pgsql', DB_URL: PGSQL_URL } : { DB_DATABASE: ':memory:' }) },
    providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider],
    modules: [
      defineModule({
        name: 'notes',
        migrations: new URL('./__fixtures__/migrations/', import.meta.url),
        seeders: [WelcomeNoteSeeder],
        routes: defineRoutes((Route) => Route.post('/notes', CreateNoteController)),
      }),
    ],
  };

  let app: TestApp;
  let previous: TestApp | undefined;
  beforeEach(async () => {
    previous = app;
    app = await createTestApp(definition, { database: 'refresh' });
  });

  it('starts migrated and empty, and sees what the test creates', async () => {
    await app.assertDatabaseCount<'notes', NotesTables>('notes', 0);
    await app.factory(NoteFactory).count(2).create();
    await app.assertDatabaseHas<'notes', NotesTables>('notes', { title: 'Note 2', pinned: false });
    await app.assertDatabaseCount<'notes', NotesTables>('notes', 2);
  });

  it('starts empty again: the previous test was rolled back — and its app closed when it ended', async () => {
    await app.assertDatabaseCount<'notes', NotesTables>('notes', 0);
    expect(() => previous!.make(Connections).get()).toThrow('The database connections are closed');
  });

  it('keeps what a request wrote in its own transaction until the test ends', async () => {
    await app.expectingJson().post('/notes').assertStatus(201).assertJson({ title: 'From a request', pinned: false });
    await app.assertDatabaseHas<'notes', NotesTables>('notes', { title: 'From a request' });
  });

  it('seeds per test when asked to — one database app at a time', async () => {
    await expect(createTestApp(definition, { database: 'refresh', seed: true })).rejects.toThrow(
      "Another test app with database: 'refresh' is still open. Close it first (await app.close())",
    );
    await app.close();
    const seeded = await createTestApp(definition, { database: 'refresh', seed: true });
    await seeded.assertDatabaseHas<'notes', NotesTables>('notes', { title: 'Welcome', pinned: true });
    await seeded.close();
    const next = await createTestApp(definition, { database: 'refresh' });
    await next.assertDatabaseMissing<'notes', NotesTables>('notes', { title: 'Welcome' });
  });

  it('explains failed database assertions with what the table holds', async () => {
    await app.factory(NoteFactory).create({ title: 'Shopping' });
    await expect(app.assertDatabaseHas<'notes', NotesTables>('notes', { title: 'Groceries' })).rejects.toThrow(
      /Expected a row in "notes" matching \{"title":"Groceries"\} — found none\.\n {2}The table has 1 rows, e\.g\.:\n {4}\{"id":\d+,"title":"Shopping","pinned":false\}/,
    );
    await expect(app.assertDatabaseMissing<'notes', NotesTables>('notes', { title: 'Shopping' })).rejects.toThrow('Expected no row in "notes" matching {"title":"Shopping"} — found 1.');
    await expect(app.assertDatabaseCount<'notes', NotesTables>('notes', 3)).rejects.toThrow('Expected 3 rows in "notes" — found 1.');
  });
});

it('types database assertions by the table', () => void (async (app: TestApp) => {
  await app.assertDatabaseHas<'notes', NotesTables>('notes', { title: 'x', pinned: true });
  // @ts-expect-error — (1) unknown column
  await app.assertDatabaseHas<'notes', NotesTables>('notes', { titel: 'x' });
  // @ts-expect-error — (2) wrong value type
  await app.assertDatabaseMissing<'notes', NotesTables>('notes', { pinned: 'yes' });
  // @ts-expect-error — (3) unknown table
  await app.assertDatabaseCount<'nodes', NotesTables>('nodes', 1);
}));

describe('createTestApp options', () => {
  it('only seeds a refreshed database', async () => {
    await expect(createTestApp({ root: tmpdir(), discover: false, env: {} }, { seed: true })).rejects.toThrow("add database: 'refresh'");
  });
});
