import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** Where the pages come from and how long browsers and caches may keep a page. */
export const DocsConfig = defineConfig('docs', {
  env: env({
    /** The repository whose `docs/*.md` and policies at the root are the pages — relative to the app root. */
    DOCS_SOURCE: env.string().default('../..'),
    /**
     * `Cache-Control: public, max-age=…` of a page in seconds (the content changes only with a deploy; an `ETag` lets a
     * browser ask again cheaply after that). In development pages are `no-cache`: an edited page shows on the next visit.
     */
    DOCS_CACHE_MAX_AGE: env.integer().min(0).default(300),
    /** Searches per minute and client (`throttle('docs.search')`) — typing sends one per pause. */
    DOCS_SEARCH_PER_MINUTE: env.integer().min(1).default(120),
    NODE_ENV: env.string().default('production'),
  }),
  resolve: (e) => ({
    source: e.DOCS_SOURCE,
    cacheMaxAge: e.DOCS_CACHE_MAX_AGE,
    searchPerMinute: e.DOCS_SEARCH_PER_MINUTE,
    /** Re-read the pages when one changes, and no long caching. */
    development: e.NODE_ENV === 'development',
  }),
});
export type DocsConfig = ConfigOf<typeof DocsConfig>;
