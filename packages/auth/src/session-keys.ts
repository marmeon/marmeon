import type { Session } from '@marmeon/session';
import { SESSION_USER_KEY } from '@marmeon/session';
import type { SignInVia } from './events.ts';
import type { SecondFactor } from './two-factor/state.ts';

/** Session keys of the signed-in user — `_`-prefixed: framework bookkeeping, left out of `session.all()`. */
export const AUTH_SESSION_KEYS = {
  /** The user's id (the session package's key: the `database` session driver copies it into `user_id`). */
  id: SESSION_USER_KEY,
  /** The account's fingerprint when the session signed in: its id and session key (`SessionFingerprints`). */
  password: '_auth_password',
  /** When the password was last typed (sign-in, confirmation), in Unix seconds — for `confirmedPassword()`. */
  confirmedAt: '_auth_confirmed_at',
  /** Signed in by the remember-me cookie, not by a password. */
  viaRemember: '_auth_via_remember',
  /** When the sign-in happened, in Unix seconds — the start of its absolute lifetime (`AUTH_SESSION_MAX_HOURS`); no activity extends it. */
  signedInAt: '_auth_signed_in_at',
  /** For a session restored by the remember-me cookie: when its token ends, in Unix seconds — the session never outlives it. */
  rememberUntil: '_auth_remember_until',
  /** A correct password whose account still owes a second factor — not a sign-in (see {@link PendingSecondFactor}). */
  pending: '_auth_pending',
  /** When this session proved a second factor, in Unix seconds — for the middleware that asks for one. */
  twoFactorAt: '_auth_two_factor_at',
  /** The sign-in's row in `SignInStore` — its end ends the session. */
  signIn: '_auth_sign_in',
  /** A random key of this sign-in (new at every sign-in): what its password checks are counted under, whatever the session id. */
  throttleKey: '_auth_throttle_key',
  /** Set when the sign-in began with a typed password (`attempt()`, including its second factor), never by a passkey or `signIn()`. */
  typedPassword: '_auth_typed_password',
} as const;


/**
 * What the session keeps between the password and the second factor. It names the account, but nothing in the session
 * signs anybody in until {@link COMPLETE_PENDING} has checked it again.
 */
export interface PendingSecondFactor {
  readonly id: string | number;
  /** The account's fingerprint at the password step: a new session key in between (a new password writes one) ends the wait. */
  readonly fingerprint: string;
  readonly remember: boolean;
  readonly via: SignInVia;
  /** Unix seconds when the password was typed (`via` is `attempt`); a sign-in nobody typed a password for has none. */
  readonly typedAt?: number;
  /** Unix seconds. */
  readonly until: number;
  readonly failures: number;
  readonly factors: readonly SecondFactor[];
}

/**
 * What each key of {@link AUTH_SESSION_KEYS} holds, by the key's name here. The session package does not know these keys (they are no
 * `SessionData` fields), so app code gets no typed way to write one: a forged `_auth_confirmed_at` would open the sudo window.
 */
export interface AuthSessionKeys {
  id: string | number;
  password: string;
  confirmedAt: number;
  viaRemember: boolean;
  signedInAt: number;
  rememberUntil: number;
  pending: PendingSecondFactor;
  twoFactorAt: number;
  signIn: string;
  throttleKey: string;
  typedPassword: boolean;
}

/** Reads a sign-in key. The value came from the session store, so it is `unknown`: every reader checks the type it needs. */
export function readAuth(session: Session, key: keyof AuthSessionKeys): unknown {
  return session.get(AUTH_SESSION_KEYS[key]);
}

/** Writes a sign-in key with the type {@link AuthSessionKeys} names for it. */
export function writeAuth<K extends keyof AuthSessionKeys>(session: Session, key: K, value: AuthSessionKeys[K]): void {
  session.put<string>(AUTH_SESSION_KEYS[key], value);
}
