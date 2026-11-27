import { createApplication, defineModule, type Application, type Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, sql, type Connection, type Database } from '@marmeon/database';
import * as fetchModule from '@marmeon/fetch';
import { FetchServiceProvider, HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { QueueServiceProvider } from '@marmeon/queue';
import type { CheckProblem } from 'marmeon';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { migratedApp, PGSQL_URL } from './__fixtures__/databases.ts';
import { SearchIndexesCheck } from './check.ts';
import { defineSearch } from './config.ts';
import { SearchDriver, type SearchProblem } from './driver.ts';
import { MeilisearchClient } from './drivers/meilisearch/client.ts';
import { MeilisearchDriver, meilisearchSettings, type RebuildTargets } from './drivers/meilisearch/driver.ts';
import { SearchServiceProvider } from './provider.ts';
import { SearchIndexes, type IndexInfo } from './registry.ts';
import { SearchIndex, type SearchDocument } from './search-index.ts';

// `marmeon check` for search: the check turns what the driver's inspect() finds into Q9 errors with their fix; the database driver
// reads the catalog of SQLite and Postgres, the meilisearch driver asks the server, each finding once present and once missing.

interface PageRow {
  id: number;
  title: string;
}

class PageIndex extends SearchIndex<PageRow> {
  static readonly index = 'pages';
  static readonly key = 'id';
  static readonly fields = { title: 'A' } as const;
  static readonly filters = ['kind'] as const;

  source(db: Database) {
    return (db as unknown as Connection<{ pages: PageRow }>).selectFrom('pages').select(['id', 'title']);
  }

  toDocument(row: PageRow): SearchDocument<typeof PageIndex> {
    return { fields: { title: row.title }, filters: { kind: 'page' } };
  }
}

const MIGRATE = 'marmeon publish @marmeon/search && marmeon migrate';
const DOCS = 'docs/full-text-search.md#checking';
const RESTORE =
  'The migration of @marmeon/search creates it, so it was changed or dropped after that migration ran: create it again in a migration of your app, with the statement of that migration.';

const running: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.close();
});

async function started(driver: 'sqlite' | 'pgsql', config: Parameters<typeof migratedApp>[3] = []): Promise<Application> {
  const migrated = await migratedApp(driver, [PageIndex], {}, config);
  running.push(migrated);
  return migrated.app;
}

/** What `marmeon check` gets from the check of a booted app, built by the container as `marmeon check` builds it. */
const check = async (app: Application): Promise<readonly CheckProblem[]> => app.container.createScope().make(SearchIndexesCheck).handle();

const run = async (app: Application, statement: string): Promise<void> => {
  await sql.raw(statement).execute(app.container.make(Connections).get());
};

const error = (message: string, fix?: string): CheckProblem => ({
  severity: 'error',
  code: 'Q9',
  message,
  ...(fix === undefined ? {} : { fix }),
  docs: DOCS,
});

describe('SearchIndexesCheck', () => {
  const indexes = new SearchIndexes().add([PageIndex], 'test');

  it('is the check search-indexes of the run phase, registered by the provider', () => {
    expect(SearchServiceProvider.checks).toEqual([SearchIndexesCheck]);
    expect([SearchIndexesCheck.check, SearchIndexesCheck.phase]).toEqual(['search-indexes', 'run']);
  });

  it('passes the signal of marmeon check on to inspect(), and refuses an answer that is no list', async () => {
    const signals: unknown[] = [];
    const driver = {
      writes: 'queue',
      inspect: async (_given: readonly IndexInfo[], context?: { signal?: AbortSignal }) => {
        signals.push(context?.signal);
        return 'nothing';
      },
    } as unknown as SearchDriver;
    const { signal } = new AbortController();
    await expect(new SearchIndexesCheck(indexes, driver).handle({ signal })).rejects.toThrow(
      new TypeError('inspect() of the search driver must return a list of SearchProblem objects.'),
    );
    expect(signals).toEqual([signal]);
  });

  it('passes without a line for a driver without inspect()', async () => {
    const driver = { writes: 'after-commit' } as unknown as SearchDriver;
    expect(await new SearchIndexesCheck(indexes, driver).handle()).toEqual([]);
  });

  it('gives inspect() every registered index and turns each problem into a Q9 error with its index, fix and the docs', async () => {
    const seen: (readonly IndexInfo[])[] = [];
    const found: SearchProblem[] = [
      { message: 'The server is down.' },
      {
        index: 'pages',
        message: 'has no index yet.',
        fix: 'marmeon search:rebuild pages',
      },
    ];
    const driver = {
      writes: 'queue',
      inspect: async (given: readonly IndexInfo[]) => {
        seen.push(given);
        return found;
      },
    } as unknown as SearchDriver;
    expect(await new SearchIndexesCheck(indexes, driver).handle()).toEqual([error('The server is down.'), error('pages: has no index yet.', 'marmeon search:rebuild pages')]);
    expect(seen).toEqual([[indexes.info(PageIndex)]]);
  });
});

describe('the database driver in marmeon check on SQLite', () => {
  it('passes when the migration of the package ran', async () => {
    expect(await check(await started('sqlite'))).toEqual([]);
  });

  it('names each trigger that is missing', async () => {
    for (const trigger of ['search_documents_ai', 'search_documents_ad', 'search_documents_au']) {
      const app = await started('sqlite');
      await run(app, `drop trigger ${trigger}`);
      expect(await check(app)).toEqual([error(`The default database has no trigger ${trigger}, which keeps search_documents_fts current. ${RESTORE}`)]);
    }
  });

  it('takes no trigger of that name on another table, and names search_rebuilds next to another gap', async () => {
    const app = await started('sqlite');
    await run(app, 'drop trigger search_documents_ad');
    await run(app, 'create trigger search_documents_ad after delete on pages begin select 1; end');
    await run(app, 'drop table search_rebuilds');
    expect(await check(app)).toEqual([
      error('The default database has no table search_rebuilds, which SEARCH_DRIVER=database needs.', MIGRATE),
      error(`The default database has no trigger search_documents_ad, which keeps search_documents_fts current. ${RESTORE}`),
    ]);
  });

  it('takes no view for the table search_documents', async () => {
    const app = await started('sqlite');
    await run(app, 'alter table search_documents rename to search_documents_old');
    await run(app, 'create view search_documents as select * from search_documents_old');
    expect(await check(app)).toEqual([error('The default database has no table search_documents, which SEARCH_DRIVER=database needs.', MIGRATE)]);
  });

  it('is an error with D2 when the migration of the package is in the app but has not run', async () => {
    const app = await createApplication(
      {
        root: workspaceTempDir('marmeon-search-check-'),
        discover: false,
        providers: [DatabaseServiceProvider, SearchServiceProvider],
        modules: [defineModule({ name: 'pages', searchIndexes: [PageIndex] }), defineModule({ name: 'system', migrations: SearchServiceProvider.migrations.from })],
      },
      { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', SEARCH_DRIVER: 'database' } },
    );
    running.push({ close: () => app.shutdown() });
    await expect(check(app)).rejects.toThrow(/^\[marmeon:D2\] /);
  });

  it('names a missing FTS5 table, and a table of that name that is no FTS5 table', async () => {
    const app = await started('sqlite');
    await run(app, 'drop table search_documents_fts');
    expect(await check(app)).toEqual([error(`The default database has no FTS5 table search_documents_fts, which every search reads. ${RESTORE}`)]);
    await run(app, 'create table search_documents_fts (a text, b text, c text, d text)');
    expect(await check(app)).toEqual([error(`The table search_documents_fts is no FTS5 table. ${RESTORE}`)]);
  });

  it('names a missing table search_rebuilds with the commands that make it', async () => {
    const app = await started('sqlite');
    await run(app, 'drop table search_rebuilds');
    expect(await check(app)).toEqual([error('The default database has no table search_rebuilds, which SEARCH_DRIVER=database needs.', MIGRATE)]);
  });

  it('names only the missing table search_documents, not what hangs on it', async () => {
    const app = await started('sqlite');
    await run(app, 'drop table search_documents');
    expect(await check(app)).toEqual([error('The default database has no table search_documents, which SEARCH_DRIVER=database needs.', MIGRATE)]);
  });

  it('says once that the migration has not run when neither table is there', async () => {
    const app = await started('sqlite');
    for (const table of ['search_documents_fts', 'search_rebuilds', 'search_documents']) await run(app, `drop table ${table}`);
    expect(await check(app)).toEqual([error('The default database has neither search_documents nor search_rebuilds: the migration of @marmeon/search has not run.', MIGRATE)]);
  });
});

describe.skipIf(!PGSQL_URL)('the database driver in marmeon check on Postgres', () => {
  it('passes when the migration ran, then names each GIN index and the vector column as they go missing or change', async () => {
    const app = await started('pgsql');
    expect(await check(app)).toEqual([]);

    await run(app, 'drop index search_documents_vector_index');
    const noVectorIndex = error(`The table search_documents has no GIN index search_documents_vector_index, so a search reads every row. ${RESTORE}`);
    expect(await check(app)).toEqual([noVectorIndex]);

    await run(app, 'create index search_documents_vector_index on search_documents (index_name)');
    const otherVectorIndex = error(
      `The index search_documents_vector_index is not the GIN index the search migration makes, or a build of it failed and left it invalid. ${RESTORE}`,
    );
    expect(await check(app)).toEqual([otherVectorIndex]);

    await run(app, 'drop index search_documents_filters_index');
    expect(await check(app)).toEqual([
      otherVectorIndex,
      error(`The table search_documents has no GIN index search_documents_filters_index, so a search reads every row. ${RESTORE}`),
    ]);

    await run(app, 'drop index search_documents_vector_index');
    await run(app, 'create index search_documents_vector_index on search_documents using gin (vector)');
    await run(app, 'create index search_documents_filters_index on search_documents using gin (filters jsonb_path_ops)');
    expect(await check(app)).toEqual([]);

    // What a failed concurrent build leaves: the definition reads right, but no query uses the index.
    await run(app, "update pg_index set indisvalid = false where indexrelid = 'search_documents_vector_index'::regclass");
    expect(await check(app)).toEqual([otherVectorIndex]);

    // A tsvector index cannot stay on a text column.
    await run(app, 'drop index search_documents_vector_index');
    await run(app, 'alter table search_documents alter column vector drop default, alter column vector type text using vector::text');
    expect(await check(app)).toEqual([error(`The column search_documents.vector is no tsvector. ${RESTORE}`), noVectorIndex]);

    await run(app, 'alter table search_documents drop column vector');
    expect(await check(app)).toEqual([error(`The table search_documents has no column vector (tsvector). ${RESTORE}`), noVectorIndex]);
  });

  it('names a configuration of the language map that the database does not have', async () => {
    const app = await started('pgsql', [defineSearch({ languages: { eo: 'esperanto_missing' } })]);
    expect(await check(app)).toEqual([
      error(
        'The search languages map to the text search configuration esperanto_missing, which the database does not have. Create it in a migration, or map the language to another one in defineSearch({ languages }).',
      ),
    ]);
  });

  it('names the missing tables, and says once that the migration has not run when neither is there', async () => {
    const app = await started('pgsql');
    await run(app, 'drop table search_rebuilds');
    expect(await check(app)).toEqual([error('The default database has no table search_rebuilds, which SEARCH_DRIVER=database needs.', MIGRATE)]);
    await run(app, 'drop table search_documents');
    expect(await check(app)).toEqual([error('The default database has neither search_documents nor search_rebuilds: the migration of @marmeon/search has not run.', MIGRATE)]);
  });

  it('looks a table up through the search path, as the statements of the driver find it', async () => {
    const app = await started('pgsql');
    // A table of that name in a schema off the search path is not the one the driver reads.
    await run(app, 'create schema elsewhere');
    await run(app, 'alter table search_rebuilds set schema elsewhere');
    expect(await check(app)).toEqual([error('The default database has no table search_rebuilds, which SEARCH_DRIVER=database needs.', MIGRATE)]);
  });
});

describe('the meilisearch driver in marmeon check', () => {
  const KEY = 'local-test-key';
  const BASE = 'http://meili.internal:7700';
  const PAGES: IndexInfo = {
    name: 'pages',
    key: 'id',
    fields: [
      { name: 'body', weight: 'C' },
      { name: 'title', weight: 'A' },
    ],
    filters: ['tenant', 'kind'],
  };
  const logger = { warn: () => {} } as unknown as Logger;

  /** A Meilisearch 1.34.3 that has `pages` with the settings of its class and lists `uids`. */
  function meili(uids: readonly string[] = ['pages']): HttpClientFake {
    return new HttpClientFake()
      .dns('meili.internal', ['10.0.0.5'])
      .respond(
        `${BASE}/version`,
        Response.json({
          pkgVersion: '1.34.3',
          commitSha: 'x',
          commitDate: 'y',
        }),
      )
      .respond(`${BASE}/indexes/pages`, Response.json({ uid: 'pages', primaryKey: 'id' }))
      .respond(
        `${BASE}/indexes/pages/settings`,
        Response.json({
          ...meilisearchSettings(PAGES),
          rankingRules: ['words'],
          displayedAttributes: ['*'],
        }),
      )
      .respond(
        new RegExp(`^${BASE}/indexes\\?`),
        Response.json({
          results: uids.map((uid) => ({ uid })),
          offset: 0,
          limit: 100,
          total: uids.length,
        }),
      );
  }

  function inspect(http: HttpClientFake, targets?: RebuildTargets, indexes: readonly IndexInfo[] = [PAGES]) {
    const client = new MeilisearchClient({
      url: new URL(BASE),
      apiKey: KEY,
      http: () => http,
      fetch: () => fetchModule,
      lookup: async () => ['10.0.0.5'],
      sleep: async () => {},
    });
    return new MeilisearchDriver(client, logger, targets).inspect(indexes);
  }

  const noRebuilds: RebuildTargets = async () => new Map();
  const rebuild = 'marmeon search:rebuild pages';

  it('passes when the server is recent enough and each index has the settings of its class', async () => {
    const http = meili();
    expect(await inspect(http, noRebuilds)).toEqual([]);
    expect(http.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${BASE}/version`,
      `GET ${BASE}/indexes/pages`,
      `GET ${BASE}/indexes/pages/settings`,
      `GET ${BASE}/indexes?offset=0&limit=100`,
    ]);
  });

  it('names a server older than 1.34 and a version it cannot read, and takes 1.34.0 and a release candidate of a later one', async () => {
    const cases: [string, string | undefined][] = [
      ['1.33.9', 'Meilisearch at meili.internal:7700 runs version 1.33.9; the driver needs 1.34 or later. Upgrade Meilisearch.'],
      ['0.99.0', 'Meilisearch at meili.internal:7700 runs version 0.99.0; the driver needs 1.34 or later. Upgrade Meilisearch.'],
      ['next', 'Meilisearch at meili.internal:7700 answered GET /version without a version this driver can read.'],
      ['1.34.0', undefined],
      ['1.40.0-rc.1', undefined],
      ['2.0.0', undefined],
    ];
    for (const [version, message] of cases) {
      const found = await inspect(meili().respond(`${BASE}/version`, Response.json({ pkgVersion: version })), noRebuilds);
      expect(found).toEqual(message === undefined ? [] : [{ message }]);
    }
  });

  it('names an index the server does not have, with the rebuild that creates it, and asks nothing more of it', async () => {
    const http = meili([]).respond(`${BASE}/indexes/pages`, Response.json({ code: 'index_not_found' }, { status: 404 }));
    expect(await inspect(http, noRebuilds)).toEqual([
      {
        index: 'pages',
        message: 'Meilisearch at meili.internal:7700 has no index "pages" yet: a search of it fails, and so does every job that writes to it.',
        fix: rebuild,
      },
    ]);
    expect(http.requests.some((request) => request.url.endsWith('/settings'))).toBe(false);
  });

  it('names each setting that differs from the class: the order of the searchable attributes, the set of the filterable ones, and maxTotalHits', async () => {
    const settings = meilisearchSettings(PAGES) as {
      searchableAttributes: string[];
      filterableAttributes: string[];
    };
    const cases: [Record<string, unknown>, string | undefined][] = [
      [{ searchableAttributes: [...settings.searchableAttributes].reverse() }, 'searchable attributes'],
      [{ searchableAttributes: ['*'] }, 'searchable attributes'],
      [{ filterableAttributes: [...settings.filterableAttributes].reverse() }, undefined],
      [{ filterableAttributes: settings.filterableAttributes.slice(1) }, 'filterable attributes'],
      [{ filterableAttributes: [...settings.filterableAttributes, 'f_other'] }, 'filterable attributes'],
      [{ filterableAttributes: [...settings.filterableAttributes, 'locale'] }, 'filterable attributes'],
      // As many entries as declared, each a declared one, but one twice and another missing.
      [{ filterableAttributes: ['locale', 'locale', 'f_kind'] }, 'filterable attributes'],
      [
        {
          filterableAttributes: [{ attributePatterns: settings.filterableAttributes }],
        },
        'filterable attributes',
      ],
      [{ pagination: { maxTotalHits: 1000000 } }, 'maxTotalHits'],
      [
        {
          searchableAttributes: ['*'],
          filterableAttributes: [],
          pagination: { maxTotalHits: 1000000 },
        },
        'searchable attributes, filterable attributes, maxTotalHits',
      ],
    ];
    for (const [changed, differences] of cases) {
      const http = meili().respond(`${BASE}/indexes/pages/settings`, Response.json({ ...meilisearchSettings(PAGES), ...changed }));
      const found = await inspect(http, noRebuilds);
      expect(found).toEqual(
        differences === undefined
          ? []
          : [
              {
                index: 'pages',
                message: `The Meilisearch index "pages" has other ${differences} than its class declares.`,
                fix: rebuild,
              },
            ],
      );
    }
  });

  it('names a server it cannot ask by its host, never the key, and stops asking', async () => {
    for (const [status, extra] of [
      [503, ''],
      [401, ' Check SEARCH_MEILISEARCH_API_KEY and that it has the actions version, indexes.get and settings.get.'],
      [403, ' Check SEARCH_MEILISEARCH_API_KEY and that it has the actions version, indexes.get and settings.get.'],
    ] as const) {
      const http = meili().respond(`${BASE}/version`, Response.json({ code: 'internal' }, { status }));
      const found = await inspect(http, noRebuilds);
      expect(found).toEqual([
        {
          message: `Meilisearch at meili.internal:7700 could not be asked: Meilisearch answered ${status} (internal).${extra}`,
        },
      ]);
      expect(JSON.stringify(found)).not.toContain(KEY);
      expect(http.requests).toHaveLength(1);
    }
    const unreachable = await inspect(
      meili().respond(`${BASE}/indexes/pages/settings`, () => Promise.reject(new fetchModule.FetchError('network', 'connection refused'))),
      noRebuilds,
    );
    expect(unreachable).toEqual([
      {
        message: 'Meilisearch at meili.internal:7700 could not be asked: The request to Meilisearch failed.',
      },
    ]);
  });

  it('names a rebuild target that no running rebuild names, and leaves alone the target of a running one and indexes of other names', async () => {
    const uids = [
      'pages',
      'pages__rebuild_0123abcd',
      'pages__rebuild_89abcdef',
      'pages__rebuild_xyz',
      'pages__rebuild_0123abcd9',
      'pages__rebuild_0123abcdef',
      'pages__rebuild_0123ABCD',
      'other__rebuild_0123abcd',
      'xpages__rebuild_0123abcd',
    ];
    const underway: RebuildTargets = async () => new Map([['pages', 'pages__rebuild_89abcdef']]);
    expect(await inspect(meili(uids), underway)).toEqual([
      {
        index: 'pages',
        message:
          'The Meilisearch index "pages__rebuild_0123abcd" is the target of a rebuild that no row of search_rebuilds names any more. Delete it, in the Meilisearch dashboard or with DELETE /indexes/pages__rebuild_0123abcd.',
      },
    ]);
  });

  it('takes a declared index whose name looks like a rebuild target for an index of its own', async () => {
    const target: IndexInfo = { ...PAGES, name: 'pages__rebuild_0123abcd' };
    const http = meili(['pages', 'pages__rebuild_0123abcd'])
      .respond(`${BASE}/indexes/pages__rebuild_0123abcd`, Response.json({ uid: 'pages__rebuild_0123abcd' }))
      .respond(`${BASE}/indexes/pages__rebuild_0123abcd/settings`, Response.json(meilisearchSettings(target)));
    expect(await inspect(http, noRebuilds, [PAGES, target])).toEqual([]);
  });

  it('lets an error other than an answer of Meilisearch through, so the check is an error', async () => {
    const client = new MeilisearchClient({
      url: new URL(BASE),
      apiKey: KEY,
      http: () => {
        throw new RangeError('a bug');
      },
      fetch: () => fetchModule,
      lookup: async () => ['10.0.0.5'],
    });
    await expect(new MeilisearchDriver(client, logger, noRebuilds).inspect([PAGES])).rejects.toThrow(new RangeError('a bug'));
  });

  it('sends no request once the signal of the check is aborted, also in the middle of the check', async () => {
    const controller = new AbortController();
    // The check runs out of time while the first request is answered.
    const http = meili().respond(`${BASE}/version`, () => {
      controller.abort(new Error('the check ran out of time'));
      return Response.json({ pkgVersion: '1.34.3' });
    });
    const client = new MeilisearchClient({ url: new URL(BASE), apiKey: KEY, http: () => http, fetch: () => fetchModule, lookup: async () => ['10.0.0.5'] });
    await expect(new MeilisearchDriver(client, logger, noRebuilds).inspect([PAGES], { signal: controller.signal })).rejects.toThrow('the check ran out of time');
    expect(http.requests.map((request) => request.url)).toEqual([`${BASE}/version`]);
  });

  it('aborts a request in flight when the check runs out of time, and reports no finding for it', async () => {
    const controller = new AbortController();
    const http = meili().respond(`${BASE}/indexes/pages/settings`, () => {
      controller.abort(new Error('the check ran out of time'));
      return new Promise<Response>(() => {});
    });
    const client = new MeilisearchClient({ url: new URL(BASE), apiKey: KEY, http: () => http, fetch: () => fetchModule, lookup: async () => ['10.0.0.5'] });
    await expect(new MeilisearchDriver(client, logger, noRebuilds).inspect([PAGES], { signal: controller.signal })).rejects.toThrow('the check ran out of time');
    expect(http.requests).toHaveLength(3);
  });

  it('names a list of indexes it cannot read', async () => {
    const http = meili().respond(new RegExp(`^${BASE}/indexes\\?`), Response.json({ indexes: [] }));
    const unreadable = { message: 'Meilisearch at meili.internal:7700 answered GET /indexes with a body that is no list of indexes.' };
    expect(await inspect(http, noRebuilds)).toEqual([unreadable]);
    // The missing table is still named: without it no change reaches Meilisearch.
    expect(await inspect(http, async () => undefined)).toEqual([
      unreadable,
      { message: 'The default database has no table search_rebuilds, which the job marmeon.search.sync reads for every change.', fix: MIGRATE },
    ]);
  });

  it('reads every page of a long list of indexes, the last one past 10000 too', async () => {
    const total = 10_001;
    const http = meili().respond(new RegExp(`^${BASE}/indexes\\?`), (request) => {
      const offset = Number(new URL(request.url).searchParams.get('offset'));
      const uids = Array.from({ length: Math.min(100, total - offset) }, (_, i) => (offset + i === total - 1 ? 'pages__rebuild_0123abcd' : `x${offset + i}`));
      return Response.json({ results: uids.map((uid) => ({ uid })), offset, limit: 100, total });
    });
    const found = await inspect(http, noRebuilds);
    expect(found.map((problem) => problem.message)).toEqual([expect.stringContaining('"pages__rebuild_0123abcd" is the target of a rebuild that no row')]);
    expect(http.requests.filter((request) => request.url.includes('/indexes?'))).toHaveLength(101);
  });

  it('reports no rebuild target without a reader of search_rebuilds, since it cannot tell one from a live target', async () => {
    const http = meili(['pages', 'pages__rebuild_0123abcd']);
    expect(await inspect(http)).toEqual([]);
    expect(http.requests.some((request) => request.url.includes('/indexes?'))).toBe(false);
  });

  it('names the missing table search_rebuilds, and then every rebuild target as left over', async () => {
    expect(await inspect(meili(['pages', 'pages__rebuild_0123abcd']), async () => undefined)).toEqual([
      {
        message: 'The default database has no table search_rebuilds, which the job marmeon.search.sync reads for every change.',
        fix: MIGRATE,
      },
      {
        index: 'pages',
        message:
          'The Meilisearch index "pages__rebuild_0123abcd" is the target of a rebuild that no row of search_rebuilds names any more. Delete it, in the Meilisearch dashboard or with DELETE /indexes/pages__rebuild_0123abcd.',
      },
    ]);
  });

  it('reads every page of the index list', async () => {
    const uids = Array.from({ length: 150 }, (_, i) => `x${i}`);
    const http = meili()
      .respond(
        `${BASE}/indexes?offset=0&limit=100`,
        Response.json({
          results: uids.slice(0, 100).map((uid) => ({ uid })),
          offset: 0,
          limit: 100,
          total: 151,
        }),
      )
      .respond(
        `${BASE}/indexes?offset=100&limit=100`,
        Response.json({
          results: [...uids.slice(100), 'pages__rebuild_0123abcd'].map((uid) => ({ uid })),
          offset: 100,
          limit: 100,
          total: 151,
        }),
      );
    const found = await inspect(http, noRebuilds);
    expect(found.map((problem) => problem.message)).toEqual([expect.stringContaining('"pages__rebuild_0123abcd" is the target of a rebuild that no row')]);
    expect(http.requests.filter((request) => request.url.includes('/indexes?'))).toHaveLength(2);
  });

  it('reads search_rebuilds of the app database in an app, through the check', async () => {
    const base = 'http://10.0.0.5:7700';
    const http = new HttpClientFake()
      .respond(`${base}/version`, Response.json({ pkgVersion: '1.34.3' }))
      .respond(`${base}/indexes/pages`, Response.json({ uid: 'pages' }))
      .respond(
        `${base}/indexes/pages/settings`,
        Response.json(
          meilisearchSettings({
            name: 'pages',
            key: 'id',
            fields: [{ name: 'title', weight: 'A' }],
            filters: ['kind'],
          }),
        ),
      )
      .respond(
        new RegExp(`^${base}/indexes\\?`),
        Response.json({
          results: [{ uid: 'pages' }, { uid: 'pages__rebuild_0123abcd' }],
          offset: 0,
          limit: 100,
          total: 2,
        }),
      );
    const start = async (stub: boolean): Promise<Application> => {
      const app = await createApplication(
        {
          root: workspaceTempDir('marmeon-search-check-'),
          discover: false,
          providers: [DatabaseServiceProvider, QueueServiceProvider, FetchServiceProvider, SearchServiceProvider],
          modules: [
            defineModule({ name: 'pages', searchIndexes: [PageIndex] }),
            ...(stub
              ? [
                  defineModule({
                    name: 'system',
                    migrations: SearchServiceProvider.migrations.from,
                  }),
                ]
              : []),
          ],
        },
        {
          env: {
            LOG_LEVEL: 'silent',
            NODE_ENV: 'test',
            DB_MANAGED: 'true',
            DB_DRIVER: 'sqlite',
            DB_DATABASE: ':memory:',
            QUEUE_DRIVER: 'sync',
            QUEUE_FAILED_DRIVER: 'null',
            SEARCH_DRIVER: 'meilisearch',
            SEARCH_MEILISEARCH_URL: base,
            SEARCH_MEILISEARCH_API_KEY: KEY,
          },
          override: (container) => container.instance(HttpClient, http),
        },
      );
      running.push({ close: () => app.shutdown() });
      return app;
    };
    const leftover = error(
      'pages: The Meilisearch index "pages__rebuild_0123abcd" is the target of a rebuild that no row of search_rebuilds names any more. Delete it, in the Meilisearch dashboard or with DELETE /indexes/pages__rebuild_0123abcd.',
    );
    // Before marmeon publish: the app has no migration of the package, so no table.
    expect(await check(await start(false))).toEqual([
      error('The default database has no table search_rebuilds, which the job marmeon.search.sync reads for every change.', MIGRATE),
      leftover,
    ]);

    const app = await start(true);
    // Published, not migrated: the database refuses every query, so the check is an error that says to migrate.
    await expect(check(app)).rejects.toThrow(/^\[marmeon:D2\] /);
    await app.container.make(Migrator).migrate();
    expect(await check(app)).toEqual([leftover]);
    await run(
      app,
      "insert into search_rebuilds (index_name, run, phase, target, started_at) values ('pages', '0123abcd-0000-4000-8000-000000000000', 'copy', 'pages__rebuild_0123abcd', '2026-11-27 00:00:00')",
    );
    expect(await check(app)).toEqual([]);
    // A run creates its target before it records it: its row names the target through the run alone.
    await run(app, 'update search_rebuilds set target = null');
    expect(await check(app)).toEqual([]);
    await run(app, "update search_rebuilds set run = '89abcdef-0000-4000-8000-000000000000'");
    expect(await check(app)).toEqual([leftover]);
  });
});
