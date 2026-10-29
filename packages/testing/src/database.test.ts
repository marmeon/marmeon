import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { Connections, DatabaseConnectionError, DatabaseServiceProvider, defineFactory, sql, type Generated, type SeedContext } from '@marmeon/database';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { prepareWorkerDatabase, workerDatabase } from './database.ts';
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

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, hostname: vi.fn(original.hostname) };
});

describe('where the worker databases live', () => {
  const env = { APP_KEY: 'unused' };

  it('puts the SQLite file inside the app, one per worker — never in the shared temporary directory', async () => {
    const root = workspaceTempDir('marmeon-testing-db-');
    const worker = await workerDatabase(root, env);
    expect(worker.key).toBe(join(root, 'storage', 'framework', 'testing', `database-${process.pid}-${threadId}.sqlite`));
    expect(worker.env.DB_DATABASE).toBe(worker.key);
  });

  it('deletes the files of processes that are gone, and keeps those of live ones and any other name', async () => {
    const root = workspaceTempDir('marmeon-testing-db-');
    const folder = join(root, 'storage', 'framework', 'testing');
    mkdirSync(folder, { recursive: true });
    // PID 2^22 + 1 is above Linux's default maximum, and macOS's.
    const gone = ['database-4194305-1.sqlite', 'database-4194305-1.sqlite-wal'].map((name) => join(folder, name));
    const live = join(folder, `database-${process.ppid}-1.sqlite`);
    const other = join(folder, 'notes.sqlite');
    const oldName = join(folder, 'database-3.sqlite');
    for (const file of [...gone, live, other, oldName]) writeFileSync(file, '');
    await workerDatabase(root, env);
    expect(gone.some((file) => existsSync(file))).toBe(false);
    expect(existsSync(oldName)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(other)).toBe(true);
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

  const pgsql = { DB_DRIVER: 'pgsql', DB_URL: 'postgres://u:p@localhost:5432/shop' };

  it('names a Postgres database after the configured one, with _test_, the root’s hash and the worker process', async () => {
    vi.stubEnv('MARMEON_TEST_DATABASE_TAG', '');
    try {
      const worker = await workerDatabase('/some/app', { ...env, ...pgsql });
      expect(new URL(worker.key).pathname).toMatch(new RegExp(`^/shop_test_[0-9a-z]+_${process.pid}_${threadId}$`));
      expect(worker.adminUrl).toBe('postgres://u:p@localhost:5432/shop');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('puts the checkout’s tag of a run of the repository’s tests in front of the root’s hash', async () => {
    vi.stubEnv('MARMEON_TEST_DATABASE_TAG', 'abcd1234');
    try {
      const worker = await workerDatabase('/some/app', { ...env, ...pgsql });
      expect(new URL(worker.key).pathname).toMatch(new RegExp(`^/shop_test_abcd1234_[0-9a-z]+_${process.pid}_${threadId}$`));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names the databases of two processes that share a pool slot differently', async () => {
    vi.stubEnv('VITEST_POOL_ID', '1');
    const original = process.pid;
    try {
      const first = await workerDatabase('/some/app', { ...env, ...pgsql });
      Object.defineProperty(process, 'pid', { value: original + 1, configurable: true });
      const second = await workerDatabase('/some/app', { ...env, ...pgsql });
      expect(second.key).not.toBe(first.key);
    } finally {
      Object.defineProperty(process, 'pid', { value: original, configurable: true });
      vi.unstubAllEnvs();
    }
  });

  it('names the databases of two hosts that share a root and a process id differently', async () => {
    const real = os.hostname();
    try {
      vi.mocked(os.hostname).mockReturnValue('host-a');
      const first = await workerDatabase('/app', { ...env, ...pgsql });
      vi.mocked(os.hostname).mockReturnValue('host-b');
      const second = await workerDatabase('/app', { ...env, ...pgsql });
      expect(second.key).not.toBe(first.key);
    } finally {
      vi.mocked(os.hostname).mockReturnValue(real);
    }
  });

  it('keeps the name within the 63 bytes Postgres allows, whatever the database is called and however long the ids', async () => {
    const original = process.pid;
    Object.defineProperty(process, 'pid', { value: 4194304, configurable: true });
    try {
      const worker = await workerDatabase('/some/app', { ...env, DB_DRIVER: 'pgsql', DB_URL: `postgres://u:p@localhost:5432/${'long'.repeat(30)}` });
      const name = new URL(worker.key).pathname.slice(1);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
      expect(name).toMatch(new RegExp(`_4194304_${threadId}$`));
    } finally {
      Object.defineProperty(process, 'pid', { value: original, configurable: true });
    }
  });

  it('shortens a long name by whole characters, so that an emoji is never cut in half', async () => {
    const worker = await workerDatabase('/some/app', { ...env, DB_DRIVER: 'pgsql', DB_URL: `postgres://u:p@localhost:5432/${encodeURI('😀'.repeat(10))}` });
    const name = decodeURI(new URL(worker.key).pathname.slice(1));
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(name.isWellFormed()).toBe(true);
    expect(name).toMatch(/^(?:😀)+_test_/u);
  });

  it('refuses a "%" in the name, which the driver would read as another one', async () => {
    await expect(workerDatabase('/some/app', { ...env, DB_DRIVER: 'pgsql', DB_URL: 'postgres://u:p@localhost:5432/a%25b' })).rejects.toThrow('does not survive being written into the URL');
  });

  it('keeps an escaped "#" as the driver reads it: decodeURI leaves "%23" alone, so the name holds it literally', async () => {
    const worker = await workerDatabase('/some/app', { ...env, DB_DRIVER: 'pgsql', DB_URL: 'postgres://u:p@localhost:5432/a%23b' });
    expect(new URL(worker.key).pathname).toMatch(/^\/a%23b_test_/);
    expect(new URL(worker.env.DB_URL!).pathname).toBe(new URL(worker.key).pathname);
  });

  it('refuses a name that cannot fit rather than let Postgres cut it', async () => {
    vi.stubEnv('MARMEON_TEST_DATABASE_TAG', 'x'.repeat(60));
    try {
      await expect(workerDatabase('/some/app', { ...env, ...pgsql })).rejects.toThrow('longer than the 63 bytes');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe.skipIf(!PGSQL_URL)('stale worker databases on Postgres', () => {
  it('drops those of this root whose process is gone, and keeps live ones, other roots’ and the main database — in an app whose database name has a dot', async () => {
    const root = workspaceTempDir('marmeon-testing-db-');
    const main = new URL(PGSQL_URL!);
    const env = { APP_KEY: generateKey(), DB_DRIVER: 'pgsql', DB_URL: PGSQL_URL };
    const dotted = new URL(PGSQL_URL!);
    dotted.pathname = '/marmeon.dot';
    const dottedEnv = { ...env, DB_URL: dotted.href };
    await expectSweep(root, env, main.pathname.slice(1));
    await expectSweep(workspaceTempDir('marmeon-testing-db-'), dottedEnv, 'marmeon.dot');
  });
});

describe.skipIf(!PGSQL_URL)('a configured database that does not exist on Postgres', () => {
  it('runs through the maintenance database and leaves the configured name uncreated', async () => {
    const missing = `missing_${process.pid}_${Date.now().toString(36)}`;
    const url = new URL(PGSQL_URL!);
    url.pathname = `/${missing}`;
    const env = { APP_KEY: generateKey(), DB_DRIVER: 'pgsql', DB_URL: url.href };
    const root = workspaceTempDir('marmeon-testing-db-');
    const worker = new URL((await workerDatabase(root, env)).key).pathname.slice(1);
    const admin = new Connections({ connections: { default: { driver: 'pgsql', url: new URL(PGSQL_URL!).href, poolMax: 1 } }, root: '/', logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
    try {
      const app = await createTestApp({ root, discover: false, providers: [EncryptionServiceProvider, DatabaseServiceProvider] }, { env, database: 'refresh' });
      const { rows } = await sql<{ datname: string }>`select datname from pg_database where datname in (${missing}, ${worker})`.execute(admin.get());
      await app.close();
      expect(rows.map((row) => row.datname)).toEqual([worker]);
    } finally {
      await sql`drop database if exists ${sql.id(worker)} with (force)`.execute(admin.get());
      await admin.destroy();
    }
  });
});

describe.skipIf(!PGSQL_URL)('a database name with non-ASCII characters on Postgres', () => {
  it('creates the worker database under the decoded name the driver connects to', async () => {
    const configured = `caf\u00e9_${process.pid}_${Date.now().toString(36)}`;
    const admin = new Connections({ connections: { default: { driver: 'pgsql', url: new URL(PGSQL_URL!).href, poolMax: 1 } }, root: '/', logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
    const url = new URL(PGSQL_URL!);
    url.pathname = `/${encodeURIComponent(configured)}`;
    const env = { APP_KEY: generateKey(), DB_DRIVER: 'pgsql', DB_URL: url.href };
    const root = workspaceTempDir('marmeon-testing-db-');
    const worker = decodeURIComponent(new URL((await workerDatabase(root, env)).key).pathname.slice(1));
    expect(worker.startsWith(`${configured}_test_`)).toBe(true);
    try {
      await sql`create database ${sql.id(configured)}`.execute(admin.get());
      const app = await createTestApp({ root, discover: false, providers: [EncryptionServiceProvider, DatabaseServiceProvider] }, { env, database: 'refresh' });
      const { rows } = await sql<{ name: string }>`select current_database() as name`.execute(app.container.make(Connections).get());
      await app.close();
      expect(rows[0]?.name).toBe(worker);
    } finally {
      await sql`drop database if exists ${sql.id(worker)} with (force)`.execute(admin.get());
      await sql`drop database if exists ${sql.id(configured)} with (force)`.execute(admin.get());
      await admin.destroy();
    }
  });
});

describe('a configured database that does not exist, with no way around it', () => {
  const missing = Object.assign(new Error('[marmeon:D11] Could not connect: database "shop" does not exist'), { cause: { code: '3D000' } });
  /** A `Connections` that refuses every attempt with `failure`, and records the URL of each; `url` is the worker database the app names. */
  const run = async (urls: string[], failure: (url: string) => Error = () => missing, url = 'postgres://u:p@localhost:5432/shop_test_x_1_1'): Promise<unknown> => {
    class Refusing {
      constructor(options: { connections: { default: { url: string } } }) {
        urls.push(options.connections.default.url);
        throw failure(options.connections.default.url);
      }
    }
    const database = { Connections: Refusing, DatabaseConnectionError } as never;
    const app = { root: '/', container: { make: (token: unknown) => (token === Refusing ? { options: () => ({ driver: 'pgsql', url }) } : {}) } } as never;
    const worker = { key: 'postgres://u:p@localhost:5432/shop_test_x_1_1', env: {}, adminUrl: 'postgres://u:p@localhost:5432/shop' };
    return prepareWorkerDatabase(database, app, worker).catch((error: unknown) => error);
  };
  const refused = (message: string) => new DatabaseConnectionError(`[marmeon:D11] ${message}`);
  const maintenanceRefused = (url: string) => (url.endsWith('/postgres') ? refused('password authentication failed') : missing);

  it('tries the maintenance database next, then says to create the configured one — still a D11 connection error', async () => {
    const urls: string[] = [];
    const error = (await run(urls, maintenanceRefused)) as Error;
    expect(urls).toEqual(['postgres://u:p@localhost:5432/shop', 'postgres://u:p@localhost:5432/postgres']);
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect(error.message).toMatch(/^\[marmeon:D11\] The test database "shop" does not exist/);
    expect(error.message).toContain('password authentication failed');
    expect(error.message.match(/\[marmeon:D11\]/g)).toHaveLength(1);
    expect(error.message).toContain(`create "shop" first; the run creates its workers' databases next to it.`);
  });

  it('passes on any other failure of the maintenance database unchanged', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: '42501' });
    const urls: string[] = [];
    expect(await run(urls, (url) => (url.endsWith('/postgres') ? denied : missing))).toBe(denied);
  });

  it('does not try it in a production run', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const urls: string[] = [];
      expect(await run(urls)).toBe(missing);
      expect(urls).toEqual(['postgres://u:p@localhost:5432/shop']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(['postgres://u:p@localhost:5432/shop', 'postgres://u:p@localhost:5432/shop_test_x'])('refuses to create %s, which is no worker database, before it connects', async (url) => {
    const urls: string[] = [];
    const error = (await run(urls, () => missing, url)) as Error;
    expect(error.message).toContain('it is not a worker database');
    expect(urls).toEqual([]);
  });
});

async function expectSweep(root: string, env: Record<string, string | undefined>, mainName: string): Promise<void> {
  const adminUrl = new URL(PGSQL_URL!).href;
  {
    const own = new URL((await workerDatabase(root, env)).key).pathname.slice(1);
    const prefix = own.replace(/\d+_\d+$/, '');
    const other = new URL((await workerDatabase(`${root}-other`, env)).key).pathname.slice(1).replace(/\d+_\d+$/, '');
    const dead = `${prefix}4194305_1`;
    const live = `${prefix}${process.ppid}_1`;
    const foreign = `${other}4194305_1`;
    const lookalike = `${prefix}4194305_1_x`;
    // The dot is a regex wildcard: this name matches an unescaped pattern and must stay.
    const wildcard = prefix.replace('.', 'X') + '4194305_1';
    const admin = new Connections({ connections: { default: { driver: 'pgsql', url: adminUrl, poolMax: 1 } }, root: '/', logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } });
    const names = [dead, live, foreign, lookalike, ...(wildcard === dead ? [] : [wildcard]), ...(mainName === new URL(PGSQL_URL!).pathname.slice(1) ? [] : [mainName])];
    try {
      for (const name of names) await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin.get());
      for (const name of names) await sql`create database ${sql.id(name)}`.execute(admin.get());
      const app = await createTestApp({ root, discover: false, providers: [EncryptionServiceProvider, DatabaseServiceProvider] }, { env, database: 'refresh' });
      await app.close();
      const { rows } = await sql<{ datname: string }>`select datname from pg_database`.execute(admin.get());
      const left = rows.map((row) => row.datname);
      expect(left).not.toContain(dead);
      expect(left).toEqual(expect.arrayContaining([live, foreign, lookalike, own, mainName, ...(wildcard === dead ? [] : [wildcard])]));
    } finally {
      for (const name of [...names, own]) await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    }
  }
}
