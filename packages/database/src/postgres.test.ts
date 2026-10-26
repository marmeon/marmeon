import { createServer, type Server, type Socket } from 'node:net';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { freshDatabase, PGSQL_URL, silent } from './__fixtures__/databases.ts';
import { Connections } from './connections.ts';
import { connectionError, DatabaseConnectionError } from './driver.ts';
import { MigrationLock } from './migrations/lock.ts';
import { CONNECT_TIMEOUT_MS, createPostgresDialect, postgresConnection } from './postgres.ts';

/** A server that accepts connections and never answers: what an unreachable host looks like from a firewall that drops packets. */
const servers: Server[] = [];
const sockets: Socket[] = [];
async function silentServer(): Promise<string> {
  const server = createServer((socket) => void sockets.push(socket));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `postgres://app:hunter2@127.0.0.1:${port}/app`;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('connecting to a host that does not answer', () => {
  it('fails the pool within its connect timeout', { timeout: 30_000 }, async () => {
    const url = await silentServer();
    const driver = createPostgresDialect({ url, connectTimeoutMs: 200 }).createDriver();
    await driver.init();
    const error = await driver.acquireConnection().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timeout/i);
    await driver.destroy();
  });

  it('names the connection in the error of a query, and never the password; the URL sets the timeout', { timeout: 30_000 }, async () => {
    const url = (await silentServer()) + '?connect_timeout=1';
    const connections = new Connections({ connections: { default: { driver: 'pgsql', url } }, root: '/', logger: silent });
    const error = await sql`select 1`.execute(connections.get()).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect((error as Error).message).toMatch(/^\[marmeon:D11\] Could not connect to the database connection "default" \(pgsql postgres:\/\/app:\*\*\*@127\.0\.0\.1:\d+\/app\): .*timeout/i);
    expect((error as Error).message).not.toContain('hunter2');
    await connections.destroy();
  });

  it('fails the migration lock within its connect timeout, with the same error', { timeout: 30_000 }, async () => {
    const url = await silentServer();
    const error = await MigrationLock.acquire({} as never, { driver: 'pgsql', url, connectTimeoutMs: 200 }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect((error as Error).message).toMatch(/^\[marmeon:D11\] Could not connect to the database connection "default" \(pgsql postgres:\/\/app:\*\*\*@127\.0\.0\.1:\d+\/app\): .*timeout/i);
    expect((error as Error).message).not.toContain('hunter2');
  });
});

describe('the wait for a free pooled connection', () => {
  it('is told apart from a failure to open a connection', () => {
    const waiting = connectionError({ name: 'default', target: 'pgsql x' }, new Error('timeout exceeded when trying to connect'));
    expect(waiting.message).toContain('no free connection');
    expect(waiting.message).toContain('DB_POOL_MAX');
    const opening = connectionError({ name: 'default', target: 'pgsql x' }, new Error('Connection terminated due to connection timeout'));
    expect(opening.message).toContain('Connection terminated due to connection timeout');
  });
});

describe('postgresConnection', () => {
  it('times out after ten seconds, the connect_timeout of the URL (seconds) or the given override', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(postgresConnection('postgres://app@db/shop').connectionTimeoutMillis).toBe(CONNECT_TIMEOUT_MS);
    expect(postgresConnection('postgres://app@db/shop?connect_timeout=30').connectionTimeoutMillis).toBe(30_000);
    expect(postgresConnection('postgres://app@db/shop?connect_timeout=0').connectionTimeoutMillis).toBe(0);
    expect(postgresConnection('postgres://app@db/shop?connect_timeout=30', 200).connectionTimeoutMillis).toBe(200);
  });

  it('keeps the options of the URL and adds the UTC session after them', () => {
    const { connectionString, options } = postgresConnection('postgres://app@db/shop?options=-c%20search_path%3Dx&sslmode=require');
    expect(options).toBe('-c search_path=x -c TimeZone=UTC');
    expect(new URL(connectionString).searchParams.has('options')).toBe(false);
    expect(new URL(connectionString).searchParams.get('sslmode')).toBe('require');
  });

  it('asks for the UTC session when the URL has no options', () => {
    expect(postgresConnection('postgres://app@db/shop')).toMatchObject({ connectionString: 'postgres://app@db/shop', options: '-c TimeZone=UTC' });
  });

  it('gives pg the IPv6 host without brackets, which it would look up as a name', () => {
    const { connectionString } = postgresConnection('postgres://app:pw@[::1]:5433/shop');
    expect(new URL(connectionString).searchParams.get('host')).toBe('::1');
  });
});

describe.skipIf(PGSQL_URL === undefined)('a full pool', () => {
  it('says that no connection was free, not that the host is down', { timeout: 30_000 }, async () => {
    const database = await freshDatabase('pgsql');
    const url = database.options.driver === 'pgsql' ? database.options.url : '';
    const connections = new Connections({ connections: { default: { driver: 'pgsql', url: url + '?connect_timeout=1', poolMax: 1 } }, root: '/', logger: silent });
    try {
      await connections.get().connection().execute(async () => {
        const error = await sql`select 1`.execute(connections.get()).then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(DatabaseConnectionError);
        expect((error as Error).message).toContain('no free connection');
      });
    } finally {
      await connections.destroy();
      await database.drop();
    }
  });
});

describe.skipIf(PGSQL_URL === undefined)('the Postgres session', () => {
  const sessionOf = async (extra: string) => {
    const database = await freshDatabase('pgsql');
    const url = new URL(database.options.driver === 'pgsql' ? database.options.url : '');
    const connections = new Connections({ connections: { default: { driver: 'pgsql', url: url.href + extra } }, root: '/', logger: silent });
    try {
      const row = await sql<{ zone: string; path: string }>`select current_setting('TimeZone') as zone, current_setting('search_path') as path`.execute(connections.get());
      return row.rows[0]!;
    } finally {
      await connections.destroy();
      await database.drop();
    }
  };

  it('runs in UTC', async () => {
    expect((await sessionOf('')).zone).toBe('UTC');
  });

  it('keeps the options of the URL and still runs in UTC', async () => {
    const session = await sessionOf(`?options=${encodeURIComponent('-c search_path=marmeon_x -c TimeZone=Asia/Tokyo')}`);
    expect(session.path).toBe('marmeon_x');
    expect(session.zone).toBe('UTC');
  });
});
