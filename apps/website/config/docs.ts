import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** Where the pages come from and how often the search may be asked. */
export const DocsConfig = defineConfig('docs', {
  env: env({
    /** The repository whose `docs/*.md` and policies at the root are the pages — relative to the app root. */
    DOCS_SOURCE: env.string().default('../..'),
    /** Searches per minute and client (`throttle('docs.search')`) — typing sends one per pause. */
    DOCS_SEARCH_PER_MINUTE: env.integer().min(1).default(120),
    NODE_ENV: env.string().default('production'),
  }),
  resolve: (e) => ({
    source: e.DOCS_SOURCE,
    searchPerMinute: e.DOCS_SEARCH_PER_MINUTE,
    /** Re-read the pages when one changes. */
    development: e.NODE_ENV === 'development',
  }),
});
export type DocsConfig = ConfigOf<typeof DocsConfig>;
