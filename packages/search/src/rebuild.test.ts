import { createHash } from 'node:crypto';
import { Clock, type Application, type Logger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, sql, type Connection, type Database } from '@marmeon/database';
import * as fetchModule from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import type { JobContext } from '@marmeon/queue';
import { afterEach, describe, expect, it } from 'vitest';
import { migratedApp, PGSQL_URL } from './__fixtures__/databases.ts';
import { searchOptions } from './config.ts';
import { SearchDriver, type SearchKey, type StoredDocument } from './driver.ts';
import { MeilisearchClient } from './drivers/meilisearch/client.ts';
import { documentId, MeilisearchDriver } from './drivers/meilisearch/driver.ts';
import { Rebuilder, rebuildTarget, type RebuildHooks, type RebuildOptions } from './rebuild.ts';
import { SearchIndexes, type IndexInfo } from './registry.ts';
import { IndexReader, lockDocuments, Search } from './search.ts';
import { SearchIndex, type SearchDocument } from './search-index.ts';
import { SyncSearchDocuments } from './sync-job.ts';

// search:rebuild under the hood: batches with checkpoints, resuming, the lock, the sweep of the database driver and the target and
// swap of Meilisearch, with the job writing to both while a rebuild runs.

interface PageRow {
  id: number;
  slug: string;
  title: string;
  audience: string;
  published: boolean | number;
}

class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'highest' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').select(['id', 'slug', 'title', 'audience', 'published']);
  }

  override includes(row: PageRow): boolean {
    return Boolean(row.published);
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return { fields: { title: row.title }, filters: { audience: row.audience } };
  }
}

const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

async function start(driver: 'sqlite' | 'pgsql'): Promise<{ app: Application; db: Connection<any> }> {
  const { app, close } = await migratedApp(driver, [PageIndex]);
  closing.push(close);
  return { app, db: app.container.make(Connections).get() };
}

/** Inserts pages with the ids `from` to `to`, all published. */
async function insertPages(db: Connection<any>, from: number, to: number): Promise<void> {
  for (let first = from; first <= to; first += 200) {
    const rows = [];
    for (let id = first; id <= Math.min(to, first + 199); id++) rows.push(sql`(${id}, ${`page-${id}`}, ${`Title ${id}`}, 'public', ${true})`);
    await sql`insert into pages (id, slug, title, audience, published) values ${sql.join(rows)}`.execute(db);
  }
}

/** Counts every write of a driver: the keys of each upsert, by the index it went to. */
function counted<D extends SearchDriver>(driver: D): D & { readonly upserts: { index: string; keys: SearchKey[] }[] } {
  const upserts: { index: string; keys: SearchKey[] }[] = [];
  const upsert = driver.upsert.bind(driver);
  return Object.assign(driver, {
    upserts,
    upsert: async (index: IndexInfo, documents: readonly StoredDocument[]) => {
      upserts.push({ index: index.name, keys: documents.map((document) => document.key) });
      await upsert(index, documents);
    },
  });
}

function rebuilder(app: Application, options: { driver?: SearchDriver; hooks?: RebuildHooks; clock?: Clock } = {}): Rebuilder {
  const c = app.container;
  return new Rebuilder({
    indexes: c.make(SearchIndexes),
    reader: c.make(IndexReader),
    driver: () => options.driver ?? c.make(SearchDriver),
    connections: () => c.make(Connections),
    container: c,
    clock: options.clock ?? c.make(Clock),
    hooks: options.hooks,
  });
}

function run(batch: number, fresh = false): RebuildOptions & { readonly lines: string[] } {
  const lines: string[] = [];
  return { batch, fresh, lines, report: (line) => lines.push(line) };
}

const keysOfDocuments = async (db: Connection<any>): Promise<SearchKey[]> =>
  (await sql<{ key: string }>`select key from search_documents where index_name = 'pages' order by id`.execute(db)).rows.map((row) => JSON.parse(row.key) as SearchKey).sort((a, b) => Number(a) - Number(b));

const rebuildRows = async (db: Connection<any>) =>
  (await sql<{ phase: string; after: string | null; target: string | null; holder: string | null }>`select phase, after, target, holder from search_rebuilds`.execute(db)).rows;

const rejection = async (promise: Promise<unknown>): Promise<Error> => (await promise.then(() => undefined, (error: unknown) => error)) as Error;

const drivers: ('sqlite' | 'pgsql')[] = PGSQL_URL ? ['sqlite', 'pgsql'] : ['sqlite'];

describe.each(drivers)('Rebuilder on the database driver (%s)', (name) => {
  it('copies 1234 rows in batches of 500: three batches, one line each, and the checkpoint is gone at the end', async () => {
    const { app, db } = await start(name);
    await insertPages(db, 1, 1234);
    const driver = counted(app.container.make(SearchDriver));
    const options = run(500);
    const outcome = await rebuilder(app, { driver }).rebuild(PageIndex, options);
    expect(outcome).toEqual({ status: 'done', indexed: 1234, removed: 0 });
    expect(driver.upserts.map((upsert) => upsert.keys.length)).toEqual([500, 500, 234]);
    expect(options.lines.slice(0, 3)).toEqual(['pages: 500 indexed, 0 removed', 'pages: 1000 indexed, 0 removed', 'pages: 1234 indexed, 0 removed']);
    expect(options.lines.at(-1)).toMatch(/^pages: done in \d+(\.\d)? m?s, 1234 indexed, 0 removed\.$/);
    expect((await keysOfDocuments(db)).length).toBe(1234);
    expect(await rebuildRows(db)).toEqual([]);
    const found = await app.container.make(Search).query({ in: PageIndex, term: 'Title 1234' });
    expect(found.ok && found.value.data.map((hit) => hit.key)).toContain(1234);
  });

  it('resumes after the checkpoint of a run that stopped: the second run writes only the rows after it', async () => {
    const { app, db } = await start(name);
    await insertPages(db, 1, 1234);
    const driver = counted(app.container.make(SearchDriver));
    const stop = new Error('stopped after the first batch');
    const first = rebuilder(app, {
      driver,
      hooks: {
        afterBatch: () => {
          throw stop;
        },
      },
    });
    expect(await rejection(first.rebuild(PageIndex, run(500)))).toBe(stop);
    // The batch and its checkpoint committed together; the lock was released, so the resume need not wait for it.
    expect(await rebuildRows(db)).toEqual([{ phase: 'copy', after: '500', target: null, holder: null }]);
    expect(driver.upserts.flatMap((upsert) => upsert.keys).length).toBe(500);

    const options = run(500);
    expect(await rebuilder(app, { driver }).rebuild(PageIndex, options)).toEqual({ status: 'done', indexed: 734, removed: 0 });
    expect(options.lines[0]).toMatch(/^pages: resuming the unfinished run started at \d{4}-\d\d-\d\dT/);
    const resumed = driver.upserts.slice(1).flatMap((upsert) => upsert.keys);
    expect(resumed.length).toBe(734);
    expect(Math.min(...resumed.map(Number))).toBe(501);
    expect((await keysOfDocuments(db)).length).toBe(1234);
  });

  it('starts over with --fresh: the checkpoint of the unfinished run is discarded', async () => {
    const { app, db } = await start(name);
    await insertPages(db, 1, 12);
    const driver = counted(app.container.make(SearchDriver));
    const stop = new Error('stop');
    await rejection(
      rebuilder(app, {
        driver,
        hooks: {
          afterBatch: () => {
            throw stop;
          },
        },
      }).rebuild(PageIndex, run(5)),
    );
    const options = run(5, true);
    expect(await rebuilder(app, { driver }).rebuild(PageIndex, options)).toEqual({ status: 'done', indexed: 12, removed: 0 });
    expect(options.lines[0]).toMatch(/^pages: --fresh discards the unfinished run started at /);
    expect(driver.upserts.slice(1).map((upsert) => upsert.keys[0])).toEqual([1, 6, 11]);
  });

  it('refuses a second run while the first holds the lock, and a run whose lock another run took over stops', async () => {
    const { app, db } = await start(name);
    await insertPages(db, 1, 10);
    const clock = new TestClock();
    clock.freeze();
    let second: Awaited<ReturnType<Rebuilder['rebuild']>> | undefined;
    let third: Awaited<ReturnType<Rebuilder['rebuild']>> | undefined;
    let batches = 0;
    const outcome = await rebuilder(app, {
      clock,
      hooks: {
        afterBatch: async () => {
          batches++;
          if (batches === 1) {
            second = await rebuilder(app, { clock }).rebuild(PageIndex, run(5));
            // The lock runs out after 60 seconds without a heartbeat: another run takes it over and finishes.
            clock.travel(61);
            third = await rebuilder(app, { clock }).rebuild(PageIndex, run(5));
          }
        },
      },
    }).rebuild(PageIndex, run(5));
    expect(second).toEqual({ status: 'held', until: new Date(clock.now() - 61_000 + 60_000).toISOString() });
    expect(third).toMatchObject({ status: 'done' });
    expect(outcome).toEqual({ status: 'lost' });
    expect(batches).toBe(1);
    expect(await rebuildRows(db)).toEqual([]);
  });

  it('sweeps documents whose rows are gone or no longer belong, but keeps one the app wrote again while the sweep ran', async () => {
    const { app, db } = await start(name);
    await insertPages(db, 1, 10);
    const search = app.container.make(Search);
    await search.index(PageIndex, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Gone without search.remove(): only a rebuild finds these.
    await sql`delete from pages where id in (3, 7)`.execute(db);
    let copied = 0;
    let swept = 0;
    const options = run(5);
    const outcome = await rebuilder(app, {
      hooks: {
        afterBatch: async (phase) => {
          // Unpublished behind the back of search after its batch was copied: the sweep finds it.
          if (phase === 'copy' && ++copied === 1) await sql`update pages set published = ${false} where id = 2`.execute(db);
        },
        beforeSweepDelete: async () => {
          // The second sweep batch read the document of 7 and found its row gone; the app brings 7 back before the sweep deletes.
          if (++swept === 2) {
            await insertPages(db, 7, 7);
            await search.index(PageIndex, 7);
          }
        },
      },
    }).rebuild(PageIndex, options);
    expect(outcome).toEqual({ status: 'done', indexed: 8, removed: 2 });
    expect(await keysOfDocuments(db)).toEqual([1, 4, 5, 6, 7, 8, 9, 10]);
    expect(options.lines).toContain('pages: 10 checked, 2 removed');
  });

  it('removes the document of a row that no longer belongs while it copies', async () => {
    const { app, db } = await start(name);
    await insertPages(db, 1, 3);
    await app.container.make(Search).index(PageIndex, [1, 2, 3]);
    await sql`update pages set published = ${false} where id = 2`.execute(db);
    expect(await rebuilder(app).rebuild(PageIndex, run(500))).toEqual({ status: 'done', indexed: 2, removed: 1 });
    expect(await keysOfDocuments(db)).toEqual([1, 3]);
  });

  it('sweeps a stale document "42" in the batch of the document 42, and keeps 42', async () => {
    const { app, db } = await start(name);
    await insertPages(db, 42, 42);
    const info = app.container.make(SearchIndexes).info(PageIndex);
    // A document under the key "42", written before the key had the type of its column; then the document of the row 42 itself.
    await app.container.make(SearchDriver).upsert(info, [{ key: '42', locale: null, fields: { title: 'Old' }, filters: { audience: 'public' } }]);
    await app.container.make(Search).index(PageIndex, 42);
    const outcome = await rebuilder(app).rebuild(PageIndex, run(500));
    expect(outcome).toEqual({ status: 'done', indexed: 1, removed: 1 });
    const stored = (await sql<{ key: string }>`select key from search_documents where index_name = 'pages'`.execute(db)).rows.map((row) => row.key);
    expect(stored).toEqual(['42']);
  });

  it('never sweeps a document the read also built, even when the read lists its key as removed too', async () => {
    const { app, db } = await start(name);
    await insertPages(db, 1, 2);
    await app.container.make(Search).index(PageIndex, [1, 2]);
    const real = app.container.make(IndexReader);
    // A read that reports each key it built a document for as removed as well: the sweep must keep those documents.
    const reader = {
      read: async (...args: Parameters<IndexReader['read']>) => {
        const found = await real.read(...args);
        return { ...found, removed: [...found.removed, ...found.documents.map((document) => document.key)] };
      },
    } as unknown as IndexReader;
    const c = app.container;
    const runner = new Rebuilder({ indexes: c.make(SearchIndexes), reader, driver: () => c.make(SearchDriver), connections: () => c.make(Connections), container: c, clock: c.make(Clock) });
    await runner.rebuild(PageIndex, run(500));
    expect(await keysOfDocuments(db)).toEqual([1, 2]);
  });
});

/**
 * Resolves once a session of the test database waits for an advisory lock, or once `settled` says the race is decided; fails after
 * 500 looks.
 */
async function advisoryWaiter(db: Connection<any>, settled: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !settled(); attempt++) {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`.execute(db);
    if (rows[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!settled()) throw new Error('No session waited for an advisory lock.');
}

/** Holds the first upsert of a driver until `release()`; `reached` resolves once it waits. Later upserts run at once. */
function holdFirstUpsert(driver: SearchDriver): { readonly reached: Promise<void>; release(): void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const upsert = driver.upsert.bind(driver);
  let first = true;
  driver.upsert = async (index, documents) => {
    if (first) {
      first = false;
      arrive();
      await held;
    }
    await upsert(index, documents);
  };
  return { reached, release };
}

const filtersOf = async (db: Connection<any>, key: SearchKey): Promise<unknown> =>
  (await sql<{ filters: unknown }>`select filters from search_documents where index_name = 'pages' and key = ${JSON.stringify(key)}`.execute(db)).rows[0]?.filters;

describe.skipIf(!PGSQL_URL)('Rebuilder and Search on Postgres: a write of an older read never lands after a newer one', () => {
  /**
   * Holds the older write after its read, then commits a change of the row with search.index() in another transaction and lets the
   * older write go. Without the lock the change commits first and the older write overwrites it; with it, the change waits.
   */
  async function race(older: (app: Application) => Promise<unknown>, newer: 'index' | 'remove' = 'index'): Promise<unknown> {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 1);
    const connections = app.container.make(Connections);
    const hold = holdFirstUpsert(app.container.make(SearchDriver));
    const first = older(app);
    await hold.reached;
    let done = false;
    const change = connections
      .transaction(async () => {
        const search = app.container.make(Search);
        if (newer === 'remove') {
          await sql`delete from pages where id = 1`.execute(connections.get());
          await search.remove(PageIndex, 1);
        } else {
          await sql`update pages set audience = 'members' where id = 1`.execute(connections.get());
          await search.index(PageIndex, 1);
        }
      })
      .finally(() => (done = true));
    // Either the change committed (no lock) or it waits for the lock of the older write.
    await Promise.race([change, advisoryWaiter(db, () => done)]);
    hold.release();
    await first;
    await change;
    return filtersOf(db, 1);
  }

  it('a rebuild batch: the change of the app ends in the index', async () => {
    expect(await race((app) => rebuilder(app).rebuild(PageIndex, run(500)))).toEqual({ audience: 'members' });
  });

  it('search.remove() after the row is deleted: the document stays removed', async () => {
    expect(await race((app) => app.container.make(Connections).transaction(() => app.container.make(Search).index(PageIndex, 1)), 'remove')).toBeUndefined();
  });

  it('search.index() of the same row in another transaction: the change ends in the index', async () => {
    expect(await race((app) => app.container.make(Connections).transaction(() => app.container.make(Search).index(PageIndex, 1)))).toEqual({ audience: 'members' });
  });
});

/** The same rows under the index name `pages`, by slug. */
class SlugPageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'slug';
  static readonly fields = { title: 'highest' } as const;

  source(db: Database) {
    return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').select(['id', 'slug', 'title', 'audience', 'published']);
  }

  toDocument(row: PageRow): SearchDocument<typeof SlugPageIndex> {
    return { fields: { title: row.title } };
  }
}

describe.skipIf(!PGSQL_URL)('Rebuilder and Search on Postgres: the lock slots', () => {
  it('indexes 15 000 keys in one transaction with at most 128 advisory locks', { timeout: 30_000 }, async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 15_000);
    const connections = app.container.make(Connections);
    const held = await connections.transaction(async () => {
      await app.container.make(Search).index(PageIndex, Array.from({ length: 15_000 }, (_, i) => i + 1));
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`.execute(connections.get());
      return rows[0]!.n;
    });
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThanOrEqual(128);
    expect(await keysOfDocuments(db)).toHaveLength(15_000);
  });

  /** Takes the slots of these keys in a transaction of its own with brief waits: whether it got them all. */
  async function tryLock(connections: Connections, index: string, keys: readonly SearchKey[]): Promise<boolean> {
    class Busy extends Error {}
    return connections
      .transaction(async () => {
        if (!(await lockDocuments(connections, index, keys, { brief: true }))) throw new Busy();
        return true;
      })
      .catch((error: unknown) => {
        if (error instanceof Busy) return false;
        throw error;
      });
  }

  it('gives each index slots of its own: a transaction holding every slot of one index leaves another index free', async () => {
    const { app } = await start('pgsql');
    const connections = app.container.make(Connections);
    const keys = Array.from({ length: 3000 }, (_, i) => i + 1);
    let holding!: () => void;
    const holds = new Promise<void>((resolve) => (holding = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const bulk = connections.transaction(async () => {
      await lockDocuments(connections, 'pages', keys);
      holding();
      await gate;
    });
    await holds;
    try {
      expect([await tryLock(connections, 'posts', keys), await tryLock(connections, 'pages', [1])]).toEqual([true, false]);
    } finally {
      release();
      await bulk;
    }
  });

  it('restores the lock_timeout and statement_timeout of the transaction after the brief wait for the slots', async () => {
    const { app } = await start('pgsql');
    const connections = app.container.make(Connections);
    const after = await connections.transaction(async () => {
      await sql`set local lock_timeout = '5s'`.execute(connections.get());
      await sql`set local statement_timeout = '7s'`.execute(connections.get());
      expect(await lockDocuments(connections, 'pages', [1, 2, 3], { brief: true })).toBe(true);
      return (await sql<{ lock: string; statement: string }>`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`.execute(connections.get())).rows[0];
    });
    expect(after).toEqual({ lock: '5s', statement: '7s' });
  });

  it('keeps a shorter lock_timeout the transaction already has for the brief wait', async () => {
    const { app } = await start('pgsql');
    const connections = app.container.make(Connections);
    let holding!: () => void;
    const holds = new Promise<void>((resolve) => (holding = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = connections.transaction(async () => {
      await lockDocuments(connections, 'pages', [1]);
      holding();
      await gate;
    });
    await holds;
    try {
      // With 20 ms the wait runs out long before the 200 ms of the brief wait; the holder lets go only after 300 ms.
      setTimeout(release, 300);
      class Busy extends Error {}
      const taken = await connections
        .transaction(async () => {
          await sql`set local lock_timeout = '20ms'`.execute(connections.get());
          if (!(await lockDocuments(connections, 'pages', [1], { brief: true }))) throw new Busy();
          return true;
        })
        .catch((error: unknown) => (error instanceof Busy ? false : Promise.reject(error)));
      expect(taken).toBe(false);
    } finally {
      release();
      await holder;
    }
  });

  it('gives up the whole slot statement after half the deadlock_timeout, even when no single wait runs out', async () => {
    const { app, db } = await start('pgsql');
    const connections = app.container.make(Connections);
    // Four keys of distinct slots, in the order the statement locks them.
    const { rows } = await sql<{ k: number }>`select distinct on (slot) k from (select k, (hashtext('pages') & ${~127}) | (hashtext('pages' || chr(1) || k::text) & 127) as slot
      from generate_series(1, 100) as k) as s order by slot limit 4`.execute(db);
    const keys = rows.map((row) => row.k);
    expect(keys).toHaveLength(4);
    // Each holder lets its slot go 150 ms after the one before: every single wait stays below the 200 ms lock_timeout, the four
    // together pass the 500 ms the statement may take with the default deadlock_timeout of one second.
    let holding = 0;
    let allHeld!: () => void;
    const held = new Promise<void>((resolve) => (allHeld = resolve));
    let letGo!: () => void;
    const go = new Promise<void>((resolve) => (letGo = resolve));
    const holders = keys.map((key, position) =>
      connections.transaction(async () => {
        await lockDocuments(connections, 'pages', [key]);
        if (++holding === keys.length) allHeld();
        await go;
        await new Promise((resolve) => setTimeout(resolve, 150 * (position + 1)));
      }),
    );
    await held;
    letGo();
    try {
      expect(await tryLock(connections, 'pages', keys)).toBe(false);
    } finally {
      await Promise.all(holders);
    }
  });

  it('gives way in a cycle with an app transaction: the app never gets a deadlock error, and the rebuild retries and finishes', async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 50);
    // A key whose slot the rebuild takes before the slot of 1: it holds that slot while it waits for 1.
    const { rows } = await sql<{ k: number }>`select k from generate_series(2, 50) as k
      order by (hashtext('pages') & ${~127}) | (hashtext('pages' || chr(1) || k::text) & 127) limit 1`.execute(db);
    const first = rows[0]!.k;
    const slotOf = async (key: number) =>
      (await sql<{ slot: number }>`select (hashtext('pages') & ${~127}) | (hashtext('pages' || chr(1) || ${String(key)}) & 127) as slot`.execute(db)).rows[0]!.slot;
    expect(await slotOf(first)).toBeLessThan(await slotOf(1));
    const connections = app.container.make(Connections);
    const search = app.container.make(Search);
    let holding!: () => void;
    const holds = new Promise<void>((resolve) => (holding = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const appWrites = connections.transaction(async () => {
      await sql`update pages set audience = 'members' where id in (1, ${first})`.execute(connections.get());
      await search.index(PageIndex, 1);
      holding();
      await gate;
      // The rebuild holds the slot of this key and waits for the slot of 1, which this transaction holds: a cycle.
      await search.index(PageIndex, first);
    });
    await holds;
    const retries: number[] = [];
    const rebuild = rebuilder(app, { hooks: { beforeRetry: (attempt) => void retries.push(attempt) } }).rebuild(PageIndex, run(500));
    let done = false;
    await advisoryWaiter(db, () => done);
    release();
    await appWrites;
    const outcome = await rebuild.finally(() => (done = true));
    expect(retries.length).toBeGreaterThan(0);
    expect(outcome).toEqual({ status: 'done', indexed: 50, removed: 0 });
    expect(await filtersOf(db, 1)).toEqual({ audience: 'members' });
    expect(await filtersOf(db, first)).toEqual({ audience: 'members' });
  });

  it('finishes while app transactions keep writing documents of the index', { timeout: 60_000 }, async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 1000);
    const connections = app.container.make(Connections);
    const search = app.container.make(Search);
    let stop = false;
    let writes = 0;
    const client = async (offset: number) => {
      for (let n = 0; !stop; n++) {
        await connections.transaction(async () => {
          await search.index(PageIndex, ((n * 37 + offset * 101) % 1000) + 1);
          await new Promise((resolve) => setTimeout(resolve, 60));
        });
        writes++;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    // Eight writers, each holding a slot of the index most of the time: a batch never finds all its slots free at one moment.
    const clients = [0, 1, 2, 3, 4, 5, 6, 7].map((offset) => client(offset));
    try {
      const outcome = await rebuilder(app).rebuild(PageIndex, run(500));
      expect(outcome).toEqual({ status: 'done', indexed: 1000, removed: 0 });
    } finally {
      stop = true;
      await Promise.all(clients);
    }
    expect(writes).toBeGreaterThan(0);
  });

  it('stops after the last try while the slots stay held, keeps the checkpoint before that batch and releases the lock', async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 4);
    const connections = app.container.make(Connections);
    let holding!: () => void;
    const holds = new Promise<void>((resolve) => (holding = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Holds the slot of 3 for the whole run: the first batch (1, 2) is written, the second (3, 4) never gets its slots.
    const appWrites = connections.transaction(async () => {
      await app.container.make(Search).index(PageIndex, 3);
      holding();
      await gate;
    });
    await holds;
    const retries: number[] = [];
    try {
      const error = await rejection(rebuilder(app, { hooks: { lockAttempts: 3, beforeRetry: (attempt) => void retries.push(attempt) } }).rebuild(PageIndex, run(2)));
      expect(error.message).toBe('Other writes of search held documents of a batch of "pages" at each of 3 tries; run marmeon search:rebuild pages again to resume.');
    } finally {
      release();
      await appWrites;
    }
    expect(retries).toEqual([1, 2]);
    expect(await rebuildRows(db)).toEqual([{ phase: 'copy', after: '2', target: null, holder: null }]);
  });

  it('never waits for the migration lock, even for a key whose 64-bit hash is its key', async () => {
    const { app, close } = await migratedApp('pgsql', [SlugPageIndex]);
    closing.push(close);
    const connections = app.container.make(Connections);
    const db = connections.get();
    const slug = 'probe?<.[G-+Jyz1';
    // ADVISORY_KEY of packages/database/src/migrations/lock.ts, the one bigint lock of `marmeon migrate`.
    const migrationKey = '5570194408043267922';
    const { rows } = await sql<{ hash: string }>`select hashtextextended('pages' || chr(1) || ${JSON.stringify(slug)}, 0)::text as hash`.execute(db);
    expect(rows[0]!.hash).toBe(migrationKey);
    await sql`insert into pages (id, slug, title, audience, published) values (1, ${slug}, 'Probe', 'public', ${true})`.execute(db);
    let holding!: () => void;
    const holds = new Promise<void>((resolve) => (holding = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const migration = connections.transaction(async () => {
      await sql`select pg_advisory_xact_lock(${migrationKey}::bigint)`.execute(connections.get());
      holding();
      await gate;
    });
    await holds;
    try {
      // A wait for the migration lock fails the statement after a second instead of hanging the test.
      await connections.transaction(async () => {
        await sql`set local lock_timeout = '1s'`.execute(connections.get());
        await app.container.make(Search).index(SlugPageIndex, slug);
      });
    } finally {
      release();
      await migration;
    }
    expect((await sql<{ key: string }>`select key from search_documents`.execute(db)).rows.map((row) => row.key)).toEqual([JSON.stringify(slug)]);
  });
});

/** Text of fewer than 200 000 characters whose words make a tsvector over the limit of Postgres: unique hyphenated CJK compounds. */
function tooLongText(): string {
  let next = 0;
  const word = (): string => {
    let value = next++;
    let text = '';
    for (let i = 0; i < 4; i++) {
      text += String.fromCodePoint(0x4e00 + (value % 20000));
      value = Math.floor(value / 20000);
    }
    return text;
  };
  const parts: string[] = [];
  for (let i = 0; i < 19_900; i++) parts.push(`${word()}-${word()}`);
  return parts.join(' ');
}

describe.skipIf(!PGSQL_URL)('Rebuilder and Search on Postgres: a document too long for a tsvector', () => {
  const message =
    'The document of the key 2 in the search index "pages" is too long for Postgres: the words of the text make a tsvector over its limit of 1048575 bytes, so the index holds no document for it. Return less text from toDocument() for that row.';

  it('fails search.index() naming the index, the key and the limit; the other documents of the batch are written', async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 3);
    const search = app.container.make(Search);
    await search.index(PageIndex, [1, 2, 3]);
    const text = tooLongText();
    expect([...text].length).toBeLessThan(200_000);
    await sql`update pages set title = ${text} where id = 2`.execute(db);
    await sql`update pages set title = 'Changed' where id = 3`.execute(db);
    const titleOf3 = async () => (await sql<{ a: string }>`select a from search_documents where key = '3'`.execute(db)).rows.map((row) => row.a);
    // In the caller's transaction: the rest is written and the old document of 2 removed before the error reaches the caller.
    await expect(
      app.container.make(Connections).transaction(async () => {
        await expect(search.index(PageIndex, [1, 2, 3])).rejects.toThrow(message);
        expect(await keysOfDocuments(db)).toEqual([1, 3]);
        expect(await titleOf3()).toEqual(['Changed']);
        throw new Error('the caller rolls back');
      }),
    ).rejects.toThrow('the caller rolls back');
    expect(await keysOfDocuments(db)).toEqual([1, 2, 3]);
    // In a transaction of its own: that transaction commits the rest and the removal, then the error is thrown.
    await expect(search.index(PageIndex, [1, 2, 3])).rejects.toThrow(message);
    expect(await keysOfDocuments(db)).toEqual([1, 3]);
    expect(await titleOf3()).toEqual(['Changed']);
  });

  it('isolates the documents too long in a later statement of the batch, and names them all', async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 205);
    const text = tooLongText();
    // 1 is in the first statement of 100 documents, 150 and 205 in the second and the third.
    await sql`update pages set title = ${text} where id in (1, 150, 205)`.execute(db);
    await expect(app.container.make(Search).index(PageIndex, Array.from({ length: 205 }, (_, i) => i + 1))).rejects.toThrow(
      'The documents of the keys 1, 150, 205 in the search index "pages" are too long for Postgres: the words of the text make a tsvector over its limit of 1048575 bytes, so the index holds no document for them. Return less text from toDocument() for those rows.',
    );
    const stored = await keysOfDocuments(db);
    expect(stored).toHaveLength(202);
    expect(stored).not.toContain(150);
  });

  it('writes every batch of a call in the caller\'s transaction before it throws, when an early batch holds a document too long', async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 600);
    await sql`update pages set title = ${tooLongText()} where id = 1`.execute(db);
    const connections = app.container.make(Connections);
    await connections.transaction(async () => {
      // 1 is in the first batch of 500, 600 in the second.
      await expect(app.container.make(Search).index(PageIndex, Array.from({ length: 600 }, (_, i) => i + 1))).rejects.toThrow('The document of the key 1 in the search index "pages"');
    });
    const stored = await keysOfDocuments(db);
    expect(stored).toHaveLength(599);
    expect(stored).toContain(600);
  });

  it('throws an error of the database other than the limit as it is, and writes nothing', async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 2);
    // A check the table refuses: an error the driver must not take for a document too long.
    await sql`alter table search_documents add constraint no_second check (key <> '2')`.execute(db);
    const error = await rejection(app.container.make(Search).index(PageIndex, [1, 2]));
    expect(error.message).toContain('no_second');
    expect(await keysOfDocuments(db)).toEqual([]);
  });

  it('a rebuild writes the rest, removes the old document of the key, reports it and goes on', async () => {
    const { app, db } = await start('pgsql');
    await insertPages(db, 1, 5);
    await app.container.make(Search).index(PageIndex, [1, 2, 3, 4, 5]);
    await sql`update pages set title = ${tooLongText()} where id = 2`.execute(db);
    const options = run(3);
    const outcome = await rebuilder(app).rebuild(PageIndex, options);
    expect(outcome).toEqual({ status: 'done', indexed: 4, removed: 0, failed: [2] });
    expect(options.lines).toContain(`pages: ${message}`);
    expect(options.lines.at(-1)).toMatch(/^pages: done in .+, 4 indexed, 0 removed, 1 failed\.$/);
    expect(await keysOfDocuments(db)).toEqual([1, 3, 4, 5]);
    expect(await rebuildRows(db)).toEqual([]);
  });
});

/**
 * A Meilisearch that keeps its indexes in memory and applies each write at once, as a finished task: enough for a rebuild, its
 * target and its swap. `failSwap` answers the next swap with an outage.
 */
function fakeMeilisearch() {
  const BASE = 'http://meili.internal:7700';
  const indexes = new Map<string, Map<string, Record<string, unknown>>>();
  const tasks = new Map<number, Record<string, unknown>>();
  const state = { failSwap: false, requests: [] as string[] };
  let next = 0;
  const task = (error?: string): Response => {
    const uid = next++;
    tasks.set(uid, error === undefined ? { uid, status: 'succeeded' } : { uid, status: 'failed', error: { code: error } });
    return Response.json({ taskUid: uid, status: 'enqueued' }, { status: 202 });
  };
  const missing = (): Response => Response.json({ code: 'index_not_found' }, { status: 404 });
  const http = new HttpClientFake().dns('meili.internal', ['10.0.0.5']).respond(/./, async (request) => {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    state.requests.push(`${request.method} /${parts.join('/')}`);
    const body = request.method === 'GET' || request.method === 'DELETE' ? undefined : (JSON.parse(await request.text()) as unknown);
    if (parts[0] === 'tasks') return Response.json(tasks.get(Number(parts[1])));
    if (parts[0] === 'swap-indexes') {
      if (state.failSwap) {
        state.failSwap = false;
        return Response.json({ code: 'internal' }, { status: 503 });
      }
      const [pair] = body as { indexes: [string, string] }[];
      const [a, b] = pair!.indexes;
      const first = indexes.get(a);
      const second = indexes.get(b);
      if (first === undefined || second === undefined) return task('index_not_found');
      indexes.set(a, second);
      indexes.set(b, first);
      return task();
    }
    if (parts[0] !== 'indexes') return Response.json({ code: 'unknown' }, { status: 400 });
    if (parts.length === 1) {
      const { uid } = body as { uid: string };
      if (indexes.has(uid)) return task('index_already_exists');
      indexes.set(uid, new Map());
      return task();
    }
    const index = indexes.get(parts[1]!);
    if (parts.length === 2) {
      if (request.method === 'GET') return index === undefined ? missing() : Response.json({ uid: parts[1] });
      if (index === undefined) return task('index_not_found');
      indexes.delete(parts[1]!);
      return task();
    }
    if (index === undefined) return task('index_not_found');
    if (parts[2] === 'settings') return task();
    if (parts[2] === 'documents' && parts[3] === 'delete-batch') {
      for (const id of body as string[]) index.delete(id);
      return task();
    }
    if (parts[2] === 'documents' && request.method === 'DELETE') {
      index.clear();
      return task();
    }
    for (const document of body as Record<string, unknown>[]) index.set(document['id'] as string, document);
    return task();
  });
  const client = new MeilisearchClient({ url: new URL(BASE), apiKey: 'local-test-key', http: () => http, fetch: () => fetchModule, lookup: async () => ['10.0.0.5'], sleep: async () => {} });
  const driver = counted(new MeilisearchDriver(client, { warn() {} } as unknown as Logger));
  return { driver, indexes, state, titles: (uid: string) => [...(indexes.get(uid)?.values() ?? [])].map((document) => document['s_title']).sort() };
}

const jobContext = (): JobContext => ({ signal: new AbortController().signal, fail: (reason: string) => Promise.reject(new Error(reason)) }) as unknown as JobContext;

describe('Rebuilder on Meilisearch', () => {
  it('fills a target of its own, swaps it in and deletes the old documents with it; a job during the run writes to both', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 5);
    const meili = fakeMeilisearch();
    // The live index holds an old document of a row that is gone: the swap leaves it behind.
    meili.indexes.set('pages', new Map([[documentId(99), { id: documentId(99), key: 99, s_title: 'Gone' }]]));
    const c = app.container;
    const job = new SyncSearchDocuments(c.make(SearchIndexes), c.make(IndexReader), meili.driver, c.make(Clock), (index) => rebuildTarget(c.make(Connections), index));
    let target: string | undefined;
    let batches = 0;
    const outcome = await rebuilder(app, {
      driver: meili.driver,
      hooks: {
        afterBatch: async () => {
          if (++batches !== 1) return;
          target = (await rebuildRows(db))[0]!.target!;
          // A row of the first batch changes after it was copied: only the job's write to the target brings the change over.
          await sql`update pages set title = 'Changed' where id = 1`.execute(db);
          await job.handle({ index: 'pages', keys: [1] }, jobContext());
        },
      },
    }).rebuild(PageIndex, run(2));
    expect(outcome).toEqual({ status: 'done', indexed: 5, removed: 0 });
    expect(target).toMatch(/^pages__rebuild_[0-9a-f]{8}$/);
    expect(meili.titles('pages')).toEqual(['Changed', 'Title 2', 'Title 3', 'Title 4', 'Title 5']);
    expect(meili.indexes.has(target!)).toBe(false);
    expect(meili.driver.upserts.filter((upsert) => upsert.index === 'pages').map((upsert) => upsert.keys)).toEqual([[1]]);
    expect(meili.state.requests).toContain(`PATCH /indexes/${target}/settings`);
    expect(await rebuildRows(db)).toEqual([]);
    // After the rebuild, a job writes to the live index alone.
    await job.handle({ index: 'pages', keys: [2] }, jobContext());
    expect(meili.driver.upserts.at(-1)).toEqual({ index: 'pages', keys: [2] });
  });

  it('creates the index itself on a first rebuild, so the job during the run reaches the target too and the swap finds both', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 3);
    const meili = fakeMeilisearch();
    const c = app.container;
    const job = new SyncSearchDocuments(c.make(SearchIndexes), c.make(IndexReader), meili.driver, c.make(Clock), (index) => rebuildTarget(c.make(Connections), index));
    let batches = 0;
    const outcome = await rebuilder(app, {
      driver: meili.driver,
      hooks: {
        afterBatch: async () => {
          if (++batches !== 1) return;
          await sql`update pages set title = 'Changed' where id = 1`.execute(db);
          await job.handle({ index: 'pages', keys: [1] }, jobContext());
        },
      },
    }).rebuild(PageIndex, run(2));
    expect(outcome).toMatchObject({ status: 'done', indexed: 3 });
    expect([...meili.indexes.keys()]).toEqual(['pages']);
    expect(meili.titles('pages')).toEqual(['Changed', 'Title 2', 'Title 3']);
    expect(meili.state.requests).toContain('PATCH /indexes/pages/settings');
  });

  it('builds the job with a look into search_rebuilds: a target there gets every write of the job too', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 1);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    meili.indexes.set('pages__rebuild_0a1b2c3d', new Map());
    app.container.instance(SearchDriver, meili.driver);
    await sql`insert into search_rebuilds (index_name, run, phase, target, started_at) values ('pages', ${crypto.randomUUID()}, 'copy', 'pages__rebuild_0a1b2c3d', ${new Date().toISOString()})`.execute(db);
    await app.container.make(SyncSearchDocuments).handle({ index: 'pages', keys: [1] }, jobContext());
    expect(meili.driver.upserts.map((upsert) => upsert.index)).toEqual(['pages__rebuild_0a1b2c3d', 'pages']);
  });

  it('writes a batch again when its rows changed between its read and its write, as the job does', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 2);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    const upsert = meili.driver.upsert;
    let changed = false;
    meili.driver.upsert = async (index, documents) => {
      await upsert(index, documents);
      // A job wrote the new title just before this write landed with the old one.
      if (!changed) {
        changed = true;
        await sql`update pages set title = 'Newer' where id = 1`.execute(db);
      }
    };
    expect(await rebuilder(app, { driver: meili.driver }).rebuild(PageIndex, run(500))).toMatchObject({ status: 'done' });
    expect(meili.titles('pages')).toEqual(['Newer', 'Title 2']);
    expect(meili.driver.upserts.map((entry) => entry.keys)).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });

  it('keeps the target of a resumed run, and deletes the target of a discarded one', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 4);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    const stop = new Error('stop');
    const stopping = { afterBatch: () => Promise.reject(stop) };
    expect(await rejection(rebuilder(app, { driver: meili.driver, hooks: stopping }).rebuild(PageIndex, run(2)))).toBe(stop);
    const [{ target: first }] = (await rebuildRows(db)) as unknown as [{ target: string }];
    expect(meili.indexes.get(first)?.size).toBe(2);

    expect(await rejection(rebuilder(app, { driver: meili.driver, hooks: stopping }).rebuild(PageIndex, run(1)))).toBe(stop);
    expect((await rebuildRows(db))[0]!.target).toBe(first);
    expect(meili.indexes.get(first)?.size).toBe(3);

    const options = run(2, true);
    expect(await rebuilder(app, { driver: meili.driver }).rebuild(PageIndex, options)).toMatchObject({ status: 'done', indexed: 4 });
    expect(meili.state.requests).toContain(`DELETE /indexes/${first}`);
    expect(meili.indexes.has(first)).toBe(false);
    expect(meili.titles('pages')).toEqual(['Title 1', 'Title 2', 'Title 3', 'Title 4']);
  });

  it('never swaps twice: after a swap that threw, the next run discards that target and starts a new one', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 3);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    meili.state.failSwap = true;
    const error = await rejection(rebuilder(app, { driver: meili.driver }).rebuild(PageIndex, run(500)));
    expect(error.message).toContain('Meilisearch answered 503');
    const [row] = await rebuildRows(db);
    expect(row).toMatchObject({ phase: 'sweep', holder: null });
    const abandoned = row!.target!;

    const options = run(500);
    expect(await rebuilder(app, { driver: meili.driver }).rebuild(PageIndex, options)).toMatchObject({ status: 'done', indexed: 3 });
    expect(options.lines[0]).toBe('pages: the unfinished run stopped during its swap and cannot go on; starting a new run.');
    expect(meili.state.requests).toContain(`DELETE /indexes/${abandoned}`);
    expect(meili.state.requests.filter((request) => request === 'POST /swap-indexes')).toHaveLength(2);
    expect([...meili.indexes.keys()]).toEqual(['pages']);
    expect(meili.titles('pages')).toEqual(['Title 1', 'Title 2', 'Title 3']);
  });

  it('empties the target of a discarded run with flush() when the driver cannot delete one', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 2);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    const stop = new Error('stop');
    await rejection(rebuilder(app, { driver: meili.driver, hooks: { afterBatch: () => Promise.reject(stop) } }).rebuild(PageIndex, run(1)));
    const [{ target: first }] = (await rebuildRows(db)) as unknown as [{ target: string }];
    const flushed: string[] = [];
    const real = meili.driver;
    const withoutDiscard: SearchDriver = {
      writes: 'queue',
      upsert: (index, documents) => real.upsert(index, documents),
      delete: (index, keys) => real.delete(index, keys),
      query: (request) => real.query(request),
      prepare: (index, target) => real.prepare(index, target),
      swap: (index, target) => real.swap(index, target),
      flush: async (index) => {
        flushed.push(index.name);
        await real.flush(index);
      },
    };
    expect(await rebuilder(app, { driver: withoutDiscard }).rebuild(PageIndex, run(500, true))).toMatchObject({ status: 'done' });
    expect(flushed).toEqual([first]);
    expect(meili.indexes.get(first)?.size).toBe(0);
  });

  it('goes on when that flush throws, since the old target never goes live again', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 2);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    await rejection(rebuilder(app, { driver: meili.driver, hooks: { afterBatch: () => Promise.reject(new Error('stop')) } }).rebuild(PageIndex, run(1)));
    const real = meili.driver;
    const throwing: SearchDriver = {
      writes: 'queue',
      upsert: (index, documents) => real.upsert(index, documents),
      delete: (index, keys) => real.delete(index, keys),
      query: (request) => real.query(request),
      prepare: (index, target) => real.prepare(index, target),
      swap: (index, target) => real.swap(index, target),
      flush: () => Promise.reject(new Error('no such index')),
    };
    const options = run(500, true);
    expect(await rebuilder(app, { driver: throwing }).rebuild(PageIndex, options)).toMatchObject({ status: 'done', indexed: 2 });
    expect(meili.titles('pages')).toEqual(['Title 1', 'Title 2']);
    expect(options.lines[1]).toMatch(/^pages: the target pages__rebuild_[0-9a-f]{8} of the earlier run could not be emptied and may still hold its documents; delete it by hand\.$/);
  });
});

describe('Rebuilder: the lock, the transaction of a batch and the resume of a sweep', () => {
  it('rolls a batch back with its checkpoint when its heartbeat finds another holder, and stops', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 10);
    const driver = counted(app.container.make(SearchDriver));
    const upsert = driver.upsert;
    driver.upsert = async (index, documents) => {
      await upsert(index, documents);
      // Another run takes the lock over while the second batch is written, before its heartbeat.
      if (driver.upserts.length === 2) await sql`update search_rebuilds set holder = 'rival', held_until = ${Date.now() + 60_000}`.execute(db);
    };
    expect(await rebuilder(app, { driver }).rebuild(PageIndex, run(5))).toEqual({ status: 'lost' });
    expect(await keysOfDocuments(db)).toEqual([1, 2, 3, 4, 5]);
    expect((await rebuildRows(db))[0]!.after).toBe('5');
  });

  it('renews the lock with each batch: a run that started more than 60 seconds ago still holds it', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 15);
    const clock = new TestClock();
    clock.freeze();
    let batches = 0;
    let rival: Awaited<ReturnType<Rebuilder['rebuild']>> | undefined;
    const outcome = await rebuilder(app, {
      clock,
      hooks: {
        afterBatch: async () => {
          clock.travel(40);
          // 80 seconds after the start, 40 after the last heartbeat.
          if (++batches === 2) rival = await rebuilder(app, { clock }).rebuild(PageIndex, run(5));
        },
      },
    }).rebuild(PageIndex, run(5));
    expect(rival).toMatchObject({ status: 'held' });
    expect(outcome).toMatchObject({ status: 'done', indexed: 15 });
  });

  it('resumes a run that stopped in its sweep: it copies nothing again and sweeps from the saved document on', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 10);
    await app.container.make(Search).index(PageIndex, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await sql`delete from pages where id in (2, 8)`.execute(db);
    const stop = new Error('stopped in the sweep');
    const stopping = {
      afterBatch: (phase: 'copy' | 'sweep') => {
        if (phase === 'sweep') throw stop;
      },
    };
    expect(await rejection(rebuilder(app, { hooks: stopping }).rebuild(PageIndex, run(5)))).toBe(stop);
    expect(await rebuildRows(db)).toEqual([{ phase: 'sweep', after: '5', target: null, holder: null }]);
    expect(await keysOfDocuments(db)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10]);

    const driver = counted(app.container.make(SearchDriver));
    const options = run(5);
    expect(await rebuilder(app, { driver }).rebuild(PageIndex, options)).toEqual({ status: 'done', indexed: 0, removed: 1 });
    expect(driver.upserts).toEqual([]);
    expect(options.lines.slice(0, 2)).toEqual([expect.stringMatching(/^pages: resuming the unfinished run started at /), 'pages: 5 checked, 1 removed']);
    expect(await keysOfDocuments(db)).toEqual([1, 3, 4, 5, 6, 7, 9, 10]);
  });

  it('reads the rows in the order of the key, whatever order source() gives them', async () => {
    class ByTitle extends PageIndex {
      override source(db: Database) {
        return super.source(db).orderBy('title');
      }
    }
    const reordered = await migratedApp('sqlite', [ByTitle]);
    closing.push(reordered.close);
    const other = reordered.app.container.make(Connections).get();
    // Titles in the opposite order of the ids.
    for (let id = 1; id <= 5; id++) await sql`insert into pages (id, slug, title, audience) values (${id}, ${`p${id}`}, ${`Title ${10 - id}`}, 'public')`.execute(other);
    expect(await rebuilder(reordered.app).rebuild(ByTitle, run(2))).toMatchObject({ status: 'done', indexed: 5 });
    expect(await keysOfDocuments(other)).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses with the commands that make it when search_rebuilds is missing', async () => {
    const { app, db } = await start('sqlite');
    await sql`drop table search_rebuilds`.execute(db);
    expect((await rejection(rebuilder(app).rebuild(PageIndex, run(5)))).message).toBe(
      'A rebuild keeps its lock and checkpoint in the table search_rebuilds, which the database does not have yet. Run pnpm marmeon publish @marmeon/search, then pnpm marmeon migrate.',
    );
  });
});

describe('Rebuilder and the job on Meilisearch: the edges of a running rebuild', () => {
  it('fails a batch whose rows change at each of its three writes, and keeps the checkpoint before it', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 2);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    const upsert = meili.driver.upsert;
    let writes = 0;
    meili.driver.upsert = async (index, documents) => {
      await upsert(index, documents);
      await sql`update pages set title = ${`Changed ${++writes}`} where id = 1`.execute(db);
    };
    const error = await rejection(rebuilder(app, { driver: meili.driver }).rebuild(PageIndex, run(500)));
    expect(error.message).toBe('The rows of a batch of "pages" changed each of the 3 times the rebuild wrote them; run marmeon search:rebuild pages again to resume.');
    expect(writes).toBe(3);
    expect((await rebuildRows(db))[0]).toMatchObject({ phase: 'copy', after: null, holder: null });
  });

  async function jobApp() {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 1);
    await sql`update pages set title = 'Changed' where id = 1`.execute(db);
    const meili = fakeMeilisearch();
    const c = app.container;
    const job = new SyncSearchDocuments(c.make(SearchIndexes), c.make(IndexReader), meili.driver, c.make(Clock), (index) => rebuildTarget(c.make(Connections), index));
    const runRow = (target: string | null) => sql`insert into search_rebuilds (index_name, run, phase, target, started_at) values ('pages', ${crypto.randomUUID()}, 'copy', ${target}, ${new Date().toISOString()})`.execute(db);
    return { db, meili, job, runRow };
  }

  it('writes to the index alone while the run has no target yet', async () => {
    const { meili, job, runRow } = await jobApp();
    meili.indexes.set('pages', new Map());
    await runRow(null);
    await job.handle({ index: 'pages', keys: [1] }, jobContext());
    expect(meili.driver.upserts.map((upsert) => upsert.index)).toEqual(['pages']);
  });

  it('skips a target that a swap or a discard removed meanwhile, and still writes the index', async () => {
    const { meili, job, runRow } = await jobApp();
    meili.indexes.set('pages', new Map());
    await runRow('pages__rebuild_0a1b2c3d');
    await job.handle({ index: 'pages', keys: [1] }, jobContext());
    expect(meili.titles('pages')).toEqual(['Changed']);
    expect(meili.indexes.has('pages__rebuild_0a1b2c3d')).toBe(false);
  });

  it('still writes the index when a driver of a provider throws for the target, then fails the attempt so it tries again', async () => {
    const { meili, job, runRow } = await jobApp();
    meili.indexes.set('pages', new Map([[documentId(1), { id: documentId(1), key: 1, s_title: 'Old live' }]]));
    await runRow('pages__rebuild_0a1b2c3d');
    const upsert = meili.driver.upsert;
    const gone = new Error('index pages__rebuild_0a1b2c3d does not exist');
    meili.driver.upsert = async (index, documents) => {
      if (index.name !== 'pages') throw gone;
      await upsert(index, documents);
    };
    expect(await rejection(job.handle({ index: 'pages', keys: [1] }, jobContext()))).toBe(gone);
    expect(meili.titles('pages')).toEqual(['Changed']);
  });

  it('still reads again and writes the newest state when the target write fails, before the attempt fails', async () => {
    const { db, meili, job, runRow } = await jobApp();
    meili.indexes.set('pages', new Map());
    await runRow('pages__rebuild_0a1b2c3d');
    const upsert = meili.driver.upsert;
    let live = 0;
    meili.driver.upsert = async (index, documents) => {
      if (index.name !== 'pages') throw new Error('target broken');
      await upsert(index, documents);
      // The row changes right after the job's first write to the index: only a read-again round brings the newer state.
      if (++live === 1) await sql`update pages set title = 'Newest' where id = 1`.execute(db);
    };
    expect((await rejection(job.handle({ index: 'pages', keys: [1] }, jobContext()))).message).toBe('target broken');
    expect(meili.titles('pages')).toEqual(['Newest']);
  });

  it('keeps a change live when the swap lands between its two writes', async () => {
    const { db, meili, job, runRow } = await jobApp();
    meili.indexes.set('pages', new Map([[documentId(1), { id: documentId(1), key: 1, s_title: 'Old live' }]]));
    meili.indexes.set('pages__rebuild_0a1b2c3d', new Map([[documentId(1), { id: documentId(1), key: 1, s_title: 'Old copy' }]]));
    await runRow('pages__rebuild_0a1b2c3d');
    const upsert = meili.driver.upsert;
    meili.driver.upsert = async (index, documents) => {
      await upsert(index, documents);
      if (meili.driver.upserts.length === 1) {
        // The rebuild swaps and deletes its target right after the job's first write.
        const live = meili.indexes.get('pages')!;
        meili.indexes.set('pages', meili.indexes.get('pages__rebuild_0a1b2c3d')!);
        meili.indexes.set('pages__rebuild_0a1b2c3d', live);
        meili.indexes.delete('pages__rebuild_0a1b2c3d');
        await sql`delete from search_rebuilds`.execute(db);
      }
    };
    await job.handle({ index: 'pages', keys: [1] }, jobContext());
    expect(meili.titles('pages')).toEqual(['Changed']);
  });
});

describe('Rebuilder: a run under another definition', () => {
  /** The same index with a second field: its fingerprint differs. */
  class WiderPageIndex extends SearchIndex<PageRow> {
    static readonly index = 'pages';
    static readonly key = 'id';
    static readonly fields = { title: 'highest', slug: 'low' } as const;
    static readonly filters = ['audience'] as const;

    source(db: Database) {
      return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').select(['id', 'slug', 'title', 'audience', 'published']);
    }

    toDocument(row: PageRow): SearchDocument<typeof WiderPageIndex> {
      return { fields: { title: row.title, slug: row.slug }, filters: { audience: row.audience } };
    }
  }

  function widened(app: Application, driver: SearchDriver): Rebuilder {
    const indexes = new SearchIndexes().add([WiderPageIndex], 'test');
    const c = app.container;
    return new Rebuilder({ indexes, reader: new IndexReader(indexes, c), driver: () => driver, connections: () => c.make(Connections), container: c, clock: c.make(Clock) });
  }

  it('starts over, and says why, when the fields changed since the unfinished run', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 4);
    const driver = counted(app.container.make(SearchDriver));
    const stop = new Error('stop');
    await rejection(rebuilder(app, { driver, hooks: { afterBatch: () => Promise.reject(stop) } }).rebuild(PageIndex, run(2)));
    const options = run(2);
    expect(await widened(app, driver).rebuild(WiderPageIndex, options)).toMatchObject({ status: 'done', indexed: 4 });
    expect(options.lines[0]).toMatch(/^pages: the index definition or the language map changed since the unfinished run started at .*; starting a new run\.$/);
    expect(driver.upserts.slice(1).map((upsert) => upsert.keys)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('fingerprints each weight by its tsvector letter, highest A to low D, in the order the class declares the fields', async () => {
    class LeveledPageIndex extends SearchIndex<PageRow> {
      static readonly index = 'pages';
      static readonly key = 'id';
      static readonly fields = { body: 'low', title: 'highest', summary: 'normal', slug: 'high' } as const;
      static readonly filters = ['audience'] as const;

      source(db: Database) {
        return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').select(['id', 'slug', 'title', 'audience', 'published']);
      }

      toDocument(row: PageRow): SearchDocument<typeof LeveledPageIndex> {
        return { fields: { title: row.title, slug: row.slug }, filters: { audience: row.audience } };
      }
    }
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 4);
    const indexes = new SearchIndexes().add([LeveledPageIndex], 'test');
    const c = app.container;
    const leveled = new Rebuilder({
      indexes,
      reader: new IndexReader(indexes, c),
      driver: () => c.make(SearchDriver),
      connections: () => c.make(Connections),
      container: c,
      clock: c.make(Clock),
      hooks: { afterBatch: () => Promise.reject(new Error('stop')) },
    });
    await rejection(leveled.rebuild(LeveledPageIndex, run(2)));
    const { rows } = await sql<{ fingerprint: string }>`select fingerprint from search_rebuilds`.execute(db);
    const languages = [...searchOptions(c).languages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const definition = ['pages', 'id', [['body', 'D'], ['title', 'A'], ['summary', 'C'], ['slug', 'B']], ['audience'], languages];
    expect(rows).toEqual([{ fingerprint: createHash('sha256').update(JSON.stringify(definition), 'utf8').digest('hex') }]);
  });

  it('resumes under the same definition', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 4);
    await rejection(rebuilder(app, { hooks: { afterBatch: () => Promise.reject(new Error('stop')) } }).rebuild(PageIndex, run(2)));
    const options = run(2);
    expect(await rebuilder(app).rebuild(PageIndex, options)).toMatchObject({ status: 'done', indexed: 2 });
    expect(options.lines[0]).toMatch(/^pages: resuming the unfinished run started at .*run it with --fresh\.$/);
  });

  it('discards the target of the unfinished run on Meilisearch when the definition changed', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 4);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    await rejection(rebuilder(app, { driver: meili.driver, hooks: { afterBatch: () => Promise.reject(new Error('stop')) } }).rebuild(PageIndex, run(2)));
    const [{ target: first }] = (await rebuildRows(db)) as unknown as [{ target: string }];
    expect(await widened(app, meili.driver).rebuild(WiderPageIndex, run(2))).toMatchObject({ status: 'done', indexed: 4 });
    expect(meili.state.requests).toContain(`DELETE /indexes/${first}`);
    expect([...meili.indexes.keys()]).toEqual(['pages']);
  });
});

describe('Rebuilder.flush(): the flush of search:flush', () => {
  it('deletes the target of an unfinished run on Meilisearch, so no resume swaps the flushed documents back', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 4);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map([[documentId(1), { id: documentId(1), key: 1, s_title: 'Live' }]]));
    await rejection(rebuilder(app, { driver: meili.driver, hooks: { afterBatch: () => Promise.reject(new Error('stop')) } }).rebuild(PageIndex, run(2)));
    const [{ target }] = (await rebuildRows(db)) as unknown as [{ target: string }];
    expect(await rebuilder(app, { driver: meili.driver }).flush(app.container.make(SearchIndexes).info(PageIndex))).toEqual({ status: 'done' });
    expect(meili.state.requests).toContain(`DELETE /indexes/${target}`);
    expect([...meili.indexes.keys()]).toEqual(['pages']);
    expect(meili.indexes.get('pages')!.size).toBe(0);
    expect(await rebuildRows(db)).toEqual([]);
  });

  it('empties that target with flush() when the driver cannot delete one', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 4);
    const meili = fakeMeilisearch();
    meili.indexes.set('pages', new Map());
    await rejection(rebuilder(app, { driver: meili.driver, hooks: { afterBatch: () => Promise.reject(new Error('stop')) } }).rebuild(PageIndex, run(2)));
    const [{ target }] = (await rebuildRows(db)) as unknown as [{ target: string }];
    const flushed: string[] = [];
    const real = meili.driver;
    const withoutDiscard: SearchDriver = {
      writes: 'queue',
      upsert: (index, documents) => real.upsert(index, documents),
      delete: (index, keys) => real.delete(index, keys),
      query: (request) => real.query(request),
      flush: async (index) => {
        flushed.push(index.name);
        await real.flush(index);
      },
    };
    await rebuilder(app, { driver: withoutDiscard }).flush(app.container.make(SearchIndexes).info(PageIndex));
    expect(flushed).toEqual([target, 'pages']);
    expect(meili.indexes.get(target)?.size).toBe(0);
  });

  it('holds the lock while it flushes: a rebuild that starts meanwhile does not get it', async () => {
    const { app, db } = await start('sqlite');
    await insertPages(db, 1, 2);
    const driver = app.container.make(SearchDriver);
    let during: Awaited<ReturnType<Rebuilder['rebuild']>> | undefined;
    const flush = driver.flush.bind(driver);
    driver.flush = async (index) => {
      during = await rebuilder(app).rebuild(PageIndex, run(5));
      await flush(index);
    };
    expect(await rebuilder(app).flush(app.container.make(SearchIndexes).info(PageIndex))).toEqual({ status: 'done' });
    expect(during).toMatchObject({ status: 'held' });
    expect(await rebuildRows(db)).toEqual([]);
  });
});
