import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, defineFactory, type Generated, type SeedContext } from '@marmeon/database';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { workerDatabase } from './database.ts';
import { createTestApp, type TestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

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
  const env = { APP_KEY: generateKey(), ...(driver === 'pgsql' ? { DB_DRIVER: 'pgsql', DB_URL: PGSQL_URL } : { DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' }) };
  const definition: ApplicationDefinition = {
    root: workspaceTempDir('marmeon-testing-db-'),
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider],
    modules: [
      defineModule({
        name: 'notes',
        migrations: new URL('./__fixtures__/migrations/', import.meta.url),
        seeders: [WelcomeNoteSeeder],
        routes: openRoutes((Route) => Route.post('/notes', CreateNoteController)),
      }),
    ],
  };

  let app: TestApp;
  let previous: TestApp | undefined;
  beforeEach(async () => {
    previous = app;
    app = await createTestApp(definition, { env, database: 'refresh' });
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
    await expect(createTestApp(definition, { env, database: 'refresh', seed: true })).rejects.toThrow(
      "Another test app with database: 'refresh' is still open. Close it first (await app.close())",
    );
    await app.close();
    const seeded = await createTestApp(definition, { env, database: 'refresh', seed: true });
    await seeded.assertDatabaseHas<'notes', NotesTables>('notes', { title: 'Welcome', pinned: true });
    await seeded.close();
    const next = await createTestApp(definition, { env, database: 'refresh' });
    await next.assertDatabaseMissing<'notes', NotesTables>('notes', { title: 'Welcome' });
  });

  it('cleans up after a test that closed its database connections itself — its writes undone, no "database is not open"', async () => {
    await app.factory(NoteFactory).create({ title: 'Closed over' });
    await app.make(Connections).destroy();
    const closed = await app.close().then(() => 'closed', (error: unknown) => String(error));
    expect(closed).toBe('closed');
    const next = await createTestApp(definition, { env, database: 'refresh' });
    await next.assertDatabaseMissing<'notes', NotesTables>('notes', { title: 'Closed over' });
    await next.close();
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
    await expect(createTestApp({ root: workspaceTempDir('marmeon-testing-db-'), discover: false }, { env: {}, seed: true })).rejects.toThrow("add database: 'refresh'");
  });
});

describe('a test app that is ready after its test ended (a hook that timed out)', () => {
  let open!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const booting = new Promise<void>((resolve) => (reached = resolve));
  class Gate {
    async boot() {
      reached();
      await gate;
    }
  }
  // Seeding is where a late app would stand open (and hold the worker's database) if it were counted before it is refused.
  let releaseSeeding!: () => void;
  const seeding = new Promise<void>((resolve) => (releaseSeeding = resolve));
  class SlowSeeder {
    async handle() {
      await seeding;
    }
  }
  const definition: ApplicationDefinition = {
    root: workspaceTempDir('marmeon-testing-db-'),
    discover: false,
    providers: [EncryptionServiceProvider, DatabaseServiceProvider, Gate],
    modules: [defineModule({ name: 'slow', seeders: [SlowSeeder] })],
  };
  const env = { APP_KEY: generateKey(), DB_DRIVER: 'sqlite', DB_URL: undefined };
  let late: Promise<TestApp>;

  // The worker's database is created and migrated by the first app: not inside the late one's race.
  beforeAll(async () => {
    const warm = await createTestApp({ ...definition, providers: [EncryptionServiceProvider, DatabaseServiceProvider] }, { env, database: 'refresh' });
    await warm.close();
  });

  it('starts an app that the test does not wait for', async () => {
    late = createTestApp(definition, { env, database: 'refresh', seed: true });
    late.catch(() => {});
    await booting;
  });

  it('closes that app when it is ready, and never lets it stand in the way of the next test app', async () => {
    const withoutGate = { ...definition, providers: [EncryptionServiceProvider, DatabaseServiceProvider] };
    const next = createTestApp(withoutGate, { env, database: 'refresh' });
    open();
    const [nextResult] = await Promise.allSettled([next]);
    releaseSeeding();
    const [lateResult] = await Promise.allSettled([late]);
    expect(lateResult).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('before this test app was ready') }) });
    expect(nextResult.status).toBe('fulfilled');
    await (nextResult as PromiseFulfilledResult<TestApp>).value.close();
    await (await createTestApp(withoutGate, { env, database: 'refresh' })).close();
  });
});

describe('where the worker databases live', () => {
  const env = { APP_KEY: 'unused' };

  it('puts the SQLite file inside the app, one per worker — never in the shared temporary directory', async () => {
    const root = workspaceTempDir('marmeon-testing-db-');
    const worker = await workerDatabase(root, env);
    expect(worker.key).toBe(join(root, 'storage', 'framework', 'testing', `database-${process.env.VITEST_POOL_ID ?? '0'}.sqlite`));
    expect(worker.env.DB_DATABASE).toBe(worker.key);
  });

  it('creates the folder in a root that has no storage directory', async () => {
    const root = workspaceTempDir('marmeon-testing-db-');
    const app = await createTestApp(
      { root, discover: false, providers: [EncryptionServiceProvider, DatabaseServiceProvider] },
      { env: { APP_KEY: generateKey(), DB_DRIVER: 'sqlite', DB_URL: undefined }, database: 'refresh' },
    );
    try {
      expect(existsSync(join(root, 'storage', 'framework', 'testing'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('names a Postgres database as before: the configured one, with _test_, the root’s hash and the worker', async () => {
    const worker = await workerDatabase('/some/app', {
      ...env,
      DB_DRIVER: 'pgsql',
      DB_URL: 'postgres://u:p@localhost:5432/shop',
    });
    expect(new URL(worker.key).pathname).toMatch(/^\/shop_test_[0-9a-z]+_\d+$/);
    expect(worker.adminUrl).toBe('postgres://u:p@localhost:5432/shop');
  });
});
