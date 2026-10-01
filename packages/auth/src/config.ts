import { defineConfig, type ConfigOf } from '@bespokecore/core';
import * as v from 'valibot';

const whole = (fallback: number, min: number) => v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(min)), String(fallback));

export const AuthConfig = defineConfig('auth', {
  env: v.object({
    /** How long "remember me" keeps someone signed in, in days — counted from the sign-in, not extended by use. */
    AUTH_REMEMBER_DAYS: whole(30, 1),
    /** The remember-me cookie (encrypted, HttpOnly). */
    AUTH_REMEMBER_COOKIE: v.optional(v.pipe(v.string(), v.regex(/^[\w-]+$/)), 'remember_web'),
    /** How long a password confirmation counts for `confirmedPassword()` routes, in seconds (default 15 minutes). */
    AUTH_PASSWORD_TIMEOUT: whole(900, 1),
    /** How long a password reset link works, in minutes. */
    AUTH_RESET_EXPIRE: whole(60, 1),
    /** Seconds before another reset link is sent to the same e-mail. */
    AUTH_RESET_THROTTLE: whole(60, 0),
    /** The prefix of API tokens (`bc_12|…`) — secret scanners recognize leaked tokens by it. */
    AUTH_TOKEN_PREFIX: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9_]{0,16}$/, 'lower-case letters, digits and _ only')), 'bc_'),
  }),
  resolve: (env) => ({
    rememberDays: env.AUTH_REMEMBER_DAYS,
    rememberCookie: env.AUTH_REMEMBER_COOKIE,
    passwordTimeout: env.AUTH_PASSWORD_TIMEOUT,
    resetExpire: env.AUTH_RESET_EXPIRE,
    resetThrottle: env.AUTH_RESET_THROTTLE,
    tokenPrefix: env.AUTH_TOKEN_PREFIX,
  }),
});
export type AuthConfig = ConfigOf<typeof AuthConfig>;
