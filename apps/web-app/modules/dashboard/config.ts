import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

/** Settings of the dashboard. */
export const DashboardConfig = defineConfig('dashboard', {
  env: env({
    NODE_ENV: env.string().optional(),
    /**
     * Makes the "Members" island slow on purpose, in milliseconds — to watch it load after the others (each island is a
     * request of its own; the slow one blocks nobody). Ignored where the app is protected (production, no `NODE_ENV` — E139).
     */
    DASHBOARD_ISLAND_DELAY: env.integer().min(0).max(10_000).default(0),
    /** Who sees the "Members" island: e-mail addresses, comma-separated, in any case (the demo's: Ada). */
    DASHBOARD_ADMINS: env.list(env.string()).default(['ada@example.com']),
  }),
  resolve: (e) => ({
    islandDelay: environment.isProtected(e) ? 0 : e.DASHBOARD_ISLAND_DELAY,
    admins: e.DASHBOARD_ADMINS.map((admin) => admin.toLowerCase()),
  }),
});
export type DashboardConfig = ConfigOf<typeof DashboardConfig>;
