import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, defineModule, type ConfigDefinition, type ServiceProviderClass } from '@bespokecore/core';
import { Connections, DatabaseServiceProvider, defineConnection, InfrastructureTransactionError, sql } from '@bespokecore/database';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { abort, Controller, defineRoutes, HttpServiceProvider } from '@bespokecore/http';
import { RedisConnections, RedisServiceProvider } from '@bespokecore/redis';
import { createHttpKernel } from '@bespokecore/server';
import * as v from 'valibot';
import { afterAll, describe, expect, it } from 'vitest';
import { MakeSessionTableCommand } from './commands/make-session-table.ts';
import { PruneSessionsCommand } from './commands/prune-sessions.ts';
import { SessionConfig } from './config.ts';
import { SessionServiceProvider, sessionTableConnection } from './provider.ts';
import { Session } from './session.ts';
import { SessionStore } from './store.ts';
import { DatabaseSessionStore } from './stores/database.ts';
import { RedisSessionStore } from './stores/redis.ts';
import { freshTarget, migrate, PGSQL_URL, REDIS_URL } from './__fixtures__/stores.ts';

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

class CountController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    const visits = Number(this.#session.get('visits') ?? 0) + 1;
    this.#session.put('visits', visits);
    return { visits };
  }
}

/** A form: hands out the CSRF token, as every page does. */
class FormController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    return { _token: this.#session.token() };
  }
}

const routes = defineRoutes((Route) => {
  Route.get('/count', CountController);
  Route.get('/form', FormController);
  Route.get('/status', () => ({ ok: true }));
  Route.get('/away', () => Response.redirect('http://localhost/status', 302));
  Route.get('/gone', () => abort(404));
  Route.post('/save', () => ({ saved: true }));
});

function boot(env: Record<string, string>, providers: ServiceProviderClass[], config: ConfigDefinition<unknown>[] = []) {
  return createApplication({
    root: import.meta.dirname,
    discover: false,
    config,
    env: { APP_KEY: generateKey(), SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ...providers, SessionServiceProvider],
    modules: [defineModule({ name: 'shop', routes })],
  });
}

const sessionCookie = (response: Response) => response.headers.getSetCookie().find((header) => header.startsWith('bespoke_session='));

describe('SESSION_DRIVER', () => {
  it('database: sessions live in the app database — and bots leave no rows behind', async () => {
    const app = await boot({ SESSION_DRIVER: 'database', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider]);
    await migrate(app.container.make(Connections));
    expect(app.container.make(SessionStore)).toBeInstanceOf(DatabaseSessionStore);
    const db = app.container.make(Connections).get();
    const rows = async () => (await sql<{ id: string; user_id: string | null; last_activity: number }>`select id, user_id, last_activity from sessions`.execute(db)).rows;
    const kernel = createHttpKernel(app);

    // 100 requests without a cookie that need no session: a status check, a redirect, a 404 of a route, a HEAD, a refused
    // post (no token) — none keeps a session: no row, no session cookie, no XSRF cookie.
    const bots = ['/status', '/away', '/gone', '/status', '/save'];
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => {
        const path = bots[i % bots.length]!;
        const method = path === '/save' ? 'POST' : i % 10 === 3 ? 'HEAD' : 'GET';
        return kernel.request(path, { method, headers: { accept: 'application/json' } });
      }),
    );
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200, 302, 404, 419]));
    expect(responses.flatMap((response) => response.headers.getSetCookie())).toEqual([]);
    expect(await rows()).toEqual([]);

    // What uses the session keeps it: data, a handed-out token (a page, a form).
    const counted = await kernel.request('/count', { headers: { accept: 'application/json' } });
    const form = await kernel.request('/form', { headers: { accept: 'application/json' } });
    expect(sessionCookie(counted)).toBeDefined();
    expect(sessionCookie(form)).toBeDefined();
    expect(await rows()).toHaveLength(2);

    // The browser comes back: its row is written back in place, not added.
    const again = await kernel.request('/count', { headers: { accept: 'application/json', cookie: sessionCookie(counted)!.split(';')[0]! } });
    expect(await again.json()).toEqual({ visits: 2 });
    expect(await rows()).toHaveLength(2);
    await app.shutdown();
  });

  it('database: names what is missing at startup', async () => {
    await expect(boot({ SESSION_DRIVER: 'database' }, [])).rejects.toThrow(
      'SESSION_DRIVER=database needs the DatabaseServiceProvider of @bespokecore/database (installed packages register it: bespoke discover).',
    );
    await expect(boot({ SESSION_DRIVER: 'database', SESSION_CONNECTION: 'reporting', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider])).rejects.toThrow(
      /Database connection "reporting" is not configured/,
    );
  });

  it('redis: names what is missing at startup', async () => {
    await expect(boot({ SESSION_DRIVER: 'redis' }, [])).rejects.toThrow(
      'SESSION_DRIVER=redis needs the RedisServiceProvider of @bespokecore/redis (installed packages register it: bespoke discover).',
    );
  });

  it.runIf(REDIS_URL)('redis: sessions live in Redis with its own expiry', async () => {
    const prefix = `bespoke-test-${crypto.randomUUID().slice(0, 8)}:`;
    const app = await boot({ SESSION_DRIVER: 'redis', REDIS_URL: REDIS_URL!, REDIS_PREFIX: prefix, SESSION_LIFETIME: '30' }, [RedisServiceProvider]);
    expect(app.container.make(SessionStore)).toBeInstanceOf(RedisSessionStore);
    const kernel = createHttpKernel(app);
    const redis = app.container.make(RedisConnections).get();
    expect((await kernel.request('/status', { headers: { accept: 'application/json' } })).status).toBe(200);
    expect(await redis.command<string[]>(['KEYS', `${prefix}session:*`])).toEqual([]);
    await kernel.request('/count', { headers: { accept: 'application/json' } });
    const [key] = await redis.command<string[]>(['KEYS', `${prefix}session:*`]);
    expect(key).toMatch(new RegExp(`^${prefix}session:[\\w-]{40}$`));
    const ttl = await redis.command<number>(['TTL', key!]);
    expect(ttl).toBeGreaterThan(1790);
    expect(ttl).toBeLessThanOrEqual(1800);
    await redis.command(['DEL', key!]);
    await app.shutdown();
  });
});

describe('SESSION_DRIVER=database never joins the app’s transactions (E108)', () => {
  class Rollback extends Error {}
  const System = (file: string) => defineConnection('system', { env: v.object({}), resolve: () => ({ driver: 'sqlite', database: file }) });
  const DATA = { _token: 'x'.repeat(40), visits: 1 };
  const ids = async (connections: Connections, name = 'default') =>
    (await sql<{ id: string }>`select id from sessions`.execute(connections.get(name))).rows.map((row) => row.id);

  it('SQLite without a file of its own: a session write inside a transaction refuses loudly', async () => {
    const app = await boot({ SESSION_DRIVER: 'database', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider]);
    const connections = app.container.make(Connections);
    await migrate(connections);
    const store = app.container.make(SessionStore);
    await connections.transaction(async () => {
      await expect(store.write('a'.repeat(40), DATA, 60)).rejects.toThrow(InfrastructureTransactionError);
      await expect(store.writeIfExists('a'.repeat(40), DATA, 60)).rejects.toThrow(
        'The session store (SESSION_DRIVER=database) cannot work inside the open transaction on the database connection "default" (E108)',
      );
    });
    await store.write('a'.repeat(40), DATA, 60); // outside: the shared file works
    expect(await ids(connections)).toEqual(['a'.repeat(40)]);
    await app.shutdown();
  });

  it('SQLite with a file of its own (SESSION_CONNECTION): a session written inside a transaction survives its rollback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bespoke-session-system-'));
    temporary.push(directory);
    const app = await boot(
      { SESSION_DRIVER: 'database', SESSION_CONNECTION: 'system', DB_DATABASE: join(directory, 'app.sqlite') },
      [DatabaseServiceProvider],
      [System(join(directory, 'system.sqlite'))],
    );
    const connections = app.container.make(Connections);
    await migrate(connections, 'system');
    expect(sessionTableConnection(app.container)).toBe('system');
    const store = app.container.make(SessionStore);
    await expect(
      connections.transaction(async () => {
        await store.write('b'.repeat(40), DATA, 60);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await ids(connections, 'system')).toEqual(['b'.repeat(40)]);
    await app.shutdown();
  });

  it.runIf(PGSQL_URL)('Postgres: a session written inside a transaction survives its rollback — a pool of its own', async () => {
    const fresh = await freshTarget('pgsql');
    try {
      const app = await boot({ SESSION_DRIVER: 'database', DB_CONNECTION: 'pgsql', DB_URL: (fresh.target as { url: string }).url }, [DatabaseServiceProvider]);
      const connections = app.container.make(Connections);
      const store = app.container.make(SessionStore);
      await expect(
        connections.transaction(async () => {
          await store.write('c'.repeat(40), DATA, 60);
          expect(await store.writeIfExists('c'.repeat(40), { ...DATA, visits: 2 }, 60)).toBe(true);
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await ids(connections)).toEqual(['c'.repeat(40)]);
      expect(await store.read('c'.repeat(40))).toEqual({ ...DATA, visits: 2 });
      await app.shutdown();
    } finally {
      await fresh.drop();
    }
  });
});

describe('session:prune', () => {
  function input() {
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
    return { input: { root: '/', args: [], options: {}, output, spawn: async () => 0 } as never, lines };
  }

  it('removes expired sessions of the database driver — what the lottery does now and then', async () => {
    const app = await boot({ SESSION_DRIVER: 'database', DB_DATABASE: ':memory:', SESSION_LIFETIME: '1' }, [DatabaseServiceProvider]);
    await migrate(app.container.make(Connections));
    const store = app.container.make(SessionStore);
    await store.write('a'.repeat(40), { x: 1 }, 60);
    await store.write('b'.repeat(40), { x: 1 }, 60);
    await sql`update sessions set last_activity = last_activity - 120000 where id = ${'a'.repeat(40)}`.execute(app.container.make(Connections).get());
    const { input: run, lines } = input();
    expect(await app.container.make(PruneSessionsCommand).handle(run)).toBe(0);
    expect(lines).toEqual(['✓ Pruned 1 expired session (database).']);
    expect(await store.read('b'.repeat(40))).toEqual({ x: 1 });
    await app.shutdown();
  });

  it('has nothing to do for sessions that expire on their own', async () => {
    const app = await boot({ SESSION_DRIVER: 'cookie' }, []);
    const { input: run, lines } = input();
    expect(await new PruneSessionsCommand(app.container.make(SessionConfig), app.container).handle(run)).toBe(0);
    expect(lines).toEqual(['Nothing to prune: cookie sessions expire on their own.']);
  });
});

describe('make:session-table', () => {
  function app(): string {
    const root = mkdtempSync(join(tmpdir(), 'bespoke-session-table-'));
    temporary.push(root);
    mkdirSync(join(root, 'bootstrap'));
    writeFileSync(
      join(root, 'bootstrap/app.ts'),
      "import { defineApplication } from '@bespokecore/core';\nimport auth from '#modules/auth';\n\nexport default defineApplication({ root: '', modules: [auth] });\n",
    );
    return root;
  }

  it('writes the migration into the system module (E96), next to the cache tables', async () => {
    const root = app();
    mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/system/index.ts'), "export default defineModule({ name: 'system', migrations: new URL('./migrations/', import.meta.url) });");
    writeFileSync(join(root, 'modules/system/migrations/2026_10_02_195920_create_cache_table.ts'), '');
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
    const run = { root, args: [], options: {}, output, spawn: async () => 0 } as never;
    expect(await new MakeSessionTableCommand().handle(run)).toBe(0);
    const migration = readdirSync(join(root, 'modules/system/migrations')).find((file) => file.endsWith('_create_sessions_table.ts'))!;
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_sessions_table\.ts$/);
    expect(readFileSync(join(root, 'modules/system/migrations', migration), 'utf8')).toContain("schema.create('sessions'");
    expect(lines).toEqual([`✓ Created modules/system/migrations/${migration}`, 'Then: bespoke migrate']);
    lines.length = 0;
    expect(await new MakeSessionTableCommand().handle(run)).toBe(1);
    expect(lines).toEqual([`✗ modules/system/migrations/${migration} already exists — the sessions table has its migration.`]);
  });
});
