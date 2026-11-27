import { createApplication, defineModule, type Application } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql, type Connection, type Database } from '@marmeon/database';
import type { JobContext } from '@marmeon/queue';
import { Queue, QueueServiceProvider } from '@marmeon/queue';
import { QueueFake } from '@marmeon/queue/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SearchDriver } from './driver.ts';
import { SearchServiceProvider } from './provider.ts';
import { Search } from './search.ts';
import { SearchIndex, type SearchDocument } from './search-index.ts';
import { SyncSearchDocuments } from './sync-job.ts';
import { MemoryDriver } from './test-helpers/memory-driver.ts';

// The job reads its rows when it runs, so two jobs of one row that run in swapped order still end with the newest state.

interface PageRow {
  id: number;
  title: string;
}

class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'A' } as const;

  source(db: Database) {
    return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').select(['id', 'title']);
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    // A title "broken" gives a locale that is no language tag, which the check of the document refuses.
    return { locale: row.title === 'broken' ? 'no locale' : null, fields: { title: row.title } };
  }
}

class MemoryProvider {
  static searchDrivers = { memory: () => new MemoryDriver('queue') };
}

const running: Application[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.shutdown();
});

async function start() {
  const holder: { queue?: QueueFake } = {};
  const app = await createApplication(
    { root: import.meta.dirname, discover: false, providers: [DatabaseServiceProvider, QueueServiceProvider, SearchServiceProvider, MemoryProvider], modules: [defineModule({ name: 'pages', searchIndexes: [PageIndex] })] },
    {
      env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', SEARCH_DRIVER: 'memory', QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null' },
      override: (container) => {
        holder.queue = new QueueFake(container);
        container.instance(Queue, holder.queue);
      },
    },
  );
  running.push(app);
  const connections = app.container.make(Connections);
  await sql`create table pages (id integer primary key, title text not null)`.execute(connections.get());
  return { app, connections, queue: holder.queue!, search: app.container.make(Search), driver: app.container.make(SearchDriver) as MemoryDriver };
}

function context(): JobContext & { failed: unknown[] } {
  const failed: unknown[] = [];
  return {
    failed,
    id: 'job-1',
    name: SyncSearchDocuments.job,
    attempt: 1,
    tries: SyncSearchDocuments.tries,
    queue: 'default',
    connection: 'sync',
    signal: new AbortController().signal,
    discard: () => undefined,
    release: () => undefined,
    fail: (reason) => void failed.push(reason),
    once: async () => true,
  };
}

describe('the job marmeon.search.sync', () => {
  it('ends with the newest state when the jobs of an old and a new state run in swapped order', async () => {
    const { app, connections, queue, search, driver } = await start();
    await sql`insert into pages (id, title) values (1, 'Old title')`.execute(connections.get());
    await search.index(PageIndex, 1);
    await sql`update pages set title = 'New title' where id = 1`.execute(connections.get());
    await search.index(PageIndex, 1);
    const [older, newer] = queue.dispatched(SyncSearchDocuments).map((job) => job.payload as { index: string; keys: number[] });
    expect([older, newer]).toEqual([{ index: 'pages', keys: [1] }, { index: 'pages', keys: [1] }]);

    const job = app.container.make(SyncSearchDocuments);
    await job.handle(newer!, context());
    await job.handle(older!, context());
    expect((await driver.documents('pages')).map((document) => document.fields)).toEqual([{ title: 'New title' }]);
  });

  it('removes the document of a row that is gone by the time the job runs', async () => {
    const { app, connections, driver } = await start();
    await sql`insert into pages (id, title) values (1, 'Title')`.execute(connections.get());
    const job = app.container.make(SyncSearchDocuments);
    await job.handle({ index: 'pages', keys: [1] }, context());
    await sql`delete from pages where id = 1`.execute(connections.get());
    await job.handle({ index: 'pages', keys: [1] }, context());
    expect(driver.calls.map((call) => [call.method, call.keys])).toEqual([['upsert', [1]], ['delete', [1]]]);
    expect(await driver.documents('pages')).toEqual([]);
  });

  it('removes a row whose document breaks a check, writes the rest of the batch, and still fails the attempt', async () => {
    const { app, connections, driver } = await start();
    await sql`insert into pages (id, title) values (1, 'One'), (2, 'Two')`.execute(connections.get());
    const job = app.container.make(SyncSearchDocuments);
    await job.handle({ index: 'pages', keys: [1, 2] }, context());
    // Row 1 now gives a document the check refuses, and row 2 a new title.
    await sql`update pages set title = 'broken' where id = 1`.execute(connections.get());
    await sql`update pages set title = 'Two again' where id = 2`.execute(connections.get());
    await expect(job.handle({ index: 'pages', keys: [1, 2] }, context())).rejects.toThrow(
      /^1 of the keys of "pages" failed a check, and the index holds no document for them \(keys 1\): PageIndex\.toDocument\(\) for the key 1: locale is "no locale"/,
    );
    expect((await driver.documents('pages')).map((document) => [document.key, document.fields])).toEqual([[2, { title: 'Two again' }]]);
  });

  it('takes the matched row out too when a key has the other type of its column, and fails the attempt', async () => {
    const { app, connections, driver } = await start();
    await sql`insert into pages (id, title) values (1, 'Title')`.execute(connections.get());
    const job = app.container.make(SyncSearchDocuments);
    await job.handle({ index: 'pages', keys: [1] }, context());
    await expect(job.handle({ index: 'pages', keys: ['1'] }, context())).rejects.toThrow(/^1 of the keys of "pages" failed a check/);
    expect(await driver.documents('pages')).toEqual([]);
  });

  it('fails for good, with the name, when no index has that name any more', async () => {
    const { app, driver } = await start();
    const run = context();
    await app.container.make(SyncSearchDocuments).handle({ index: 'gone', keys: [1] }, run);
    expect(run.failed).toEqual(['No search index is named "gone" any more (it was renamed or removed), so the documents of this job were not synced.']);
    expect(driver.calls).toEqual([]);
  });

  it('rethrows an error of the driver, so the queue counts the attempt as failed and tries again', async () => {
    const { app, connections, driver } = await start();
    await sql`insert into pages (id, title) values (1, 'Title')`.execute(connections.get());
    driver.upsert = async () => {
      throw new Error('the search service is down');
    };
    await expect(app.container.make(SyncSearchDocuments).handle({ index: 'pages', keys: [1] }, context())).rejects.toThrow('the search service is down');
    expect(SyncSearchDocuments.tries).toBeGreaterThan(1);
  });
});
