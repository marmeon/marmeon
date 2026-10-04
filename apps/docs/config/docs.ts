import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

/** Where the READMEs come from and how long browsers and caches may keep a page. */
export const DocsConfig = defineConfig('docs', {
  env: v.object({
    /** The repository whose `README.md` and `packages/*\/README.md` are the pages — relative to the app root. */
    DOCS_SOURCE: v.optional(v.string(), '../..'),
    /**
     * `Cache-Control: public, max-age=…` of a page in seconds (the content changes only with a deploy; an `ETag` lets a
     * browser ask again cheaply after that). In development pages are `no-cache`: an edited README shows on the next visit.
     */
    DOCS_CACHE_MAX_AGE: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0)), '300'),
    /** Searches per minute and client (`throttle('docs.search')`) — typing sends one per pause. */
    DOCS_SEARCH_PER_MINUTE: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)), '120'),
    NODE_ENV: v.optional(v.string(), 'production'),
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
