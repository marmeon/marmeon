import { defineConfig, env, environment, type ConfigOf } from '@marmeon/core';
import type { SessionConfig } from '@marmeon/session';

const whole = (fallback: number, min: number) => env.integer().min(min).default(fallback);
const DAYS = 'a whole number of days (0 keeps unconfirmed accounts)';
const REMEMBER = 'a whole number of days from 0 (off) to 30';
const MINUTES = 'a whole number of minutes from 5 to 1440';
const RESET_MINUTES = 'a whole number of minutes from 1 to 1440';
const HOURS = 'a whole number of hours from 1 to 720';
const PER_MINUTE = 'a whole number from 1 to 60';
const DEVICE_DAYS = 'a whole number of days from 0 (off) to 365';
const PER_DAY = 'a whole number from 10 to 100000';

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
    /** The remember-me cookie (encrypted, HttpOnly); over HTTPS its name gets the `__Host-` prefix. */
    AUTH_REMEMBER_COOKIE: env.string().regex(/^(?!__(host|secure)-)[\w-]+$/i, 'Expected letters, digits, _ and -, without a __Host- or __Secure- prefix: the framework adds __Host- itself').default('marmeon_remember'),
    /** How long a password confirmation counts for `confirmedPassword()` routes, in seconds (default 15 minutes). */
    AUTH_PASSWORD_TIMEOUT_SECONDS: whole(900, 1),
    /** How long a password reset link works, in minutes (1 to 1440: a link in a mail archive must not stay good for long). See `docs/passwords.md#configuration`. */
    AUTH_RESET_MINUTES: env.integer(RESET_MINUTES).min(1, RESET_MINUTES).max(1440, RESET_MINUTES).default(60),
    /** Seconds before another reset link is sent to the same e-mail. */
    AUTH_RESET_THROTTLE_SECONDS: whole(60, 0),
    /** How long the link of a change of address works, in minutes (5 to 1440). See `docs/authentication.md#changing-the-address`. */
    AUTH_EMAIL_CHANGE_MINUTES: env.integer(MINUTES).min(5, MINUTES).max(1440, MINUTES).default(60),
    /** Seconds an account must wait between two requests that send a link for a new address (private registration); a request inside the pause is answered as usual and sends nothing. */
    AUTH_EMAIL_CHANGE_THROTTLE_SECONDS: whole(60, 0),
    /** The prefix of API tokens (`marmeon_…`) — secret scanners recognize leaked tokens by it. */
    AUTH_TOKEN_PREFIX: env.string().regex(/^(?:[a-z0-9_]{0,15}_)?$/, 'empty, or lower-case letters and digits ending in _ (16 at most)').default('marmeon_'),
    /**
     * Private registration (the default): registration and the change of address never tell whether an address has an account —
     * the same answer in the same time, a note to the owner instead. `false` (or `0`) makes them say "taken"; outside development
     * and tests the boot then warns ({@link PRIVATE_REGISTRATION_OFF_WARNING}). The auth module `marmeon make:auth` writes reads it.
     */
    AUTH_PRIVATE_REGISTRATION: env.boolean().default(true),
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
     * it expires or is revoked.
     */
    AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: env.boolean().default(false),
    /**
     * Password sign-ins `Auth.attempt()` takes a minute for one identifier from one client (an IPv6 address counts as its /64);
     * the next is refused as `throttled`. See `docs/authentication.md#signing-in`.
     */
    AUTH_LOGIN_ATTEMPTS_PER_MINUTE: env.integer(PER_MINUTE).min(1, PER_MINUTE).max(60, PER_MINUTE).default(5),
    /**
     * Password sign-ins one account takes a day from all clients together; past it nothing is checked, the right password included,
     * until the owner signs in with a passkey or resets the password. See `docs/authentication.md#signing-in`.
     */
    AUTH_ACCOUNT_SIGN_INS_PER_DAY: env.integer(PER_DAY).min(10, PER_DAY).max(100_000, PER_DAY).default(100),
    /**
     * Days the device cookie lasts that a browser gets when it signs in with the password or completes a password reset: the browser
     * of an account's owner then keeps signing in when strangers have used up the account's daily ceiling (`AUTH_ACCOUNT_SIGN_INS_PER_DAY`),
     * on a limit of its own (ten an hour). `0` turns the cookie off. See `docs/authentication.md#limits-on-password-sign-ins`.
     */
    AUTH_DEVICE_COOKIE_DAYS: env.integer(DEVICE_DAYS).min(0, DEVICE_DAYS).max(365, DEVICE_DAYS).default(90),
    /** The app's name — the issuer authenticator apps show for the second factor (`TwoFactor.begin()`). */
    APP_NAME: env.string().optional(),
    NODE_ENV: env.string().optional(),
  })
    .renamed('AUTH_PASSWORD_TIMEOUT', 'AUTH_PASSWORD_TIMEOUT_SECONDS')
    .renamed('AUTH_RESET_EXPIRE', 'AUTH_RESET_MINUTES')
    .renamed('AUTH_RESET_THROTTLE', 'AUTH_RESET_THROTTLE_SECONDS')
    .renamed('AUTH_EMAIL_CHANGE_THROTTLE', 'AUTH_EMAIL_CHANGE_THROTTLE_SECONDS'),
  resolve: (e) => refuseOldKeys({
    rememberDays: e.AUTH_REMEMBER_DAYS,
    /** Whether "Keep me signed in" is on (`AUTH_REMEMBER_DAYS` above 0). */
    remember: e.AUTH_REMEMBER_DAYS > 0,
    sessionMaxSeconds: e.AUTH_SESSION_MAX_HOURS * 3600,
    rememberCookie: e.AUTH_REMEMBER_COOKIE,
    appName: e.APP_NAME,
    loginAttemptsPerMinute: e.AUTH_LOGIN_ATTEMPTS_PER_MINUTE,
    accountSignInsPerDay: e.AUTH_ACCOUNT_SIGN_INS_PER_DAY,
    deviceCookieDays: e.AUTH_DEVICE_COOKIE_DAYS,
    passwordTimeoutSeconds: e.AUTH_PASSWORD_TIMEOUT_SECONDS,
    resetMinutes: e.AUTH_RESET_MINUTES,
    resetThrottleSeconds: e.AUTH_RESET_THROTTLE_SECONDS,
    emailChangeMinutes: e.AUTH_EMAIL_CHANGE_MINUTES,
    emailChangeThrottleSeconds: e.AUTH_EMAIL_CHANGE_THROTTLE_SECONDS,
    tokenPrefix: e.AUTH_TOKEN_PREFIX,
    privateRegistration: e.AUTH_PRIVATE_REGISTRATION,
    /** Days before `auth:prune-unverified` deletes an account without a confirmed address — 0: it deletes none. */
    unverifiedDays: e.AUTH_UNVERIFIED_DAYS,
    /** A new password revokes every API token of the account, in the transaction of the new hash. */
    revokeTokensOnPasswordChange: e.AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE,
    /** Protected (every `NODE_ENV` but `development` and `test`): turning private registration off is warned about at boot. */
    protected: environment.isProtected(e),
  }),
});
export type AuthConfig = ConfigOf<typeof AuthConfig>;

const RENAMED_KEYS: Readonly<Record<string, string>> = {
  passwordTimeout: 'passwordTimeoutSeconds',
  resetExpire: 'resetMinutes',
  resetThrottle: 'resetThrottleSeconds',
  emailChangeThrottle: 'emailChangeThrottleSeconds',
};

/** The keys of the AuthConfig that changed their name: an untyped read of one throws instead of answering `undefined`. */
function refuseOldKeys<T extends object>(config: T): T {
  for (const [old, now] of Object.entries(RENAMED_KEYS)) {
    Object.defineProperty(config, old, {
      enumerable: false,
      get() {
        throw new TypeError(`AuthConfig.${old} was renamed AuthConfig.${now} — the value is the same number, now with its unit in the name.`);
      },
    });
  }
  return config;
}

/**
 * The name the remember-me cookie goes by: `AUTH_REMEMBER_COOKIE`, with the `__Host-` prefix when the session's cookies are
 * `Secure` (`secure` is theirs). Over plain HTTP (development) there is no prefix. Only this name is ever read.
 */
export function rememberCookieName(config: Pick<AuthConfig, 'rememberCookie'>, session: Pick<SessionConfig, 'secure'>): string {
  return session.secure ? `__Host-${config.rememberCookie}` : config.rememberCookie;
}

/**
 * What the boot logs, once per process, when a protected environment (production, also without a `NODE_ENV`) runs with
 * `AUTH_PRIVATE_REGISTRATION=false`.
 */
export const PRIVATE_REGISTRATION_OFF_WARNING =
  'AUTH_PRIVATE_REGISTRATION=false outside development and tests: registration and the change of address tell whether an address ' +
  'has an account ("already registered") — anyone can test a list of addresses against your users. Remove the line (private ' +
  'registration is the default) unless the accounts of your app are public anyway.';
