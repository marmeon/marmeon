import { defineConfig, environment, type ConfigOf } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';

/** Settings of the dashboard. */
export const DashboardConfig = defineConfig('dashboard', {
  env: r.env({
    NODE_ENV: r.string().optional(),
    /**
     * Makes the "Members" island slow on purpose, in milliseconds — to watch it load after the others (each island is a
     * request of its own; the slow one blocks nobody). Ignored where the app is protected (production, staging, no `NODE_ENV` — E139).
     */
    DASHBOARD_ISLAND_DELAY: r.integer().between(0, 10_000).default(0),
    /** Who sees the "Members" island: e-mail addresses, comma-separated (the demo's: Ada). */
    DASHBOARD_ADMINS: r.list(r.string().lowercase()).default(['ada@example.com']),
  }),
  resolve: (env) => ({ islandDelay: environment.isProtected(env) ? 0 : env.DASHBOARD_ISLAND_DELAY, admins: env.DASHBOARD_ADMINS }),
});
export type DashboardConfig = ConfigOf<typeof DashboardConfig>;
