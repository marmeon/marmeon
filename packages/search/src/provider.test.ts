import { createApplication, type Application, type ServiceProviderClass } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import type { SearchDriverFactory } from './driver.ts';
import { SearchSetupError } from './errors.ts';
import { SearchServiceProvider } from './provider.ts';

// The driver record: SEARCH_DRIVER selects a built-in driver or one a provider brings, and every wrong name — unknown, malformed,
// built-in, twice — stops the start with Q9.

const plugin = (name: string, searchDrivers: Record<string, SearchDriverFactory>): ServiceProviderClass =>
  ({ [name]: class { static searchDrivers = searchDrivers; } })[name]!;

const typesense: SearchDriverFactory = () => ({});

function boot(env: Record<string, string> = {}, providers: ServiceProviderClass[] = []): Promise<Application> {
  return createApplication(
    { root: import.meta.dirname, discover: false, providers: [SearchServiceProvider, ...providers] },
    { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', ...env } },
  );
}

const rejection = async (promise: Promise<unknown>): Promise<Error> => (await promise.then(() => undefined, (error: unknown) => error)) as Error;

describe('SearchServiceProvider: the driver record', () => {
  it('starts on database by default, and on a driver a provider brings', async () => {
    await expect(boot()).resolves.toBeDefined();
    await expect(boot({ SEARCH_DRIVER: 'typesense' }, [plugin('TypesenseProvider', { typesense })])).resolves.toBeDefined();
  });

  it('stops for a name nobody brought and lists the known names, those of providers too', async () => {
    const error = await rejection(boot({ SEARCH_DRIVER: 'elastic' }, [plugin('TypesenseProvider', { typesense })]));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe('[marmeon:Q9] SEARCH_DRIVER=elastic is not a search driver. Known: database, meilisearch, typesense.');
  });

  it('stops for a provider that brings a driver named like a built-in one', async () => {
    const error = await rejection(boot({}, [plugin('ShadowProvider', { database: typesense })]));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe(
      '[marmeon:Q9] ShadowProvider brings a search driver named "database", but that name belongs to the built-in one. Built-in names: database, meilisearch. Choose another name.',
    );
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('stops for a malformed driver name, even when SEARCH_DRIVER does not select it', async () => {
    const error = await rejection(boot({}, [plugin('LoudProvider', { Typesense: typesense })]));
    expect(error).toBeInstanceOf(SearchSetupError);
    expect(error.message).toBe('[marmeon:Q9] LoudProvider brings a search driver named "Typesense", but a name is lowercase letters, digits and dashes, starting with a letter.');
  });

  it('stops for a driver that is no factory', async () => {
    const error = await rejection(boot({}, [plugin('ValueProvider', { typesense: 42 as unknown as SearchDriverFactory })]));
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
