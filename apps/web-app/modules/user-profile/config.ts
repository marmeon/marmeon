import { defineConfig, environment, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

/** Settings of the user-profile module. */
export const ProfileConfig = defineConfig('user-profile', {
  env: v.object({
    NODE_ENV: v.optional(v.string()),
    /**
     * Makes the profile's activity panel slow on purpose, in milliseconds — to watch a deferred prop load after the
     * page (`defer()`). Ignored where the app is protected (production, staging, no `NODE_ENV` — E139).
     */
    PROFILE_ACTIVITY_DELAY: v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(0), v.maxValue(10_000)), '0'),
  }),
  resolve: (env) => ({ activityDelay: environment.isProtected(env) ? 0 : env.PROFILE_ACTIVITY_DELAY }),
});
export type ProfileConfig = ConfigOf<typeof ProfileConfig>;
