import { Application, type Resolver } from '@marmeon/core';
import { Connections, DatabaseHealthCheck, sql, type Connection, type Database } from '@marmeon/database';
import { afterEach, describe, expect, it } from 'vitest';
import { migratedApp } from '../../__fixtures__/databases.ts';
import { defineSearch } from '../../config.ts';
import { SearchDriver, type SearchDriverContext } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';
import { MAX_LOCALE_LENGTH, Search, type SearchRequest } from '../../search.ts';
import { SearchIndex, type SearchDocument, type SearchIndexClass } from '../../search-index.ts';
import { HOSTILE } from '../../test-helpers/hostile-terms.ts';
import { tokens } from '../../terms.ts';
import { databaseDriver } from './index.ts';
import { querySqlite } from './sqlite.ts';
import { SearchIndexes } from '../../registry.ts';

// The database driver on SQLite, against the stub migration as an app runs it: FTS5 ranking by weight, prefixes and diacritics,
// filters compared as JSON, several indexes at once, the 1000 cap, excerpts, the FTS index kept whole, and the caller's transaction.

interface PageRow {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  body: string | null;
  audience: string;
  tenant: number | null;
  featured: boolean | number;
  locale: string | null;
  published: boolean | number;
}

type Tables = { pages: PageRow };

const pages = (db: Database) => (db as unknown as Connection<Tables>).selectFrom('pages').select(['id', 'slug', 'title', 'summary', 'body', 'audience', 'tenant', 'featured', 'locale', 'published']);

class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'A', summary: 'B', body: 'C' } as const;
  static readonly filters = ['audience', 'tenant', 'featured'] as const;

  source(db: Database) {
    return pages(db);
  }

  override includes(row: PageRow): boolean {
    return Boolean(row.published);
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return {
      locale: row.locale,
      fields: { title: row.title, summary: row.summary, body: row.body },
      filters: { audience: row.audience, featured: Boolean(row.featured), ...(row.tenant === null ? {} : { tenant: row.tenant }) },
    };
  }
}

/** The same rows by slug, with the title only: the summary never reaches this index. */
class PostIndex extends SearchIndex<PageRow> {
  static readonly index = 'posts';
  static readonly key = 'slug';
  static readonly fields = { title: 'A' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return pages(db);
  }

  toDocument(row: PageRow): SearchDocument<typeof PostIndex> {
    return { fields: { title: row.title }, filters: { audience: row.audience } };
  }
}

/** A filter `level` whose value has the type the audience names: the number 1, the boolean true or the string "1". */
class LevelIndex extends SearchIndex<PageRow> {
  static readonly index = 'levels';
  static readonly key = 'id';
  static readonly fields = { title: 'A' } as const;
  static readonly filters = ['level'] as const;

  source(db: Database) {
    return pages(db);
  }

  toDocument(row: PageRow): SearchDocument<typeof LevelIndex> {
    const level = row.audience === 'number' ? 1 : row.audience === 'boolean' ? true : '1';
    return { fields: { title: row.title }, filters: { level } };
  }
}

/** The summary at weight D and the body at C, by slug. */
class NoteIndex extends SearchIndex<PageRow> {
  static readonly index = 'notes';
  static readonly key = 'slug';
  static readonly fields = { title: 'A', body: 'C', summary: 'D' } as const;

  source(db: Database) {
    return pages(db);
  }

  toDocument(row: PageRow): SearchDocument<typeof NoteIndex> {
    return { fields: { title: row.title, body: row.body, summary: row.summary } };
  }
}

const INDEXES: readonly SearchIndexClass[] = [PageIndex, PostIndex, LevelIndex, NoteIndex];

const running: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of running.splice(0)) await close();
});

interface Started {
  readonly app: Application;
  readonly search: Search;
  readonly connections: Connections;
  readonly db: Connection<any>;
}

async function start(): Promise<Started> {
  const { app, close } = await migratedApp('sqlite', INDEXES);
  running.push(close);
  const connections = app.container.make(Connections);
  return { app, search: app.container.make(Search), connections, db: connections.get() };
}

let nextId = 1;

async function insertPage(db: Connection<any>, row: Partial<PageRow> = {}): Promise<PageRow> {
  const id = row.id ?? nextId++;
  const page: PageRow = { id, slug: `page-${id}`, title: `Page ${id}`, summary: null, body: null, audience: 'public', tenant: null, featured: false, locale: null, published: true, ...row };
  await sql`insert into pages (id, slug, title, summary, body, audience, tenant, featured, locale, published)
    values (${page.id}, ${page.slug}, ${page.title}, ${page.summary}, ${page.body}, ${page.audience}, ${page.tenant}, ${page.featured ? 1 : 0}, ${page.locale}, ${page.published ? 1 : 0})`.execute(db);
  return page;
}

async function search<I extends SearchIndexClass>(started: Started, request: SearchRequest<I>) {
  const result = await started.search.query(request);
  if (!result.ok) throw new Error(`The search failed: ${result.error.message}`);
  return result.value;
}

const keysOf = (page: { data: readonly { key: unknown }[] }) => page.data.map((hit) => hit.key);

async function integrity(db: Connection<any>): Promise<void> {
  // Throws "database disk image is malformed" when the FTS index and the table disagree.
  await sql`insert into search_documents_fts (search_documents_fts, rank) values ('integrity-check', 1)`.execute(db);
}

async function rowCounts(db: Connection<any>): Promise<{ documents: number; indexed: number }> {
  const documents = (await sql<{ n: number }>`select count(*) as n from search_documents`.execute(db)).rows[0]!.n;
  // The docsize table holds a row per row of the FTS index itself; a select of the FTS table would read the content table.
  const indexed = (await sql<{ n: number }>`select count(*) as n from search_documents_fts_docsize`.execute(db)).rows[0]!.n;
  return { documents: Number(documents), indexed: Number(indexed) };
}

describe('the database driver on SQLite: matching and ranking', () => {
  it('ranks a match in a field of weight A above one in a field of weight C', async () => {
    const started = await start();
    const inTitle = await insertPage(started.db, { title: 'whales', body: 'Ocean life' });
    const inBody = await insertPage(started.db, { title: 'Ocean life', body: 'whales' });
    await started.search.index(PageIndex, [inBody.id, inTitle.id]);
    const page = await search(started, { in: PageIndex, term: 'whales' });
    expect(keysOf(page)).toEqual([inTitle.id, inBody.id]);
    expect(page.data[0]!.score).toBeGreaterThan(page.data[1]!.score);
  });

  it.each([
    ['A above B', { title: 'whales' }, { summary: 'whales' }],
    ['B above C', { summary: 'whales' }, { body: 'whales' }],
  ] as const)('ranks a match of weight %s', async (_, strong, weak) => {
    const started = await start();
    const filler = { title: 'Ocean life', summary: 'Ocean life', body: 'Ocean life' };
    // The stronger page first: a tie would put the newer, weaker one first.
    const strongPage = await insertPage(started.db, { ...filler, ...strong });
    const weakPage = await insertPage(started.db, { ...filler, ...weak });
    await started.search.index(PageIndex, [weakPage.id, strongPage.id]);
    const page = await search(started, { in: PageIndex, term: 'whales' });
    expect(keysOf(page)).toEqual([strongPage.id, weakPage.id]);
    expect(page.data[0]!.score).toBeGreaterThan(page.data[1]!.score);
  });

  it('ranks a match of weight C above one of weight D', async () => {
    const started = await start();
    const strong = await insertPage(started.db, { slug: 'strong', title: 'Ocean life', summary: 'Ocean life', body: 'whales' });
    const weak = await insertPage(started.db, { slug: 'weak', title: 'Ocean life', summary: 'whales', body: 'Ocean life' });
    await started.search.index(NoteIndex, [weak.slug, strong.slug]);
    const page = await search(started, { in: NoteIndex, term: 'whales' });
    expect(keysOf(page)).toEqual([strong.slug, weak.slug]);
    expect(page.data[0]!.score).toBeGreaterThan(page.data[1]!.score);
  });

  it('matches the start of the last word only with prefix', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Häuser am See' });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'hau', prefix: true }))).toEqual([page.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'hau' }))).toEqual([]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'häu', prefix: true }))).toEqual([page.id]);
  });

  it('weighs a match through the prefix like a whole word', async () => {
    const started = await start();
    // The stronger page first: a tie would put the newer, weaker one first.
    const inTitle = await insertPage(started.db, { title: 'Häuser', body: 'Ocean life' });
    const inBody = await insertPage(started.db, { title: 'Ocean life', body: 'Häuser' });
    await started.search.index(PageIndex, [inTitle.id, inBody.id]);
    const page = await search(started, { in: PageIndex, term: 'hau', prefix: true });
    expect(keysOf(page)).toEqual([inTitle.id, inBody.id]);
    expect(page.data[0]!.score).toBeGreaterThan(page.data[1]!.score);
  });

  it('reads only the last word as a prefix in the score', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'house canary', body: 'houses' });
    await started.search.index(PageIndex, page.id);
    // house and canary in the title (A): 10 + 10. The body's "houses" starts with "house", which is not the last word.
    expect((await search(started, { in: PageIndex, term: 'house canary', prefix: true })).data.map((hit) => hit.score)).toEqual([20]);
  });

  it('adds up the score of every word of the term', async () => {
    const started = await start();
    // Both pages have the first word in the title; only where the second word sits sets them apart.
    const strong = await insertPage(started.db, { title: 'merger', summary: 'canary', body: 'Ocean life' });
    const weak = await insertPage(started.db, { title: 'merger', summary: 'Ocean life', body: 'canary' });
    await started.search.index(PageIndex, [strong.id, weak.id]);
    const page = await search(started, { in: PageIndex, term: 'merger canary' });
    expect(keysOf(page)).toEqual([strong.id, weak.id]);
    expect(page.data[0]!.score).toBeGreaterThan(page.data[1]!.score);
  });

  it('orders hits of the same score newest first, the same on every page', async () => {
    const started = await start();
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await insertPage(started.db, { title: 'whale' })).id);
    await started.search.index(PageIndex, ids);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', perPage: 2 }))).toEqual([ids[2], ids[1]]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', perPage: 2, page: 2 }))).toEqual([ids[0]]);
  });

  it('ignores diacritics in the term and in the text', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Le lac de la Sée' });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'see' }))).toEqual([page.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'SÉE' }))).toEqual([page.id]);
  });

  it.each(HOSTILE)('searches %s without an SQLite error, and finds only documents with its words', async (_, term) => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'foo bar a see near x y start more search code' });
    const unrelated = await insertPage(started.db, { title: 'zzz' });
    await started.search.index(PageIndex, [page.id, unrelated.id]);
    for (const prefix of [false, true]) {
      const result = await started.search.query({ in: PageIndex, term, prefix, excerpts: true });
      expect(result.ok).toBe(true);
      // Found exactly when every word of the term is a word of the page (the last one as a prefix with prefix): syntax that slipped
      // through would widen or break the match.
      const words = page.title.split(' ');
      const plain = (token: string) => token.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      const list = tokens(term).map(plain);
      const found = list.length > 0 && list.every((token, i) => words.includes(token) || (prefix && i === list.length - 1 && words.some((word) => word.startsWith(token))));
      expect(result.ok && keysOf(result.value)).toEqual(found ? [page.id] : []);
    }
  });

  it('reads an unterminated quote, OR and a group as three plain words', async () => {
    const started = await start();
    const both = await insertPage(started.db, { title: 'foo or bar' });
    await insertPage(started.db, { title: 'only foo' });
    await started.search.index(PageIndex, [both.id, both.id + 1]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'foo" OR (bar' }))).toEqual([both.id]);
  });

  it('does not read a word before a colon as a column filter', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'a see' });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'a:see' }))).toEqual([page.id]);
  });
});

describe('the database driver on SQLite: what other tenants cannot move', () => {
  /** Tenant 1's hits for "merger canary" after tenant 2 got `others` documents with "merger": the same rows of tenant 1 every time. */
  async function tenantOne(others: number) {
    const started = await start();
    await insertPage(started.db, { id: 1, title: 'merger canary', tenant: 1 });
    await insertPage(started.db, { id: 2, title: 'canary', body: 'merger', tenant: 1 });
    await insertPage(started.db, { id: 3, title: 'canary', summary: 'merger', tenant: 1 });
    const ids = [1, 2, 3];
    for (let i = 0; i < others; i++) ids.push((await insertPage(started.db, { id: 100 + i, title: `merger ${'word '.repeat(i)}`, tenant: 2 })).id);
    await started.search.index(PageIndex, ids);
    const page = await search(started, { in: PageIndex, term: 'merger canary', filters: { tenant: 1 } });
    return page.data.map((hit) => [hit.key, hit.score]);
  }

  it('gives tenant 1 the same hits, scores and order whatever tenant 2 indexes', async () => {
    const alone = await tenantOne(0);
    expect(alone.map(([key]) => key)).toEqual([1, 3, 2]);
    expect(await tenantOne(1)).toEqual(alone);
    expect(await tenantOne(10)).toEqual(alone);
  });
});

describe('the database driver on SQLite: filters and locales', () => {
  it('filters by a string, a number, a boolean and one of a list', async () => {
    const started = await start();
    const publicPage = await insertPage(started.db, { title: 'whale', audience: 'public', tenant: 1, featured: true });
    const staffPage = await insertPage(started.db, { title: 'whale', audience: 'staff', tenant: 2 });
    const otherPage = await insertPage(started.db, { title: 'whale', audience: 'other' });
    await started.search.index(PageIndex, [publicPage.id, staffPage.id, otherPage.id]);
    const found = async (filters: SearchRequest<typeof PageIndex>['filters']) => keysOf(await search(started, { in: PageIndex, term: 'whale', filters })).toSorted();
    expect(await found({ audience: 'public' })).toEqual([publicPage.id]);
    expect(await found({ tenant: 2 })).toEqual([staffPage.id]);
    expect(await found({ featured: true })).toEqual([publicPage.id]);
    expect(await found({ featured: false })).toEqual([staffPage.id, otherPage.id]);
    expect(await found({ audience: ['public', 'staff'] })).toEqual([publicPage.id, staffPage.id]);
    expect(await found({ audience: 'public', tenant: 2 })).toEqual([]);
  });

  it('matches no filter on a document that leaves the filter out', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale', tenant: null });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', filters: { tenant: 0 } }))).toEqual([]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', filters: { tenant: [0, 1] } }))).toEqual([]);
  });

  it('compares filter values with their type: true is not 1, and "1" is not 1', async () => {
    const started = await start();
    const number = await insertPage(started.db, { title: 'whale', audience: 'number' });
    const boolean = await insertPage(started.db, { title: 'whale', audience: 'boolean' });
    const string = await insertPage(started.db, { title: 'whale', audience: 'string' });
    await started.search.index(LevelIndex, [number.id, boolean.id, string.id]);
    expect(keysOf(await search(started, { in: LevelIndex, term: 'whale', filters: { level: 1 } }))).toEqual([number.id]);
    expect(keysOf(await search(started, { in: LevelIndex, term: 'whale', filters: { level: true } }))).toEqual([boolean.id]);
    expect(keysOf(await search(started, { in: LevelIndex, term: 'whale', filters: { level: '1' } }))).toEqual([string.id]);
  });

  it('refuses an undeclared filter before any statement reaches the database', async () => {
    const started = await start();
    const statements: string[] = [];
    const stop = started.connections.onQuery((event) => statements.push(event.sql));
    await expect(started.search.query({ in: PageIndex, term: 'whale', filters: { slug: 'x' } as never })).rejects.toThrow(TypeError);
    stop();
    expect(statements).toEqual([]);
  });

  it('narrows a locale to its documents and to those without one', async () => {
    const started = await start();
    const german = await insertPage(started.db, { title: 'whale', locale: 'de' });
    const none = await insertPage(started.db, { title: 'whale', locale: null });
    const english = await insertPage(started.db, { title: 'whale', locale: 'en' });
    await started.search.index(PageIndex, [german.id, none.id, english.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', locale: 'de' })).toSorted()).toEqual([german.id, none.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' })).toSorted()).toEqual([german.id, none.id, english.id]);
  });
});

describe('the database driver on SQLite: several indexes, pages and excerpts', () => {
  it('ranks two indexes together, and each hit carries its index and the key with its type', async () => {
    const started = await start();
    const strong = await insertPage(started.db, { slug: 'strong', title: 'whale' });
    const weak = await insertPage(started.db, { slug: 'weak', title: 'Ocean', body: 'whale' });
    await started.search.index(PageIndex, weak.id);
    await started.search.index(PostIndex, strong.slug);
    const page = await search(started, { in: [PageIndex, PostIndex], term: 'whale' });
    expect(page.data.map((hit) => [hit.index, hit.key])).toEqual([
      ['posts', 'strong'],
      ['pages', weak.id],
    ]);
  });

  it('stores and returns a key of 253 characters whose JSON form is 1520 characters long', async () => {
    const started = await start();
    // Every character escaped as \u0001: the longest JSON form a key can have.
    const slug = '\u0001'.repeat(253);
    await insertPage(started.db, { slug, title: 'whale' });
    await started.search.index(PostIndex, slug);
    const stored = (await sql<{ n: number }>`select length(key) as n from search_documents where index_name = 'posts'`.execute(started.db)).rows[0]!.n;
    expect(Number(stored)).toBe(1520);
    // SQLite does not hold a varchar to its width; Postgres does, so the column declares the full length.
    const declared = (await sql<{ type: string }>`select type from pragma_table_info('search_documents') where name = 'key'`.execute(started.db)).rows[0]!.type;
    expect(declared.toLowerCase()).toBe('varchar(1520)');
    const locale = (await sql<{ type: string }>`select type from pragma_table_info('search_documents') where name = 'locale'`.execute(started.db)).rows[0]!.type;
    expect(locale.toLowerCase()).toBe(`varchar(${MAX_LOCALE_LENGTH})`);
    expect(keysOf(await search(started, { in: PostIndex, term: 'whale' }))).toEqual([slug]);
    await started.search.remove(PostIndex, slug);
    expect((await rowCounts(started.db)).documents).toBe(0);
  });

  it('pages through the hits and caps the total at 1000', async () => {
    const started = await start();
    await sql`with recursive n(i) as (select 1 union all select i + 1 from n where i < 1005)
      insert into pages (id, slug, title, audience, featured, published) select 10000 + i, 'bulk-' || i, 'whale ' || i, 'public', 0, 1 from n`.execute(started.db);
    await started.search.index(PageIndex, Array.from({ length: 1005 }, (_, i) => 10001 + i));
    expect((await rowCounts(started.db)).documents).toBe(1005);
    const first = await search(started, { in: PageIndex, term: 'whale', perPage: 100 });
    expect(first.meta.total).toBe(1000);
    expect(first.data).toHaveLength(100);
    const last = await search(started, { in: PageIndex, term: 'whale', perPage: 100, page: 10 });
    expect(last.data).toHaveLength(100);
    expect(last.meta.total).toBe(1000);
    expect(new Set([...keysOf(first), ...keysOf(last)]).size).toBe(200);
  });

  it('counts no more than 1001 matches in the driver itself', async () => {
    const started = await start();
    await sql`with recursive n(i) as (select 1 union all select i + 1 from n where i < 1005)
      insert into pages (id, slug, title, audience, featured, published) select 10000 + i, 'bulk-' || i, 'whale ' || i, 'public', 0, 1 from n`.execute(started.db);
    await started.search.index(PageIndex, Array.from({ length: 1005 }, (_, i) => 10001 + i));
    const info = started.app.container.make(SearchIndexes).info(PageIndex);
    const result = await started.app.container.make(SearchDriver).query({ indexes: [info], tokens: ['whale'], term: 'whale', filters: {}, prefix: false, excerpts: false, offset: 0, limit: 10 });
    expect(result.ok && result.value.total).toBe(1001);
  });

  it('refuses a filter name that is no declared name before it becomes part of a JSON path', async () => {
    const started = await start();
    const info = started.app.container.make(SearchIndexes).info(PageIndex);
    const statements: string[] = [];
    const stop = started.connections.onQuery((event) => statements.push(event.sql));
    for (const name of ['a"."b', 'Audience', '$', 'a b']) {
      await expect(querySqlite(started.db, { indexes: [info], tokens: ['whale'], term: 'whale', filters: { [name]: 'x' }, prefix: false, excerpts: false, offset: 0, limit: 10 })).rejects.toThrow(TypeError);
    }
    stop();
    expect(statements).toEqual([]);
  });

  it('refuses filters that are no plain object in the driver itself, so no filter drops out', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale', tenant: 1 });
    await started.search.index(PageIndex, page.id);
    const info = started.app.container.make(SearchIndexes).info(PageIndex);
    const inherited = Object.create({ tenant: 2 }) as object;
    const hidden = Object.defineProperty({}, 'tenant', { value: 2, enumerable: false });
    for (const filters of [new Map([['tenant', 2]]), inherited, hidden, { [Symbol('tenant')]: 2 }, null]) {
      await expect(querySqlite(started.db, { indexes: [info], tokens: ['whale'], term: 'whale', filters: filters as never, prefix: false, excerpts: false, offset: 0, limit: 10 })).rejects.toThrow(TypeError);
    }
  });

  it('counts a total below the cap exactly, also on a page after the first', async () => {
    const started = await start();
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push((await insertPage(started.db, { title: `whale ${i}` })).id);
    await started.search.index(PageIndex, ids);
    const second = await search(started, { in: PageIndex, term: 'whale', perPage: 5, page: 2 });
    expect(second.meta.total).toBe(7);
    expect(second.data).toHaveLength(2);
  });

  it('makes excerpts as segments only from declared fields', async () => {
    const started = await start();
    const page = await insertPage(started.db, { slug: 'whale-hidden', title: 'Blue whale', summary: 'hidden summary about the whale' });
    await started.search.index(PostIndex, page.slug);
    const found = await search(started, { in: PostIndex, term: 'whale', excerpts: true });
    expect(found.data).toHaveLength(1);
    const excerpt = found.data[0]!.excerpt!;
    expect(excerpt).toEqual([
      { text: 'Blue ', match: false },
      { text: 'whale', match: true },
    ]);
    expect(excerpt.map((segment) => segment.text).join('')).not.toContain('hidden');
    expect(keysOf(await search(started, { in: PostIndex, term: 'hidden' }))).toEqual([]);
  });

  it('ranks from the index alone and makes excerpts only for the rows of the page', async () => {
    const started = await start();
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push((await insertPage(started.db, { title: `whale ${i}` })).id);
    await started.search.index(PageIndex, ids);
    const statements: { sql: string; parameters: readonly unknown[] }[] = [];
    const stop = started.connections.onQuery((event) => statements.push({ sql: event.sql, parameters: event.parameters }));
    const page = await search(started, { in: PageIndex, term: 'whale', perPage: 5, page: 2, excerpts: true });
    stop();
    expect(page.data).toHaveLength(5);
    expect(page.data.every((hit) => hit.excerpt?.some((segment) => segment.match))).toBe(true);
    // No statement reads the text of every match: no highlight(), no bm25(), and snippet() only in a statement over the page's ids.
    expect(statements.filter((statement) => /highlight\(|bm25\(/.test(statement.sql))).toEqual([]);
    const snippets = statements.filter((statement) => statement.sql.includes('snippet('));
    expect(snippets).toHaveLength(1);
    const rowIds = (await sql<{ id: number }>`select id from search_documents where index_name = 'pages' and key in (${sql.join(page.data.map((hit) => String(hit.key)))})`.execute(started.db)).rows;
    expect(snippets[0]!.parameters.filter((parameter) => typeof parameter === 'number').toSorted((x, y) => Number(x) - Number(y))).toEqual(rowIds.map((row) => Number(row.id)).toSorted((x, y) => x - y));
  });

  it('gives no excerpt of a document whose filters changed after the page was read', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale watching tours', tenant: 1 });
    await started.search.index(PageIndex, page.id);
    let moved: Promise<unknown> | undefined;
    const stop = started.connections.onQuery((event) => {
      // Right after the page statement, another request moves the document to tenant 2 with a new text; the excerpt statement
      // waits for its commit.
      if (moved === undefined && event.sql.startsWith('select d.id as id, d.index_name')) {
        moved = started.connections.transaction(async () => {
          await sql`update pages set tenant = 2, title = 'CONFIDENTIAL whale acquisition' where id = ${page.id}`.execute(started.db);
          await started.search.index(PageIndex, page.id);
        });
      }
    });
    const found = await search(started, { in: PageIndex, term: 'whale', filters: { tenant: 1 }, excerpts: true });
    stop();
    await moved;
    expect(moved).toBeDefined();
    expect(found.data.map((hit) => hit.excerpt)).toEqual([[]]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', filters: { tenant: 1 } }))).toEqual([]);
  });

  it('leaves the excerpt out unless asked', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale' });
    await started.search.index(PageIndex, page.id);
    expect((await search(started, { in: PageIndex, term: 'whale' })).data[0]).not.toHaveProperty('excerpt');
  });
});

describe('the database driver on SQLite: writes', () => {
  it('keeps the FTS index whole after an insert, an update, a removal and a flush', async () => {
    const started = await start();
    const one = await insertPage(started.db, { title: 'whale' });
    const two = await insertPage(started.db, { title: 'dolphin' });
    await started.search.index(PageIndex, [one.id, two.id]);
    await integrity(started.db);
    await sql`update pages set title = 'orca' where id = ${one.id}`.execute(started.db);
    await started.search.index(PageIndex, one.id);
    await integrity(started.db);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' }))).toEqual([]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'orca' }))).toEqual([one.id]);
    const revision = (await sql<{ revision: number }>`select revision from search_documents where key = ${String(one.id)}`.execute(started.db)).rows[0]!.revision;
    expect(Number(revision)).toBe(2);
    await started.search.remove(PageIndex, two.id);
    await integrity(started.db);
    expect(keysOf(await search(started, { in: PageIndex, term: 'dolphin' }))).toEqual([]);
    await started.app.container.make(SearchDriver).flush({ name: 'pages', key: 'id', fields: [], filters: [] });
    await integrity(started.db);
    expect(await rowCounts(started.db)).toEqual({ documents: 0, indexed: 0 });
  });

  it('flushes one index and keeps the documents of another', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale' });
    await started.search.index(PageIndex, page.id);
    await started.search.index(PostIndex, page.slug);
    await started.app.container.make(SearchDriver).flush(started.app.container.make(SearchIndexes).info(PageIndex));
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' }))).toEqual([]);
    expect(keysOf(await search(started, { in: PostIndex, term: 'whale' }))).toEqual([page.slug]);
    await integrity(started.db);
  });

  it('removes a document whose row includes() refuses', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale' });
    await started.search.index(PageIndex, page.id);
    await sql`update pages set published = 0 where id = ${page.id}`.execute(started.db);
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' }))).toEqual([]);
    await integrity(started.db);
  });

  it('stores the last document of a key that one write names twice, and keeps the FTS index whole', async () => {
    const started = await start();
    const info = started.app.container.make(SearchIndexes).info(PostIndex);
    await started.app.container.make(SearchDriver).upsert(info, [
      { key: 'twice', locale: null, fields: { title: 'whale' }, filters: {} },
      { key: 'twice', locale: null, fields: { title: 'orca' }, filters: {} },
    ]);
    expect(keysOf(await search(started, { in: PostIndex, term: 'orca' }))).toEqual(['twice']);
    expect(keysOf(await search(started, { in: PostIndex, term: 'whale' }))).toEqual([]);
    expect(await rowCounts(started.db)).toEqual({ documents: 1, indexed: 1 });
    const revision = (await sql<{ revision: number }>`select revision from search_documents where key = '"twice"'`.execute(started.db)).rows[0]!.revision;
    expect(Number(revision)).toBe(1);
    await integrity(started.db);
  });

  it('does not start with two defineSearch() in its config, on SQLite too (Q9)', async () => {
    const error = await migratedApp('sqlite', INDEXES, {}, [defineSearch({}), defineSearch({})]).then(
      ({ close }) => {
        running.push(close);
        return undefined;
      },
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error!.message).toBe('[marmeon:Q9] The app has more than one defineSearch(…) in its config; keep one.');
  });

  it('keeps one index apart from another under the same key', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale' });
    await started.search.index(PageIndex, page.id);
    await started.search.index(LevelIndex, page.id);
    await started.search.remove(LevelIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' }))).toEqual([page.id]);
  });

  it('writes in the caller transaction: a rollback leaves no row in either table, a commit leaves one', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale' });
    class Rollback extends Error {}
    await expect(
      started.connections.transaction(async () => {
        await started.search.index(PageIndex, page.id);
        expect(await rowCounts(started.db)).toEqual({ documents: 1, indexed: 1 });
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
    expect(await rowCounts(started.db)).toEqual({ documents: 0, indexed: 0 });
    await started.connections.transaction(() => started.search.index(PageIndex, page.id));
    expect(await rowCounts(started.db)).toEqual({ documents: 1, indexed: 1 });
    await integrity(started.db);
  });
});

describe('the database driver at the start', () => {
  const fakeApp = (requirements: unknown[]) => ({ container: { make: () => ({ require: (r: unknown) => requirements.push(r) }) } }) as unknown as Application;
  const driverOn = (driver: string) =>
    databaseDriver({ name: 'database', container: { make: () => ({ options: () => ({ driver }) }) } as unknown as Resolver, logger: undefined as never } satisfies SearchDriverContext);

  it('stops on a MySQL connection with Q9, and requires nothing', async () => {
    const requirements: unknown[] = [];
    const error = await driverOn('mysql').boot!(fakeApp(requirements)).then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error!.message).toBe('[marmeon:Q9] SEARCH_DRIVER=database does not run on MySQL, and the default database connection is a MySQL one. Use SEARCH_DRIVER=meilisearch.');
    expect(requirements).toEqual([]);
  });

  it('starts on a Postgres connection without connecting to it, and requires the table', async () => {
    const requirements: unknown[] = [];
    const app = { container: { make: (token: unknown) => (token === Application ? { definition: { config: [] }, modules: [], providers: [] } : { require: (r: unknown) => requirements.push(r) }) } } as unknown as Application;
    await driverOn('pgsql').boot!(app);
    expect(requirements).toEqual([
      { connection: 'default', table: 'search_documents', columns: ['id', 'index_name', 'key', 'locale', 'config', 'filters', 'a', 'b', 'c', 'd', 'revision'], secrets: ['a', 'b', 'c', 'd'] },
    ]);
  });

  it('stops on a database driver it has no SQL for with Q9, and requires nothing', async () => {
    const requirements: unknown[] = [];
    const error = await driverOn('oracle').boot!(fakeApp(requirements)).then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error!.message).toBe('[marmeon:Q9] SEARCH_DRIVER=database has no SQL for the database driver "oracle". Use SQLite or Postgres, or select another driver.');
    expect(requirements).toEqual([]);
  });

  it('requires the table with every column it uses and its texts secret', async () => {
    const requirements: unknown[] = [];
    await driverOn('sqlite').boot!(fakeApp(requirements));
    expect(requirements).toEqual([
      { connection: 'default', table: 'search_documents', columns: ['id', 'index_name', 'key', 'locale', 'config', 'filters', 'a', 'b', 'c', 'd', 'revision'], secrets: ['a', 'b', 'c', 'd'] },
    ]);
  });

  it('is ready on the migrated stub: the table has every column and its text columns are secret', async () => {
    const { app } = await start();
    await expect(app.container.make(DatabaseHealthCheck).handle()).resolves.toBe('default');
    expect([...app.container.make(Connections).metadata().secrets.get('search_documents')!].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lets migrate leave out the FTS table and its shadow tables once the app has booted', async () => {
    const unknown: unknown[] = [];
    const { app, close } = await migratedApp('sqlite', INDEXES, { onUnknown: (connection, found) => unknown.push({ connection, found }) });
    running.push(close);
    const db = app.container.make(Connections).get();
    const shadows = (await sql<{ name: string }>`select name from pragma_table_list where schema = 'main' and type in ('virtual', 'shadow') order by name`.execute(db)).rows.map((row) => row.name);
    // An external-content table has no _content shadow table: its content is search_documents.
    expect(shadows).toEqual(['search_documents_fts', 'search_documents_fts_config', 'search_documents_fts_data', 'search_documents_fts_docsize', 'search_documents_fts_idx']);
    expect(unknown).toEqual([]);
  });
});
