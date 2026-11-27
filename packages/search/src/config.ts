import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** The drivers the package ships; a provider can bring more (`static searchDrivers`). */
export const BUILT_IN_SEARCH_DRIVERS = ['database', 'meilisearch'] as const;

/** The environment of search; see `docs/full-text-search.md#configuration`. */
export const SearchConfig = defineConfig('search', {
  env: env({
    /**
     * `database` (default: the index lives in a table of the app's database, no other service), `meilisearch` (a Meilisearch server,
     * through @marmeon/fetch and @marmeon/queue) or a driver a provider brings. A name nobody brought stops the start.
     */
    SEARCH_DRIVER: env.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a driver name: lowercase letters, digits and dashes, starting with a letter').default('database'),
    /** The address of the Meilisearch server, such as `http://127.0.0.1:7700`. Read when `SEARCH_DRIVER=meilisearch`. */
    SEARCH_MEILISEARCH_URL: env.string().default(''),
    /** The Meilisearch API key, read when `SEARCH_DRIVER=meilisearch`. The name contains `API_KEY`, so the log redactor masks it. */
    SEARCH_MEILISEARCH_API_KEY: env.string().default(''),
  }),
  resolve: (e) => ({
    driver: e.SEARCH_DRIVER,
    meilisearch: { url: e.SEARCH_MEILISEARCH_URL, apiKey: e.SEARCH_MEILISEARCH_API_KEY },
  }),
});
export type SearchConfig = ConfigOf<typeof SearchConfig>;
