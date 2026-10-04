import { defineConfig, environment, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

/**
 * The SSR lab: pages that show how server rendering behaves when it is slow or fails (`/lab/…`). On with `NODE_ENV=development`
 * only (E164) — off in production, staging, without `NODE_ENV` and in tests, unless `LAB_PAGES=true` (the lab's own tests; to
 * measure the production build).
 */
export const LabConfig = defineConfig('lab', {
  env: v.object({
    NODE_ENV: v.optional(v.string()),
    LAB_PAGES: v.optional(v.picklist(['true', 'false'])),
    /** How long the slow Suspense boundary of `/lab/streaming` takes on the server, in milliseconds. */
    LAB_DELAY: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0), v.maxValue(10_000)), '1000'),
  }),
  resolve: (env) => ({
    enabled: env.LAB_PAGES === undefined ? environment.isDevelopment(env) : env.LAB_PAGES === 'true',
    delay: env.LAB_DELAY,
  }),
});
export type LabConfig = ConfigOf<typeof LabConfig>;
