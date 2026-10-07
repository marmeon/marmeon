import { defineConfig, environment, type ConfigOf } from '@marmeon/core';
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
    /**
     * Private registration (E146, the default since E193): registration and the change of address never tell whether an address
     * has an account — the same answer in the same time, a note to the owner instead. `false` (and only `false`: anything but
     * `true`/`false` stops the boot) makes them say "taken", like Laravel's starter kits; outside development and tests the boot
     * then warns ({@link PRIVATE_REGISTRATION_OFF_WARNING}). The auth module `marmeon make:auth` writes reads it.
     */
    AUTH_PRIVATE_REGISTRATION: v.optional(v.pipe(v.picklist(['true', 'false']), v.transform((value) => value === 'true')), 'true'),
    /**
     * Days an account may stay without a confirmed address (E203) — then `auth:prune-unverified` (the module `marmeon make:auth`
     * writes, nightly) deletes it: an address somebody signed up with but never confirmed is not kept (pre-hijacked accounts, data
     * minimization). A whole number; `0` keeps them (outside development and tests the boot then says so, {@link UNVERIFIED_KEPT_NOTICE}).
     */
    AUTH_UNVERIFIED_DAYS: v.optional(
      v.pipe(v.string(), v.regex(/^\d{1,5}$/, 'a whole number of days (0 keeps unconfirmed accounts)'), v.transform(Number)),
      '7',
    ),
    NODE_ENV: v.optional(v.string()),
  }),
  resolve: (env) => ({
    rememberDays: env.AUTH_REMEMBER_DAYS,
    rememberCookie: env.AUTH_REMEMBER_COOKIE,
    passwordTimeout: env.AUTH_PASSWORD_TIMEOUT,
    resetExpire: env.AUTH_RESET_EXPIRE,
    resetThrottle: env.AUTH_RESET_THROTTLE,
    tokenPrefix: env.AUTH_TOKEN_PREFIX,
    privateRegistration: env.AUTH_PRIVATE_REGISTRATION,
    /** Days before an account without a confirmed address is deleted (`auth:prune-unverified`) — 0: never. */
    unverifiedDays: env.AUTH_UNVERIFIED_DAYS,
    /** Protected (E139 — every `NODE_ENV` but `development` and `test`): turning private registration off is warned about at boot. */
    protected: environment.isProtected(env),
  }),
});
export type AuthConfig = ConfigOf<typeof AuthConfig>;

/**
 * What the boot logs, once per process, when a protected environment (production, staging, no `NODE_ENV` — E139) runs with
 * `AUTH_PRIVATE_REGISTRATION=false` (E193).
 */
export const PRIVATE_REGISTRATION_OFF_WARNING =
  'AUTH_PRIVATE_REGISTRATION=false outside development and tests: registration and the change of address tell whether an address ' +
  'has an account ("already registered") — anyone can test a list of addresses against your users. Remove the line (private ' +
  'registration is the default) unless the accounts of your app are public anyway.';

/**
 * What the boot logs, once per process, when a protected environment (E139) keeps accounts without a confirmed address forever
 * (`AUTH_UNVERIFIED_DAYS=0`, E203).
 */
export const UNVERIFIED_KEPT_NOTICE =
  'AUTH_UNVERIFIED_DAYS=0 outside development and tests: accounts whose address was never confirmed are kept forever — whoever ' +
  "signed up with somebody else's address keeps holding it, and the data of sign-ups nobody finished stays. Remove the line " +
  '(7 days is the default) unless you clear them yourself.';
