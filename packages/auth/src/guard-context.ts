import type { Clock, EventDispatcher, Key, Logger, Resolver } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import type { SessionEndings, UserSessions } from '@marmeon/session';
import type { AccountSessions } from './account-sessions.ts';
import type { Auth } from './auth.ts';
import type { AuthConfig } from './config.ts';
import type { EmailChangeStore } from './email-changes.ts';
import type { SessionFingerprints } from './fingerprint.ts';
import type { GuardNames } from './guard-names.ts';
import type { NewPassword } from './new-password.ts';
import type { PasswordResetTokenStore } from './password-reset.ts';
import type { SignInStore } from './sign-ins.ts';
import type { SignInThrottle } from './sign-in-throttle.ts';
import type { AccessTokenStore } from './tokens.ts';
import type { SecondFactorPasskeys, TwoFactorState } from './two-factor/state.ts';
import type { TwoFactorStore } from './two-factor/store.ts';
import type { UserProvider } from './user.ts';

/**
 * Everything one guard owns that the auth services use: its users, stores, settings, names and events. A service takes it as its
 * first constructor parameter and nothing else of the guard's, so a service built for one guard cannot pick up another's
 * `UserProvider`, store or counter by a forgotten argument. Members that a guard may not have answer `undefined`: the service
 * then skips that part (a package guard has no API tokens, say).
 *
 * @internal
 */
export abstract class GuardContext {
  /** Every key, cookie and counter name of the guard. */
  abstract readonly names: GuardNames;
  /** The settings in force for the guard. */
  abstract readonly settings: AuthConfig;
  abstract readonly fingerprints: SessionFingerprints;
  abstract readonly signInThrottle: SignInThrottle;

  abstract users(): UserProvider;
  abstract signIns(): SignInStore;
  abstract passwordResets(): PasswordResetTokenStore;
  abstract accessTokens(): AccessTokenStore | undefined;
  abstract emailChanges(): EmailChangeStore | undefined;
  abstract userSessions(): UserSessions | undefined;
  abstract factors(): TwoFactorState;
  abstract totp(): TwoFactorStore | undefined;
  /**
   * The guard's `PasskeyStore`, typed loosely: the main entry must not reach the passkeys subpath, not even for a type, so the
   * passkeys service narrows it where it reads it.
   */
  abstract passkeyStore(): object | undefined;
  abstract secondFactorPasskeys(): SecondFactorPasskeys;
  abstract newPassword(): NewPassword;
  abstract accountSessions(): AccountSessions;
  abstract auth(): Auth;

  // What every guard shares, answered here so a service built for a guard never has to be handed them one by one.
  abstract connections(): Connections;
  abstract events(): EventDispatcher;
  abstract clock(): Clock;
  abstract logger(): Logger;
  /** The live streams' endings, or `undefined` where the app has none. */
  abstract endings(): SessionEndings | undefined;

  /** What to dispatch for `event`, which a service of this guard raised: the event itself, another one, or `undefined` for none. */
  abstract event<E extends object>(event: E): object | undefined;
}

/** A class with a generated injection list, as the container reads it. */
type Injectable<T> = (abstract new (...parameters: never[]) => T) & { readonly inject?: readonly Key[] };

/**
 * Builds `Class` for the guard of `context`: its injection list starts with {@link GuardContext}, which is given here, and the rest
 * (`Session`, `Router`, …) is made by `resolver`. Throws a `TypeError` for a class whose first entry is anything else: such a
 * class takes its guard's users or stores one by one, and a factory that forgot one would fall back to the app's.
 *
 * @internal
 */
export function buildForGuard<T>(Class: Injectable<T>, resolver: Resolver, context: GuardContext): T {
  const inject = Class.inject;
  if (inject === undefined || inject[0] !== GuardContext) {
    throw new TypeError(`${Class.name} cannot be built for a guard: its first constructor parameter is not the GuardContext.`);
  }
  // An optional parameter (`?`) counts in `Class.length`, so it is caught here. A default (`= …`) does not count and is not injected
  // either: the structure test of the guard services rules defaults out in their sources.
  if (inject.length < Class.length) {
    throw new TypeError(`${Class.name} cannot be built for a guard: ${Class.length - inject.length} of its constructor parameters would be left out (optional parameters are not injected).`);
  }
  const Concrete = Class as unknown as new (...parameters: unknown[]) => T;
  return new Concrete(context, ...inject.slice(1).map((dependency) => resolver.make(dependency)));
}
