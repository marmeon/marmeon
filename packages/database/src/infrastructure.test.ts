import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshDatabase, PGSQL_URL, silent } from './__fixtures__/databases.ts';
import { Connections, InfrastructureTransactionError, outsideTransaction, TransactionError } from './index.ts';
import type { ConnectionOptions } from './config.ts';

// The infrastructure connection (E108): the cache, rate limits, locks and sessions never join the app's transactions.

class Rollback extends Error {}

const USAGE = { system: 'The counter', remedy: 'Give the counter its own SQLite file (COUNTER_CONNECTION) or use Redis.' };

/** A hang is a failure, not a stuck suite. */
function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`hung for ${ms} ms`)))]);
}

async function createHits(db: Kysely<any>): Promise<void> {
  await db.schema.createTable('hits').ifNotExists().addColumn('key', 'text', (c) => c.primaryKey()).addColumn('n', 'integer', (c) => c.notNull()).execute();
}

/** One rate-limit hit: a single atomic statement, like the cache's `increment`. */
async function hit(db: Kysely<any>, key = 'login'): Promise<void> {
  await sql`insert into hits (key, n) values (${key}, 1) on conflict (key) do update set n = hits.n + 1`.execute(db);
}

async function count(db: Kysely<any>, key = 'login'): Promise<number> {
  const { rows } = await sql<{ n: number }>`select n from hits where key = ${key}`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

describe.each(drivers)('connections.infrastructure() on %s — outside of transactions', (driver) => {
  let connections: Connections;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const fresh = await freshDatabase(driver);
    drop = fresh.drop;
    connections = new Connections({ connections: { default: fresh.options }, root: '/', logger: silent });
    await createHits(connections.get());
  });
  afterAll(async () => {
    await connections.destroy();
    await drop();
  });

  it('works on the same database as the connection, and its writes are there for everyone', async () => {
    const infrastructure = connections.infrastructure('default', USAGE);
    await hit(infrastructure);
    await hit(infrastructure);
    expect(await count(connections.get())).toBe(2);
    expect(connections.infrastructure('default', USAGE)).toBe(infrastructure); // one handle per connection and user
  });

  it('runs single statements only — no transactions of its own', async () => {
    await expect(connections.infrastructure('default', USAGE).transaction().execute(async () => {})).rejects.toThrow(
      'The counter runs single statements on its own connection (E108) — it has no transactions.',
    );
  });

  it('refuses an unknown connection', () => {
    expect(() => connections.infrastructure('cache', USAGE)).toThrow('Database connection "cache" is not configured. Known: default.');
  });
});

describe('connections.infrastructure() on SQLite', () => {
  let directory: string;
  let open: Connections | undefined;
  const connect = (named: Record<string, ConnectionOptions>) =>
    (open = new Connections({ connections: { default: { driver: 'sqlite', database: join(directory, 'app.sqlite') }, ...named }, root: directory, logger: silent }));

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'bespoke-infrastructure-'));
  });
  afterEach(async () => {
    await open?.destroy();
    open = undefined;
    for (const file of ['app.sqlite', 'system.sqlite']) for (const suffix of ['', '-wal', '-shm']) rmSync(join(directory, `${file}${suffix}`), { force: true });
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('without a file of its own: refuses loudly inside a transaction of that file — never joins, never hangs', async () => {
    const connections = connect({});
    await createHits(connections.get());
    const infrastructure = connections.infrastructure('default', USAGE);
    await expect(
      within(
        connections.transaction(async () => {
          await expect(hit(infrastructure)).rejects.toThrow(InfrastructureTransactionError);
          await expect(hit(infrastructure)).rejects.toThrow(
            'The counter cannot work inside the open transaction on the database connection "default" (E108): it is a SQLite file, and that transaction holds its only connection — ' +
              'its writes would either join the transaction (and be rolled back with it) or wait for it forever. ' +
              'Give the counter its own SQLite file (COUNTER_CONNECTION) or use Redis. Outside of transactions the shared connection works.',
          );
          // Stepping out does not help: the transaction still holds the file's one connection.
          await expect(outsideTransaction(() => hit(infrastructure))).rejects.toThrow(InfrastructureTransactionError);
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    // Outside again: the shared file works.
    await hit(infrastructure);
    expect(await count(connections.get())).toBe(1);
  });

  it('waits for another call chain’s transaction on the shared file — like every query there', async () => {
    const connections = connect({});
    await createHits(connections.get());
    const infrastructure = connections.infrastructure('default', USAGE);
    const order: string[] = [];
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const transaction = connections.transaction(async () => {
      await connections.get<any>().selectFrom('hits').selectAll().execute();
      entered();
      await sleep(50);
      order.push('transaction done');
    });
    await inside;
    // Another request, outside of any transaction: it waits for the file's connection, then runs.
    await within(hit(infrastructure).then(() => order.push('hit')));
    await transaction;
    expect(order).toEqual(['transaction done', 'hit']);
  });

  it('with a file of its own: works inside a transaction of the app, and its writes survive that rollback', async () => {
    const connections = connect({ system: { driver: 'sqlite', database: 'system.sqlite' } });
    await createHits(connections.get('system'));
    const infrastructure = connections.infrastructure('system', USAGE);
    await expect(
      within(
        connections.transaction(async () => {
          await hit(infrastructure);
          await hit(infrastructure);
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await count(connections.get('system'))).toBe(2);
  });

  it('another connection name for the SAME file is no way out: the transaction holds the file', async () => {
    const connections = connect({ alias: { driver: 'sqlite', database: 'app.sqlite' } });
    await createHits(connections.get());
    const infrastructure = connections.infrastructure('alias', USAGE);
    await within(
      connections.transaction(async () => {
        await hit(connections.get(), 'in the transaction'); // it holds the file's write lock now
        await expect(hit(infrastructure)).rejects.toThrow('The counter cannot work inside the open transaction on the database connection "default" (E108)');
      }),
    );
  });

  it('in a test’s isolated connection: works on the isolated connection outside of transactions, refuses inside one', async () => {
    const connections = connect({});
    await createHits(connections.get());
    const isolation = await connections.isolate();
    try {
      const infrastructure = connections.infrastructure('default', USAGE);
      await hit(infrastructure);
      expect(await count(connections.get())).toBe(1); // the test sees it — and its rollback undoes it
      await within(
        connections.transaction(async () => {
          await expect(hit(infrastructure)).rejects.toThrow(InfrastructureTransactionError);
        }),
      );
    } finally {
      await isolation.rollback();
    }
    expect(await count(connections.get())).toBe(0);
  });
});

describe.runIf(PGSQL_URL)('connections.infrastructure() on Postgres', () => {
  let drop: () => Promise<void>;
  let options: Extract<ConnectionOptions, { driver: 'pgsql' }>;
  let open: Connections[] = [];
  const connect = (overrides: Partial<Extract<ConnectionOptions, { driver: 'pgsql' }>> = {}) => {
    const connections = new Connections({ connections: { default: { ...options, ...overrides } }, root: '/', logger: silent });
    open.push(connections);
    return connections;
  };

  beforeAll(async () => {
    const fresh = await freshDatabase('pgsql');
    drop = fresh.drop;
    options = fresh.options as typeof options;
    const setup = connect();
    await createHits(setup.get());
  });
  afterEach(async () => {
    await Promise.all(open.map((connections) => connections.destroy()));
    open = [];
    const cleanup = connect();
    await sql`delete from hits`.execute(cleanup.get());
  });
  afterAll(async () => {
    await Promise.all(open.map((connections) => connections.destroy()));
    await drop();
  });

  it('a rate-limit hit inside a transaction that rolls back is kept', async () => {
    const connections = connect();
    const infrastructure = connections.infrastructure('default', USAGE);
    await expect(
      within(
        connections.transaction(async () => {
          await hit(infrastructure);
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await count(connections.get())).toBe(1);
  });

  it('a lock taken inside an open transaction is visible to another process at once', async () => {
    const connections = connect();
    const other = connect(); // another process: its own pools
    const infrastructure = connections.infrastructure('default', USAGE);
    await within(
      connections.transaction(async () => {
        await hit(infrastructure, 'lock:stats:7');
        expect(await count(other.get(), 'lock:stats:7')).toBe(1); // the transaction is still open
      }),
    );
  });

  it('has a pool of its own: transactions holding every connection of the app’s pool do not starve it', async () => {
    const connections = connect({ poolMax: 2, infrastructurePoolMax: 1 });
    const infrastructure = connections.infrastructure('default', USAGE);
    // Two transactions take both connections of the app's pool and each waits for a rate-limit hit.
    await within(Promise.all([0, 1].map(() => connections.transaction(() => hit(infrastructure)))));
    expect(await count(connections.get())).toBe(2);
  });

  it('in a test’s isolated connection: one physical connection as on SQLite — shared outside, refused inside a transaction', async () => {
    const connections = connect();
    const isolation = await connections.isolate();
    try {
      const infrastructure = connections.infrastructure('default', USAGE);
      await hit(infrastructure);
      expect(await count(connections.get())).toBe(1);
      await within(
        connections.transaction(async () => {
          await expect(hit(infrastructure)).rejects.toThrow(
            'The counter cannot work inside the open transaction on the database connection "default" (E108): in a test, the connection is isolated',
          );
        }),
      );
    } finally {
      await isolation.rollback();
    }
    expect(await count(connections.get())).toBe(0);
  });

  it('closes its pool with the connections', async () => {
    const observer = connect();
    const backends = async () =>
      Number((await sql<{ n: string }>`select count(*) as n from pg_stat_activity where datname = current_database()`.execute(observer.get())).rows[0]!.n);
    const connections = connect();
    const before = await backends();
    await hit(connections.infrastructure('default', USAGE));
    expect(await backends()).toBe(before + 1); // the infrastructure pool's connection (the app's pool never opened)
    await connections.destroy();
    expect(await backends()).toBe(before);
    expect(() => connections.infrastructure('default', USAGE)).toThrow('The database connections are closed');
  });
});

describe('TransactionError', () => {
  it('is the base of InfrastructureTransactionError', () => {
    expect(new InfrastructureTransactionError('default', USAGE, false)).toBeInstanceOf(TransactionError);
  });
});
