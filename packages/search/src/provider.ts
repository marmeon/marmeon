import { Application, type Resolver, type ServiceProvider } from '@marmeon/core';
import { collectDrivers, withCode } from '@marmeon/core/internal';
import { BUILT_IN_SEARCH_DRIVERS, SearchConfig } from './config.ts';
import type { SearchDriverFactory } from './driver.ts';
import { SearchSetupError } from './errors.ts';

declare module '@marmeon/core' {
  interface ServiceProviderClass {
    /**
     * Search drivers this provider brings, by name — `SEARCH_DRIVER=<name>` selects one. A built-in name (`database`, `meilisearch`), a
     * malformed name or a name another provider brings stops the start (Q9). See `docs/full-text-search.md#writing-a-driver`.
     */
    readonly searchDrivers?: Readonly<Record<string, SearchDriverFactory>>;
  }
}

function setup(message: string, options?: { cause?: unknown }): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message), options);
}

/**
 * Registers search: `SEARCH_DRIVER` selects the driver, and a name nobody brought stops the start. Found by `marmeon discover`.
 * See `docs/full-text-search.md#configuration`.
 */
export class SearchServiceProvider implements ServiceProvider {
  static config = [SearchConfig];

  /** The drivers other providers bring; a malformed name, a built-in name or a name twice stops the start. */
  #factories(container: Resolver): ReadonlyMap<string, SearchDriverFactory> {
    try {
      return collectDrivers<SearchDriverFactory>(container.make(Application).providers, 'searchDrivers', BUILT_IN_SEARCH_DRIVERS, 'search driver');
    } catch (error) {
      // collectDrivers refuses a broken record with a TypeError; Q9 is the one code of every search setup error.
      if (error instanceof TypeError) throw setup(error.message, { cause: error });
      throw error;
    }
  }

  async boot(app: Application): Promise<void> {
    const config = app.container.make(SearchConfig);
    const custom = this.#factories(app.container);
    if (!(BUILT_IN_SEARCH_DRIVERS as readonly string[]).includes(config.driver) && !custom.has(config.driver)) {
      throw setup(`SEARCH_DRIVER=${config.driver} is not a search driver. Known: ${[...BUILT_IN_SEARCH_DRIVERS, ...custom.keys()].join(', ')}.`);
    }
  }
}
