import type { SessionConfig } from '@marmeon/session';
import { accountScope, guardUserKey } from '@marmeon/session/internal';
import { rememberCookieName, type AuthConfig } from './config.ts';
import { AUTH_SESSION_KEYS, type AuthSessionKeys } from './session-keys.ts';

/**
 * Every name a sign-in is kept under that is not a table: session keys, HKDF contexts, cookies and counters. The app guard's names are
 * the ones the framework always used, so an update signs nobody out; a package guard's carry its name, so the same user id in
 * two tables never reads, resets or ends the other's session, cookie or counter.
 */
export interface GuardNames {
  readonly name: string;
  readonly session: Readonly<Record<keyof AuthSessionKeys | 'webauthn', string>>;
  readonly fingerprintContext: string;
  readonly loginThrottleContext: string;
  readonly deviceContext: string;
  /** The remember-me cookie's name, with the `__Host-` prefix when the session's cookies are `Secure`. */
  rememberCookie(config: Pick<AuthConfig, 'rememberCookie'>, session: Pick<SessionConfig, 'secure'>): string;
  /** The device cookie's name, with the `__Host-` prefix when `secure`. */
  deviceCookie(secure: boolean): string;
  /** A rate-limiter key of a service (a counter of an account, a sign-in or a client), made guard-specific. */
  limiterKey(base: string): string;
  /** The name of a route limiter (`auth.login`), made guard-specific. */
  routeLimit(name: string): string;
  /** The scope the live package files an account's streams under. */
  accountScope(id: string | number): string;
}

const APP_NAME = 'web';

const SESSION_FIELDS = {
  password: 'password',
  confirmedAt: 'confirmed_at',
  viaRemember: 'via_remember',
  signedInAt: 'signed_in_at',
  rememberUntil: 'remember_until',
  pending: 'pending',
  twoFactorAt: 'two_factor_at',
  signIn: 'sign_in',
  throttleKey: 'throttle_key',
  typedPassword: 'typed_password',
  webauthn: 'webauthn',
} as const satisfies Record<Exclude<keyof AuthSessionKeys, 'id'> | 'webauthn', string>;

/** The names of the app guard: every literal the framework used before guards had names. */
export const APP_GUARD_NAMES: GuardNames = {
  name: APP_NAME,
  session: { ...AUTH_SESSION_KEYS, webauthn: '_auth_webauthn' },
  fingerprintContext: 'marmeon:auth-session',
  loginThrottleContext: 'marmeon:auth-login-throttle',
  deviceContext: 'marmeon:auth-device',
  rememberCookie: rememberCookieName,
  deviceCookie: (secure) => (secure ? '__Host-marmeon_device' : 'marmeon_device'),
  limiterKey: (base) => base,
  routeLimit: (name) => name,
  accountScope: (id) => accountScope(id),
};

const GUARD_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(['web', 'api', 'app', 'auth', 'marmeon']);

/** Whether `name` may name a package guard: lower case, digits and single hyphens, at most 32 characters, none of the framework's own words. */
export function isGuardName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 32 && GUARD_NAME.test(name) && !RESERVED.has(name);
}

/**
 * The names of the package guard `name`. `:` separates the guard from the key in every name, and no app name has one, so
 * no guard's name equals another's or the app's. Throws a `TypeError` for a name {@link isGuardName} refuses.
 */
export function guardNames(name: string): GuardNames {
  if (!isGuardName(name)) {
    throw new TypeError(`A guard's name is lower case letters, digits and single hyphens, starts with a letter, has at most 32 characters and is none of ${[...RESERVED].join(', ')}.`);
  }
  const session: Record<string, string> = { id: guardUserKey(name) };
  for (const [key, field] of Object.entries(SESSION_FIELDS)) session[key] = `_auth:${name}:${field}`;
  return {
    name,
    session: session as GuardNames['session'],
    fingerprintContext: `marmeon:auth-session:${name}`,
    loginThrottleContext: `marmeon:auth-login-throttle:${name}`,
    deviceContext: `marmeon:auth-device:${name}`,
    // A `.` joins the guard to the cookie's name: `AUTH_REMEMBER_COOKIE` allows letters, digits, `_` and `-` and a guard name the same
    // without `_`, so neither holds a `.` and no app name (`marmeon_device-office`, say) equals a guard's. RFC 6265 names allow it.
    // The device cookie has a second `.`: a remember cookie has exactly one, so `AUTH_REMEMBER_COOKIE=marmeon_device` cannot meet it.
    rememberCookie: (config, { secure }) => `${rememberCookieName(config, { secure })}.${name}`,
    deviceCookie: (secure) => `${secure ? '__Host-' : ''}marmeon_device.${name}.device`,
    limiterKey: (base) => `guard:${name}|${base}`,
    routeLimit: (limit) => `auth.${name}.${limit.replace(/^auth\./, '')}`,
    accountScope: (id) => accountScope(id, name),
  };
}
