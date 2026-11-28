import { defineModule, type ApplicationDefinition, type Container, type ServiceProviderClass } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, sql, type Connection, type Database } from '@marmeon/database';
import { Search, SearchDriver, SearchIndex, SearchServiceProvider, type SearchDocument } from '@marmeon/search';
import { SearchFake } from '@marmeon/search/testing';
import { describe, expect, it } from 'vitest';
import { tempDir, workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { importSearch } from './import-search.ts';
import { createTestApp } from './index.ts';

interface NoteRow {
  id: number;
  title: string;
  pinned: number | boolean;
}

class NoteIndex extends SearchIndex<NoteRow> {
  static readonly index = 'notes';
  static readonly key = 'id';
  static readonly fields = { title: 'highest' } as const;

  source(db: Database) {
    return (db as unknown as Connection<{ notes: NoteRow }>).selectFrom('notes').select(['id', 'title', 'pinned']);
  }

  toDocument(row: NoteRow): SearchDocument<typeof NoteIndex> {
    return { fields: { title: row.title } };
  }
}

/** A driver a provider brings, standing in for a configured driver the test may keep: it searches nothing and records nothing. */
const configured: SearchDriver = {
  writes: 'after-commit',
  upsert: async () => undefined,
  delete: async () => undefined,
  query: async () => ({ ok: true, value: { hits: [], total: 0 } }),
  flush: async () => undefined,
};

const ConfiguredDriverProvider: ServiceProviderClass = class ConfiguredDriverProvider {
  static searchDrivers = { configured: () => configured };
};

const definition: ApplicationDefinition = {
  root: tempDir('marmeon-testing-search-'),
  discover: false,
  providers: [DatabaseServiceProvider, SearchServiceProvider, ConfiguredDriverProvider],
  modules: [defineModule({ name: 'search-fake', searchIndexes: [NoteIndex] })],
};

const env = { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:' };
const databaseMessage = "app.search has no fake: with SEARCH_DRIVER=database the test searches its own database with the real driver. For the fake: createTestApp(…, { search: 'fake' }).";
const realMessage = "app.search has no fake: the test chose createTestApp(…, { search: 'real' }), so the configured search driver is used.";
const overrideMessage = "app.search has no fake: the test's override binds a SearchDriver of its own.";
const providerMessage = 'app.search needs the provider of @marmeon/search, which the app does not register: run marmeon discover, or add SearchServiceProvider to its providers.';

/** Keeps the database driver out of a test that only asks which driver the test app chose: `override` runs after the choice. */
const standIn = (container: Container) => container.instance(SearchDriver, configured);

/** A stand-in that first reads what createTestApp bound: the fake, or the provider's binding of the selected driver. */
function standInAfter(seen: { binding?: unknown }) {
  return (container: Container) => {
    try {
      seen.binding = container.make(SearchDriver);
    } catch (error) {
      // The database driver of this version refuses to be built; what counts is that no fake was bound.
      seen.binding = error;
    }
    standIn(container);
  };
}

describe('app.search', () => {
  it('is the search driver of the container by default when the app selects a driver other than database', async () => {
    await using app = await createTestApp(definition, { env: { ...env, SEARCH_DRIVER: 'configured' } });
    expect(app.search).toBeInstanceOf(SearchFake);
    expect(app.make(SearchDriver)).toBe(app.search);
  });

  it.each([
    ['SEARCH_DRIVER=database', { SEARCH_DRIVER: 'database' }],
    ['no SEARCH_DRIVER, whose default is database', { SEARCH_DRIVER: undefined }],
  ])('is not in place by default with %s: the real driver stays and app.search says why', async (_name, driver) => {
    const seen: { binding?: unknown } = {};
    await using app = await createTestApp(definition, { env: { ...env, ...driver }, override: standInAfter(seen) });
    expect(seen).toHaveProperty('binding');
    expect(seen.binding).not.toBeInstanceOf(SearchFake);
    expect(() => app.search).toThrow(new Error(databaseMessage));
  });

  it("is in place with search: 'fake', also on the database driver", async () => {
    await using app = await createTestApp(definition, { env: { ...env, SEARCH_DRIVER: 'database' }, search: 'fake' });
    expect(app.search).toBeInstanceOf(SearchFake);
    expect(app.make(SearchDriver)).toBe(app.search);
  });

  it("is not in place with search: 'real': the configured driver stays", async () => {
    await using app = await createTestApp(definition, { env: { ...env, SEARCH_DRIVER: 'configured' }, search: 'real' });
    expect(app.make(SearchDriver)).toBe(configured);
    expect(() => app.search).toThrow(new Error(realMessage));
  });

  it("is not in place when the test's override binds a driver of its own", async () => {
    await using app = await createTestApp(definition, { env: { ...env, SEARCH_DRIVER: 'configured' }, override: standIn });
    expect(app.make(SearchDriver)).toBe(configured);
    expect(() => app.search).toThrow(new Error(overrideMessage));
  });

  it('refuses an option that is neither fake nor real', async () => {
    // @ts-expect-error — the option takes only 'fake' or 'real'; a JS caller reaches the check below.
    await expect(createTestApp(definition, { env, search: 'memory' })).rejects.toThrow(new Error(`createTestApp(…, { search }) takes 'fake' or 'real', not "memory".`));
  });

  it('still stops the start for a SEARCH_DRIVER nobody brought, with the fake in place', async () => {
    await expect(createTestApp(definition, { env: { ...env, SEARCH_DRIVER: 'nobody' } })).rejects.toThrow('SEARCH_DRIVER=nobody is not a search driver.');
  });

  it('is absent from an app without the provider, which still starts', async () => {
    await using app = await createTestApp({ root: tempDir('marmeon-testing-search-none-'), discover: false, modules: [defineModule({ name: 'no-search' })] });
    expect(app.container.has(SearchDriver)).toBe(false);
    expect(() => app.search).toThrow(new Error(providerMessage));
  });
});

describe('app.search with the database of a test', () => {
  const refreshDefinition: ApplicationDefinition = {
    root: workspaceTempDir('marmeon-testing-search-db-'),
    discover: false,
    providers: [DatabaseServiceProvider, SearchServiceProvider],
    modules: [defineModule({ name: 'search-refresh', migrations: new URL('./__fixtures__/migrations/', import.meta.url), searchIndexes: [NoteIndex] })],
  };
  const refreshEnv = { DB_DRIVER: 'sqlite', DB_URL: undefined, DB_DATABASE: ':memory:' };

  it('records what Search indexes in the transaction of the test, and nothing of a transaction that rolls back', async () => {
    await using app = await createTestApp(refreshDefinition, { env: refreshEnv, database: 'refresh', search: 'fake' });
    const connections = app.make(Connections);
    const search = app.make(Search);
    await sql`insert into notes (id, title) values (1, 'Whale songs'), (2, 'Garden plans')`.execute(connections.get());

    await search.index(NoteIndex, 1);
    app.search.assertIndexed(NoteIndex, 1);
    await connections
      .transaction(async () => {
        await search.index(NoteIndex, 2);
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(app.search.documents(NoteIndex).map((document) => document.key)).toEqual([1]);

    const result = await search.query({ in: NoteIndex, term: 'whale' });
    expect(result.ok && result.value.data).toEqual([{ index: 'notes', key: 1, score: 4 }]);
  });
});

describe('importSearch', () => {
  const notFound = (message: string): Error => Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' });

  it('loads both entries of the package', async () => {
    const modules = await importSearch();
    expect(modules?.SearchDriver).toBe(SearchDriver);
    expect(modules?.SearchFake).toBe(SearchFake);
  });

  // Relies on @marmeon/search being resolvable in this workspace (importOptional's resolve check).
  it.each([
    ["Cannot find package '@marmeon/search' imported from /app/node_modules/@marmeon/testing/dist/test-app.js"],
    ['the code does not parse'],
  ])('throws the error when the package is installed: %s', async (message) => {
    const error = message.startsWith('Cannot') ? notFound(message) : new SyntaxError(message);
    await expect(importSearch(() => Promise.reject(error))).rejects.toBe(error);
  });
});
