import { defineConfig, environment, type ConfigOf } from '@marmeon/core';
import * as v from 'valibot';

/** Settings of the dashboard. */
export const DashboardConfig = defineConfig('dashboard', {
  env: v.object({
    NODE_ENV: v.optional(v.string()),
    /**
     * Makes the "Members" island slow on purpose, in milliseconds — to watch it load after the others (each island is a
     * request of its own; the slow one blocks nobody). Ignored where the app is protected (production, staging, no `NODE_ENV` — E139).
     */
    DASHBOARD_ISLAND_DELAY: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0), v.maxValue(10_000)), '0'),
    /** Who sees the "Members" island: e-mail addresses, comma-separated (the demo's: Ada). */
    DASHBOARD_ADMINS: v.optional(
      v.pipe(
        v.string(),
        v.transform((value) => value.split(',').map((email) => email.trim().toLowerCase()).filter(Boolean)),
      ),
      'ada@example.com',
    ),
  }),
  resolve: (env) => ({ islandDelay: environment.isProtected(env) ? 0 : env.DASHBOARD_ISLAND_DELAY, admins: env.DASHBOARD_ADMINS }),
});
export type DashboardConfig = ConfigOf<typeof DashboardConfig>;
