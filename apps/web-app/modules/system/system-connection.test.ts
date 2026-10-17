import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache, RateLimiter } from '@marmeon/cache';
import { Connections, Migrator, sql } from '@marmeon/database';
import { Queue } from '@marmeon/queue';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import { SendWelcomeMailJob } from '../auth/jobs/SendWelcomeMailJob.ts';

class Rollback extends Error {}

// This app's own setup (.env.example): the cache — with the rate limits and locks — and the sessions live on the
// `system` connection, a SQLite file of their own (config/database.ts). They never join the app's transactions; the queue
// does (a job is part of the transaction that dispatched it). The other tests keep the memory stores (.env.test).
describe('the system connection', () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  const open = async (): Promise<TestApp> => {
    directory = mkdtempSync(join(tmpdir(), 'marmeon-web-system-'));
    const app = await createTestApp(application, {
      queue: 'real',
      env: {
        // The SQLite setup of .env.example — also under `pnpm test:pgsql` (on Postgres the stores need no system file).
        DB_CONNECTION: 'sqlite',
        DB_DATABASE: join(directory, 'database.sqlite'),
        SYSTEM_DB_DATABASE: join(directory, 'system.sqlite'),
        CACHE_DRIVER: 'database',
        CACHE_CONNECTION: 'system',
        SESSION_DRIVER: 'database',
        SESSION_CONNECTION: 'system',
      },
    });
    await app.make(Migrator).migrate();
    return app;
  };
  const tables = async (app: TestApp, connection: string) =>
    (await app.make(Connections).get(connection).introspection.getTables()).map((table) => table.name).sort();

  it('migrates the cache and session tables into the system file — the rest, the jobs included, into the app’s', async () => {
    const app = await open();
    expect(await tables(app, 'system')).toEqual(['cache', 'cache_locks', 'marmeon_schema_markers', 'marmeon_secret_columns', 'marmeon_table_owners', 'marmeon_versions', 'sessions']);
    const own = await tables(app, 'default');
    expect(own).toEqual(expect.arrayContaining(['users', 'jobs', 'failed_jobs', 'marmeon_migrations']));
    expect(own).not.toEqual(expect.arrayContaining(['cache']));
    expect(own).not.toEqual(expect.arrayContaining(['sessions']));
  });

  it('keeps a rate-limit hit and a lock taken inside a transaction that rolls back — but not the job it dispatched', async () => {
    const app = await open();
    const connections = app.make(Connections);
    await expect(
      connections.transaction(async () => {
        expect(await app.make(RateLimiter).hit('login:ada@example.com', 60)).toBe(1);
        expect(await app.make(Cache).lock('unique:welcome:1', 60).get()).toBe(true);
        await app.make(Queue).dispatch(SendWelcomeMailJob, { userId: 1 });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await app.make(RateLimiter).attempts('login:ada@example.com')).toBe(1);
    expect(await app.make(Cache).lock('unique:welcome:1', 60).get()).toBe(false); // still held
    expect((await sql<{ n: number }>`select count(*) as n from jobs`.execute(connections.get())).rows[0]!.n).toBe(0);
  });

  it('signs in and out with the sessions in the system file', async () => {
    const app = await open();
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const rows = async () =>
      (await sql<{ user_id: string | null }>`select user_id from sessions`.execute(app.make(Connections).get('system'))).rows.map((row) => row.user_id);
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect('/users/me').assertAuthenticated(ada);
    expect(await rows()).toEqual([String(ada.id)]);
    await app.withCookie('marmeon_session', login.cookie('marmeon_session')!).post('/logout').assertRedirect('/login').assertGuest();
    expect(await rows()).toEqual([null]);
  });
});
