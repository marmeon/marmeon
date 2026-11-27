import { createApplication, type Application, type ServiceProviderClass } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { JobRegistry, QueueServiceProvider } from '@marmeon/queue';
import { describe, expect, it } from 'vitest';
import { SearchDriver, type SearchDriverContext, type SearchDriverFactory } from './driver.ts';
import { SearchSetupError } from './errors.ts';
import { importQueue, SearchServiceProvider } from './provider.ts';
import { MemoryDriver } from './test-helpers/memory-driver.ts';

// The driver record: SEARCH_DRIVER selects a built-in driver or one a provider brings, and every wrong name — unknown, malformed,
// built-in, twice — stops the start with Q9.

const plugin = (name: string, searchDrivers: Record<string, SearchDriverFactory>): ServiceProviderClass =>
  ({ [name]: class { static searchDrivers = searchDrivers; } })[name]!;

const typesense: SearchDriverFactory = () => new MemoryDriver('after-commit');

function boot(env: Record<string, string> = {}, providers: ServiceProviderClass[] = []): Promise<Application> {
  return createApplication(
    { root: import.meta.dirname, discover: false, providers: [SearchServiceProvider, ...providers] },
    { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', ...env } },
  );
}

const rejection = async (promise: Promise<unknown>): Promise<Error> => (await promise.then(() => undefined, (error: unknown) => error)) as Error;

describe('SearchServiceProvider: the driver record', () => {
  it('starts on a driver a provider brings', async () => {
    await expect(boot({ SEARCH_DRIVER: 'typesense' }, [plugin('TypesenseProvider', { typesense })])).resolves.toBeDefined();
  });

  it('stops on the built-in drivers, which this version does not build yet', async () => {
    const database = await rejection(boot());
    expect(database).toBeInstanceOf(SearchSetupError);
    expect(database.message).toBe('[marmeon:Q9] SEARCH_DRIVER=database is not built in this version of @marmeon/search. Select a driver a provider brings.');
    const meilisearch = await rejection(boot({ SEARCH_DRIVER: 'meilisearch' }));
    expect(meilisearch.message).toBe('[marmeon:Q9] SEARCH_DRIVER=meilisearch is not built in this version of @marmeon/search. Select a driver a provider brings.');
  });

  it('stops for a name nobody brought and lists the known names, those of providers too', async () => {
    const error = await rejection(boot({ SEARCH_DRIVER: 'elastic' }, [plugin('TypesenseProvider', { typesense })]));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe('[marmeon:Q9] SEARCH_DRIVER=elastic is not a search driver. Known: database, meilisearch, typesense.');
  });

  it('stops for a provider that brings a driver named like a built-in one', async () => {
    const error = await rejection(boot({ SEARCH_DRIVER: 'typesense' }, [plugin('ShadowProvider', { database: typesense }), plugin('TypesenseProvider', { typesense })]));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe(
      '[marmeon:Q9] ShadowProvider brings a search driver named "database", but that name belongs to the built-in one. Built-in names: database, meilisearch. Choose another name.',
    );
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('stops for a malformed driver name, even when SEARCH_DRIVER does not select it', async () => {
    const error = await rejection(boot({ SEARCH_DRIVER: 'typesense' }, [plugin('LoudProvider', { Typesense: typesense }), plugin('TypesenseProvider', { typesense })]));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe('[marmeon:Q9] LoudProvider brings a search driver named "Typesense", but a name is lowercase letters, digits and dashes, starting with a letter.');
  });

  it('stops for a driver that is no factory', async () => {
    const error = await rejection(boot({ SEARCH_DRIVER: 'other' }, [plugin('ValueProvider', { typesense: 42 as unknown as SearchDriverFactory }), plugin('OtherProvider', { other: typesense })]));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe('[marmeon:Q9] ValueProvider.searchDrivers.typesense must be a function that creates the search driver.');
  });

  it('finds a driver of a provider listed before the search provider', async () => {
    const app = createApplication(
      { root: import.meta.dirname, discover: false, providers: [plugin('TypesenseProvider', { typesense }), SearchServiceProvider] },
      { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', SEARCH_DRIVER: 'typesense' } },
    );
    await expect(app).resolves.toBeDefined();
  });

  it('stops when two providers bring the same name', async () => {
    const error = await rejection(boot({ SEARCH_DRIVER: 'typesense' }, [plugin('FirstProvider', { typesense }), plugin('SecondProvider', { typesense })]));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe('[marmeon:Q9] The search driver "typesense" is brought by both FirstProvider and SecondProvider — one name, one driver. Rename one of them.');
  });

  it('refuses a SEARCH_DRIVER that is no driver name in the configuration', async () => {
    await expect(boot({ SEARCH_DRIVER: 'Data Base' })).rejects.toThrow(/SEARCH_DRIVER.*must be a driver name/s);
  });
});

describe('SearchServiceProvider: the driver contract', () => {
  const selected = (factory: SearchDriverFactory, providers: ServiceProviderClass[] = [], env: Record<string, string> = {}) =>
    boot({ SEARCH_DRIVER: 'custom', ...env }, [plugin('CustomProvider', { custom: factory }), ...providers]);

  it('builds the selected driver at the start with its name, the container and a logger', async () => {
    const contexts: SearchDriverContext[] = [];
    const driver = new MemoryDriver('after-commit');
    const app = await selected((context) => {
      contexts.push(context);
      return driver;
    });
    expect(contexts.map((context) => context.name)).toEqual(['custom']);
    expect(typeof contexts[0]!.logger.info).toBe('function');
    expect(app.container.make(SearchDriver)).toBe(driver);
  });

  it('stops for a driver that is no object, declares no write mode or lacks a required method', async () => {
    const complete = { writes: 'after-commit', upsert() {}, delete() {}, query() {}, flush() {} };
    const cases: [unknown, string][] = [
      [undefined, 'The search driver "custom" must return a SearchDriver object, got undefined.'],
      [null, 'The search driver "custom" must return a SearchDriver object, got null.'],
      [{ ...complete, writes: 'later' }, `The search driver "custom" must declare writes as 'transaction', 'queue' or 'after-commit'.`],
      ...['upsert', 'delete', 'query', 'flush'].map((member): [unknown, string] => [
        { ...complete, [member]: undefined },
        `The search driver "custom" has no ${member}() method: a SearchDriver has upsert(), delete(), query() and flush().`,
      ]),
      ...['boot', 'prepare', 'swap', 'inspect', 'close'].map((member): [unknown, string] => [
        { ...complete, [member]: true },
        `The search driver "custom" has a ${member} that is no method: define ${member}() as a method, or leave it out.`,
      ]),
    ];
    for (const [driver, message] of cases) {
      const error = await rejection(selected(() => driver as SearchDriver));
      expect(error).toBeInstanceOf(SearchSetupError);
      expect(error.message).toBe(`[marmeon:Q9] ${message}`);
    }
  });

  it('stops for a driver that writes through the queue when the app has no queue', async () => {
    const error = await rejection(selected(() => new MemoryDriver('queue')));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toMatch(/^\[marmeon:Q9\] The search driver "custom" writes through the queue, which needs @marmeon\/queue/);
  });

  it('starts a queue driver with the queue, and registers marmeon.search.sync as a framework job', async () => {
    const app = await selected(() => new MemoryDriver('queue'), [DatabaseServiceProvider, QueueServiceProvider], { DB_MANAGED: 'false', DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', QUEUE_DRIVER: 'sync', QUEUE_FAILED_DRIVER: 'null' });
    try {
      expect(app.container.make(JobRegistry).get('marmeon.search.sync')?.job).toBe('marmeon.search.sync');
    } finally {
      await app.shutdown();
    }
  });

  it('runs boot() of the driver once at the start, and close() once at the shutdown', async () => {
    const seen: string[] = [];
    const driver = Object.assign(new MemoryDriver('after-commit'), {
      async boot(app: Application) {
        seen.push(`boot:${app === undefined ? 'none' : 'app'}`);
      },
      async close() {
        seen.push('close');
      },
    });
    const app = await selected(() => driver);
    expect(seen).toEqual(['boot:app']);
    await app.shutdown();
    expect(seen).toEqual(['boot:app', 'close']);
  });

  it('lets a failing boot() of the driver stop the start', async () => {
    const driver = Object.assign(new MemoryDriver('after-commit'), {
      async boot() {
        throw new SearchSetupError('[marmeon:Q9] the service is not set up');
      },
    });
    await expect(selected(() => driver)).rejects.toThrow('[marmeon:Q9] the service is not set up');
  });
});

describe('importQueue', () => {
  const error = (message: string, code?: string) => Object.assign(new Error(message), code === undefined ? {} : { code });

  it('is undefined only when @marmeon/queue itself is not installed', async () => {
    expect(await importQueue(() => Promise.reject(error("Cannot find package '@marmeon/queue' imported from x", 'ERR_MODULE_NOT_FOUND')))).toBeUndefined();
    expect(await importQueue(() => Promise.reject(error("Cannot find module '@marmeon/queue' imported from x", 'ERR_MODULE_NOT_FOUND')))).toBeUndefined();
  });

  it('rethrows any other import error, also another missing package that the importer path of the queue names', async () => {
    await expect(importQueue(() => Promise.reject(error('boom while loading')))).rejects.toThrow('boom while loading');
    await expect(importQueue(() => Promise.reject(error('mentions @marmeon/queue but has no code')))).rejects.toThrow('has no code');
    await expect(
      importQueue(() => Promise.reject(error("Cannot find package 'missing-dependency' imported from /app/node_modules/@marmeon/queue/dist/index.js", 'ERR_MODULE_NOT_FOUND'))),
    ).rejects.toThrow('missing-dependency');
  });
});
