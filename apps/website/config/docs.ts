import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/** Where the pages come from and how often the search may be asked. */
export const DocsConfig = defineConfig('docs', {
  env: env({
    /** The repository whose `docs/*.md` and policies at the root are the pages — relative to the app root. */
    DOCS_SOURCE: env.string().default('../..'),
    /** The snapshots of the release lines, one folder per line — relative to the app root. Without it (and the pins), there are no lines. */
    DOCS_LINES: env.string().default('content/lines'),
    /** The file that pins each release line to the commit of its tag — relative to the app root. */
    DOCS_LINE_PINS: env.string().default('docs-lines.json'),
    /** Searches per minute and client (`throttle('docs.search')`) — typing sends one per pause. */
    DOCS_SEARCH_PER_MINUTE: env.integer().min(1).default(120),
    NODE_ENV: env.string().default('production'),
  }),
  resolve: (e) => ({
    source: e.DOCS_SOURCE,
    lines: e.DOCS_LINES,
    linePins: e.DOCS_LINE_PINS,
    searchPerMinute: e.DOCS_SEARCH_PER_MINUTE,
    /** Re-read the pages when one changes. */
    development: e.NODE_ENV === 'development',
  }),
});
export type DocsConfig = ConfigOf<typeof DocsConfig>;
