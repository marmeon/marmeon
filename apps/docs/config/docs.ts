import { defineConfig, type ConfigOf } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';

/** Where the READMEs come from and how long browsers and caches may keep a page. */
export const DocsConfig = defineConfig('docs', {
  env: r.env({
    /** The repository whose `README.md` and `packages/*\/README.md` are the pages — relative to the app root. */
    DOCS_SOURCE: r.string().default('../..'),
    /**
     * `Cache-Control: public, max-age=…` of a page in seconds (the content changes only with a deploy; an `ETag` lets a
     * browser ask again cheaply after that). In development pages are `no-cache`: an edited README shows on the next visit.
     */
    DOCS_CACHE_MAX_AGE: r.integer().min(0).default(300),
    /** Searches per minute and client (`throttle('docs.search')`) — typing sends one per pause. */
    DOCS_SEARCH_PER_MINUTE: r.integer().min(1).default(120),
    NODE_ENV: r.string().default('production'),
  }),
  resolve: (env) => ({
    source: env.DOCS_SOURCE,
    cacheMaxAge: env.DOCS_CACHE_MAX_AGE,
    searchPerMinute: env.DOCS_SEARCH_PER_MINUTE,
    /** Re-read the READMEs when one changes, and no long caching. */
    development: env.NODE_ENV === 'development',
  }),
});
export type DocsConfig = ConfigOf<typeof DocsConfig>;
