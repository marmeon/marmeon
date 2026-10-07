import { tmpdir } from 'node:os';
import { createApplication } from '@marmeon/core';
import { sql, type Generated, type Kysely } from 'kysely';
import { jsonArrayFrom as pgJsonArrayFrom } from 'kysely/helpers/postgres';
import { jsonArrayFrom as sqliteJsonArrayFrom } from 'kysely/helpers/sqlite';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import { Connections, Database, DatabaseConnectionError, DatabaseServiceProvider, defineConnection, type QueryEvent } from './index.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

interface TestTables {
  users: { id: Generated<number>; name: string; is_admin: Generated<boolean>; settings: unknown; bio: string | null; created_at: Generated<string> };
  posts: { id: Generated<number>; user_id: number; title: string };
}

async function createTables(db: Kysely<any>, driver: 'sqlite' | 'pgsql') {
  const id = driver === 'sqlite' ? ('integer' as const) : ('bigint' as const);
  await db.schema
    .createTable('users')
    .addColumn('id', id, (c) => (driver === 'sqlite' ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity()))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('is_admin', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('settings', driver === 'sqlite' ? 'json' : 'jsonb')
    .addColumn('bio', 'text')
    .addColumn('created_at', driver === 'sqlite' ? 'datetime' : 'timestamptz(3)', (c) =>
      c.notNull().defaultTo(driver === 'sqlite' ? sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` : sql`now()`),
    )
    .execute();
  await db.schema
    .createTable('posts')
    .addColumn('id', id, (c) => (driver === 'sqlite' ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity()))
    .addColumn('user_id', id, (c) => c.notNull().references('users.id'))
    .addColumn('title', 'text', (c) => c.notNull())
    .execute();
}

const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describe.each(drivers)('a %s connection', (driver) => {
  let connections: Connections;
  let db: Kysely<TestTables>;
  let drop: () => Promise<void>;
  const queries: QueryEvent[] = [];
  const jsonArrayFrom = driver === 'sqlite' ? sqliteJsonArrayFrom : pgJsonArrayFrom;

  beforeAll(async () => {
    const fresh = await freshDatabase(driver);
    drop = fresh.drop;
    connections = new Connections({ connections: { default: fresh.options }, root: '/', logger: silent });
    connections.onQuery((query) => queries.push(query));
    db = connections.get<TestTables>();
    await createTables(db, driver);
  });
  afterAll(async () => {
    await connections.destroy();
    await drop();
  });

  it('returns the same JavaScript types on every driver', async () => {
    const at = new Date('2026-10-01T12:34:56.789Z');
    const user = await db
      .insertInto('users')
      .values({ name: 'Ada', is_admin: true, settings: JSON.stringify({ theme: 'dark' }), bio: '[not json]', created_at: at as never })
      .returningAll()
      .executeTakeFirstOrThrow();
    expect(user).toEqual({ id: 1, name: 'Ada', is_admin: true, settings: { theme: 'dark' }, bio: '[not json]', created_at: '2026-10-01T12:34:56.789Z' });
    const defaults = await db.insertInto('users').values({ name: 'Alan', settings: null }).returning(['id', 'is_admin', 'created_at']).executeTakeFirstOrThrow();
    expect(defaults).toEqual({ id: 2, is_admin: false, created_at: expect.stringMatching(ISO_UTC) });
  });

  it('commits and rolls back transactions', async () => {
    await db.transaction().execute((trx) => trx.insertInto('posts').values({ user_id: 1, title: 'Kept' }).execute());
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('posts').values({ user_id: 1, title: 'Lost' }).execute();
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await db.selectFrom('posts').select('title').execute()).toEqual([{ title: 'Kept' }]);
  });

  it('isolates a connection in a transaction, where the code’s own transactions become savepoints', async () => {
    // What a test wrapped in a transaction (E21) looks like to the code under test.
    const isolation = await connections.isolate();
    await db.insertInto('posts').values({ user_id: 1, title: 'Undone with the test' }).execute();
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('posts').values({ user_id: 1, title: 'Undone by its own rollback' }).execute();
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await db.transaction().execute((trx) => trx.insertInto('posts').values({ user_id: 1, title: 'Committed, then undone with the test' }).execute());
    expect((await db.selectFrom('posts').select('title').orderBy('id').execute()).map((post) => post.title)).toEqual([
      'Kept',
      'Undone with the test',
      'Committed, then undone with the test',
    ]);
    await isolation.rollback();

    expect((await db.selectFrom('posts').select('title').execute()).map((post) => post.title)).toEqual(['Kept']);
    expect(queries.filter((q) => /savepoint/i.test(q.sql)).map((q) => q.sql)).toEqual([
      'savepoint marmeon_savepoint_1',
      'rollback to savepoint marmeon_savepoint_1',
      'savepoint marmeon_savepoint_1',
      'release savepoint marmeon_savepoint_1',
    ]);
  });

  it('keeps using the pool once the isolation is rolled back', async () => {
    const isolation = await connections.isolate();
    await expect(connections.isolate()).rejects.toThrow('is already isolated');
    await isolation.rollback();
    await isolation.rollback(); // twice is harmless
    await db.transaction().execute((trx) => trx.insertInto('posts').values({ user_id: 1, title: 'Outer' }).execute());
    await db.transaction().execute((trx) => trx.insertInto('posts').values({ user_id: 1, title: 'Inner, kept' }).execute());
  });

  it('loads a relation in one query, parsed', async () => {
    queries.length = 0;
    const user = await db
      .selectFrom('users')
      .select((eb) => ['name', jsonArrayFrom(eb.selectFrom('posts').select(['posts.id', 'posts.title']).whereRef('posts.user_id', '=', 'users.id').orderBy('posts.id')).as('posts')])
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    expect(user.posts.map((post) => post.title)).toEqual(['Kept', 'Outer', 'Inner, kept']);
    expect(typeof user.posts[0]!.id).toBe('number');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ connection: 'default', sql: expect.stringMatching(/^select/), parameters: [1] });
    expect(queries[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs failed queries with their error', async () => {
    queries.length = 0;
    await expect(sql`select * from missing_table`.execute(db)).rejects.toThrow();
    expect(queries).toEqual([expect.objectContaining({ sql: 'select * from missing_table', error: expect.anything() })]);
  });
});

describe('the SQLite adapter', () => {
  const connections = new Connections({ connections: { default: { driver: 'sqlite', database: ':memory:' } }, root: '/', logger: silent });
  const db = connections.get<Record<string, never>>();
  afterAll(() => connections.destroy());

  it('rejects values SQLite cannot store instead of storing NULL', async () => {
    // node:sqlite would read an object as named parameters and bind nothing.
    await expect(sql`select ${{ theme: 'dark' }} as v`.execute(db)).rejects.toThrow('SQLite cannot bind parameter 1 of type Object');
    await expect(sql`select ${undefined} as v`.execute(db)).rejects.toThrow('of type undefined');
    await expect(sql`select ${new Date(Number.NaN)} as v`.execute(db)).rejects.toThrow('Invalid Date');
    const { rows } = await sql<{ at: string; yes: number; bytes: Uint8Array }>`select ${new Date(0)} as at, ${true} as yes, ${new Uint8Array([1])} as bytes`.execute(db);
    expect(rows[0]).toEqual({ at: '1970-01-01T00:00:00.000Z', yes: 1, bytes: new Uint8Array([1]) });
  });
});

describe.runIf(drivers.includes('pgsql' as never))('a Postgres pool', () => {
  it('survives an idle connection being terminated by the server — instead of crashing the process', async () => {
    const { freshConnections } = await import('./__fixtures__/databases.ts');
    const { connections, close } = await freshConnections('pgsql');
    const warnings: string[] = [];
    const logged = new Connections({
      connections: { default: connections.options() },
      root: '/',
      logger: Object.assign(Object.create(silent), { child: () => ({ ...silent, warn: (message: string) => warnings.push(message) }) }),
    });
    const db = logged.get();
    const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
    await sql`select pg_terminate_backend(${rows[0]!.pid})`.execute(connections.get()); // the admin kills the idle connection
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(warnings).toEqual(['An idle database connection failed; the pool replaces it']);
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows).toEqual([{ one: 1 }]); // and it keeps working
    await logged.destroy();
    await close();
  });
});

describe('connection errors', () => {
  it('name the connection and where it points — never the password', async () => {
    const connections = new Connections({
      connections: { default: { driver: 'pgsql', url: 'postgres://app:hunter2@127.0.0.1:1/app' } },
      root: '/',
      logger: silent,
    });
    const error = await sql`select 1`.execute(connections.get()).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect((error as Error).message).toMatch(/^Could not connect to the database connection "default" \(pgsql postgres:\/\/app:\*\*\*@127\.0\.0\.1:1\/app\): .*ECONNREFUSED/);
    expect((error as Error).message).not.toContain('hunter2');
    await connections.destroy();
  });

  it('report a missing SQLite directory at boot, and unknown connections by name', () => {
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: 'nope/db.sqlite' } }, root: tmpdir(), logger: silent });
    expect(() => connections.verify()).toThrow(/directory of the SQLite database for connection "default" does not exist: .*nope/);
    expect(() => connections.get('reporting')).toThrow('Database connection "reporting" is not configured. Known: default.');
  });
});

describe('DatabaseServiceProvider', () => {
  const root = tempDir('marmeon-db-');
  const Reporting = defineConnection('reporting', {
    env: v.object({ REPORTING_DB: v.string() }),
    resolve: (env) => ({ driver: 'sqlite', database: env.REPORTING_DB }),
  });

  it('binds the default Database and named connections, and closes them on shutdown', async () => {
    const app = await createApplication({
      root,
      discover: false,
      env: { DB_DATABASE: 'app.sqlite', REPORTING_DB: ':memory:' },
      config: [Reporting],
      providers: [DatabaseServiceProvider],
    });
    const db = app.container.make(Database);
    const connections = app.container.make(Connections);
    expect(db).toBe(connections.get());
    expect(connections.names()).toEqual(['default', 'reporting']);
    await sql`create table t (x integer)`.execute(db);
    expect(connections.options()).toEqual({ driver: 'sqlite', database: 'app.sqlite' });
    expect((await sql<{ x: number }>`select 1 as x`.execute(connections.get('reporting'))).rows).toEqual([{ x: 1 }]);

    await app.shutdown();
    expect(() => connections.get()).toThrow('The database connections are closed');
  });

  it('builds a Postgres URL from DB_HOST & co., and validates DB_URL at startup', async () => {
    const pgsql = await createApplication({
      root,
      discover: false,
      env: { DB_CONNECTION: 'pgsql', DB_HOST: 'db.internal', DB_PORT: '6543', DB_DATABASE: 'shop', DB_USERNAME: 'shop', DB_PASSWORD: 's3cr€t' },
      providers: [DatabaseServiceProvider],
    });
    expect(pgsql.container.make(Connections).options()).toEqual({ driver: 'pgsql', url: 'postgres://shop:s3cr%E2%82%ACt@db.internal:6543/shop', poolMax: 10, infrastructurePoolMax: 4 });
    await pgsql.shutdown();
    await expect(
      createApplication({ root, discover: false, env: { DB_CONNECTION: 'pgsql', DB_URL: 'mysql://x' }, providers: [DatabaseServiceProvider] }),
    ).rejects.toThrow(/DB_URL.*postgres:\/\//);
  });
});
