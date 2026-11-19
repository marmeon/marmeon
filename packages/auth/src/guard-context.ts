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
 * The brand of a service class that a package guard may be given as an option (`TwoFactor` as `twoFactor`, `Passkeys` as `passkeys`). A symbol on the class, not its
 * name: a bundler renames a class, and a subclass keeps the brand it inherits.
 *
 * @internal
 */
export const GUARD_FEATURE: unique symbol = Symbol('marmeon-auth.guard-feature');

/**
 * What the `Passkeys` class hands a package guard under {@link GUARD_PASSKEYS}: the main entry must not import the passkeys folder, so the
 * guard builds the passkey store and names its configuration and columns through this, never by import.
 *
 * @internal
 */
export interface GuardPasskeyKit {
  /** The configuration of the relying party: the app's providers carry it (`static config = [PasskeyConfig]`), and a guard refuses to start without it. */
  readonly config: Key<unknown>;
  /** The columns the guard's passkey table needs before `/up/ready` turns green. */
  readonly columns: readonly string[];
  /** Whether `store` is what {@link store} makes, which is the check before it counts as a source of factors. */
  isStore(store: unknown): boolean;
  /** The store of the guard's passkeys on its own tables, which is also its source of the `passkey` factor. */
  store(connections: Connections, clock: Clock, tables: { readonly passkeys: string; readonly twoFactor: string; readonly recoveryCodes: string }): TwoFactorState;
}

/** The static field of `Passkeys` that holds its {@link GuardPasskeyKit}. @internal */
export const GUARD_PASSKEYS: unique symbol = Symbol('marmeon-auth.guard-passkeys');

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

  /** The root container proofs of re-authentication must have been claimed on, for the app's guard; a package guard takes none. */
  reauthenticationRoot(): object | undefined {
    return undefined;
  }

  // What every guard shares, answered here so a service built for a guard never has to be handed them one by one.
  abstract connections(): Connections;
  abstract events(): EventDispatcher;
  abstract clock(): Clock;
  abstract logger(): Logger;
  /** The live streams' endings, or `undefined` where the app has none. */
  abstract endings(): SessionEndings | undefined;

  /**
   * What to dispatch for `event`, which a service of this guard raised, in order (empty for none). A service dispatches it through {@link dispatchForGuard}, never by itself.
   */
  abstract dispatched(event: object): readonly object[];
}

/**
 * Dispatches what `guard` has for `event` on `events`, in order. The one place a guard service dispatches: a service that dispatched
 * `event` itself would reach the app's listeners with a package guard's account.
 *
 * @internal
 */
export async function dispatchForGuard(guard: GuardContext, events: EventDispatcher, event: object): Promise<void> {
  for (const dispatched of guard.dispatched(event)) await events.dispatch(dispatched);
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
