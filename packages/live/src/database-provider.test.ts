import { rmSync } from 'node:fs';
import { createApplication, HealthChecks, Logger, type Application } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SessionEndings, SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { connectionsAt, freshPostgres, migrate, PGSQL_URL, sqliteTarget, type LiveTarget } from './__fixtures__/database.ts';
import { LiveHub } from './hub.ts';
import { Broadcaster, LiveServiceProvider } from './index.ts';
import { LiveStreamReader } from './test-stream.ts';

const cleanups: (() => Promise<void> | void)[] = [];
/** What the apps logged as an error. */
const errors: string[] = [];
const logging: Logger = { debug() {}, info() {}, warn() {}, error: (message) => void errors.push(message), child: () => logging };
afterEach(async () => {
  errors.length = 0;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const envOf = (target: LiveTarget, more: Record<string, string> = {}) => ({
  APP_KEY: generateKey(),
  NODE_ENV: 'test',
  LIVE_DRIVER: 'database',
  LIVE_POLL_MILLISECONDS: '50',
  SESSION_DRIVER: 'memory',
  ...(target.driver === 'sqlite' ? { DB_DRIVER: 'sqlite', DB_DATABASE: target.file } : { DB_DRIVER: 'pgsql', DB_URL: target.url }),
  DB_MANAGED: 'false',
  ...more,
});

async function boot(env: Record<string, string>, providers: Parameters<typeof createApplication>[0]['providers'] = [EncryptionServiceProvider, HttpServiceProvider, DatabaseServiceProvider, SessionServiceProvider, LiveServiceProvider]): Promise<Application> {
  const app = await createApplication({ root: import.meta.dirname, discover: false, providers }, { env, override: (container) => container.instance(Logger, logging) });
  cleanups.push(() => app.shutdown());
  return app;
}

/** The readiness checks that said something is wrong, by name. */
async function failing(app: Application): Promise<Record<string, string>> {
  const report = await app.container.make(HealthChecks).run(app.container);
  return Object.fromEntries(report.checks.filter((check) => check.status !== 'ok').map((check) => [check.name, String((check.error as Error | undefined)?.message ?? check.status)]));
}

function sqliteDirectory(): { directory: string; target: LiveTarget } {
  const directory = tempDir('marmeon-live-provider-');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, target: sqliteTarget(directory) };
}

describe('LIVE_DRIVER=database: what the start and readiness say', () => {
  it('stops the start without the database provider, naming the install and the table', async () => {
    const { target } = sqliteDirectory();
    const error = await boot(envOf(target), [EncryptionServiceProvider, HttpServiceProvider, LiveServiceProvider]).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^\[marmeon:H7\] LIVE_DRIVER=database needs @marmeon\/database and its provider/);
    expect((error as Error).message).toContain('marmeon make:live-table && marmeon migrate');
  });

  it('stops the start for a connection nobody defined (D11), as the sessions do', async () => {
    const { target } = sqliteDirectory();
    await expect(boot(envOf(target, { LIVE_CONNECTION: 'nowhere' }))).rejects.toThrow(/nowhere/);
  });

  it('is not ready while the table is missing, and names the command that creates it', async () => {
    const { target } = sqliteDirectory();
    const app = await boot(envOf(target));
    const problems = await failing(app);
    expect(problems['database']).toContain('live_hints is missing');
    expect(problems['live-table']).toContain('marmeon make:live-table && marmeon migrate');
  });

  it('is ready once the migration of make:live-table ran', async () => {
    const { target } = sqliteDirectory();
    const setup = connectionsAt(target);
    await migrate(setup);
    await setup.destroy();
    const app = await boot(envOf(target));
    expect(await failing(app)).toEqual({});
  });

  it('is not ready for a SQLite table whose id is a plain rowid — a pruned id would come back', async () => {
    const { target } = sqliteDirectory();
    const setup = connectionsAt(target);
    await sql`create table live_hints (id integer primary key, channel varchar(200), message text not null, created_at bigint not null)`.execute(setup.get());
    await setup.destroy();
    const problems = await failing(await boot(envOf(target)));
    expect(problems['live-table']).toMatch(/^\[marmeon:H7\] The live_hints table cannot serve LIVE_DRIVER=database: its id is not AUTOINCREMENT/);
    expect(problems['live-table']).toContain('marmeon make:live-table');
    expect(problems['database']).toBeUndefined();
  });

  it('is not ready when the table cannot be inspected — the check fails closed', async () => {
    const { target } = sqliteDirectory();
    const setup = connectionsAt(target);
    await migrate(setup);
    await setup.destroy();
    const app = await boot(envOf(target));
    app.container.make(Connections).get = () => {
      throw new Error('no access');
    };
    expect((await failing(app))['live-table']).toContain('no access');
  });

  it('adds no table check for the other drivers', async () => {
    const { target } = sqliteDirectory();
    const app = await boot(envOf(target, { LIVE_DRIVER: 'memory' }));
    expect(app.container.make(HealthChecks).all().map((check) => check.check)).not.toContain('live-table');
  });
});

describe('LIVE_DRIVER=database: the backend the provider builds', () => {
  it('a Broadcaster refresh inside a transaction is written after the commit, and not at all after a rollback', async () => {
    const { target } = sqliteDirectory();
    const setup = connectionsAt(target);
    await migrate(setup);
    await setup.destroy();
    const app = await boot(envOf(target));
    const connections = app.container.make(Connections);
    const count = async () => Number((await sql<{ n: number }>`select count(*) as n from live_hints`.execute(connections.get())).rows[0]!.n);
    await connections.transaction(async () => {
      await app.container.make(Broadcaster).refresh('orders.1');
      expect(await count()).toBe(0);
    });
    expect(await count()).toBe(1);
    class Rollback extends Error {}
    await expect(
      connections.transaction(async () => {
        await app.container.make(Broadcaster).refresh('orders.2');
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await count()).toBe(1);
    expect(errors).toEqual([]);
  });

  describe.each(['outside a transaction', 'inside one that commits', 'inside one that rolls back'] as const)('a sign-out in one app, %s', (where) => {
    it('closes the stream another app holds, through the shared file', async () => {
      const { target } = sqliteDirectory();
      const setup = connectionsAt(target);
      await migrate(setup);
      await setup.destroy();
      await signOutReachesOtherApp(target, where);
      expect(errors).toEqual([]);
    });
  });
});

/** App A ends a session inside a transaction while the backend cannot write (the table is gone): the failure is logged once and the app's `transaction()` is not told. */
async function failingSignOut(target: LiveTarget, outcome: 'commits' | 'rolls back'): Promise<void> {
  const app = await boot(envOf(target));
  const connections = app.container.make(Connections);
  await sql`drop table live_hints`.execute(connections.get());
  class Rollback extends Error {}
  const run = connections.transaction(async () => {
    await app.container.make(SessionEndings).ended('scope-of-adas-session');
    if (outcome === 'rolls back') throw new Rollback();
  });
  if (outcome === 'commits') await expect(run).resolves.toBeUndefined();
  else await expect(run).rejects.toBeInstanceOf(Rollback);
  expect(errors).toEqual(['The streams of a session that ended could not be closed (the live backend failed)']);
}

type Where = 'outside a transaction' | 'inside one that commits' | 'inside one that rolls back';

/** App A ends a session (as `StartSession` does), possibly inside a transaction; the stream app B holds closes, and A's connection was never asked to write inside it. */
async function signOutReachesOtherApp(target: LiveTarget, where: Where): Promise<void> {
  const a = await boot(envOf(target));
  const b = await boot(envOf(target));
  const hub = b.container.make(LiveHub);
  await hub.listen();
  const reader = new LiveStreamReader(await hub.open({ channels: ['orders.7'], scope: 'scope-of-adas-session', connection: 'tab-a-0001' }));
  cleanups.push(() => reader.close());
  await reader.hello();
  const end = () => a.container.make(SessionEndings).ended('scope-of-adas-session');
  class Rollback extends Error {}
  if (where === 'outside a transaction') await end();
  else {
    const run = a.container.make(Connections).transaction(async () => {
      await end();
      if (where === 'inside one that rolls back') throw new Rollback();
    });
    if (where === 'inside one that rolls back') await expect(run).rejects.toBeInstanceOf(Rollback);
    else await run;
  }
  await reader.closed;
  expect(reader.ended).toBe(true);
}

describe('a sign-out whose end cannot be written', () => {
  it.each(['commits', 'rolls back'] as const)('SQLite, inside a transaction that %s: logged once, never thrown', async (outcome) => {
    const { target } = sqliteDirectory();
    const setup = connectionsAt(target);
    await migrate(setup);
    await setup.destroy();
    await failingSignOut(target, outcome);
  });
});

describe.runIf(PGSQL_URL !== undefined)('LIVE_DRIVER=database on Postgres', () => {
  async function fresh() {
    const { target, drop } = await freshPostgres();
    cleanups.push(drop);
    return target;
  }

  it('is ready with the identity column of the migration', async () => {
    expect(await failing(await boot(envOf(await fresh())))).toEqual({});
  });

  it('is not ready for an id that is neither an identity nor a serial column', async () => {
    const target = await fresh();
    const setup = connectionsAt(target);
    await sql`drop table live_hints`.execute(setup.get());
    await sql`create table live_hints (id bigint primary key, channel varchar(200), message text not null, created_at bigint not null)`.execute(setup.get());
    await setup.destroy();
    expect((await failing(await boot(envOf(target))))['live-table']).toContain('its id is neither an identity nor a serial column');
  });

  it('is ready for a serial id as well — its sequence never reuses an id either', async () => {
    const target = await fresh();
    const setup = connectionsAt(target);
    await sql`drop table live_hints`.execute(setup.get());
    await sql`create table live_hints (id bigserial primary key, channel varchar(200), message text not null, created_at bigint not null)`.execute(setup.get());
    await setup.destroy();
    expect(await failing(await boot(envOf(target)))).toEqual({});
  });

  it('a Broadcaster refresh inside a transaction is written after the commit, and not at all after a rollback', async () => {
    const target = await fresh();
    const app = await boot(envOf(target));
    const connections = app.container.make(Connections);
    const count = async () => Number((await sql<{ n: string }>`select count(*) as n from live_hints`.execute(connections.get())).rows[0]!.n);
    await connections.transaction(async () => {
      await app.container.make(Broadcaster).refresh('orders.1');
      expect(await count()).toBe(0);
    });
    expect(await count()).toBe(1);
    class Rollback extends Error {}
    await expect(
      connections.transaction(async () => {
        await app.container.make(Broadcaster).refresh('orders.2');
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await count()).toBe(1);
    expect(errors).toEqual([]);
  });

  describe.each(['outside a transaction', 'inside one that commits', 'inside one that rolls back'] as const)('a sign-out in one app, %s', (where) => {
    it('closes the stream another app holds, through the shared database', async () => {
      await signOutReachesOtherApp(await fresh(), where);
      expect(errors).toEqual([]);
    });
  });

  it.each(['commits', 'rolls back'] as const)('a sign-out whose end cannot be written, inside a transaction that %s: logged once, never thrown', async (outcome) => {
    await failingSignOut(await fresh(), outcome);
  });
});
