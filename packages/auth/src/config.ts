import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';

const whole = (fallback: number, min: number) => env.integer().min(min).default(fallback);
const DAYS = 'a whole number of days (0 keeps unconfirmed accounts)';
const REMEMBER = 'a whole number of days from 0 (off) to 30';
const HOURS = 'a whole number of hours from 1 to 720';

export const AuthConfig = defineConfig('auth', {
  env: env({
    /**
     * How long "Keep me signed in" keeps a browser signed in, in days from the sign-in — never extended by use. A convenience each
     * user chooses; `0` turns it off (no cookie signs in), and a lower value also ends tokens issued under a higher one;
     * `auth:prune-tokens` deletes every token older than it. At most 30. See `docs/authentication.md#remember-me`.
     */
    AUTH_REMEMBER_DAYS: env.integer(REMEMBER).min(0, REMEMBER).max(30, REMEMBER).default(30),
    /**
     * The longest a sign-in lasts, in hours, however active — then the password is asked again, or a valid "Keep me signed in"
     * cookie signs in anew. A session older than an app's first start with this setting counts from its next request.
     * See `docs/authentication.md#how-long-a-sign-in-lasts`.
     */
    AUTH_SESSION_MAX_HOURS: env.integer(HOURS).min(1, HOURS).max(720, HOURS).default(24),
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
     * Private registration (the default): registration and the change of address never tell whether an address has an account —
     * the same answer in the same time, a note to the owner instead. `false` (anything but `true`/`false` stops the boot; empty
     * counts as unset) makes them say "taken"; outside development and tests the boot then warns
     * ({@link PRIVATE_REGISTRATION_OFF_WARNING}). The auth module `marmeon make:auth` writes reads it.
     */
    AUTH_PRIVATE_REGISTRATION: env.in(['true', 'false']).default('true'),
    /**
     * Days an account may stay without a confirmed address — then `auth:prune-unverified` (the command of the module
     * `marmeon make:auth` writes) deletes it: an address somebody signed up with but never confirmed is not kept (pre-hijacked
     * accounts, data minimization). The command is not scheduled by itself — the app turns its line in `modules/auth/schedule.ts`
     * on. A whole number; `0`: the command deletes nothing.
     */
    AUTH_UNVERIFIED_DAYS: env.integer(DAYS).min(0, DAYS).max(99_999, DAYS).default(7),
    /**
     * `true`: a new password — set by the user (`Auth.updatePassword()`) or by a reset link (`PasswordBroker.reset()`) — also revokes
     * every API token of the account, in the transaction of the new hash. `false` (the default) keeps them: a token stays valid until
     * it expires or is revoked. Only `true` and `false` start; empty counts as unset.
     */
    AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: env.in(['true', 'false']).default('false'),
    /** The app's name — the issuer authenticator apps show for the second factor (`TwoFactor.begin()`). */
    APP_NAME: env.string().optional(),
    NODE_ENV: env.string().optional(),
  }),
  resolve: (e) => ({
    rememberDays: e.AUTH_REMEMBER_DAYS,
    /** Whether "Keep me signed in" is on (`AUTH_REMEMBER_DAYS` above 0). */
    remember: e.AUTH_REMEMBER_DAYS > 0,
    sessionMaxSeconds: e.AUTH_SESSION_MAX_HOURS * 3600,
    rememberCookie: e.AUTH_REMEMBER_COOKIE,
    appName: e.APP_NAME,
    passwordTimeout: e.AUTH_PASSWORD_TIMEOUT,
    resetExpire: e.AUTH_RESET_EXPIRE,
    resetThrottle: e.AUTH_RESET_THROTTLE,
    tokenPrefix: e.AUTH_TOKEN_PREFIX,
    privateRegistration: e.AUTH_PRIVATE_REGISTRATION === 'true',
    /** Days before `auth:prune-unverified` deletes an account without a confirmed address — 0: it deletes none. */
    unverifiedDays: e.AUTH_UNVERIFIED_DAYS,
    /** A new password revokes every API token of the account, in the transaction of the new hash. */
    revokeTokensOnPasswordChange: e.AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE === 'true',
    /** Protected (every `NODE_ENV` but `development` and `test`): turning private registration off is warned about at boot. */
    protected: environment.isProtected(e),
  }),
});
export type AuthConfig = ConfigOf<typeof AuthConfig>;

/**
 * What the boot logs, once per process, when a protected environment (production, also without a `NODE_ENV`) runs with
 * `AUTH_PRIVATE_REGISTRATION=false`.
 */
export const PRIVATE_REGISTRATION_OFF_WARNING =
  'AUTH_PRIVATE_REGISTRATION=false outside development and tests: registration and the change of address tell whether an address ' +
  'has an account ("already registered") — anyone can test a list of addresses against your users. Remove the line (private ' +
  'registration is the default) unless the accounts of your app are public anyway.';
