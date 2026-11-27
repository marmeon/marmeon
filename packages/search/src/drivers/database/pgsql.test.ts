import type { Application } from '@marmeon/core';
import { Connections, sql, type Connection, type Database } from '@marmeon/database';
import { afterEach, describe, expect, it } from 'vitest';
import { migratedApp, PGSQL_URL } from '../../__fixtures__/databases.ts';
import { defineSearch } from '../../config.ts';
import { SearchDriver } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';
import { SearchIndexes } from '../../registry.ts';
import { Search, type SearchRequest } from '../../search.ts';
import { SearchIndex, type SearchDocument, type SearchIndexClass } from '../../search-index.ts';
import { HOSTILE } from '../../test-helpers/hostile-terms.ts';
import { tokens } from '../../terms.ts';

// The database driver on Postgres, against the stub migration as an app runs it: weighted tsvectors written with the configuration
// of each document's locale, stemming, the fallback configuration, terms read without any syntax, prefixes, filters by JSON
// containment, scores local to each document, ts_headline only for the rows of the page, the 1000 cap and the caller's transaction.

interface PageRow {
  id: number;
  slug: string;
  title: string;
  summary: string | null;
  body: string | null;
  audience: string;
  tenant: number | null;
  featured: boolean;
  locale: string | null;
  published: boolean;
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
    return row.published;
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return {
      locale: row.locale,
      fields: { title: row.title, summary: row.summary, body: row.body },
      filters: { audience: row.audience, featured: row.featured, ...(row.tenant === null ? {} : { tenant: row.tenant }) },
    };
  }
}

/** The same rows by slug, with the title only. */
class PostIndex extends SearchIndex<PageRow> {
  static readonly index = 'posts';
  static readonly key = 'slug';
  static readonly fields = { title: 'A' } as const;
  static readonly filters = ['audience'] as const;

  source(db: Database) {
    return pages(db);
  }

  toDocument(row: PageRow): SearchDocument<typeof PostIndex> {
    return { locale: row.locale, fields: { title: row.title }, filters: { audience: row.audience } };
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

/** The summary at weight D and the body at C. */
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

async function start(config: Parameters<typeof migratedApp>[3] = []): Promise<Started> {
  const { app, close } = await migratedApp('pgsql', INDEXES, {}, config);
  running.push(close);
  const connections = app.container.make(Connections);
  return { app, search: app.container.make(Search), connections, db: connections.get() };
}

let nextId = 1;

async function insertPage(db: Connection<any>, row: Partial<PageRow> = {}): Promise<PageRow> {
  const id = row.id ?? nextId++;
  const page: PageRow = { id, slug: `page-${id}`, title: `Page ${id}`, summary: null, body: null, audience: 'public', tenant: null, featured: false, locale: null, published: true, ...row };
  await sql`insert into pages (id, slug, title, summary, body, audience, tenant, featured, locale, published)
    values (${page.id}, ${page.slug}, ${page.title}, ${page.summary}, ${page.body}, ${page.audience}, ${page.tenant}, ${page.featured}, ${page.locale}, ${page.published})`.execute(db);
  return page;
}

async function search<I extends SearchIndexClass>(started: Started, request: SearchRequest<I>) {
  const result = await started.search.query(request);
  if (!result.ok) throw new Error(`The search failed: ${result.error.message}`);
  return result.value;
}

const keysOf = (page: { data: readonly { key: unknown }[] }) => page.data.map((hit) => hit.key);

async function documentCount(db: Connection<any>): Promise<number> {
  return Number((await sql<{ n: string }>`select count(*) as n from search_documents`.execute(db)).rows[0]!.n);
}

/** Inserts `count` published pages titled "whale <i>" with ids from 10001 on, and indexes them. */
async function bulk(started: Started, count: number): Promise<void> {
  await sql`insert into pages (id, slug, title, audience, featured, published)
    select 10000 + i, 'bulk-' || i, 'whale ' || i, 'public', false, true from generate_series(1, ${count}::int) as i`.execute(started.db);
  await started.search.index(PageIndex, Array.from({ length: count }, (_, i) => 10001 + i));
}

interface PlanNode {
  readonly 'Node Type': string;
  readonly Output?: readonly string[];
  readonly 'Actual Rows': number;
  readonly 'Actual Loops': number;
  readonly Plans?: readonly PlanNode[];
}

/** Every node of a plan with the nodes above it, outermost first. */
function* nodes(node: PlanNode, above: readonly PlanNode[] = []): Generator<{ node: PlanNode; above: readonly PlanNode[] }> {
  yield { node, above };
  for (const child of node.Plans ?? []) yield* nodes(child, [...above, node]);
}

describe.skipIf(!PGSQL_URL)('the database driver on Postgres: languages and matching', () => {
  it('finds "Häuser" for "Haus" in a German document, and stores the configuration of its locale', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Die Häuser am See', locale: 'de' });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'Haus', locale: 'de' }))).toEqual([page.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'Haus' }))).toEqual([page.id]);
    const stored = (await sql<{ config: string }>`select config from search_documents where key = ${String(page.id)}`.execute(started.db)).rows[0]!.config;
    expect(stored).toBe('german');
  });

  it('stems English: "house" finds "houses", "running" finds "runs"', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Old houses', body: 'The dog runs', locale: 'en-GB' });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'house', locale: 'en-GB' }))).toEqual([page.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'running' }))).toEqual([page.id]);
  });

  it('reads a locale nothing maps with the simple configuration: whole words, no stemming', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'La domoj estas grandaj', locale: 'eo' });
    await started.search.index(PageIndex, page.id);
    const stored = (await sql<{ config: string }>`select config from search_documents where key = ${String(page.id)}`.execute(started.db)).rows[0]!.config;
    expect(stored).toBe('simple');
    expect(keysOf(await search(started, { in: PageIndex, term: 'domoj', locale: 'eo' }))).toEqual([page.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'domo', locale: 'eo' }))).toEqual([]);
  });

  it('maps a locale through defineSearch({ languages }), the exact locale before its language', async () => {
    const started = await start([defineSearch({ languages: { 'de-CH': 'simple' } })]);
    const swiss = await insertPage(started.db, { title: 'Häuser', locale: 'de-CH' });
    const austrian = await insertPage(started.db, { title: 'Häuser', locale: 'de-AT' });
    await started.search.index(PageIndex, [swiss.id, austrian.id]);
    const configs = (await sql<{ key: string; config: string }>`select key, config from search_documents order by key`.execute(started.db)).rows;
    expect(configs.map((row) => row.config)).toEqual(['simple', 'german']);
    expect(keysOf(await search(started, { in: PageIndex, term: 'Haus', locale: 'de-AT' }))).toEqual([austrian.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'Haus', locale: 'de-CH' }))).toEqual([]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'häuser', locale: 'de-CH' }))).toEqual([swiss.id]);
  });

  it('finds a document without a locale with and without a locale in the search, and narrows a locale to its documents', async () => {
    const started = await start();
    const none = await insertPage(started.db, { title: 'whale' });
    const english = await insertPage(started.db, { title: 'whale', locale: 'en' });
    const german = await insertPage(started.db, { title: 'whale', locale: 'de' });
    await started.search.index(PageIndex, [none.id, english.id, german.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' })).toSorted()).toEqual([none.id, english.id, german.id].toSorted());
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', locale: 'en' })).toSorted()).toEqual([none.id, english.id].toSorted());
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', locale: 'fr' }))).toEqual([none.id]);
  });

  it('keeps diacritics in a document without a locale: simple neither stems nor folds them', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Le lac de la Sée' });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'see' }))).toEqual([]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'SÉE' }))).toEqual([page.id]);
  });

  it('finds a document of a locale only with the configuration the map gives for it now', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Die Häuser', locale: 'de' });
    await started.search.index(PageIndex, page.id);
    // As if the map had read de with simple when the document was written.
    await sql`update search_documents set config = 'simple', vector = setweight(to_tsvector('simple', a), 'A') where key = ${String(page.id)}`.execute(started.db);
    expect(keysOf(await search(started, { in: PageIndex, term: 'häuser', locale: 'de' }))).toEqual([]);
    // Without a locale, every configuration the map gives is tried, simple included.
    expect(keysOf(await search(started, { in: PageIndex, term: 'häuser' }))).toEqual([page.id]);
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'Haus', locale: 'de' }))).toEqual([page.id]);
  });

  it('finds with no search a document whose configuration the map gives for no locale', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale', locale: 'de' });
    await started.search.index(PageIndex, page.id);
    // As if an earlier map had named a configuration the current one does not give at all.
    await sql`create text search configuration retired_german (copy = german)`.execute(started.db);
    await sql`update search_documents set config = 'retired_german', vector = setweight(to_tsvector('retired_german', a), 'A') where key = ${String(page.id)}`.execute(started.db);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' }))).toEqual([]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', locale: 'de' }))).toEqual([]);
  });

  it('matches the start of the last word only with prefix', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Die Häuser', locale: 'de' });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'häu', prefix: true }))).toEqual([page.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'häu' }))).toEqual([]);
  });

  it('reads only the last word as a prefix', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Haus Häuser', locale: 'de' });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'haus häu', prefix: true }))).toEqual([page.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'ha häu', prefix: true }))).toEqual([]);
  });

  it.each(HOSTILE)('searches %s without a Postgres error, and finds only documents with its words', async (_, term) => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'foo bar a see near x y start more search code' });
    const unrelated = await insertPage(started.db, { title: 'zzz' });
    await started.search.index(PageIndex, [page.id, unrelated.id]);
    for (const prefix of [false, true]) {
      const result = await started.search.query({ in: PageIndex, term, prefix, excerpts: true });
      expect(result.ok).toBe(true);
      // The page has no locale, so it reads with simple: lowercase, no stemming, no stop words. Found exactly when every word of the
      // term is a word of the page (the last one as a prefix with prefix): syntax that slipped through would widen or break the match.
      const words = page.title.split(' ');
      const list = tokens(term).map((token) => token.toLowerCase());
      const found = list.length > 0 && list.every((token, i) => words.includes(token) || (prefix && i === list.length - 1 && words.some((word) => word.startsWith(token))));
      expect(result.ok && keysOf(result.value)).toEqual(found ? [page.id] : []);
    }
  });

  it('finds nothing in a language that drops every word of the term, and fails nothing', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'the end of it', locale: 'en' });
    await started.search.index(PageIndex, page.id);
    for (const prefix of [false, true]) expect(keysOf(await search(started, { in: PageIndex, term: 'the and of', locale: 'en', prefix }))).toEqual([]);
    // simple has no stop words: a document without a locale holds them as words.
    const plain = await insertPage(started.db, { title: 'the and of' });
    await started.search.index(PageIndex, plain.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'the and of', locale: 'en' }))).toEqual([plain.id]);
  });

  it('reads an unterminated quote, OR and a group, and every tsquery operator, as plain words', async () => {
    const started = await start();
    const both = await insertPage(started.db, { title: 'foo or bar' });
    const one = await insertPage(started.db, { title: 'only foo' });
    await started.search.index(PageIndex, [both.id, one.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'foo" OR (bar' }))).toEqual([both.id]);
    expect(keysOf(await search(started, { in: PageIndex, term: "'):*&!<->\\ foo" })).toSorted()).toEqual([both.id, one.id].toSorted());
  });

  it('requires every word of "cat or dog": "or" is no operator, a stop word in English and a word in simple', async () => {
    const started = await start();
    const both = await insertPage(started.db, { slug: 'both', title: 'cat dog', locale: 'en' });
    const cat = await insertPage(started.db, { slug: 'cat', title: 'cat', locale: 'en' });
    const dog = await insertPage(started.db, { slug: 'dog', title: 'dog', locale: 'en' });
    const plainBoth = await insertPage(started.db, { slug: 'plain-both', title: 'cat dog' });
    const plainOr = await insertPage(started.db, { slug: 'plain-or', title: 'cat or dog' });
    await started.search.index(PageIndex, [both.id, cat.id, dog.id, plainBoth.id, plainOr.id]);
    // English: or is a stop word and drops out, so cat and dog are both required.
    expect(keysOf(await search(started, { in: PageIndex, term: 'cat or dog', locale: 'en' })).toSorted()).toEqual([both.id, plainOr.id].toSorted());
    // simple (documents without a locale): or stays a word the document must hold.
    expect(keysOf(await search(started, { in: PageIndex, term: 'cat or dog', locale: 'eo' }))).toEqual([plainOr.id]);
  });

  it('reads quotes and a leading minus as nothing: "a b" finds what a b finds, -a what a finds', async () => {
    const started = await start();
    const ab = await insertPage(started.db, { title: 'alpha beta' });
    const ba = await insertPage(started.db, { title: 'beta gamma alpha' });
    const a = await insertPage(started.db, { title: 'alpha' });
    const b = await insertPage(started.db, { title: 'beta' });
    await started.search.index(PageIndex, [ab.id, ba.id, a.id, b.id]);
    const plainPair = keysOf(await search(started, { in: PageIndex, term: 'alpha beta' }));
    expect(plainPair.toSorted()).toEqual([ab.id, ba.id].toSorted());
    expect(keysOf(await search(started, { in: PageIndex, term: '"alpha beta"' }))).toEqual(plainPair);
    const plainOne = keysOf(await search(started, { in: PageIndex, term: 'alpha' }));
    expect(plainOne).toHaveLength(3);
    expect(keysOf(await search(started, { in: PageIndex, term: '-alpha' }))).toEqual(plainOne);
    expect(keysOf(await search(started, { in: PageIndex, term: 'beta -alpha' }))).toEqual(plainPair);
  });
});

describe.skipIf(!PGSQL_URL)('the database driver on Postgres: ranking', () => {
  it.each([
    ['A above B', { title: 'whales' }, { summary: 'whales' }],
    ['B above C', { summary: 'whales' }, { body: 'whales' }],
    ['A above C', { title: 'whales' }, { body: 'whales' }],
  ] as const)('ranks a match of weight %s', async (_, strong, weak) => {
    const started = await start();
    const weakPage = await insertPage(started.db, { title: 'Ocean', summary: 'Ocean', body: 'Ocean', ...weak });
    const strongPage = await insertPage(started.db, { title: 'Ocean', summary: 'Ocean', body: 'Ocean', ...strong });
    await started.search.index(PageIndex, [weakPage.id, strongPage.id]);
    const page = await search(started, { in: PageIndex, term: 'whales' });
    expect(keysOf(page)).toEqual([strongPage.id, weakPage.id]);
    expect(page.data[0]!.score).toBeGreaterThan(page.data[1]!.score);
  });

  it('ranks a match of weight C above one of weight D', async () => {
    const started = await start();
    const inBody = await insertPage(started.db, { slug: 'in-body', title: 'Ocean', body: 'whales' });
    const inSummary = await insertPage(started.db, { slug: 'in-summary', title: 'Ocean', summary: 'whales' });
    await started.search.index(NoteIndex, [inSummary.slug, inBody.slug]);
    const page = await search(started, { in: NoteIndex, term: 'whales' });
    expect(keysOf(page)).toEqual(['in-body', 'in-summary']);
    expect(page.data.every((hit) => hit.score > 0 && hit.score < 1)).toBe(true);
  });

  it('gives tenant 1 the same hits, scores and order whatever tenant 2 indexes', async () => {
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
    const alone = await tenantOne(0);
    expect(alone.map(([key]) => key)).toEqual([1, 3, 2]);
    expect(await tenantOne(40)).toEqual(alone);
  });
});

describe.skipIf(!PGSQL_URL)('the database driver on Postgres: filters', () => {
  it('filters by a string, a number, a boolean and one of a list', async () => {
    const started = await start();
    const one = await insertPage(started.db, { title: 'whale', audience: 'public', tenant: 1, featured: true });
    const two = await insertPage(started.db, { title: 'whale', audience: 'staff', tenant: 2 });
    const three = await insertPage(started.db, { title: 'whale', audience: 'admins', tenant: 1 });
    await started.search.index(PageIndex, [one.id, two.id, three.id]);
    const found = async (filters: SearchRequest<typeof PageIndex>['filters']) => keysOf(await search(started, { in: PageIndex, term: 'whale', filters })).toSorted();
    expect(await found({ audience: 'staff' })).toEqual([two.id]);
    expect(await found({ tenant: 1 })).toEqual([one.id, three.id].toSorted());
    expect(await found({ featured: true })).toEqual([one.id]);
    expect(await found({ audience: ['public', 'staff'] })).toEqual([one.id, two.id].toSorted());
    expect(await found({ audience: ['public', 'admins'], tenant: 1, featured: false })).toEqual([three.id]);
  });

  it('matches no filter on a document that leaves the filter out', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale', tenant: null });
    await started.search.index(PageIndex, page.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', filters: { tenant: 1 } }))).toEqual([]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale', filters: { tenant: [1, 2] } }))).toEqual([]);
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

  it('searches two indexes with a filter both declare, ranks them together and gives each hit its index', async () => {
    const started = await start();
    const strong = await insertPage(started.db, { slug: 'strong', title: 'whale', body: 'Ocean', audience: 'public' });
    const weak = await insertPage(started.db, { slug: 'weak', title: 'Ocean', body: 'whale', audience: 'public' });
    const hidden = await insertPage(started.db, { slug: 'hidden', title: 'whale', audience: 'staff' });
    await started.search.index(PageIndex, [weak.id, hidden.id]);
    await started.search.index(PostIndex, [strong.slug, hidden.slug]);
    const page = await search(started, { in: [PageIndex, PostIndex], term: 'whale', filters: { audience: 'public' } });
    expect(page.data.map((hit) => [hit.index, hit.key])).toEqual([
      ['posts', 'strong'],
      ['pages', weak.id],
    ]);
  });

  it('refuses a filter name that is no declared name in the driver itself, before any statement', async () => {
    const started = await start();
    const info = started.app.container.make(SearchIndexes).info(PageIndex);
    const statements: string[] = [];
    const stop = started.connections.onQuery((event) => statements.push(event.sql));
    for (const name of ['a"."b', 'Audience', '$', 'a b']) {
      await expect(started.app.container.make(SearchDriver).query({ indexes: [info], tokens: ['whale'], term: 'whale', filters: { [name]: 'x' }, prefix: false, excerpts: false, offset: 0, limit: 10 })).rejects.toThrow(TypeError);
    }
    stop();
    expect(statements.filter((statement) => !statement.includes('pg_ts_config'))).toEqual([]);
  });

  it('refuses a filter value that would drop out of the JSON, and filters that are no plain object, in the driver itself', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale', tenant: 1 });
    await started.search.index(PageIndex, page.id);
    const info = started.app.container.make(SearchIndexes).info(PageIndex);
    const driver = started.app.container.make(SearchDriver);
    const run = (filters: unknown) => driver.query({ indexes: [info], tokens: ['whale'], term: 'whale', filters: filters as never, prefix: false, excerpts: false, offset: 0, limit: 10 });
    // Each would otherwise become the condition filters @> '{}', which every document passes.
    for (const filters of [{ tenant: undefined }, { tenant: [undefined] }, { tenant: () => 2 }, { tenant: Number.NaN }, { tenant: null }, { tenant: [] }, { tenant: [2, undefined] }, new Map([['tenant', 2]])]) {
      await expect(run(filters)).rejects.toThrow(TypeError);
    }
    const hits = await run({ tenant: 2 });
    expect(hits.ok && hits.value.hits).toEqual([]);
  });

  it('refuses an undeclared filter before any statement reaches the database', async () => {
    const started = await start();
    const statements: string[] = [];
    const stop = started.connections.onQuery((event) => statements.push(event.sql));
    await expect(started.search.query({ in: PostIndex, term: 'whale', filters: { tenant: 1 } as never })).rejects.toThrow(TypeError);
    stop();
    expect(statements).toEqual([]);
  });
});

describe.skipIf(!PGSQL_URL)('the database driver on Postgres: keys, pages and excerpts', () => {
  it('stores and returns a key of 253 characters whose JSON form is 1520 characters long', async () => {
    const started = await start();
    const slug = '\u0001'.repeat(253);
    await insertPage(started.db, { slug, title: 'whale' });
    await started.search.index(PostIndex, slug);
    const stored = (await sql<{ n: number }>`select length(key) as n from search_documents where index_name = 'posts'`.execute(started.db)).rows[0]!.n;
    expect(Number(stored)).toBe(1520);
    const declared = (await sql<{ n: number }>`select character_maximum_length as n from information_schema.columns where table_name = 'search_documents' and column_name = 'key'`.execute(started.db)).rows[0]!.n;
    expect(Number(declared)).toBe(1520);
    expect(keysOf(await search(started, { in: PostIndex, term: 'whale' }))).toEqual([slug]);
    await started.search.index(PostIndex, slug);
    await started.search.remove(PostIndex, slug);
    expect(await documentCount(started.db)).toBe(0);
  });

  it('pages through the hits and caps the total at 1000', async () => {
    const started = await start();
    await bulk(started, 1005);
    expect(await documentCount(started.db)).toBe(1005);
    const first = await search(started, { in: PageIndex, term: 'whale', perPage: 100 });
    expect(first.meta.total).toBe(1000);
    expect(first.data).toHaveLength(100);
    const last = await search(started, { in: PageIndex, term: 'whale', perPage: 100, page: 10 });
    expect(last.data).toHaveLength(100);
    expect(last.meta.total).toBe(1000);
    expect(new Set([...keysOf(first), ...keysOf(last)]).size).toBe(200);
    const info = started.app.container.make(SearchIndexes).info(PageIndex);
    const result = await started.app.container.make(SearchDriver).query({ indexes: [info], tokens: ['whale'], term: 'whale', filters: {}, prefix: false, excerpts: false, offset: 0, limit: 10 });
    expect(result.ok && result.value.total).toBe(1001);
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
    expect(found.data.map((hit) => hit.excerpt)).toEqual([
      [
        { text: 'Blue ', match: false },
        { text: 'whale', match: true },
      ],
    ]);
    expect(keysOf(await search(started, { in: PostIndex, term: 'hidden' }))).toEqual([]);
    expect((await search(started, { in: PostIndex, term: 'whale' })).data[0]).not.toHaveProperty('excerpt');
  });

  it('marks the forms of a word in an excerpt with the configuration of the document, from any field', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'Stadtplan', body: 'Alte Häuser am Markt', locale: 'de' });
    await started.search.index(PageIndex, page.id);
    const found = await search(started, { in: PageIndex, term: 'Haus', locale: 'de', excerpts: true });
    expect(found.data).toHaveLength(1);
    expect(found.data[0]!.excerpt!.filter((segment) => segment.match).map((segment) => segment.text)).toEqual(['Häuser']);
  });

  it('runs ts_headline above the limit, for the rows of the page only', async () => {
    const started = await start();
    await bulk(started, 60);
    const statements: { sql: string; parameters: readonly unknown[] }[] = [];
    const stop = started.connections.onQuery((event) => statements.push({ sql: event.sql, parameters: event.parameters }));
    const page = await search(started, { in: PageIndex, term: 'whale', perPage: 5, page: 3, excerpts: true });
    stop();
    expect(page.data).toHaveLength(5);
    expect(page.data.every((hit) => hit.excerpt?.some((segment) => segment.match))).toBe(true);
    // One statement makes excerpts; the count does not.
    const headlines = statements.filter((statement) => statement.sql.includes('ts_headline('));
    expect(headlines).toHaveLength(1);
    expect(statements.filter((statement) => statement.sql.startsWith('select count(*)')).every((statement) => !statement.sql.includes('ts_headline('))).toBe(true);
    // The plan of that statement, run: every node that computes ts_headline sits above the Limit and handles no more rows than
    // the page holds, while the scan below the Limit reads all 60 matches.
    const explained = await started.db.executeQuery({
      sql: `explain (analyze, verbose, format json) ${headlines[0]!.sql}`,
      parameters: headlines[0]!.parameters,
      query: { kind: 'RawNode', sqlFragments: [], parameters: [] },
      queryId: { queryId: 'explain-headline' },
    } as never);
    const plan = (explained.rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0]!.Plan;
    const all = [...nodes(plan)];
    const withHeadline = all.filter(({ node }) => node.Output?.some((column) => column.includes('ts_headline(')));
    expect(withHeadline.length).toBeGreaterThan(0);
    for (const { node, above } of withHeadline) {
      expect(node['Node Type']).not.toBe('Limit');
      expect(above.some((parent) => parent['Node Type'] === 'Limit')).toBe(false);
      expect(node['Actual Rows'] * node['Actual Loops']).toBeLessThanOrEqual(5);
    }
    const limit = all.find(({ node }) => node['Node Type'] === 'Limit');
    expect(limit).toBeDefined();
    expect([...nodes(limit!.node)].some(({ node }) => node.Output?.some((column) => column.includes('ts_headline(')))).toBe(false);
    expect([...nodes(limit!.node)].some(({ node }) => node['Actual Rows'] * node['Actual Loops'] >= 60)).toBe(true);
  });
});

describe.skipIf(!PGSQL_URL)('the database driver on Postgres: writes', () => {
  it('replaces the vector on an update, counts the revision up, and removes and flushes', async () => {
    const started = await start();
    const one = await insertPage(started.db, { title: 'whale' });
    const two = await insertPage(started.db, { title: 'dolphin' });
    await started.search.index(PageIndex, [one.id, two.id]);
    await sql`update pages set title = 'orca' where id = ${one.id}`.execute(started.db);
    await started.search.index(PageIndex, one.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' }))).toEqual([]);
    expect(keysOf(await search(started, { in: PageIndex, term: 'orca' }))).toEqual([one.id]);
    const revision = (await sql<{ revision: string }>`select revision from search_documents where key = ${String(one.id)}`.execute(started.db)).rows[0]!.revision;
    expect(Number(revision)).toBe(2);
    await started.search.remove(PageIndex, two.id);
    expect(keysOf(await search(started, { in: PageIndex, term: 'dolphin' }))).toEqual([]);
    await started.app.container.make(SearchDriver).flush(started.app.container.make(SearchIndexes).info(PageIndex));
    expect(await documentCount(started.db)).toBe(0);
  });

  it('stores the last document of a key that one write names twice', async () => {
    const started = await start();
    const info = started.app.container.make(SearchIndexes).info(PostIndex);
    await started.app.container.make(SearchDriver).upsert(info, [
      { key: 'twice', locale: null, fields: { title: 'whale' }, filters: {} },
      { key: 'twice', locale: null, fields: { title: 'orca' }, filters: {} },
    ]);
    expect(keysOf(await search(started, { in: PostIndex, term: 'orca' }))).toEqual(['twice']);
    expect(await documentCount(started.db)).toBe(1);
  });

  it('writes in the caller transaction: a rollback leaves no row, a commit leaves one', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale' });
    class Rollback extends Error {}
    await expect(
      started.connections.transaction(async () => {
        await started.search.index(PageIndex, page.id);
        expect(await documentCount(started.db)).toBe(1);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
    expect(await documentCount(started.db)).toBe(0);
    await started.connections.transaction(() => started.search.index(PageIndex, page.id));
    expect(keysOf(await search(started, { in: PageIndex, term: 'whale' }))).toEqual([page.id]);
  });
});

describe.skipIf(!PGSQL_URL)('the database driver on Postgres at the start and the first use', () => {
  it('stops the first search and the first write with Q9 when a mapped configuration does not exist, and starts without asking', async () => {
    const started = await start([defineSearch({ languages: { eo: 'esperanto_missing' } })]);
    const page = await insertPage(started.db, { title: 'whale' });
    for (const attempt of [() => started.search.query({ in: PageIndex, term: 'whale' }), () => started.search.index(PageIndex, page.id)]) {
      const error = await attempt().then(() => undefined, (e: unknown) => e as Error);
      expect(error).toBeInstanceOf(SearchSetupError);
      expect(error!.message).toMatch(/^\[marmeon:Q9\] The search languages map to the text search configuration esperanto_missing, which the database does not have\./);
    }
    expect(await documentCount(started.db)).toBe(0);
  });

  it('names every configuration the database lacks', async () => {
    const started = await start([defineSearch({ languages: { eo: 'esperanto_missing', ga: 'gaelic_missing' } })]);
    const error = await started.search.query({ in: PageIndex, term: 'whale' }).then(() => undefined, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error!.message).toMatch(/^\[marmeon:Q9\] The search languages map to the text search configurations esperanto_missing, gaelic_missing, which the database does not have\./);
  });

  it('writes and searches with a configuration the app made in its database', async () => {
    const started = await start([defineSearch({ languages: { 'de-CH': 'swiss_german' } })]);
    await sql`create text search configuration swiss_german (copy = german)`.execute(started.db);
    const page = await insertPage(started.db, { title: 'Die Häuser', locale: 'de-CH' });
    await started.search.index(PageIndex, page.id);
    const stored = (await sql<{ config: string }>`select config from search_documents where key = ${String(page.id)}`.execute(started.db)).rows[0]!.config;
    expect(stored).toBe('swiss_german');
    expect(keysOf(await search(started, { in: PageIndex, term: 'Haus', locale: 'de-CH' }))).toEqual([page.id]);
  });

  it('does not start with two defineSearch() in its config (Q9)', async () => {
    const error = await migratedApp('pgsql', INDEXES, {}, [defineSearch({}), defineSearch({})]).then(
      ({ close }) => {
        running.push(close);
        return undefined;
      },
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error!.message).toBe('[marmeon:Q9] The app has more than one defineSearch(…) in its config; keep one.');
  });

  it('checks the configurations once per driver', async () => {
    const started = await start();
    const page = await insertPage(started.db, { title: 'whale' });
    const statements: string[] = [];
    const stop = started.connections.onQuery((event) => statements.push(event.sql));
    await started.search.index(PageIndex, page.id);
    await search(started, { in: PageIndex, term: 'whale' });
    await search(started, { in: PageIndex, term: 'whale' });
    stop();
    expect(statements.filter((statement) => statement.includes('pg_ts_config'))).toHaveLength(1);
  });

  it('lets migrate leave out the vector column once the app has booted', async () => {
    const unknown: unknown[] = [];
    const { close } = await migratedApp('pgsql', INDEXES, { onUnknown: (connection, found) => unknown.push({ connection, found }) });
    running.push(close);
    expect(unknown).toEqual([]);
  });
});

/** Rows of a table whose key column is `citext`: Postgres compares it without case. */
class TagIndex extends SearchIndex<{ slug: string; title: string }> {
  static readonly index = 'tags';
  static readonly key = 'slug';
  static readonly fields = { title: 'A' } as const;

  source(db: Database) {
    return (db as unknown as Connection<{ tags: { slug: string; title: string } }>).selectFrom('tags').select(['slug', 'title']);
  }

  toDocument(row: { slug: string; title: string }): SearchDocument<typeof TagIndex> {
    return { fields: { title: row.title } };
  }
}

describe.skipIf(!PGSQL_URL)('the database driver on Postgres: keys in another spelling', () => {
  it('refuses "About" for the row "about" of a citext key column, and an integer key given as "042"', async () => {
    const { app, close } = await migratedApp('pgsql', [TagIndex, PageIndex]);
    running.push(close);
    const db = app.container.make(Connections).get();
    await sql`create extension if not exists citext`.execute(db);
    await sql`create table tags (slug citext primary key, title text not null)`.execute(db);
    await sql`insert into tags (slug, title) values ('about', 'About us')`.execute(db);
    const search = app.container.make(Search);
    await search.index(TagIndex, 'about');
    await expect(search.index(TagIndex, 'About')).rejects.toThrow(
      new TypeError('TagIndex.source() returned the row with the key "about" for none of the keys asked for: the database matched a key of another type or spelling. Pass keys exactly as the column "slug" holds them.'),
    );
    await insertPage(db, { id: 42 });
    await expect(search.index(PageIndex, '042' as never)).rejects.toThrow(
      new TypeError('PageIndex.source() returned the row with the key 42 for none of the keys asked for: the database matched a key of another type or spelling. Pass keys exactly as the column "id" holds them.'),
    );
    expect((await sql<{ key: string }>`select key from search_documents order by key`.execute(db)).rows.map((row) => row.key)).toEqual(['"about"']);
  });
});
