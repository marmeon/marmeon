import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, defineModule, env, type ConfigDefinition, type ServiceProviderClass } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, defineConnection, InfrastructureTransactionError, sql } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, Controller, HttpServiceProvider } from '@marmeon/http';
import { RedisConnections, RedisServiceProvider } from '@marmeon/redis';
import { createHttpKernel } from '@marmeon/server';
import { describe, expect, it } from 'vitest';
import { MakeSessionTableCommand } from './commands/make-session-table.ts';
import { PruneSessionsCommand } from './commands/prune-sessions.ts';
import { SessionConfig } from './config.ts';
import { SessionServiceProvider, sessionTableConnection } from './provider.ts';
import { Session } from './session.ts';
import { UserSessions } from './user-sessions.ts';
import { EncryptedSessionCodec, plainSessionCodec, SessionCodec } from './codec.ts';
import { sessionKey, SessionStore } from './store.ts';
import { DatabaseSessionStore } from './stores/database.ts';
import { RedisSessionStore } from './stores/redis.ts';
import { freshTarget, migrate, PGSQL_URL, REDIS_URL } from './__fixtures__/stores.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { openRoutes } from './test-helpers/open-routes.ts';

// The console builds the command through the container, which injects the application.
const application = await createApplication({ root: import.meta.dirname, modules: [], discover: false }, { phase: 'build' });
const command = () => application.container.make(MakeSessionTableCommand);

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

const routes = openRoutes((Route) => {
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
    providers: [EncryptionServiceProvider, HttpServiceProvider, ...providers, SessionServiceProvider],
    modules: [defineModule({ name: 'shop', routes })],
  }, { env: { APP_KEY: generateKey(), SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', ...env } });
}

const sessionCookie = (response: Response) => response.headers.getSetCookie().find((header) => header.startsWith('marmeon_session='));
/** The session id a `Set-Cookie` header carries (encrypted like every cookie). */
const cookieValue = (app: Awaited<ReturnType<typeof boot>>, header: string) =>
  app.container.make(Encrypter).decrypt(decodeURIComponent(header.split(';')[0]!.split('=')[1]!), 'cookie:marmeon_session');

describe('SESSION_DRIVER', () => {
  it('database: sessions live in the app database — and bots leave no rows behind', async () => {
    const app = await boot({ SESSION_DRIVER: 'database', DB_MANAGED: 'false', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider]);
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
    // Each row is keyed by the SHA-256 of the id its cookie carries — no id in the table.
    const id = await cookieValue(app, sessionCookie(counted)!);
    expect((await rows()).map((row) => row.id)).toContain(sessionKey(id));
    expect((await rows()).map((row) => row.id)).not.toContain(id);
    await app.shutdown();
  });

  it('SESSION_ENCRYPT=true: the payload column holds ciphertext bound to the session — the app reads it as before', async () => {
    const app = await boot({ SESSION_DRIVER: 'database', DB_MANAGED: 'false', DB_DATABASE: ':memory:', SESSION_ENCRYPT: 'true' }, [DatabaseServiceProvider]);
    await migrate(app.container.make(Connections));
    expect(app.container.make(SessionCodec)).toBeInstanceOf(EncryptedSessionCodec);
    const kernel = createHttpKernel(app);
    const counted = await kernel.request('/count', { headers: { accept: 'application/json' } });
    const again = await kernel.request('/count', { headers: { accept: 'application/json', cookie: sessionCookie(counted)!.split(';')[0]! } });
    expect(await again.json()).toEqual({ visits: 2 });
    const [row] = (await sql<{ payload: string }>`select payload from sessions`.execute(app.container.make(Connections).get())).rows;
    expect(row!.payload).not.toMatch(/visits|_token|\{/);
    const id = await cookieValue(app, sessionCookie(counted)!);
    expect(JSON.parse(await app.container.make(Encrypter).decrypt(row!.payload, `session:${sessionKey(id)}`))).toMatchObject({ visits: 2 });
    await app.shutdown();
  });

  it('a new APP_KEY with the old one in APP_PREVIOUS_KEYS keeps encrypted sessions — without it, everybody starts afresh', async () => {
    const directory = tempDir('marmeon-session-rotation-');
    const [oldKey, newKey] = [generateKey(), generateKey()];
    const files = { SESSION_DRIVER: 'file', SESSION_FILES: directory, SESSION_ENCRYPT: 'true' };
    const before = await boot({ ...files, APP_KEY: oldKey }, []);
    const first = await createHttpKernel(before).request('/count', { headers: { accept: 'application/json' } });
    const cookie = sessionCookie(first)!.split(';')[0]!;
    const visit = async (env: Record<string, string>) =>
      (await (await createHttpKernel(await boot({ ...files, ...env }, [])).request('/count', { headers: { accept: 'application/json', cookie } })).json()) as { visits: number };
    expect(await visit({ APP_KEY: newKey, APP_PREVIOUS_KEYS: oldKey })).toEqual({ visits: 2 });
    expect(await visit({ APP_KEY: newKey })).toEqual({ visits: 1 });
  });

  it('SESSION_ENCRYPT stays off by default', async () => {
    const plain = await boot({ SESSION_DRIVER: 'memory' }, []);
    expect(plain.container.make(SessionCodec)).toBe(plainSessionCodec);
    await expect(boot({ SESSION_DRIVER: 'memory', SESSION_ENCRYPT: 'yes' }, [])).rejects.toThrow(/SESSION_ENCRYPT/);
  });

  it('SESSION_DRIVER=cookie no longer starts — the message names the drivers there are', async () => {
    await expect(boot({ SESSION_DRIVER: 'cookie' }, [])).rejects.toThrow(/SESSION_DRIVER.*file.*database.*redis.*memory/s);
  });

  it('SESSION_DRIVER and UserSessions take no cookie driver and no missing store', () => {
    // @ts-expect-error `cookie` is not a driver
    const driver: SessionConfig['driver'] = 'cookie';
    // @ts-expect-error a store is required
    const sessions = new UserSessions(undefined);
    expect([driver, sessions]).toHaveLength(2);
  });

  it('database: an error of the sessions table goes out as the driver wrote it — the store adds no advice of its own', async () => {
    const app = await boot({ SESSION_DRIVER: 'database', DB_MANAGED: 'false', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider]);
    const db = app.container.make(Connections).get();
    await sql`create table sessions (id varchar(64) primary key, user_id varchar(255), payload text, last_activity bigint)`.execute(db);
    const error = await app.container.make(SessionStore).read('a'.repeat(64)).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/version/);
    expect((error as Error).message).not.toContain('make:session-table');
    await app.shutdown();
  });

  it('database: names what is missing at startup', async () => {
    await expect(boot({ SESSION_DRIVER: 'database' }, [])).rejects.toThrow(
      'SESSION_DRIVER=database needs the DatabaseServiceProvider of @marmeon/database (installed packages register it: marmeon discover).',
    );
    await expect(boot({ SESSION_DRIVER: 'database', SESSION_CONNECTION: 'reporting', DB_MANAGED: 'false', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider])).rejects.toThrow(
      /Database connection "reporting" is not configured/,
    );
  });

  it('redis: names what is missing at startup', async () => {
    await expect(boot({ SESSION_DRIVER: 'redis' }, [])).rejects.toThrow(
      '[marmeon:A3] SESSION_DRIVER=redis needs the RedisServiceProvider of @marmeon/redis (installed packages register it: marmeon discover).',
    );
  });

  it.runIf(REDIS_URL)('redis: sessions live in Redis with its own expiry', async () => {
    const prefix = `marmeon-test-${crypto.randomUUID().slice(0, 8)}:`;
    const app = await boot({ SESSION_DRIVER: 'redis', REDIS_URL: REDIS_URL!, REDIS_PREFIX: prefix, SESSION_LIFETIME_MINUTES: '30' }, [RedisServiceProvider]);
    expect(app.container.make(SessionStore)).toBeInstanceOf(RedisSessionStore);
    const kernel = createHttpKernel(app);
    const redis = app.container.make(RedisConnections).get();
    expect((await kernel.request('/status', { headers: { accept: 'application/json' } })).status).toBe(200);
    expect(await redis.command<string[]>(['KEYS', `${prefix}session:*`])).toEqual([]);
    await kernel.request('/count', { headers: { accept: 'application/json' } });
    const [key] = await redis.command<string[]>(['KEYS', `${prefix}session:*`]);
    expect(key).toMatch(new RegExp(`^${prefix}session:[0-9a-f]{64}$`)); // the hash of the id
    const ttl = await redis.command<number>(['TTL', key!]);
    expect(ttl).toBeGreaterThan(1790);
    expect(ttl).toBeLessThanOrEqual(1800);
    await redis.command(['DEL', key!]);
    await app.shutdown();
  });
});

describe('SESSION_DRIVER=database never joins the app’s transactions', () => {
  class Rollback extends Error {}
  const System = (file: string) => defineConnection('system', { env: env({}), resolve: () => ({ driver: 'sqlite', database: file, managed: false }) });
  const DATA = JSON.stringify({ _token: 'x'.repeat(40), visits: 1 });
  const NEW = { expectedVersion: undefined, lifetimeSeconds: 60 };
  const ids = async (connections: Connections, name = 'default') =>
    (await sql<{ id: string }>`select id from sessions`.execute(connections.get(name))).rows.map((row) => row.id);

  it('SQLite without a file of its own: a session write inside a transaction refuses loudly', async () => {
    const app = await boot({ SESSION_DRIVER: 'database', DB_MANAGED: 'false', DB_DATABASE: ':memory:' }, [DatabaseServiceProvider]);
    const connections = app.container.make(Connections);
    await migrate(connections);
    const store = app.container.make(SessionStore);
    await connections.transaction(async () => {
      await expect(store.write('a'.repeat(64), DATA, NEW)).rejects.toThrow(InfrastructureTransactionError);
      await expect(store.write('a'.repeat(64), DATA, { ...NEW, expectedVersion: 1 })).rejects.toThrow(
        'The session store (SESSION_DRIVER=database) cannot work inside the open transaction on the database connection "default"',
      );
    });
    await store.write('a'.repeat(64), DATA, NEW); // outside: the shared file works
    expect(await ids(connections)).toEqual(['a'.repeat(64)]);
    await app.shutdown();
  });

  it('SQLite with a file of its own (SESSION_CONNECTION): a session written inside a transaction survives its rollback', async () => {
    const directory = tempDir('marmeon-session-system-');
    const app = await boot(
      { SESSION_DRIVER: 'database', SESSION_CONNECTION: 'system', DB_MANAGED: 'false', DB_DATABASE: join(directory, 'app.sqlite') },
      [DatabaseServiceProvider],
      [System(join(directory, 'system.sqlite'))],
    );
    const connections = app.container.make(Connections);
    await migrate(connections, 'system');
    expect(sessionTableConnection(app.container)).toBe('system');
    const store = app.container.make(SessionStore);
    await expect(
      connections.transaction(async () => {
        await store.write('b'.repeat(64), DATA, NEW);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await ids(connections, 'system')).toEqual(['b'.repeat(64)]);
    await app.shutdown();
  });

  it.runIf(PGSQL_URL)('Postgres: a session written inside a transaction survives its rollback — a pool of its own', async () => {
    const fresh = await freshTarget('pgsql');
    try {
      const app = await boot({ SESSION_DRIVER: 'database', DB_MANAGED: 'false', DB_DRIVER: 'pgsql', DB_URL: (fresh.target as { url: string }).url }, [DatabaseServiceProvider]);
      const connections = app.container.make(Connections);
      const store = app.container.make(SessionStore);
      await expect(
        connections.transaction(async () => {
          await store.write('c'.repeat(64), DATA, NEW);
          expect(await store.write('c'.repeat(64), '{"visits":2}', { ...NEW, expectedVersion: 1 })).toBe('written');
          throw new Rollback();
        }),
      ).rejects.toBeInstanceOf(Rollback);
      expect(await ids(connections)).toEqual(['c'.repeat(64)]);
      expect(await store.read('c'.repeat(64))).toEqual({ data: '{"visits":2}', version: 2 });
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
    const app = await boot({ SESSION_DRIVER: 'database', DB_MANAGED: 'false', DB_DATABASE: ':memory:', SESSION_LIFETIME_MINUTES: '1' }, [DatabaseServiceProvider]);
    await migrate(app.container.make(Connections));
    const store = app.container.make(SessionStore);
    await store.write('a'.repeat(64), '{"x":1}', { expectedVersion: undefined, lifetimeSeconds: 60 });
    await store.write('b'.repeat(64), '{"x":1}', { expectedVersion: undefined, lifetimeSeconds: 60 });
    await sql`update sessions set last_activity = last_activity - 120000 where id = ${'a'.repeat(64)}`.execute(app.container.make(Connections).get());
    const { input: run, lines } = input();
    expect(await app.container.make(PruneSessionsCommand).handle(run)).toBe(0);
    expect(lines).toEqual(['✓ Pruned 1 expired session (database).']);
    expect(await store.read('b'.repeat(64))).toEqual({ data: '{"x":1}', version: 1 });
    await app.shutdown();
  });

  it('SESSION_LIFETIME_MINUTES=1: the database store still reads a session idle for 59 seconds and no longer one idle for 61', async () => {
    const app = await boot({ SESSION_DRIVER: 'database', DB_MANAGED: 'false', DB_DATABASE: ':memory:', SESSION_LIFETIME_MINUTES: '1' }, [DatabaseServiceProvider]);
    await migrate(app.container.make(Connections));
    const store = app.container.make(SessionStore);
    const idle = async (id: string, seconds: number) => {
      await store.write(id, '{"x":1}', { expectedVersion: undefined, lifetimeSeconds: 60 });
      await sql`update sessions set last_activity = last_activity - ${seconds * 1000} where id = ${id}`.execute(app.container.make(Connections).get());
      return store.read(id);
    };
    expect(await idle('a'.repeat(64), 59)).toEqual({ data: '{"x":1}', version: 1 });
    expect(await idle('b'.repeat(64), 61)).toBeUndefined();
    await app.shutdown();
  });

  it('has nothing to do for sessions that expire on their own', async () => {
    const app = await boot({ SESSION_DRIVER: 'memory' }, []);
    const { input: run, lines } = input();
    expect(await new PruneSessionsCommand({ ...app.container.make(SessionConfig), driver: 'redis' }, app.container).handle(run)).toBe(0);
    expect(lines).toEqual(['Nothing to prune: redis sessions expire on their own.']);
  });
});

describe('make:session-table', () => {
  function app(): string {
    const root = tempDir('marmeon-session-table-');
    mkdirSync(join(root, 'bootstrap'));
    writeFileSync(
      join(root, 'bootstrap/app.ts'),
      "import { defineApplication } from '@marmeon/core';\nimport auth from '#modules/auth';\n\nexport default defineApplication({ root: '', modules: [auth] });\n",
    );
    return root;
  }

  it('writes the migration into the system module, next to the cache tables', async () => {
    const root = app();
    mkdirSync(join(root, 'modules/system/migrations'), { recursive: true });
    writeFileSync(join(root, 'modules/system/index.ts'), "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'system', migrations: new URL('./migrations/', import.meta.url) });\n");
    writeFileSync(join(root, 'modules/system/migrations/2026_10_02_195920_create_cache_table.ts'), '');
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
    const run = { root, args: [], options: {}, output, spawn: async () => 0 } as never;
    expect(await command().handle(run)).toBe(0);
    const migration = readdirSync(join(root, 'modules/system/migrations')).find((file) => file.endsWith('_create_sessions_table.ts'))!;
    expect(migration).toMatch(/^\d{4}_\d{2}_\d{2}_\d{6}_create_sessions_table\.ts$/);
    expect(readFileSync(join(root, 'modules/system/migrations', migration), 'utf8')).toContain("schema.create('sessions'");
    expect(lines).toEqual([`✓ Created modules/system/migrations/${migration}`, 'Then: marmeon migrate']);
    lines.length = 0;
    expect(await command().handle(run)).toBe(0);
    expect(lines).toEqual([`modules/system/migrations/${migration} is there — skipped`, '✓ Nothing to publish — every migration of @marmeon/session is in your app']);
  });

  it('takes --module=<name> to a module of its own, and refuses a name that leaves modules/', async () => {
    const root = app();
    const lines: string[] = [];
    const output = { success: (line: string) => lines.push(`✓ ${line}`), error: (line: string) => lines.push(`✗ ${line}`), warn: (line: string) => lines.push(`! ${line}`), line: (line = '') => lines.push(line) };
    const run = (options: Record<string, string>) => ({ root, args: [], options, output, spawn: async () => 0 }) as never;
    expect(await command().handle(run({ module: '../x' }))).toBe(1);
    expect(existsSync(join(root, 'modules'))).toBe(false);
    expect(await command().handle(run({ module: 'billing' }))).toBe(0);
    expect(readdirSync(join(root, 'modules/billing/migrations'))).toHaveLength(1);
  });

  it('writes one migration: the table as the store writes it — no other to choose', () => {
    expect(Object.keys(MakeSessionTableCommand.options)).toEqual(['module']);
    expect(MakeSessionTableCommand.options.module).toEqual({ type: 'string', short: 'm' });
    expect(MakeSessionTableCommand.usage).toBe('[--module=system]');
    expect(readdirSync(new URL('../stubs/migrations/', import.meta.url))).toEqual(['0001_01_01_000000_create_sessions_table.ts']);
  });
});
