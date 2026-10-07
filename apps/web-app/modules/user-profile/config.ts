import { defineConfig, environment, type ConfigOf } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';

/** Settings of the user-profile module. */
export const ProfileConfig = defineConfig('user-profile', {
  env: r.env({
    NODE_ENV: r.string().optional(),
    /**
     * Makes the profile's activity panel slow on purpose, in milliseconds — to watch a deferred prop load after the
     * page (`defer()`). Ignored where the app is protected (production, staging, no `NODE_ENV` — E139).
     */
    PROFILE_ACTIVITY_DELAY: r.integer().between(0, 10_000).default(0),
  }),
  resolve: (env) => ({ activityDelay: environment.isProtected(env) ? 0 : env.PROFILE_ACTIVITY_DELAY }),
});
export type ProfileConfig = ConfigOf<typeof ProfileConfig>;
