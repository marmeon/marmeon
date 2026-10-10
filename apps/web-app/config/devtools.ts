import { defineDevtools } from '@marmeon/devtools';

/**
 * The devtools: they record what the app does — requests, queries, jobs, mails, … — redacted, into
 * `storage/framework/devtools/`, and only with `NODE_ENV=development` (`marmeon dev` sets it; its worker and scheduler
 * write there too). @marmeon/devtools is a dev dependency, and this file is loaded by it alone: never in production.
 * The defaults record everything; left out here are the live stream (a request that stays open as long as the tab) and
 * SQLite's own `pragma` statements.
 */
export default defineDevtools({
  ignore: {
    paths: ['/_marmeon/live'],
    queries: (query) => query.sql.startsWith('pragma'),
  },
  slowQueryMs: 100,
});
