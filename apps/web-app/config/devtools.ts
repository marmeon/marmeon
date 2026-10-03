import { defineDevtools } from '@bespokecore/devtools';

/**
 * The devtools (W7, E115): they record what the app does — requests, queries, jobs, mails, … — redacted, into
 * `storage/framework/devtools/` (E116), and only with `NODE_ENV=development` (`bespoke dev` sets it; its worker and scheduler
 * write there too). @bespokecore/devtools is a dev dependency, and this file is loaded by it alone: never in production.
 * The defaults record everything; left out here are the live stream (a request that stays open as long as the tab) and
 * SQLite's own `pragma` statements.
 */
export default defineDevtools({
  ignore: {
    paths: ['/_bespoke/live'],
    queries: (query) => query.sql.startsWith('pragma'),
  },
  slowQueryMs: 100,
});
