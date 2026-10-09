import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

const whole = (fallback: number, min: number) => env.integer().min(min).default(fallback);
const DAYS = 'a whole number of days (0 keeps unconfirmed accounts)';

export const AuthConfig = defineConfig('auth', {
  env: env({
    /** How long "remember me" keeps someone signed in, in days — counted from the sign-in, not extended by use. */
    AUTH_REMEMBER_DAYS: whole(30, 1),
    /** The remember-me cookie (encrypted, HttpOnly). */
    AUTH_REMEMBER_COOKIE: env.string().regex(/^[\w-]+$/).default('remember_web'),
    /** How long a password confirmation counts for `confirmedPassword()` routes, in seconds (default 15 minutes). */
    AUTH_PASSWORD_TIMEOUT: whole(900, 1),
    /** How long a password reset link works, in minutes. */
    AUTH_RESET_EXPIRE: whole(60, 1),
    /** Seconds before another reset link is sent to the same e-mail. */
    AUTH_RESET_THROTTLE: whole(60, 0),
    /** The prefix of API tokens (`marmeon_12|…`) — secret scanners recognize leaked tokens by it. */
    AUTH_TOKEN_PREFIX: env.string().regex(/^[a-z0-9_]{0,16}$/, 'lower-case letters, digits and _ only').default('marmeon_'),
    /**
     * Private registration (E146, the default since E193): registration and the change of address never tell whether an address
     * has an account — the same answer in the same time, a note to the owner instead. `false` (and only `false`: anything but
     * `true`/`false` stops the boot; empty counts as unset) makes them say "taken", like Laravel's starter kits; outside development and tests the boot
     * then warns ({@link PRIVATE_REGISTRATION_OFF_WARNING}). The auth module `marmeon make:auth` writes reads it.
     */
    AUTH_PRIVATE_REGISTRATION: env.in(['true', 'false']).default('true'),
    /**
     * Days an account may stay without a confirmed address (E203) — then `auth:prune-unverified` (the command of the module
     * `marmeon make:auth` writes) deletes it: an address somebody signed up with but never confirmed is not kept (pre-hijacked
     * accounts, data minimization). The command is not scheduled by itself — the app turns its line in `modules/auth/schedule.ts`
     * on (E209). A whole number; `0`: the command deletes nothing.
     */
    AUTH_UNVERIFIED_DAYS: env.integer(DAYS).min(0, DAYS).max(99_999, DAYS).default(7),
    NODE_ENV: env.string().optional(),
  }),
  resolve: (e) => ({
    rememberDays: e.AUTH_REMEMBER_DAYS,
    rememberCookie: e.AUTH_REMEMBER_COOKIE,
    passwordTimeout: e.AUTH_PASSWORD_TIMEOUT,
    resetExpire: e.AUTH_RESET_EXPIRE,
    resetThrottle: e.AUTH_RESET_THROTTLE,
    tokenPrefix: e.AUTH_TOKEN_PREFIX,
    privateRegistration: e.AUTH_PRIVATE_REGISTRATION === 'true',
    /** Days before `auth:prune-unverified` deletes an account without a confirmed address — 0: it deletes none. */
    unverifiedDays: e.AUTH_UNVERIFIED_DAYS,
    /** Protected (E139 — every `NODE_ENV` but `development` and `test`): turning private registration off is warned about at boot. */
    protected: environment.isProtected(e),
  }),
});
export type AuthConfig = ConfigOf<typeof AuthConfig>;

/**
 * What the boot logs, once per process, when a protected environment (production, no `NODE_ENV` — E139) runs with
 * `AUTH_PRIVATE_REGISTRATION=false` (E193).
 */
export const PRIVATE_REGISTRATION_OFF_WARNING =
  'AUTH_PRIVATE_REGISTRATION=false outside development and tests: registration and the change of address tell whether an address ' +
  'has an account ("already registered") — anyone can test a list of addresses against your users. Remove the line (private ' +
  'registration is the default) unless the accounts of your app are public anyway.';
