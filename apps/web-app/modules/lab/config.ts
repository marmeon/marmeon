import { defineConfig, environment, type ConfigOf } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';

/**
 * The SSR lab: pages that show how server rendering behaves when it is slow or fails (`/lab/…`). On with `NODE_ENV=development`
 * only (E164) — off in production, staging, without `NODE_ENV` and in tests, unless `LAB_PAGES=true` (the lab's own tests; to
 * measure the production build).
 */
export const LabConfig = defineConfig('lab', {
  env: r.env({
    NODE_ENV: r.string().optional(),
    LAB_PAGES: r.in(['true', 'false']).optional(),
    /** How long the slow Suspense boundary of `/lab/streaming` takes on the server, in milliseconds. */
    LAB_DELAY: r.integer().between(0, 10_000).default(1000),
  }),
  resolve: (env) => ({
    enabled: env.LAB_PAGES === undefined ? environment.isDevelopment(env) : env.LAB_PAGES === 'true',
    delay: env.LAB_DELAY,
  }),
});
export type LabConfig = ConfigOf<typeof LabConfig>;
