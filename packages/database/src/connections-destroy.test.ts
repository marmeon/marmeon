import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { freshDatabase, PGSQL_URL, silent } from './__fixtures__/databases.ts';
import { Connections } from './connections.ts';
import type { ConnectionOptions } from './config.ts';
import { inspectionConnection, migratorConnection } from './migrator-connection.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

// The Postgres case runs in `pnpm test:pgsql` (MARMEON_TEST_PGSQL_URL).
// `Connections.destroy()` closes every pool, also when only the migrator's, the inspection's or the infrastructure's connection ever sent a query
// (`migrate`, `db:show`, the cache), and a handle that is used for the first time after it refuses instead of opening a pool nothing closes.

const ways = {
  app: (connections: Connections) => connections.get(),
  migrator: (connections: Connections) => migratorConnection(connections),
  inspection: (connections: Connections) => inspectionConnection(connections),
  infrastructure: (connections: Connections) => connections.infrastructure(),
} as const;

// The server ends a backend a moment after the client's `end()`, so a closed pool may still show up for a few hundred milliseconds; a leak never reaches 0.
/** How many sessions of other connections the server has in the database `name`, once the closing connections had a moment to leave. */
async function sessions(count: () => Promise<number>): Promise<number> {
  let found = await count();
  for (let attempt = 0; found > 0 && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    found = await count();
  }
  return found;
}

describe.each(Object.keys(ways) as Array<keyof typeof ways>)('destroy() after a query of the %s connection alone', (way) => {
  it.runIf(PGSQL_URL !== undefined)('leaves no Postgres session', { timeout: 30_000 }, async () => {
    const fresh = await freshDatabase('pgsql');
    const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
    try {
      const connections = new Connections({ connections: { default: fresh.options }, root: '/', logger: silent });
      await sql`select 1`.execute(ways[way](connections));
      const name = new URL((fresh.options as { url: string }).url).pathname.slice(1);
      await connections.destroy();
      const count = async () => Number((await sql<{ n: string }>`select count(*) as n from pg_stat_activity where datname = ${name}`.execute(admin.get())).rows[0]!.n);
      expect(await sessions(count)).toBe(0);
    } finally {
      await admin.destroy();
      await fresh.drop();
    }
  });

  it('closes a SQLite file: its write-ahead files are gone', { timeout: 30_000 }, async () => {
    const directory = tempDir('marmeon-destroy-');
    const options: ConnectionOptions = { driver: 'sqlite', database: join(directory, 'app.db') };
    const connections = new Connections({ connections: { default: options }, root: directory, logger: silent });
    // Reads a page of the file (the catalog, which every handle may read): that is what opens its write-ahead files.
    await sql`select count(*) from sqlite_master`.execute(ways[way](connections));
    expect(existsSync(join(directory, 'app.db-wal'))).toBe(true);
    await connections.destroy();
    expect(existsSync(join(directory, 'app.db-wal'))).toBe(false);
    expect(existsSync(join(directory, 'app.db-shm'))).toBe(false);
  });
});

describe.each(Object.keys(ways) as Array<keyof typeof ways>)('a query of the %s connection after destroy()', (way) => {
  it('is refused, and opens no database file', { timeout: 30_000 }, async () => {
    const directory = tempDir('marmeon-destroy-');
    const options: ConnectionOptions = { driver: 'sqlite', database: join(directory, 'app.db') };
    const connections = new Connections({ connections: { default: options }, root: directory, logger: silent });
    const handle = ways[way](connections);
    await connections.destroy();
    await expect(sql`select 1`.execute(handle)).rejects.toThrow('The database connections are closed (the application shut down); cannot use "default".');
    expect(existsSync(join(directory, 'app.db'))).toBe(false);
    expect(existsSync(join(directory, 'app.db-wal'))).toBe(false);
  });
});

it('closes a SQLite connection that never ran a query without creating its file', async () => {
  const directory = tempDir('marmeon-destroy-');
  const connections = new Connections({ connections: { default: { driver: 'sqlite', database: join(directory, 'app.db') } }, root: directory, logger: silent });
  connections.get();
  await connections.destroy();
  expect(existsSync(join(directory, 'app.db'))).toBe(false);
});

// No server needed: nothing listens on port 1, so the first query fails at once.
it('closes a Postgres connection whose first query failed, without throwing', { timeout: 30_000 }, async () => {
  const connections = new Connections({ connections: { default: { driver: 'pgsql', url: 'postgres://nobody:nothing@127.0.0.1:1/none' } }, root: '/', logger: silent });
  await sql`select 1`.execute(connections.get()).catch(() => undefined);
  await expect(connections.destroy()).resolves.toBeUndefined();
});

describe.each(['migrator', 'inspection'] as const)('a query of the %s connection after it ran one and destroy() closed it', (way) => {
  const closed = 'The database connections are closed (the application shut down); cannot use "default".';

  it('names the shutdown on SQLite', async () => {
    const directory = tempDir('marmeon-destroy-');
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: join(directory, 'app.db') } }, root: directory, logger: silent });
    const handle = ways[way](connections);
    await sql`select 1`.execute(handle);
    await connections.destroy();
    await expect(sql`select 1`.execute(handle)).rejects.toThrow(closed);
  });

  // No server needed: the refusal comes before the client library is asked for a connection.
  it('names the shutdown on Postgres', async () => {
    const connections = new Connections({ connections: { default: { driver: 'pgsql', url: 'postgres://nobody:nothing@127.0.0.1:1/none' } }, root: '/', logger: silent });
    const handle = ways[way](connections);
    await sql`select 1`.execute(handle).catch(() => undefined);
    await connections.destroy();
    await expect(sql`select 1`.execute(handle)).rejects.toThrow(closed);
  });
});
