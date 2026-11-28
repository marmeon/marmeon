import { createApplication, defineModule, type Application, type ServiceProviderClass } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql, type Connection, type Database } from '@marmeon/database';
import { Queue, QueueServiceProvider } from '@marmeon/queue';
import { QueueFake } from '@marmeon/queue/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchDriver, type SearchDriverFactory } from './driver.ts';
import { SearchSetupError } from './errors.ts';
import { SearchServiceProvider } from './provider.ts';
import type { IndexInfo } from './registry.ts';
import { canonicalLocale, IndexReader, MAX_DOCUMENT_LENGTH, Search, storedDocument } from './search.ts';
import { SearchIndex, type SearchDocument, type SearchIndexClass } from './search-index.ts';
import { SyncSearchDocuments } from './sync-job.ts';
import { MemoryDriver } from './test-helpers/memory-driver.ts';
import { MAX_MARK_RUN } from './terms.ts';

// Search against a driver of each write mode: what a rollback leaves, what reaches the driver, and every refusal of the input.

interface PageRow {
  id: number;
  title: string;
  body: string | null;
  audience: string;
  tenant: number | null;
  locale: string | null;
  published: number;
}

interface PostRow {
  slug: string;
  title: string;
  audience: string;
}

type Tables = { pages: PageRow; posts: PostRow; notes: PostRow };

/** How often `source()` was called — Search reads every row through it. */
const reads = { pages: 0 };

/** The methods of the page indexes; each subclass declares its own statics. */
abstract class PageRows extends SearchIndex<PageRow> {
  static readonly index: string = 'page-rows';
  static readonly key = 'id';
  static readonly fields = { title: 'highest', body: 'normal' } as const;
  static readonly filters = ['audience', 'tenant'] as const;

  source(db: Database) {
    reads.pages++;
    return (db as unknown as Connection<Tables>).selectFrom('pages').select(['id', 'title', 'body', 'audience', 'tenant', 'locale', 'published']);
  }

  override includes(row: PageRow): boolean {
    return row.published === 1;
  }

  toDocument(row: PageRow): SearchDocument<typeof PageRows> {
    return { locale: row.locale, fields: { title: row.title, body: row.body }, filters: { audience: row.audience, ...(row.tenant === null ? {} : { tenant: row.tenant }) } };
  }
}

class PageIndex extends PageRows {
  static override readonly index = 'pages';
}

class PostIndex extends SearchIndex<PostRow> {
  static readonly index = 'posts';
  static readonly key = 'slug';
  static readonly fields = { title: 'highest' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return (db as unknown as Connection<Tables>).selectFrom('posts').select(['slug', 'title', 'audience']);
  }

  toDocument(row: PostRow): SearchDocument<typeof PostIndex> {
    return { fields: { title: row.title }, filters: { audience: row.audience } };
  }
}

/** Rows of a table whose key column compares without case (`collate nocase`). */
class NoteIndex extends SearchIndex<PostRow> {
  static readonly index = 'notes';
  static readonly key = 'slug';
  static readonly fields = { title: 'highest' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return (db as unknown as Connection<Tables>).selectFrom('notes').select(['slug', 'title', 'audience']);
  }

  toDocument(row: PostRow): SearchDocument<typeof NoteIndex> {
    return { fields: { title: row.title }, filters: { audience: row.audience } };
  }
}

/** An index whose document `toDocument` is replaced per test. */
const shape: { document: (row: PageRow) => unknown } = { document: () => ({ fields: {} }) };

class ShapedIndex extends SearchIndex<PageRow> {
  static readonly index = 'shaped';
  static readonly key = 'id';
  static readonly fields = { title: 'highest', summary: 'high', body: 'low' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return (db as unknown as Connection<Tables>).selectFrom('pages').select(['id', 'title', 'body', 'audience', 'tenant', 'locale', 'published']);
  }

  toDocument(row: PageRow): SearchDocument<typeof ShapedIndex> {
    return shape.document(row) as SearchDocument<typeof ShapedIndex>;
  }
}

/** Not registered anywhere. */
class StrayIndex extends PageRows {
  static override readonly index = 'stray';
}

class Rollback extends Error {}

const plugin = (factory: SearchDriverFactory): ServiceProviderClass => class MemoryProvider {
  static searchDrivers = { memory: factory };
};

interface Started {
  readonly app: Application;
  readonly driver: MemoryDriver;
  readonly search: Search;
  readonly connections: Connections;
  readonly queue: QueueFake | undefined;
}

const running: Application[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.shutdown();
});

async function start(writes: SearchDriver['writes']): Promise<Started> {
  const holder: { driver?: MemoryDriver; queue?: QueueFake } = {};
  const queued = writes === 'queue';
  const app = await createApplication(
    {
      root: import.meta.dirname,
      discover: false,
      providers: [
        DatabaseServiceProvider,
        ...(queued ? [QueueServiceProvider] : []),
        SearchServiceProvider,
        plugin(({ container }) => (holder.driver = new MemoryDriver(writes, writes === 'transaction' ? () => container.make(Connections) : undefined))),
      ],
      modules: [defineModule({ name: 'pages', searchIndexes: [PageIndex, PostIndex, ShapedIndex, NoteIndex] })],
    },
    {
      env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', SEARCH_DRIVER: 'memory', QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null' },
      ...(queued
        ? {
            override: (container) => {
              holder.queue = new QueueFake(container);
              container.instance(Queue, holder.queue);
            },
          }
        : {}),
    },
  );
  running.push(app);
  const connections = app.container.make(Connections);
  const db = connections.get();
  await sql`create table pages (id integer primary key, title text not null, body text, audience text not null, tenant integer, locale text, published integer not null)`.execute(db);
  await sql`create table posts (slug text primary key, title text not null, audience text not null)`.execute(db);
  await sql`create table notes (slug text collate nocase primary key, title text not null, audience text not null)`.execute(db);
  if (writes === 'transaction') await MemoryDriver.createTable(connections);
  return { app, driver: holder.driver!, search: app.container.make(Search), connections, queue: holder.queue };
}

async function insertPage(connections: Connections, row: Partial<PageRow> & { id: number }): Promise<void> {
  const page: PageRow = { title: `Page ${row.id}`, body: 'about whales', audience: 'public', tenant: null, locale: null, published: 1, ...row };
  await sql`insert into pages (id, title, body, audience, tenant, locale, published) values (${page.id}, ${page.title}, ${page.body}, ${page.audience}, ${page.tenant}, ${page.locale}, ${page.published})`.execute(connections.get());
}

async function updateTitle(connections: Connections, id: number, title: string): Promise<void> {
  await sql`update pages set title = ${title} where id = ${id}`.execute(connections.get());
}

const keys = async (driver: MemoryDriver, index = 'pages') => (await driver.documents(index)).map((document) => document.key);

describe('Search on a driver that writes in the transaction', () => {
  it('keeps the document when the caller commits, and none when it rolls back', async () => {
    const { search, driver, connections } = await start('transaction');
    await insertPage(connections, { id: 1 });
    await insertPage(connections, { id: 2 });
    await connections.transaction(() => search.index(PageIndex, 1));
    await expect(connections.transaction(async () => {
      await search.index(PageIndex, 2);
      expect(await keys(driver)).toEqual([1, 2]);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    expect(await keys(driver)).toEqual([1]);
  });

  it('writes in a transaction of its own outside one, which a failing batch rolls back whole', async () => {
    const { search, driver, connections } = await start('transaction');
    await insertPage(connections, { id: 1 });
    await search.index(PageIndex, [1]);
    expect(driver.calls.map((call) => [call.method, call.inTransaction])).toEqual([['upsert', true]]);
    await search.remove(PageIndex, 1);
    expect(driver.calls.at(-1)).toMatchObject({ method: 'delete', inTransaction: true });
    expect(await keys(driver)).toEqual([]);
    // The first document of the batch is written, then the driver fails: the batch's own transaction takes the write back.
    await insertPage(connections, { id: 2 });
    await insertPage(connections, { id: 3 });
    const upsert = driver.upsert.bind(driver);
    driver.upsert = async (index, documents) => {
      await upsert(index, documents.slice(0, 1));
      throw new Error('the second document failed');
    };
    await expect(search.index(PageIndex, [2, 3])).rejects.toThrow('the second document failed');
    expect(await keys(driver)).toEqual([]);
  });

  it('takes a document out with remove() in the transaction, and back with a rollback', async () => {
    const { search, driver, connections } = await start('transaction');
    await insertPage(connections, { id: 1 });
    await search.index(PageIndex, 1);
    await expect(connections.transaction(async () => {
      await search.remove(PageIndex, [1]);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    expect(await keys(driver)).toEqual([1]);
  });
});

describe('Search reads every row through source()', () => {
  it('indexes the row as source() reads it, not as the caller passed it', async () => {
    const { search, driver, connections } = await start('after-commit');
    await insertPage(connections, { id: 1, title: 'Stored title' });
    const before = reads.pages;
    await search.index(PageIndex, { id: 1, title: 'Passed title', body: null, audience: 'secret', tenant: null, locale: null, published: 1 });
    // Read at the call, and once more after the write after the commit, to see whether the row changed meanwhile.
    expect(reads.pages).toBe(before + 2);
    expect(await driver.documents('pages')).toEqual([{ key: 1, locale: null, fields: { title: 'Stored title', body: 'about whales' }, filters: { audience: 'public' } }]);
  });

  it('removes a row includes() refuses, a row whose includes() returns no true, and a row that is gone', async () => {
    const { search, driver, connections } = await start('after-commit');
    await insertPage(connections, { id: 1 });
    await insertPage(connections, { id: 2 });
    await search.index(PageIndex, [1, 2, 3]);
    expect(await keys(driver)).toEqual([1, 2]);
    expect(driver.calls.map((call) => [call.method, call.keys])).toEqual([['delete', [3]], ['upsert', [1, 2]]]);

    await sql`update pages set published = 0 where id = 1`.execute(connections.get());
    await search.index(PageIndex, 1);
    expect(await keys(driver)).toEqual([2]);
  });

  it('keeps a row only when includes() returns exactly true, read from the instance the container built', async () => {
    class LooseIndex extends PageRows {
      static override readonly index = 'loose';
      override includes(): boolean {
        return 1 as unknown as boolean;
      }
    }
    const { app } = await startWith(LooseIndex);
    const connections = app.container.make(Connections);
    await insertPage(connections, { id: 1 });
    await app.container.make(Search).index(LooseIndex, 1);
    expect(holderDriver(app).calls.map((call) => call.method)).toEqual(['delete']);
  });

  it('refuses an includes that the built instance holds as a value, not a method', async () => {
    class ValueIndex extends PageRows {
      static override readonly index = 'valued';
      constructor() {
        super();
        Object.defineProperty(this, 'includes', { value: true });
      }
    }
    const { app } = await startWith(ValueIndex);
    await insertPage(app.container.make(Connections), { id: 1 });
    const error = await app.container.make(Search).index(ValueIndex, 1).then(() => undefined, (caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error?.message).toBe('[marmeon:Q9] ValueIndex has an includes that is no method on the instance the container built: define includes(row) as a method, or leave it out.');
  });

  it('treats 42 and "42" as two keys', async () => {
    const { search, driver } = await start('after-commit');
    await search.remove(PostIndex, ['42']);
    await search.remove(PageIndex, [42, 42]);
    expect(driver.calls.map((call) => call.keys)).toEqual([['42'], [42]]);
    await search.index(PostIndex, ['42', '42']);
    expect(driver.calls.at(-1)?.keys).toEqual(['42']);
    await search.remove(PageIndex, [42, '42'] as never);
    expect(driver.calls.at(-1)?.keys).toEqual([42, '42']);
  });

  it('refuses a key whose type differs from the column, which the database would match all the same', async () => {
    const { search, driver, connections } = await start('after-commit');
    await insertPage(connections, { id: 42 });
    await search.index(PageIndex, 42);
    const refusal = new TypeError(
      'PageIndex.source() returned the row with the key 42 for none of the keys asked for: the database matched a key of another type or spelling. Pass keys exactly as the column "id" holds them.',
    );
    await expect(search.index(PageIndex, '42' as never)).rejects.toThrow(refusal);
    // SQLite reads "042" as the integer 42 too.
    await expect(search.index(PageIndex, '042' as never)).rejects.toThrow(refusal);
    expect(driver.calls.map((call) => call.keys)).toEqual([[42]]);
  });

  it('refuses a key in another case that a case-insensitive key column matches, and the job removes that row\'s document', async () => {
    const { app, search, driver, connections } = await start('after-commit');
    await sql`insert into notes (slug, title, audience) values ('about', 'About us', 'public')`.execute(connections.get());
    await search.index(NoteIndex, 'about');
    expect(await keys(driver, 'notes')).toEqual(['about']);
    await expect(search.index(NoteIndex, 'About')).rejects.toThrow(
      new TypeError('NoteIndex.source() returned the row with the key "about" for none of the keys asked for: the database matched a key of another type or spelling. Pass keys exactly as the column "slug" holds them.'),
    );
    // Tolerant, as the job reads: the row the database matched loses its document, and the key is reported.
    const found = await app.container.make(IndexReader).read(NoteIndex, ['About'], { tolerant: true });
    expect(found.documents).toEqual([]);
    expect(found.removed.sort()).toEqual(['About', 'about']);
    expect(found.failed.map((entry) => entry.key)).toEqual(['about']);
    // remove() deletes the keys it is given: "About" is not the key of the document "about".
    await search.remove(NoteIndex, 'About');
    expect(await keys(driver, 'notes')).toEqual(['about']);
  });

  it('reads in batches of 500 keys', async () => {
    const { search, driver } = await start('after-commit');
    await search.index(PageIndex, Array.from({ length: 1001 }, (_, n) => n + 1));
    expect(driver.calls.map((call) => call.keys.length)).toEqual([500, 500, 1]);
  });
});

/** An app on an after-commit driver with one more index. */
async function startWith(Index: SearchIndexClass): Promise<{ app: Application }> {
  const app = await createApplication(
    {
      root: import.meta.dirname,
      discover: false,
      providers: [DatabaseServiceProvider, SearchServiceProvider, plugin(() => new MemoryDriver('after-commit'))],
      modules: [defineModule({ name: 'pages', searchIndexes: [Index] })],
    },
    { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', SEARCH_DRIVER: 'memory' } },
  );
  running.push(app);
  await sql`create table pages (id integer primary key, title text not null, body text, audience text not null, tenant integer, locale text, published integer not null)`.execute(app.container.make(Connections).get());
  return { app };
}

const holderDriver = (app: Application): MemoryDriver => app.container.make(SearchDriver) as MemoryDriver;

describe('Search on a driver that writes through the queue', () => {
  it('queues one job of keys per call inside a transaction, after the commit, and none after a rollback', async () => {
    const { search, driver, connections, queue } = await start('queue');
    await insertPage(connections, { id: 1 });
    await insertPage(connections, { id: 2 });
    await connections.transaction(async () => {
      await search.index(PageIndex, [1, 2, 1]);
      expect(queue!.dispatched(SyncSearchDocuments)).toEqual([]);
    });
    await expect(connections.transaction(async () => {
      await search.index(PageIndex, 2);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    expect(queue!.dispatched(SyncSearchDocuments).map((job) => job.payload)).toEqual([{ index: 'pages', keys: [1, 2] }]);
    // Nothing reached the driver at the call: the job does the work.
    expect(driver.calls).toEqual([]);
    await queue!.work();
    expect(await keys(driver)).toEqual([1, 2]);
  });

  it('queues rows as their keys, never their text, and 500 keys at most per job', async () => {
    const { search, queue } = await start('queue');
    await search.index(PostIndex, [{ slug: 'a', title: 'Secret plans', audience: 'staff' }]);
    await search.remove(PostIndex, Array.from({ length: 501 }, (_, n) => `post-${n}`));
    const payloads = queue!.dispatched(SyncSearchDocuments).map((job) => job.payload as { index: string; keys: unknown[] });
    expect(payloads[0]).toEqual({ index: 'posts', keys: ['a'] });
    expect(JSON.stringify(payloads)).not.toContain('Secret');
    expect(payloads.slice(1).map((payload) => payload.keys.length)).toEqual([500, 1]);
  });
});

describe('Search on a driver that writes after the commit', () => {
  it('writes nothing after a rollback, and the documents of the call after a commit', async () => {
    const { search, driver, connections } = await start('after-commit');
    await insertPage(connections, { id: 1, title: 'First' });
    await expect(connections.transaction(async () => {
      await search.index(PageIndex, 1);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    expect(driver.calls).toEqual([]);

    await connections.transaction(async () => {
      await search.index(PageIndex, 1);
      await updateTitle(connections, 1, 'Later');
      expect(driver.calls).toEqual([]);
    });
    // The document read at the call is written after the commit; the read after it finds the change, so it is written again.
    expect(driver.calls).toMatchObject([
      { method: 'upsert', inTransaction: false },
      { method: 'upsert', inTransaction: false },
    ]);
    expect((await driver.documents('pages'))[0]?.fields).toEqual({ title: 'Later', body: 'about whales' });
  });

  it('ends with the newest state when an older write lands after a newer one', async () => {
    const { search, driver, connections } = await start('after-commit');
    await insertPage(connections, { id: 1, audience: 'public' });
    // The first write waits until the test lets it go; every later one runs at once.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let waiting!: () => void;
    const reached = new Promise<void>((resolve) => (waiting = resolve));
    const upsert = driver.upsert.bind(driver);
    let first = true;
    driver.upsert = async (index, documents) => {
      if (first) {
        first = false;
        waiting();
        await held;
      }
      await upsert(index, documents);
    };
    const older = connections.transaction(() => search.index(PageIndex, 1));
    await reached;
    await sql`update pages set audience = 'members' where id = 1`.execute(connections.get());
    await connections.transaction(() => search.index(PageIndex, 1));
    expect((await driver.documents('pages'))[0]?.filters).toEqual({ audience: 'members' });
    release();
    await older;
    expect((await driver.documents('pages'))[0]?.filters).toEqual({ audience: 'members' });
    expect(driver.calls.filter((call) => call.method === 'upsert')).toHaveLength(3);
  });

  it('fails the call when the rows change at each of three writes after the commit', async () => {
    const { search, driver, connections } = await start('after-commit');
    await insertPage(connections, { id: 1 });
    const upsert = driver.upsert.bind(driver);
    let count = 0;
    driver.upsert = async (index, documents) => {
      await upsert(index, documents);
      count++;
      await updateTitle(connections, 1, `Title ${count}`);
    };
    await expect(connections.transaction(() => search.index(PageIndex, 1))).rejects.toThrow('The rows of "pages" changed each of the 3 times search.index() wrote them after the commit; call it again.');
    expect(count).toBe(3);
  });

  it('removes after the commit only', async () => {
    const { search, driver, connections } = await start('after-commit');
    await insertPage(connections, { id: 1 });
    await search.index(PageIndex, 1);
    await expect(connections.transaction(async () => {
      await search.remove(PageIndex, 1);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    expect(await keys(driver)).toEqual([1]);
    await connections.transaction(() => search.remove(PageIndex, 1));
    expect(await keys(driver)).toEqual([]);
  });
});

describe('Search refuses input it cannot index', () => {
  it('refuses rows and keys in one list, a value that is neither, and keys that are no keys', async () => {
    const { search } = await start('after-commit');
    const row = { id: 1, title: 't', body: null, audience: 'public', tenant: null, locale: null, published: 1 };
    await expect(search.index(PageIndex, [row, 2] as never)).rejects.toThrow(new TypeError('search.index(PageIndex, …) got rows and keys in one list; give only rows or only keys.'));
    await expect(search.index(PageIndex, [true] as never)).rejects.toThrow(new TypeError('search.index(PageIndex, …) got true at position 0, but it takes rows or keys.'));
    await expect(search.remove(PageIndex, [row] as never)).rejects.toThrow(new TypeError('search.remove(PageIndex, …) got an object at position 0, but it takes keys.'));
    await expect(search.index(PageIndex, 1.5)).rejects.toThrow(new TypeError('The key at position 0 is 1.5, but a search key is a string of 1 to 253 characters (well-formed, without NUL) or a safe integer.'));
    await expect(search.index(PostIndex, '')).rejects.toThrow(TypeError);
    await expect(search.index(PostIndex, 'x'.repeat(254))).rejects.toThrow(TypeError);
    // A driver must be able to store a key: Postgres keeps no NUL, and a lone surrogate is no text.
    await expect(search.index(PostIndex, 'a\u0000b')).rejects.toThrow(TypeError);
    await expect(search.index(PostIndex, 'a\ud800')).rejects.toThrow(TypeError);
    await expect(search.index(PageIndex, [{ ...row, id: null }] as never)).rejects.toThrow(new TypeError('The column "id" of the row at position 0 is null, but a search key is a string of 1 to 253 characters (well-formed, without NUL) or a safe integer.'));
  });

  it('refuses an index that is not registered', async () => {
    const { search } = await start('after-commit');
    await expect(search.index(StrayIndex, 1)).rejects.toThrow(new TypeError('StrayIndex is not a registered search index. List it in a module\'s searchIndexes or a provider\'s static searchIndexes.'));
    await expect(search.query({ in: StrayIndex, term: 'a' })).rejects.toThrow(TypeError);
  });

  it('refuses a document with a field, a filter or a property its class does not declare, and values of the wrong kind', async () => {
    const { search, connections } = await start('after-commit');
    await insertPage(connections, { id: 1 });
    const cases: [unknown, string][] = [
      [{ fields: { title: 't', author: 'a' } }, 'ShapedIndex.toDocument() for the key 1 returned the field "author", which ShapedIndex does not declare in static fields.'],
      [{ fields: {}, filters: { tenant: 1 } }, 'ShapedIndex.toDocument() for the key 1 returned the filter "tenant", which ShapedIndex does not declare in static filters.'],
      [{ fields: {}, filter: {} }, 'ShapedIndex.toDocument() for the key 1 returned the property "filter"; a document has only locale, fields and filters.'],
      [{ fields: { title: 42 } }, 'ShapedIndex.toDocument() for the key 1 returned 42 for the field "title", but a field holds a string or null.'],
      [{ fields: {}, filters: { audience: null } }, 'ShapedIndex.toDocument() for the key 1: the filter "audience" is null, but a filter value is a string of at most 255 characters (well-formed, without NUL), a finite number or a boolean.'],
      [{ fields: {}, filters: { audience: Number.NaN } }, 'ShapedIndex.toDocument() for the key 1: the filter "audience" is NaN, but a filter value is a string of at most 255 characters (well-formed, without NUL), a finite number or a boolean.'],
      [{ fields: {}, filters: { audience: 'x'.repeat(256) } }, `ShapedIndex.toDocument() for the key 1: the filter "audience" is ${JSON.stringify('x'.repeat(80))}…, but a filter value is a string of at most 255 characters (well-formed, without NUL), a finite number or a boolean.`],
      [{ fields: {}, filters: { audience: 'a\u0000b' } }, 'ShapedIndex.toDocument() for the key 1: the filter "audience" is "a\\u0000b", but a filter value is a string of at most 255 characters (well-formed, without NUL), a finite number or a boolean.'],
      [{ fields: {}, locale: 'english' }, 'ShapedIndex.toDocument() for the key 1: locale is "english", but a locale is a language tag such as "en" or "pt-BR", at most 35 characters in its canonical form.'],
      [{ fields: {}, locale: 'de-DE-u-ca-gregory-co-phonebk-hc-h23-nu-latn' }, 'ShapedIndex.toDocument() for the key 1: locale is "de-DE-u-ca-gregory-co-phonebk-hc-h23-nu-latn", but a locale is a language tag such as "en" or "pt-BR", at most 35 characters in its canonical form.'],
      [undefined, 'ShapedIndex.toDocument() for the key 1 returned undefined, but a document is an object with fields.'],
    ];
    for (const [document, message] of cases) {
      shape.document = () => document;
      await expect(search.index(ShapedIndex, 1), message).rejects.toThrow(new TypeError(message));
    }
  });

  it('stores the locale in its canonical form, the texts cleaned, and cuts 200 000 characters in the order of the weights', async () => {
    const { search, driver, connections } = await start('after-commit');
    await insertPage(connections, { id: 1 });
    await insertPage(connections, { id: 2 });
    const marks = `a\u0000b${String.fromCharCode(0xe000)}c${String.fromCharCode(0xe001)}`;
    shape.document = (row) =>
      row.id === 1
        ? { locale: 'pt-br', fields: { title: marks, summary: null }, filters: { audience: true } }
        : { locale: 'PT-BR', fields: { body: 'd'.repeat(10), summary: 's'.repeat(MAX_DOCUMENT_LENGTH - 5), title: 't'.repeat(10) } };
    await search.index(ShapedIndex, [1, 2]);
    const [first, second] = await driver.documents('shaped');
    expect(first).toEqual({ key: 1, locale: 'pt-BR', fields: { title: 'abc' }, filters: { audience: true } });
    // highest before high before low: the title stays whole, the summary takes the rest but 10, and the body is cut to nothing.
    expect(second?.locale).toBe('pt-BR');
    expect(second?.fields).toEqual({ title: 't'.repeat(10), summary: 's'.repeat(MAX_DOCUMENT_LENGTH - 10) });
  });
});

describe('storedDocument(): the text in NFKC', () => {
  const info: IndexInfo = { name: 'shaped', key: 'id', fields: [{ name: 'title', weight: 'highest' }], filters: [] };
  const stored = (title: string) => storedDocument(info, 'ShapedIndex', 1, { fields: { title } }).fields['title'] ?? '';
  const codePoints = (text: string) => [...text].length;

  it('stores fullwidth letters and ligatures in their plain form', () => {
    expect(stored('Ｗｉｋｉ o\ufb03ce')).toBe('Wiki office');
  });

  it('measures the 200 000 characters after NFKC, where a ligature grows and a decomposed letter shrinks', () => {
    // U+FB03 grows to three characters; U+1F82 decomposed is four characters that compose into one.
    expect(stored('\ufb03'.repeat(MAX_DOCUMENT_LENGTH))).toBe('ffi'.repeat(MAX_DOCUMENT_LENGTH / 3 + 1).slice(0, MAX_DOCUMENT_LENGTH));
    const composed = stored('\u03b1\u0313\u0300\u0345'.repeat(MAX_DOCUMENT_LENGTH + 10));
    expect(codePoints(composed)).toBe(MAX_DOCUMENT_LENGTH);
    expect(composed).toBe('\u1f82'.repeat(MAX_DOCUMENT_LENGTH));
  });

  /** The texts `normalize()` was called on while `run` ran, and what each call returned. */
  function normalizing(run: () => void): { readonly inputs: string[]; readonly outputs: string[] } {
    const spy = vi.spyOn(String.prototype, 'normalize');
    try {
      run();
      return { inputs: spy.mock.contexts.map((context) => String(context)), outputs: spy.mock.results.map((result) => String(result.value)) };
    } finally {
      spy.mockRestore();
    }
  }
  const normalized = (run: () => void) => normalizing(run).inputs;
  /** One step of the prefix that normalizes: the budget and what the unsettled end of a cut prefix can grow to. */
  const step = MAX_DOCUMENT_LENGTH + 18 * 2 * (MAX_MARK_RUN + 1);

  it('normalizes no more of a huge field than four times what the budget and the unsettled end need', () => {
    const receivers = normalized(() => stored('x'.repeat(5_000_000)));
    expect(receivers.length).toBeGreaterThan(0);
    for (const receiver of receivers) expect(codePoints(receiver)).toBeLessThanOrEqual(4 * step);
  });

  it('reads no further into a field that grows under NFKC than the budget needs', () => {
    // U+FDFA grows to 18 characters: the first prefix already fills the budget, and nothing longer is normalized.
    const receivers = normalized(() => expect(codePoints(stored('\ufdfa'.repeat(4 * MAX_DOCUMENT_LENGTH)))).toBe(MAX_DOCUMENT_LENGTH));
    expect(receivers.map(codePoints)).toEqual([step]);
  });

  it('normalizes plain text of a huge field once', () => {
    expect(normalized(() => stored('x'.repeat(5_000_000))).map(codePoints)).toEqual([step]);
  });

  it('keeps every result below 19 steps when a field shrinks under NFKC first and grows after', () => {
    // Decomposed U+1F82 shrinks four to one and fills exactly the first step, U+FDFA grows one to 18 in the next: a pass that read
    // more than one step of new text would pass 19 steps.
    const { outputs } = normalizing(() => stored('\u03b1\u0313\u0300\u0345'.repeat(50_279) + '\ufdfa'.repeat(402_232)));
    expect(outputs.length).toBeGreaterThan(1);
    for (const output of outputs) expect(codePoints(output)).toBeLessThan(19 * step);
  });

  it.each([
    ['combining marks', 'a' + '\u0301'.repeat(100_000) + '\u0316'.repeat(100_000), 'a' + '\u0301'.repeat(30)],
    ['halfwidth sound marks', 'a' + '\uff9e\u0301'.repeat(100_000), 'a' + '\uff9e\u0301'.repeat(15)],
  ])('keeps the first 30 of a run of %s, so no normalization sorts a longer run', (_, text, kept) => {
    const run = /[\p{M}\uff9e\uff9f]{31}/u;
    const receivers = normalized(() => expect(stored(text)).toBe(kept.normalize('NFKC')));
    expect(receivers.length).toBeGreaterThan(0);
    for (const receiver of receivers) expect(run.test(receiver)).toBe(false);
  });

  it('keeps the text after a long run of characters that cleaning removes', () => {
    expect(stored('\u0000'.repeat(4 * MAX_DOCUMENT_LENGTH + 5) + 'abc')).toBe('abc');
  });
});

describe('Search.query()', () => {
  async function indexed() {
    const started = await start('after-commit');
    const { search, connections } = started;
    await insertPage(connections, { id: 1, title: 'Whales of the north', audience: 'public', tenant: 1, locale: 'pt-BR' });
    await insertPage(connections, { id: 2, title: 'Whales of the south', audience: 'staff', tenant: 2 });
    await insertPage(connections, { id: 3, title: 'Whales of the east', audience: 'staff', tenant: 3, locale: 'de' });
    await sql`insert into posts (slug, title, audience) values ('a', 'Whales in posts', 'public')`.execute(connections.get());
    await search.index(PageIndex, [1, 2, 3]);
    await search.index(PostIndex, 'a');
    return started;
  }

  it('returns a page of hits across indexes, with the meta of paginate', async () => {
    const { search } = await indexed();
    const result = await search.query({ in: [PageIndex, PostIndex], term: 'whales', perPage: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.map((hit) => [hit.index, hit.key])).toEqual([['pages', 1], ['pages', 2], ['pages', 3]]);
    expect(result.value.meta).toEqual({ page: 1, perPage: 3, total: 4, lastPage: 2, from: 1, to: 3 });
    const second = await search.query({ in: [PageIndex, PostIndex], term: 'whales', perPage: 3, page: 2 });
    expect(second.ok && second.value.data.map((hit) => [hit.index, hit.key])).toEqual([['posts', 'a']]);
    expect(second.ok && second.value.meta).toEqual({ page: 2, perPage: 3, total: 4, lastPage: 2, from: 4, to: 4 });
  });

  it('narrows by the filters, a list being any of its values, and passes the canonical locale on', async () => {
    const { search } = await indexed();
    const staff = await search.query({ in: PageIndex, term: 'whales', filters: { audience: 'staff' } });
    expect(staff.ok && staff.value.data.map((hit) => hit.key)).toEqual([2, 3]);
    const either = await search.query({ in: PageIndex, term: 'whales', filters: { tenant: [1, 2] } });
    expect(either.ok && either.value.data.map((hit) => hit.key)).toEqual([1, 2]);
    const one = await search.query({ in: PageIndex, term: 'whales', filters: { tenant: [1] } });
    expect(one.ok && one.value.data.map((hit) => hit.key)).toEqual([1]);
    const none = await search.query({ in: PageIndex, term: 'whales', filters: { tenant: [4] } });
    expect(none.ok && none.value.data).toEqual([]);
    // pt-br and pt-BR are one locale: its page and the page without a locale, never the page in de.
    const lower = await search.query({ in: PageIndex, term: 'whales', locale: 'pt-br' });
    const upper = await search.query({ in: PageIndex, term: 'whales', locale: 'pt-BR' });
    expect(lower).toEqual(upper);
    expect(lower.ok && lower.value.data.map((hit) => hit.key)).toEqual([1, 2]);
    const german = await search.query({ in: PageIndex, term: 'whales', locale: 'de' });
    expect(german.ok && german.value.data.map((hit) => hit.key)).toEqual([2, 3]);
  });

  it('refuses an undeclared filter, undefined, null, an empty list and a filter outside what every index declares', async () => {
    const { search } = await indexed();
    const query = (filters: unknown) => search.query({ in: [PageIndex, PostIndex], term: 'whales', filters: filters as never });
    await expect(query({ author: 'x' })).rejects.toThrow(new TypeError('search.query() filters by "author", which the index "pages" does not declare in static filters.'));
    await expect(query({ tenant: 1 })).rejects.toThrow(new TypeError('search.query() filters by "tenant", which the index "posts" does not declare in static filters.'));
    await expect(query({ audience: undefined })).rejects.toThrow(new TypeError('search.query({ filters: { audience } }) is undefined. A filter always has a value; leave the filter out to search without it.'));
    await expect(query({ audience: null })).rejects.toThrow(new TypeError('search.query({ filters: { audience } }) is null. A filter always has a value; leave the filter out to search without it.'));
    await expect(query({ audience: [] })).rejects.toThrow(new TypeError('search.query({ filters: { audience } }) is an empty list, which no document matches. Give at least one value.'));
    await expect(query({ audience: ['public', undefined] })).rejects.toThrow(TypeError);
    await expect(query({ audience: { $ne: 'x' } })).rejects.toThrow(TypeError);
    await expect(query('audience=public')).rejects.toThrow(TypeError);
  });

  it('refuses filters it could not read whole: from a class, inherited, hidden, under a symbol, or a list with a hole', async () => {
    const { search, driver } = await indexed();
    class TenantScope {
      get tenant(): number {
        return 1;
      }
    }
    const hidden = Object.defineProperty({}, 'tenant', { value: 1, enumerable: false });
    const holey: unknown[] = [1, 2, 3];
    delete holey[1];
    const cases: unknown[] = [new TenantScope(), Object.create({ tenant: 1 }), hidden, { [Symbol('tenant')]: 1 }, { tenant: holey }];
    const before = driver.queries.length;
    for (const filters of cases) await expect(search.query({ in: PageIndex, term: 'whales', filters: filters as never })).rejects.toThrow(TypeError);
    expect(driver.queries.length).toBe(before);
    // A plain object without a prototype is read like any other.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { tenant: 1 });
    const result = await search.query({ in: PageIndex, term: 'whales', filters: bare as never });
    expect(result.ok && result.value.data.map((hit) => hit.key)).toEqual([1]);
  });

  it('refuses a page past hit 1000, a page size out of range, an invalid locale and a request without index', async () => {
    const { search } = await indexed();
    await expect(search.query({ in: PageIndex, term: 'whales', page: 11, perPage: 100 })).rejects.toThrow(
      new TypeError('search.query({ page: 11, perPage: 100 }) reaches past hit 1000; a search reaches at most the first 1000 hits.'),
    );
    await expect(search.query({ in: PageIndex, term: 'whales', page: 10, perPage: 100 })).resolves.toMatchObject({ ok: true });
    await expect(search.query({ in: PageIndex, term: 'whales', perPage: 101 })).rejects.toThrow(new TypeError('search.query({ perPage }) is 101, but it is a whole number from 1 to 100.'));
    await expect(search.query({ in: PageIndex, term: 'whales', page: 0 })).rejects.toThrow(new TypeError('search.query({ page }) is 0, but it is a whole number from 1.'));
    await expect(search.query({ in: PageIndex, term: 'whales', locale: 'de_DE' })).rejects.toThrow(TypeError);
    await expect(search.query({ in: [], term: 'whales' })).rejects.toThrow(new TypeError('search.query({ in }) names no index: give an index class or a list of them.'));
    await expect(search.query({ in: PageIndex, term: 42 as never })).rejects.toThrow(TypeError);
  });

  it('hands the driver the checked request: tokens, the normalized term, filters, locale, flags and the page as offset and limit', async () => {
    const { search, driver } = await indexed();
    const result = await search.query({ in: [PageIndex, PostIndex], term: `\uff37hales "of"\u0000 north${' '.repeat(300)}tail`, filters: { audience: ['public', 'staff'] }, locale: 'pt-br', prefix: true, excerpts: true, page: 3, perPage: 7 });
    expect(driver.queries.at(-1)).toEqual({
      indexes: [expect.objectContaining({ name: 'pages' }), expect.objectContaining({ name: 'posts' })],
      tokens: ['Whales', 'of', 'north'],
      // NFKC turns the fullwidth W into W, the input is cut at 256 characters (the tail is gone), and then NUL is removed.
      term: `Whales "of" north${' '.repeat(255 - 'Whales "of" north'.length)}`,
      filters: { audience: ['public', 'staff'] },
      locale: 'pt-BR',
      prefix: true,
      excerpts: true,
      offset: 14,
      limit: 7,
    });
    expect(result.ok).toBe(true);
    const plain = await search.query({ in: PageIndex, term: 'whale' });
    expect(driver.queries.at(-1)).toMatchObject({ prefix: false, excerpts: false, offset: 0, limit: 20, filters: {} });
    expect(plain.ok && plain.value.data).toEqual([]);
  });

  it('passes the excerpt of a hit on only when asked for', async () => {
    const { search } = await indexed();
    const withExcerpts = await search.query({ in: PageIndex, term: 'north', excerpts: true });
    expect(withExcerpts.ok && withExcerpts.value.data).toEqual([{ index: 'pages', key: 1, score: 1, excerpt: [{ text: 'Whales of the north', match: true }] }]);
    const without = await search.query({ in: PageIndex, term: 'north' });
    expect(without.ok && without.value.data).toEqual([{ index: 'pages', key: 1, score: 1 }]);
    const prefixed = await search.query({ in: PageIndex, term: 'nor', prefix: true });
    expect(prefixed.ok && prefixed.value.data.map((hit) => hit.key)).toEqual([1]);
  });

  it('finds nothing for a term without words, and does not ask the driver', async () => {
    const { search, driver } = await indexed();
    const before = driver.calls.length;
    for (const term of ['', '   ', '"*:()', '&|!']) {
      const result = await search.query({ in: PageIndex, term });
      expect(result).toEqual({ ok: true, value: { data: [], meta: { page: 1, perPage: 20, total: 0, lastPage: 1, from: null, to: null } } });
    }
    expect(driver.calls.length).toBe(before);
  });

  it('refuses an option it does not know, so a misspelt filter never searches without it', async () => {
    const { search, driver } = await indexed();
    const request = { in: PageIndex, term: 'whales', filter: { tenant: 1 } };
    const before = driver.queries.length;
    await expect(search.query(request)).rejects.toThrow(
      new TypeError('search.query() got the option "filter"; a search takes in, term, filters, locale, prefix, excerpts, page, perPage.'),
    );
    class TenantSearch {
      readonly term = 'whales';
      get in() {
        return PageIndex;
      }
      get filter() {
        return { tenant: 1 };
      }
    }
    await expect(search.query(new TenantSearch() as never)).rejects.toThrow(new TypeError('search.query() takes a plain request object, got an object.'));
    await expect(search.query(Object.assign(Object.create({ filters: { tenant: 1 } }) as object, { in: PageIndex, term: 'whales' }) as never)).rejects.toThrow(TypeError);
    const hidden = Object.defineProperty({ in: PageIndex, term: 'whales' }, 'filter', { value: { tenant: 1 }, enumerable: false });
    await expect(search.query(hidden as never)).rejects.toThrow(new TypeError('search.query() takes a plain request object, got an object.'));
    await expect(search.query({ in: PageIndex, term: 'whales', [Symbol('filters')]: { tenant: 1 } } as never)).rejects.toThrow(TypeError);
    expect(driver.queries.length).toBe(before);
  });

  it('refuses a hit with a key that is no key or a score that is no finite number, and a failure of another kind', async () => {
    const { search, driver } = await indexed();
    driver.query = async () => ({ ok: true, value: { hits: [{ index: 'pages', key: 1.5, score: 1 }], total: 1 } }) as never;
    await expect(search.query({ in: PageIndex, term: 'whales' })).rejects.toThrow(TypeError);
    driver.query = async () => ({ ok: true, value: { hits: [{ index: 'pages', key: 1, score: Number.NaN }], total: 1 } }) as never;
    await expect(search.query({ in: PageIndex, term: 'whales' })).rejects.toThrow(new TypeError('The search driver returned a hit of "pages" with the score NaN; a score is a finite number.'));
    driver.query = async () => ({ ok: true, value: { hits: [], total: Number.NaN } }) as never;
    await expect(search.query({ in: PageIndex, term: 'whales' })).rejects.toThrow(new TypeError('The search driver returned the total NaN; a total is a whole number of 0 or more.'));
    driver.query = async () => ({ ok: false, error: { kind: 'timeout', message: 'slow' } }) as never;
    await expect(search.query({ in: PageIndex, term: 'whales' })).rejects.toThrow(new TypeError('The search driver returned a failure of the kind "timeout"; a failure is unavailable or missing-index.'));
  });

  it('returns the failure of the driver as an err', async () => {
    const { search, driver } = await indexed();
    driver.failure = { kind: 'unavailable', message: 'The search service did not answer.' };
    expect(await search.query({ in: PageIndex, term: 'whales' })).toEqual({ ok: false, error: { kind: 'unavailable', message: 'The search service did not answer.' } });
  });

  it('caps the total at 1000 and drops hits of an index that was not asked for', async () => {
    const { search, driver } = await indexed();
    driver.query = async () => ({ ok: true, value: { hits: [{ index: 'posts', key: 'a', score: 2 }, { index: 'pages', key: 1, score: 1 }], total: 5000 } }) as never;
    const result = await search.query({ in: PageIndex, term: 'whales' });
    expect(result.ok && result.value.data).toEqual([{ index: 'pages', key: 1, score: 1 }]);
    // A driver that returns more than a page never hands the app more than perPage hits.
    driver.query = async () => ({ ok: true, value: { hits: [1, 2, 3].map((key) => ({ index: 'pages', key, score: 1 })), total: 3 } }) as never;
    const capped = await search.query({ in: PageIndex, term: 'whales', perPage: 2 });
    expect(capped.ok && capped.value.data.map((hit) => hit.key)).toEqual([1, 2]);
    expect(result.ok && result.value.meta).toMatchObject({ total: 1000, lastPage: 50 });
  });
});

describe('canonicalLocale', () => {
  it('keeps a canonical tag of exactly 35 characters, the width of the stored locale', () => {
    expect(canonicalLocale('EN-aaaaaaaa-bbbbbbbb-cccccccc-ddddd', 'locale')).toBe('en-aaaaaaaa-bbbbbbbb-cccccccc-ddddd');
  });

  it('refuses a canonical tag of 36 characters', () => {
    expect(() => canonicalLocale('en-aaaaaaaa-bbbbbbbb-cccccccc-dddddd', 'locale')).toThrow(TypeError);
  });

  it('refuses a tag whose canonical form is longer than 35 characters', () => {
    expect(() => canonicalLocale('de-DE-u-ca-gregory-co-phonebk-hc-h23-nu-latn', 'search.query({ locale })')).toThrow(
      new TypeError('search.query({ locale }) is "de-DE-u-ca-gregory-co-phonebk-hc-h23-nu-latn", but a locale is a language tag such as "en" or "pt-BR", at most 35 characters in its canonical form.'),
    );
  });
});
