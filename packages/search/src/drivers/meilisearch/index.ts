import type { Application } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { withCode } from '@marmeon/core/internal';
import { SearchConfig } from '../../config.ts';
import type { SearchDriver, SearchDriverContext, SearchDriverFactory } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';
import { importFetch, MeilisearchClient, meilisearchApiKey, meilisearchUrl, type FetchModule, type Lookup, type Now, type Sleep } from './client.ts';
import { rebuildTargets } from '../../rebuild.ts';
import { MeilisearchDriver } from './driver.ts';

function setup(message: string): SearchSetupError {
  return new SearchSetupError(withCode('Q9', message));
}

/**
 * Builds the `meilisearch` driver: checks `SEARCH_MEILISEARCH_URL` and `SEARCH_MEILISEARCH_API_KEY` when it is built, and at its boot
 * that @marmeon/fetch is installed and its `HttpClient` registered. `lookup`, `sleep` and `now` replace DNS, the wait between task polls and the clock
 * in the package's own tests.
 * @internal
 */
export function createMeilisearchDriver(context: SearchDriverContext, options: { readonly lookup?: Lookup; readonly sleep?: Sleep; readonly now?: Now } = {}): SearchDriver {
  const config = context.container.make(SearchConfig);
  const url = meilisearchUrl(config.meilisearch.url);
  const apiKey = meilisearchApiKey(config.meilisearch.apiKey);
  let module: FetchModule | undefined;
  const loaded = (): FetchModule => {
    // boot() loads @marmeon/fetch or stops the start; unset means something searched before the app started.
    if (module === undefined) throw setup('The meilisearch search driver was used before the application started, so @marmeon/fetch is not loaded yet.');
    return module;
  };
  const client = new MeilisearchClient({ url, apiKey, http: () => context.container.make(loaded().HttpClient), fetch: loaded, lookup: options.lookup, sleep: options.sleep, now: options.now });
  const driver = new MeilisearchDriver(client, context.logger, () => rebuildTargets(context.container.make(Connections)));
  return Object.assign(driver, {
    async boot(app: Application): Promise<void> {
      const found = await importFetch();
      if (found === undefined) {
        throw setup('SEARCH_DRIVER=meilisearch talks to Meilisearch through @marmeon/fetch (marmeon add fetch; if it is installed already: marmeon discover; if the app does not boot yet: pnpm add -E @marmeon/fetch@<version of your app>).');
      }
      if (!app.container.has(found.HttpClient)) {
        throw setup("SEARCH_DRIVER=meilisearch talks to Meilisearch through the HttpClient of @marmeon/fetch, which this app does not register. Run marmeon discover (or add FetchServiceProvider to the app's providers).");
      }
      module = found;
    },
  });
}

/** The `meilisearch` driver: each index lives on the Meilisearch server of `SEARCH_MEILISEARCH_URL`. */
export const meilisearchDriver: SearchDriverFactory = (context) => createMeilisearchDriver(context);
