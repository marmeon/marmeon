import { createApplication, defineModule, type Application, type Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql, type Connection, type Database } from '@marmeon/database';
import * as fetchModule from '@marmeon/fetch';
import { FetchServiceProvider, HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { QueueServiceProvider } from '@marmeon/queue';
import { afterEach, describe, expect, it } from 'vitest';
import type { DriverQuery } from '../../driver.ts';
import { SearchDriver } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';
import { SearchConfig } from '../../config.ts';
import { SearchServiceProvider } from '../../provider.ts';
import type { IndexInfo } from '../../registry.ts';
import { Search } from '../../search.ts';
import { SearchIndex, type SearchDocument } from '../../search-index.ts';
import { MARK_END, MARK_START, meilisearchFilterValue } from '../../terms.ts';
import { MeilisearchClient, SearchSyncError } from './client.ts';
import { documentId, MeilisearchDriver, multiSearchBody } from './driver.ts';
import { createMeilisearchDriver } from './index.ts';

// The meilisearch driver: what it sends, what it reads back, how failures surface, and its start checks.

const KEY = 'local-test-key';
const BASE = 'http://meili.internal:7700';
const PAGES: IndexInfo = { name: 'pages', key: 'id', fields: [{ name: 'body', weight: 'C' }, { name: 'title', weight: 'A' }], filters: ['tenant', 'kind'] };
const POSTS: IndexInfo = { name: 'posts', key: 'slug', fields: [{ name: 'title', weight: 'A' }], filters: ['tenant'] };

const warnings: string[] = [];
const logger = { warn: (message: string) => warnings.push(message) } as unknown as Logger;

function driver(http: HttpClientFake): MeilisearchDriver {
  const client = new MeilisearchClient({ url: new URL(BASE), apiKey: KEY, http: () => http, fetch: () => fetchModule, lookup: async () => ['10.0.0.5'], sleep: async () => {} });
  return new MeilisearchDriver(client, logger);
}

/** A fake Meilisearch: every write is task 1, which ends with `task`; the index exists unless `missing`. */
function meili(options: { task?: Record<string, unknown>; missing?: boolean } = {}): HttpClientFake {
  return new HttpClientFake()
    .dns('meili.internal', ['10.0.0.5'])
    .respond(/./, Response.json({ taskUid: 1, status: 'enqueued' }, { status: 202 }))
    .respond(`${BASE}/indexes/pages`, options.missing ? Response.json({ code: 'index_not_found' }, { status: 404 }) : Response.json({ uid: 'pages' }))
    .respond(`${BASE}/tasks/1`, Response.json({ uid: 1, status: 'succeeded', ...options.task }));
}

const bodyOf = async (request: Request): Promise<unknown> => JSON.parse(await request.clone().text());

const rejection = async (promise: Promise<unknown>): Promise<Error> => (await promise.then(() => undefined, (error: unknown) => error)) as Error;

const query = (overrides: Partial<DriverQuery> = {}): DriverQuery => ({ indexes: [PAGES], tokens: ['quick', 'fox'], term: '"quick" -fox', filters: {}, prefix: false, excerpts: false, offset: 0, limit: 20, ...overrides });

afterEach(() => {
  warnings.length = 0;
});

describe('MeilisearchDriver: writes', () => {
  it('derives an id that is valid for every key: no key text, no path character, at most 43 characters', () => {
    const ids = ['a/b', '../x', 42, '42', 'ü'.repeat(253)].map(documentId);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(ids).size).toBe(5);
  });

  it('stores fields as s_*, filters as hashes in f_*, the key and the locale, and waits for the task', async () => {
    const http = meili();
    await driver(http).upsert(PAGES, [
      { key: 'a/b', locale: 'pt-BR', fields: { title: 'Hello', body: 'World' }, filters: { tenant: 'x" OR f_tenant = "y', kind: 7 } },
      { key: 42, locale: null, fields: { title: 'Answer' }, filters: {} },
      { key: 'ü'.repeat(253), locale: null, fields: { title: 'Long' }, filters: {} },
    ]);
    expect(http.requests.map((request) => `${request.method} ${request.url}`)).toEqual([`GET ${BASE}/indexes/pages`, `POST ${BASE}/indexes/pages/documents?primaryKey=id`, `GET ${BASE}/tasks/1`]);
    const [first, second, third] = (await bodyOf(http.requests[1]!)) as Record<string, unknown>[];
    expect(first).toEqual({
      id: documentId('a/b'),
      key: 'a/b',
      locale: 'pt-BR',
      s_title: 'Hello',
      s_body: 'World',
      f_tenant: meilisearchFilterValue('x" OR f_tenant = "y'),
      f_kind: meilisearchFilterValue(7),
    });
    expect(first!['f_tenant']).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toEqual({ id: documentId(42), key: 42, locale: null, s_title: 'Answer' });
    expect(third!['id']).toBe(documentId('ü'.repeat(253)));
    expect(http.requests[1]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('never creates an index on a write: a missing index fails before any document is sent, with the command that creates it', async () => {
    const http = meili({ missing: true });
    const error = await rejection(driver(http).upsert(PAGES, [{ key: 1, locale: null, fields: { title: 'x' }, filters: {} }]));
    expect(error).toBeInstanceOf(SearchSyncError);
    expect(error.message).toBe('The Meilisearch index "pages" does not exist. Run marmeon search:rebuild pages.');
    expect(http.requests).toHaveLength(1);
  });

  it('throws when Meilisearch accepted the write but its task failed', async () => {
    const http = meili({ task: { status: 'failed', error: { code: 'invalid_document_fields', message: 'secret field text' } } });
    const error = await rejection(driver(http).upsert(PAGES, [{ key: 1, locale: null, fields: { title: 'secret field text' }, filters: {} }]));
    expect(error).toBeInstanceOf(SearchSyncError);
    expect(error.message).toBe('The Meilisearch task 1 failed (invalid_document_fields).');
  });

  it('deletes by id, flushes, and fails a delete on a missing index with the command that creates it', async () => {
    const http = meili();
    await driver(http).delete(PAGES, ['a/b', 42]);
    expect(http.requests[0]!.url).toBe(`${BASE}/indexes/pages/documents/delete-batch`);
    expect(await bodyOf(http.requests[0]!)).toEqual([documentId('a/b'), documentId(42)]);
    await driver(http).flush(PAGES);
    expect(`${http.requests[2]!.method} ${http.requests[2]!.url}`).toBe(`DELETE ${BASE}/indexes/pages/documents`);

    const missing = meili({ task: { status: 'failed', error: { code: 'index_not_found' } } });
    expect((await rejection(driver(missing).delete(PAGES, [1]))).message).toBe('The Meilisearch index "pages" does not exist. Run marmeon search:rebuild pages.');
  });

  it('prepares an index: creates it, accepts one that exists, and applies the settings in weight order', async () => {
    const statuses = [{ status: 'failed', error: { code: 'index_already_exists' } }, { status: 'succeeded' }];
    const http = meili().respond(`${BASE}/tasks/1`, () => Response.json({ uid: 1, ...statuses.shift() }));
    await driver(http).prepare(PAGES);
    expect(http.requests.map((request) => `${request.method} ${request.url}`)).toEqual([`POST ${BASE}/indexes`, `GET ${BASE}/tasks/1`, `PATCH ${BASE}/indexes/pages/settings`, `GET ${BASE}/tasks/1`]);
    expect(await bodyOf(http.requests[0]!)).toEqual({ uid: 'pages', primaryKey: 'id' });
    expect(await bodyOf(http.requests[2]!)).toEqual({
      searchableAttributes: ['s_title', 's_body'],
      filterableAttributes: ['locale', 'f_tenant', 'f_kind'],
      displayedAttributes: ['key', 's_title', 's_body'],
      pagination: { maxTotalHits: 1000 },
    });
  });

  it('prepares a rebuild target under its own name and never deletes it', async () => {
    const statuses = [{ status: 'failed', error: { code: 'index_already_exists' } }, { status: 'succeeded' }];
    const http = meili().respond(`${BASE}/tasks/1`, () => Response.json({ uid: 1, ...statuses.shift() }));
    await driver(http).prepare(PAGES, 'pages_rebuild');
    expect(http.requests.map((request) => `${request.method} ${request.url}`)).toEqual([`POST ${BASE}/indexes`, `GET ${BASE}/tasks/1`, `PATCH ${BASE}/indexes/pages_rebuild/settings`, `GET ${BASE}/tasks/1`]);
    expect(await bodyOf(http.requests[0]!)).toEqual({ uid: 'pages_rebuild', primaryKey: 'id' });
  });

  it('swaps a rebuilt index in and deletes the old one', async () => {
    const http = meili();
    await driver(http).swap(PAGES, 'pages_rebuild');
    expect(await bodyOf(http.requests[0]!)).toEqual([{ indexes: ['pages', 'pages_rebuild'] }]);
    expect(`${http.requests[2]!.method} ${http.requests[2]!.url}`).toBe(`DELETE ${BASE}/indexes/pages_rebuild`);
  });
});

describe('MeilisearchDriver: searching', () => {
  it('sends one federated multi-search with the tokens only, every token required, the filters hashed and the locale', async () => {
    const body = multiSearchBody(query({ indexes: [PAGES, POSTS], filters: { tenant: 'x" OR f_tenant = "y' }, locale: 'pt-BR', offset: 40, limit: 20 }));
    const filter = `f_tenant = "${meilisearchFilterValue('x" OR f_tenant = "y')}" AND (locale = "pt-BR" OR locale IS NULL)`;
    expect(body).toEqual({
      federation: { page: 3, hitsPerPage: 20 },
      queries: [
        { indexUid: 'pages', q: 'quick fox', matchingStrategy: 'all', showRankingScore: true, attributesToRetrieve: ['key'], filter },
        { indexUid: 'posts', q: 'quick fox', matchingStrategy: 'all', showRankingScore: true, attributesToRetrieve: ['key'], filter },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('x\\" OR');
  });

  it('asks for excerpts of the fields in weight order, marked with the private-use markers', () => {
    const [first] = (multiSearchBody(query({ excerpts: true })) as { queries: Record<string, unknown>[] }).queries;
    expect(first).toMatchObject({ attributesToCrop: ['s_title', 's_body'], attributesToHighlight: ['s_title', 's_body'], cropLength: 24, highlightPreTag: MARK_START, highlightPostTag: MARK_END });
  });

  it('refuses an offset that is no whole page', () => {
    expect(() => multiSearchBody(query({ offset: 5, limit: 20 }))).toThrow(TypeError);
  });

  it('reads the hits: index, key with its type, ranking score, and the first marked field in weight order as segments', async () => {
    const http = meili().respond(
      `${BASE}/multi-search`,
      Response.json({
        hits: [
          { key: 42, _federation: { indexUid: 'pages', weightedRankingScore: 0.5 }, _rankingScore: 0.9, _formatted: { key: '42', s_title: 'Plain title', s_body: `…the ${MARK_START}quick${MARK_END} fox…` } },
          { key: 'hello', _federation: { indexUid: 'posts', weightedRankingScore: 0.4 }, _formatted: { s_title: 'No match here' } },
        ],
        page: 1,
        hitsPerPage: 20,
        totalPages: 1,
        totalHits: 2,
      }),
    );
    const result = await driver(http).query(query({ indexes: [PAGES, POSTS], excerpts: true }));
    expect(result).toEqual({
      ok: true,
      value: {
        hits: [
          { index: 'pages', key: 42, score: 0.9, excerpt: [{ text: '…the ', match: false }, { text: 'quick', match: true }, { text: ' fox…', match: false }] },
          { index: 'posts', key: 'hello', score: 0.4, excerpt: [{ text: 'No match here', match: false }] },
        ],
        total: 2,
      },
    });
    expect(await bodyOf(http.requests[0]!)).toMatchObject({ federation: { page: 1, hitsPerPage: 20 } });
  });

  it('returns missing-index and unavailable as results, never throws, and warns about a refused key', async () => {
    const answer = (status: number, body: unknown) => meili().respond(`${BASE}/multi-search`, Response.json(body, { status }));
    const missing = await driver(answer(400, { code: 'index_not_found' })).query(query());
    expect(missing.ok ? undefined : missing.error.kind).toBe('missing-index');
    const down = await driver(answer(503, {})).query(query());
    expect(down.ok ? undefined : down.error).toEqual({ kind: 'unavailable', message: 'The search could not run on Meilisearch. Meilisearch answered 503.' });
    const refused = await driver(answer(403, { code: 'invalid_api_key' })).query(query());
    expect(refused.ok ? undefined : refused.error.kind).toBe('unavailable');
    expect(warnings).toEqual(['Meilisearch refused the API key or an action it lacks; check SEARCH_MEILISEARCH_API_KEY and its actions.']);
    const unreachable = await driver(meili().failNext('network')).query(query());
    expect(unreachable.ok ? undefined : unreachable.error.kind).toBe('unavailable');
    const malformed = await driver(answer(200, { hits: 'no' })).query(query());
    expect(malformed.ok ? undefined : malformed.error.kind).toBe('unavailable');
  });
});

describe('MeilisearchDriver: the remaining failures', () => {
  it('warns and returns unavailable for a search Meilisearch rejects', async () => {
    const http = meili().respond(`${BASE}/multi-search`, Response.json({ code: 'invalid_search_filter' }, { status: 400 }));
    const result = await driver(http).query(query());
    expect(result.ok ? undefined : result.error).toEqual({ kind: 'unavailable', message: 'The search could not run on Meilisearch. Meilisearch answered 400 (invalid_search_filter).' });
    expect(warnings).toEqual(['Meilisearch refused a search. Meilisearch answered 400 (invalid_search_filter). An index whose settings are older than its class needs marmeon search:rebuild.']);
  });

  it('warns about a refused key on a write and rethrows', async () => {
    const http = meili().respond(`${BASE}/indexes/pages/documents/delete-batch`, Response.json({ code: 'invalid_api_key' }, { status: 403 }));
    expect((await rejection(driver(http).delete(PAGES, [1]))).message).toBe('Meilisearch answered 403 (invalid_api_key).');
    expect(warnings).toEqual(['Meilisearch refused the API key or an action it lacks; check SEARCH_MEILISEARCH_API_KEY and its actions.']);
  });

  it('names the rebuild for a flush answered 404 index_not_found at once', async () => {
    const http = meili().respond(`${BASE}/indexes/pages/documents`, Response.json({ code: 'index_not_found' }, { status: 404 }));
    expect((await rejection(driver(http).flush(PAGES))).message).toBe('The Meilisearch index "pages" does not exist. Run marmeon search:rebuild pages.');
  });

  it('rethrows a failed index creation other than an index that exists, before any settings', async () => {
    const http = meili({ task: { status: 'failed', error: { code: 'invalid_index_uid' } } });
    expect((await rejection(driver(http).prepare(PAGES))).message).toBe('The Meilisearch task 1 failed (invalid_index_uid).');
    expect(http.requests.map((request) => request.method)).toEqual(['POST', 'GET']);
  });

  it('refuses an index name or a locale it would not write into a path or a filter', async () => {
    await expect(driver(meili()).flush({ ...PAGES, name: '../admin' })).rejects.toThrow(TypeError);
    expect(() => multiSearchBody(query({ locale: 'en") OR (locale = "de' }))).toThrow(TypeError);
  });
});

describe('the meilisearch driver in an app', () => {
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
      return { fields: { title: row.title } };
    }
  }

  const running: Application[] = [];
  afterEach(async () => {
    for (const app of running.splice(0)) await app.shutdown();
  });

  const ENV = { LOG_LEVEL: 'silent', NODE_ENV: 'test', DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null', SEARCH_DRIVER: 'meilisearch' };
  const FULL = { ...ENV, SEARCH_MEILISEARCH_URL: 'http://10.0.0.5:7700', SEARCH_MEILISEARCH_API_KEY: KEY };

  async function start(env: Record<string, string>, http = new HttpClientFake(), providers = [DatabaseServiceProvider, QueueServiceProvider, FetchServiceProvider, SearchServiceProvider]) {
    const app = await createApplication(
      { root: import.meta.dirname, discover: false, providers, modules: [defineModule({ name: 'pages', searchIndexes: [PageIndex] })] },
      { env, override: (container) => container.instance(HttpClient, http) },
    );
    running.push(app);
    return app;
  }

  it('starts with the full configuration, writes through the queued job and searches', async () => {
    const base = 'http://10.0.0.5:7700';
    const http = new HttpClientFake()
      .respond(/./, Response.json({ taskUid: 9 }, { status: 202 }))
      .respond(`${base}/indexes/pages`, Response.json({ uid: 'pages' }))
      .respond(`${base}/tasks/9`, Response.json({ uid: 9, status: 'succeeded' }))
      .respond(`${base}/multi-search`, Response.json({ hits: [{ key: 1, _federation: { indexUid: 'pages' }, _rankingScore: 1 }], totalHits: 1 }));
    const app = await start(FULL, http);
    expect(app.container.make(SearchDriver).writes).toBe('queue');
    const connections = app.container.make(Connections);
    await sql`create table pages (id integer primary key, title text not null)`.execute(connections.get());
    await sql`insert into pages (id, title) values (1, 'Hello')`.execute(connections.get());

    await app.container.make(Search).index(PageIndex, 1);
    const documents = http.requests.find((request) => request.url === `${base}/indexes/pages/documents?primaryKey=id`);
    expect(await bodyOf(documents!)).toEqual([{ id: documentId(1), key: 1, locale: null, s_title: 'Hello' }]);

    const result = await app.container.make(Search).query({ in: PageIndex, term: 'hello' });
    expect(result.ok ? result.value.data : result.error).toEqual([{ index: 'pages', key: 1, score: 1 }]);
  });

  it('stops the start for a missing or malformed address and a missing key, naming no value', async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...FULL, SEARCH_MEILISEARCH_URL: '' }, /needs SEARCH_MEILISEARCH_URL/],
      [{ ...FULL, SEARCH_MEILISEARCH_URL: 'http://user:hunter2-secret@meili.internal' }, /carries a user name or a password/],
      [{ ...FULL, SEARCH_MEILISEARCH_URL: 'http://meili.internal/?key=hunter2-secret' }, /must not carry a query/],
      [{ ...FULL, SEARCH_MEILISEARCH_API_KEY: '' }, /needs SEARCH_MEILISEARCH_API_KEY/],
      [{ ...FULL, SEARCH_MEILISEARCH_API_KEY: 'hunter2\nsecret' }, /must be printable ASCII, without line breaks/],
    ];
    for (const [env, message] of cases) {
      const error = await rejection(start(env));
      expect(error).toBeInstanceOf(SearchSetupError);
      expect(error.message).toMatch(/^\[marmeon:Q9\] /);
      expect(error.message).toMatch(message);
      expect(error.message).not.toContain('hunter2');
    }
  });

  it('refuses to send before the app started, when @marmeon/fetch is not loaded yet', async () => {
    const app = await start(FULL);
    const config = app.container.make(SearchConfig);
    const early = createMeilisearchDriver({ name: 'meilisearch', container: app.container, logger });
    expect(config.driver).toBe('meilisearch');
    await expect(early.flush(PAGES)).rejects.toThrow('[marmeon:Q9] The meilisearch search driver was used before the application started, so @marmeon/fetch is not loaded yet.');
  });

  it('stops the start without @marmeon/queue and without the HttpClient of @marmeon/fetch', async () => {
    const noQueue = await rejection(start(FULL, undefined, [DatabaseServiceProvider, FetchServiceProvider, SearchServiceProvider]));
    expect(noQueue.message).toMatch(/^\[marmeon:Q9\] The search driver "meilisearch" writes through the queue, which needs @marmeon\/queue/);
    const noFetch = await rejection(
      createApplication({ root: import.meta.dirname, discover: false, providers: [DatabaseServiceProvider, QueueServiceProvider, SearchServiceProvider] }, { env: FULL }).then((app) => {
        running.push(app);
      }),
    );
    expect(noFetch.message).toMatch(/^\[marmeon:Q9\] SEARCH_DRIVER=meilisearch talks to Meilisearch through the HttpClient of @marmeon\/fetch, which this app does not register/);
  });
});
