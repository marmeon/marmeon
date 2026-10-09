import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

/**
 * The SSR lab: pages that show how server rendering behaves when it is slow or fails (`/lab/…`). On with `NODE_ENV=development`
 * only (E164) — off in production, staging, without `NODE_ENV` and in tests, unless `LAB_PAGES=true` (the lab's own tests; to
 * measure the production build).
 */
export const LabConfig = defineConfig('lab', {
  env: env({
    NODE_ENV: env.string().optional(),
    LAB_PAGES: env.in(['true', 'false']).optional(),
    /** How long the slow Suspense boundary of `/lab/streaming` takes on the server, in milliseconds. */
    LAB_DELAY: env.integer().min(0).max(10_000).default(1000),
  }),
  resolve: (e) => ({
    enabled: e.LAB_PAGES === undefined ? environment.isDevelopment(e) : e.LAB_PAGES === 'true',
    delay: e.LAB_DELAY,
  }),
});
export type LabConfig = ConfigOf<typeof LabConfig>;
