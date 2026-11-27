import { createApplication, defineModule, type Application, type ServiceProviderClass } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql, type Connection, type Database } from '@marmeon/database';
import { AssertionError } from 'node:assert';
import { afterEach, describe, expect, it } from 'vitest';
import type { DriverQuery } from './driver.ts';
import { SearchFake } from './fake.ts';
import type { IndexInfo } from './registry.ts';
import { SearchServiceProvider } from './provider.ts';
import { Search, type SearchRequest } from './search.ts';
import { SearchIndex, type SearchDocument, type SearchIndexClass } from './search-index.ts';

// The fake behind the real Search: what it records, what a rollback leaves, and that it searches by the rules every driver follows.

interface PageRow {
  id: number;
  title: string;
  summary: string | null;
  body: string | null;
  audience: string;
  tenant: number | null;
  locale: string | null;
  published: number;
}

interface NoteRow {
  slug: string;
  title: string;
  audience: string;
}

type Tables = { pages: PageRow; notes: NoteRow };

class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'A', summary: 'B', body: 'D' } as const;
  static readonly filters = ['audience', 'tenant'] as const;

  source(db: Database) {
    return (db as unknown as Connection<Tables>).selectFrom('pages').select(['id', 'title', 'summary', 'body', 'audience', 'tenant', 'locale', 'published']);
  }

  override includes(row: PageRow): boolean {
    return row.published === 1;
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return { locale: row.locale, fields: { title: row.title, summary: row.summary, body: row.body }, filters: { audience: row.audience, ...(row.tenant === null ? {} : { tenant: row.tenant }) } };
  }
}

class NoteIndex extends SearchIndex<NoteRow> {
  static readonly index = 'notes';
  static readonly key = 'slug';
  static readonly fields = { title: 'A' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return (db as unknown as Connection<Tables>).selectFrom('notes').select(['slug', 'title', 'audience']);
  }

  toDocument(row: NoteRow): SearchDocument<typeof NoteIndex> {
    return { fields: { title: row.title }, filters: { audience: row.audience } };
  }
}

class Rollback extends Error {}

interface Started {
  readonly fake: SearchFake;
  readonly search: Search;
  readonly connections: Connections;
}

const running: Application[] = [];

afterEach(async () => {
  for (const app of running.splice(0)) await app.shutdown();
});

async function start(): Promise<Started> {
  const fake = new SearchFake();
  const FakeProvider: ServiceProviderClass = class FakeProvider {
    static searchDrivers = { fake: () => fake };
  };
  const app = await createApplication(
    {
      root: import.meta.dirname,
      discover: false,
      providers: [DatabaseServiceProvider, SearchServiceProvider, FakeProvider],
      modules: [defineModule({ name: 'pages', searchIndexes: [PageIndex, NoteIndex] })],
    },
    { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', SEARCH_DRIVER: 'fake' } },
  );
  running.push(app);
  const connections = app.container.make(Connections);
  const db = connections.get();
  await sql`create table pages (id integer primary key, title text not null, summary text, body text, audience text not null, tenant integer, locale text, published integer not null)`.execute(db);
  await sql`create table notes (slug text primary key, title text not null, audience text not null)`.execute(db);
  return { fake, search: app.container.make(Search), connections };
}

async function insertPage(connections: Connections, row: Partial<PageRow> & { id: number }): Promise<void> {
  const page: PageRow = { title: `Page ${row.id}`, summary: null, body: null, audience: 'public', tenant: null, locale: null, published: 1, ...row };
  await sql`insert into pages (id, title, summary, body, audience, tenant, locale, published)
    values (${page.id}, ${page.title}, ${page.summary}, ${page.body}, ${page.audience}, ${page.tenant}, ${page.locale}, ${page.published})`.execute(connections.get());
}

async function insertNote(connections: Connections, row: NoteRow): Promise<void> {
  await sql`insert into notes (slug, title, audience) values (${row.slug}, ${row.title}, ${row.audience})`.execute(connections.get());
}

/** The keys of the hits of a search, in order; a failure fails the test. */
async function found<const I extends SearchIndexClass>(search: Search, request: SearchRequest<I>): Promise<unknown[]> {
  const result = await search.query(request);
  if (!result.ok) throw new Error(`the search failed: ${result.error.message}`);
  return result.value.data.map((hit) => hit.key);
}

describe('SearchFake records', () => {
  it('the documents Search built from the rows, and asserts them by key or by a function', async () => {
    const { fake, search, connections } = await start();
    await insertPage(connections, { id: 1, title: 'Whales', body: 'about whales' });
    await insertNote(connections, { slug: 'n-1', title: 'A note', audience: 'staff' });
    await search.index(PageIndex, { id: 1, title: 'Passed, not read', summary: null, body: null, audience: 'public', tenant: null, locale: null, published: 1 });
    await search.index(NoteIndex, 'n-1');

    expect(fake.documents(PageIndex)).toEqual([{ key: 1, locale: null, fields: { title: 'Whales', body: 'about whales' }, filters: { audience: 'public' } }]);
    expect(fake.written.map((write) => [write.method, write.index, write.keys])).toEqual([['upsert', 'pages', [1]], ['upsert', 'notes', ['n-1']]]);
    fake.assertIndexed(PageIndex, 1).assertIndexed(NoteIndex, 'n-1').assertIndexed(PageIndex, (document) => document.fields['title'] === 'Whales');

    expect(() => fake.assertIndexed(PageIndex, 2)).toThrow(new AssertionError({ message: 'Expected the search index "pages" to hold the document 2; it holds 1.' }));
    expect(() => fake.assertIndexed(PageIndex, '1' as never)).toThrow(AssertionError);
    expect(() => fake.assertIndexed(PageIndex, (document) => document.fields['title'] === 'Other')).toThrow(
      new AssertionError({ message: 'Expected the search index "pages" to hold a document matching the function; it holds 1.' }),
    );
    expect(() => fake.assertNothingIndexed()).toThrow(new AssertionError({ message: 'Expected no document to be indexed, but 2 were ("pages", "notes").' }));
  });

  it('a row includes() refuses as removed, and a removal only once the document is gone', async () => {
    const { fake, search, connections } = await start();
    await insertPage(connections, { id: 1 });
    await insertPage(connections, { id: 2, published: 0 });
    await search.index(PageIndex, [1, 2]);
    fake.assertIndexed(PageIndex, 1).assertRemoved(PageIndex, 2);
    expect(() => fake.assertRemoved(PageIndex, 1)).toThrow(new AssertionError({ message: 'Expected the document 1 to be removed from the search index "pages", but the index holds it.' }));
    expect(() => fake.assertRemoved(PageIndex, 3)).toThrow(new AssertionError({ message: 'Expected the document 3 to be removed from the search index "pages", but no removal of it was written.' }));

    await search.remove(PageIndex, 1);
    fake.assertRemoved(PageIndex, 1);
    expect(fake.documents(PageIndex)).toEqual([]);
  });

  it('removals and flushes as no indexing for assertNothingIndexed()', async () => {
    const { fake, search } = await start();
    await search.remove(PageIndex, [1, 2]);
    await fake.flush({ name: 'notes', key: 'slug', fields: [], filters: [] });
    expect(fake.written.map((write) => write.method)).toEqual(['delete', 'flush']);
    fake.assertNothingIndexed();
  });

  it('nothing for a write inside a transaction that rolls back, and the write once it commits', async () => {
    const { fake, search, connections } = await start();
    await insertPage(connections, { id: 1 });
    await expect(connections.transaction(async () => {
      await search.index(PageIndex, 1);
      // Recorded only after the commit: inside the transaction nothing is there yet.
      fake.assertNothingIndexed();
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    fake.assertNothingIndexed();
    expect(fake.written).toEqual([]);

    await connections.transaction(() => search.index(PageIndex, 1));
    fake.assertIndexed(PageIndex, 1);

    await expect(connections.transaction(async () => {
      await search.remove(PageIndex, 1);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    fake.assertIndexed(PageIndex, 1);
  });

  it('a flush, which empties the index and counts as a removal', async () => {
    const { fake, search, connections } = await start();
    await insertPage(connections, { id: 1 });
    await search.index(PageIndex, 1);
    await fake.flush({ name: 'pages', key: 'id', fields: [], filters: [] });
    expect(fake.documents(PageIndex)).toEqual([]);
    fake.assertRemoved(PageIndex, 1);
    expect(fake.written.at(-1)).toEqual({ method: 'flush', index: 'pages', keys: [], documents: [] });
  });

  it('refuses an assertion on something that is no index class', async () => {
    const { fake } = await start();
    expect(() => fake.assertIndexed({} as never, 1 as never)).toThrow(new TypeError('app.search.assertIndexed() takes a search index class (a class that extends SearchIndex) first.'));
    expect(() => fake.documents(undefined as never)).toThrow(TypeError);
    expect(() => fake.assertIndexed(PageIndex, null as never)).toThrow(TypeError);
  });
});

describe('SearchFake searches', () => {
  it('finds a document holding every word, without case and diacritics, best fields first', async () => {
    const { search, connections } = await start();
    await insertPage(connections, { id: 1, title: 'Garden notes', body: 'Häuser am See' });
    await insertPage(connections, { id: 2, title: 'Häuser', summary: 'am See' });
    await insertPage(connections, { id: 3, title: 'Häuser only' });
    await search.index(PageIndex, [1, 2, 3]);

    // id 2: title (A = 4) + summary (B = 3); id 1: body (D = 1) only. id 3 lacks "see".
    expect(await found(search, { in: PageIndex, term: 'hauser SEE' })).toEqual([2, 1]);
    const result = await search.query({ in: PageIndex, term: 'hauser see' });
    expect(result.ok && result.value.data.map((hit) => hit.score)).toEqual([7, 1]);
    // Syntax is no syntax: quotes and brackets fall away, and "or" is a word every document must hold.
    expect(await found(search, { in: PageIndex, term: '"hauser" (see:*' })).toEqual([2, 1]);
    expect(await found(search, { in: PageIndex, term: 'hauser OR see' })).toEqual([]);
  });

  it('takes the last word as the start of a word only with prefix', async () => {
    const { search, connections } = await start();
    await insertPage(connections, { id: 1, title: 'Whales of the north' });
    await search.index(PageIndex, 1);
    expect(await found(search, { in: PageIndex, term: 'wha' })).toEqual([]);
    expect(await found(search, { in: PageIndex, term: 'wha', prefix: true })).toEqual([1]);
    // Only the last word is a prefix.
    expect(await found(search, { in: PageIndex, term: 'wha north', prefix: true })).toEqual([]);
    expect(await found(search, { in: PageIndex, term: 'whales nor', prefix: true })).toEqual([1]);
  });

  it('applies the filters with their types, and a document without the filter matches none', async () => {
    const { search, connections } = await start();
    await insertPage(connections, { id: 1, title: 'Plan', tenant: 7 });
    await insertPage(connections, { id: 2, title: 'Plan', tenant: 8, audience: 'staff' });
    await insertPage(connections, { id: 3, title: 'Plan' });
    await search.index(PageIndex, [1, 2, 3]);

    expect(await found(search, { in: PageIndex, term: 'plan', filters: { tenant: 7 } })).toEqual([1]);
    expect(await found(search, { in: PageIndex, term: 'plan', filters: { tenant: [7, 8] } })).toEqual([1, 2]);
    expect(await found(search, { in: PageIndex, term: 'plan', filters: { tenant: '7' as never } })).toEqual([]);
    expect(await found(search, { in: PageIndex, term: 'plan', filters: { audience: 'public' } })).toEqual([1, 3]);
    // Fail closed, as with the real drivers: Search refuses before the fake is asked.
    await expect(search.query({ in: PageIndex, term: 'plan', filters: { tenant: undefined as never } })).rejects.toThrow(TypeError);
    await expect(search.query({ in: PageIndex, term: 'plan', filters: { tenant: [] as never } })).rejects.toThrow(TypeError);
  });

  it('refuses filters a test hands the fake itself in a shape that Search.query() refuses', async () => {
    const fake = new SearchFake();
    const info: IndexInfo = { name: 'pages', key: 'id', fields: [{ name: 'title', weight: 'A' }], filters: ['audience'] };
    await fake.upsert(info, [{ key: 1, locale: null, fields: { title: 'Plan' }, filters: { audience: 'members' } }]);
    const query = (filters: unknown): DriverQuery => ({ indexes: [info], tokens: ['plan'], term: 'plan', filters: filters as DriverQuery['filters'], prefix: false, excerpts: false, offset: 0, limit: 20 });
    const hidden = {};
    Object.defineProperty(hidden, 'audience', { value: 'public', enumerable: false });
    const shapes: [string, unknown][] = [
      ['a Map', new Map([['audience', 'public']])],
      ['an inherited key', Object.create({ audience: 'public' })],
      ['a non-enumerable key', hidden],
      ['a symbol key', { audience: 'members', [Symbol('audience')]: 'public' }],
    ];
    for (const [shape, filters] of shapes) {
      await expect(fake.query(query(filters)), shape).rejects.toThrow(new TypeError('The search filters must be a plain object with enumerable string keys.'));
    }
    await expect(fake.query(query({ audience: [] }))).rejects.toThrow(new TypeError('The search filter "audience" got an empty list, which would match nothing.'));
    // A hole in a list is a value too, and no scalar: `.map()` would skip it.
    const values: [string, unknown][] = [['undefined', undefined], ['null', null], ['an object', {}], ['NaN', Number.NaN], ['a list with undefined', [undefined]], ['a list with a hole', Object.assign([], { length: 1 })]];
    for (const [shape, value] of values) {
      await expect(fake.query(query({ audience: value })), shape).rejects.toThrow(new TypeError('The search filter "audience" must be a string, a finite number or a boolean, or a non-empty list of them.'));
    }
    // The filter still decides what a plain object finds.
    const members = await fake.query(query({ audience: 'members' }));
    expect(members.ok && members.value.hits.map((hit) => hit.key)).toEqual([1]);
    const visitors = await fake.query(query({ audience: 'public' }));
    expect(visitors.ok && visitors.value.hits).toEqual([]);
  });

  it('keeps documents of the asked locale and documents without one', async () => {
    const { search, connections } = await start();
    await insertPage(connections, { id: 1, title: 'Haus', locale: 'de' });
    await insertPage(connections, { id: 2, title: 'Haus', locale: 'pt-br' });
    await insertPage(connections, { id: 3, title: 'Haus' });
    await search.index(PageIndex, [1, 2, 3]);
    expect(await found(search, { in: PageIndex, term: 'haus', locale: 'pt-BR' })).toEqual([2, 3]);
    expect(await found(search, { in: PageIndex, term: 'haus', locale: 'de' })).toEqual([1, 3]);
    expect(await found(search, { in: PageIndex, term: 'haus' })).toEqual([1, 2, 3]);
  });

  it('pages through the hits and caps the total at 1000', async () => {
    const { search, connections } = await start();
    const db = connections.get();
    await sql`with recursive n(i) as (select 1 union all select i + 1 from n where i < 1005)
      insert into pages (id, title, audience, published) select i, 'Same title', 'public', 1 from n`.execute(db);
    await search.index(PageIndex, Array.from({ length: 1005 }, (_, n) => n + 1));

    const result = await search.query({ in: PageIndex, term: 'same', page: 10, perPage: 100 });
    expect(result.ok && result.value.meta).toEqual({ page: 10, perPage: 100, total: 1000, lastPage: 10, from: 901, to: 1000 });
    expect(result.ok && result.value.data.at(0)?.key).toBe(901);
  });

  it('searches several indexes and marks the matches of an excerpt as segments', async () => {
    const { search, connections } = await start();
    await insertPage(connections, { id: 1, title: 'Intro', body: `${'x '.repeat(60)}the <b>whale</b> sings` });
    await insertNote(connections, { slug: 'n-1', title: 'Whale notes', audience: 'public' });
    await search.index(PageIndex, 1);
    await search.index(NoteIndex, 'n-1');

    const result = await search.query({ in: [PageIndex, NoteIndex], term: 'whale', excerpts: true, filters: { audience: 'public' } });
    if (!result.ok) throw new Error('the search failed');
    expect(result.value.data.map((hit) => [hit.index, hit.key])).toEqual([['notes', 'n-1'], ['pages', 1]]);
    expect(result.value.data[0]!.excerpt).toEqual([{ text: 'Whale', match: true }, { text: ' notes', match: false }]);
    const excerpt = result.value.data[1]!.excerpt!;
    expect(excerpt[0]).toEqual({ text: expect.stringMatching(/^… x/) as unknown, match: false });
    expect(excerpt.filter((segment) => segment.match)).toEqual([{ text: 'whale', match: true }]);
    expect(excerpt.map((segment) => segment.text).join('')).toContain('the <b>whale</b> sings');
  });

  it('answers the next searches with the failure failNext() set', async () => {
    const { fake, search, connections } = await start();
    await insertPage(connections, { id: 1, title: 'Whales' });
    await search.index(PageIndex, 1);
    const unavailable = { ok: false, error: { kind: 'unavailable', message: 'The fake search driver failed this search.' } };
    fake.failNext('unavailable', 2);
    expect(await search.query({ in: PageIndex, term: 'whales' })).toEqual(unavailable);
    expect(await search.query({ in: PageIndex, term: 'whales' })).toEqual(unavailable);
    expect(await found(search, { in: PageIndex, term: 'whales' })).toEqual([1]);
    fake.failNext('missing-index').failNext();
    expect(await search.query({ in: PageIndex, term: 'whales' })).toEqual({ ok: false, error: { kind: 'missing-index', message: 'The fake search driver reports the index as missing.' } });
    expect(await search.query({ in: PageIndex, term: 'whales' })).toEqual({ ok: false, error: { kind: 'unavailable', message: 'The fake search driver failed this search.' } });
    expect(await found(search, { in: PageIndex, term: 'whales' })).toEqual([1]);
    expect(() => fake.failNext('down' as never)).toThrow(new TypeError(`failNext() takes 'unavailable' or 'missing-index', not "down".`));
    expect(() => fake.failNext('unavailable', 0)).toThrow(TypeError);
  });
});
