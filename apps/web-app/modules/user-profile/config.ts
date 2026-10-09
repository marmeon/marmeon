import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

/** Settings of the user-profile module. */
export const ProfileConfig = defineConfig('user-profile', {
  env: env({
    NODE_ENV: env.string().optional(),
    /**
     * Makes the profile's activity panel slow on purpose, in milliseconds — to watch a deferred prop load after the
     * page (`defer()`). Ignored where the app is protected (production, staging, no `NODE_ENV` — E139).
     */
    PROFILE_ACTIVITY_DELAY: env.integer().min(0).max(10_000).default(0),
  }),
  resolve: (e) => ({ activityDelay: environment.isProtected(e) ? 0 : e.PROFILE_ACTIVITY_DELAY }),
});
export type ProfileConfig = ConfigOf<typeof ProfileConfig>;
