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
  }),
  resolve: (env) => ({
    rememberDays: env.AUTH_REMEMBER_DAYS,
    rememberCookie: env.AUTH_REMEMBER_COOKIE,
    passwordTimeout: env.AUTH_PASSWORD_TIMEOUT,
  }),
});
export type AuthConfig = ConfigOf<typeof AuthConfig>;
