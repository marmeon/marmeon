import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, defineModule, type Application } from '@marmeon/core';
import { DatabaseServiceProvider, type Connection, type Database } from '@marmeon/database';
import { Queue, QueueServiceProvider } from '@marmeon/queue';
import { QueueFake } from '@marmeon/queue/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SearchServiceProvider } from './provider.ts';
import { Search, type SyncPayload } from './search.ts';
import { SearchIndex, type SearchDocument } from './search-index.ts';
import { SyncSearchDocuments } from './sync-job.ts';
import { MemoryDriver } from './test-helpers/memory-driver.ts';

// The payload of the job `marmeon.search.sync` as the queue keeps it (the envelope around it is the queue's format): the index by
// name and the keys, never text.
const DIRECTORY = new URL('./__fixtures__/formats/search-sync/', import.meta.url);

const fixture = (name: string): SyncPayload => JSON.parse(readFileSync(new URL(name, DIRECTORY), 'utf8')) as SyncPayload;
const validate = (value: unknown) => SyncSearchDocuments.schema['~standard'].validate(value) as Promise<{ value?: SyncPayload; issues?: readonly { message: string; path?: readonly unknown[] }[] }>;

interface Row {
  key: number | string;
  title: string;
}

class PageIndex extends SearchIndex<Row> {
  static readonly index = 'pages';
  static readonly key = 'key';
  static readonly fields = { title: 'highest' } as const;

  source(db: Database) {
    return (db as unknown as Connection<{ pages: Row }>).selectFrom('pages').select(['key', 'title']);
  }

  toDocument(row: Row): SearchDocument<typeof PageIndex> {
    return { fields: { title: row.title } };
  }
}

class MemoryProvider {
  static searchDrivers = { memory: () => new MemoryDriver('queue') };
}

const running: Application[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.shutdown();
});

describe('the payload of marmeon.search.sync as the queue keeps it', () => {
  it('has a fixture of every version', () => {
    expect(readdirSync(DIRECTORY).sort()).toEqual(['v1.json']);
  });

  it('reads every fixture of the format, unchanged', async () => {
    for (const name of readdirSync(DIRECTORY)) {
      const result = await validate(fixture(name));
      expect(result.issues, name).toBeUndefined();
      expect(result.value, name).toEqual(fixture(name));
    }
  });

  it('is what search.index() writes today', async () => {
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
    await app.container.make(Search).index(PageIndex, [{ key: 1, title: 'One' }, { key: 'a-slug', title: 'Two' }]);
    expect(holder.queue!.dispatched(SyncSearchDocuments).map((job) => job.payload)).toEqual([fixture('v1.json')]);
  });

  it('refuses an empty list, more than 500 keys, a key that is no key, a malformed index name and a key it does not know', async () => {
    const refused = [
      { index: 'pages', keys: [] },
      { index: 'pages', keys: Array.from({ length: 501 }, (_, n) => n) },
      { index: 'pages', keys: [1.5] },
      { index: 'pages', keys: [''] },
      { index: 'pages', keys: ['x'.repeat(254)] },
      { index: 'pages', keys: ['a\u0000b'] },
      { index: 'Pages', keys: [1] },
      { ...fixture('v1.json'), title: 'text never travels' },
    ];
    for (const payload of refused) expect((await validate(payload)).issues?.length, JSON.stringify(payload).slice(0, 60)).toBeGreaterThan(0);
  });
});
