import type { Clock, EventDispatcher, Logger } from '@marmeon/core';
import type { Connections } from '@marmeon/database';
import type { SessionEndings, UserSessions } from '@marmeon/session';
import type { AccountSessions } from '../account-sessions.ts';
import type { Auth } from '../auth.ts';
import type { AuthConfig } from '../config.ts';
import type { EmailChangeStore } from '../email-changes.ts';
import type { SessionFingerprints } from '../fingerprint.ts';
import { GuardContext } from '../guard-context.ts';
import { APP_GUARD_NAMES, type GuardNames } from '../guard-names.ts';
import type { NewPassword } from '../new-password.ts';
import type { PasswordResetTokenStore } from '../password-reset.ts';
import type { SignInThrottle } from '../sign-in-throttle.ts';
import type { SignInStore } from '../sign-ins.ts';
import type { AccessTokenStore } from '../tokens.ts';
import { NoTwoFactorState, type SecondFactorPasskeys, type TwoFactorState } from '../two-factor/state.ts';
import type { TwoFactorStore } from '../two-factor/store.ts';
import type { UserProvider } from '../user.ts';

/** What a test hands to {@link guardContext}; a part left out is an empty object (a reset store that holds nothing), or `undefined` where the context allows none. */
export interface GuardParts {
  names?: GuardNames;
  settings?: Partial<AuthConfig>;
  users?: UserProvider;
  signIns?: SignInStore;
  passwordResets?: PasswordResetTokenStore;
  accessTokens?: AccessTokenStore;
  emailChanges?: EmailChangeStore;
  userSessions?: UserSessions;
  factors?: TwoFactorState;
  totp?: TwoFactorStore;
  passkeyStore?: object;
  secondFactorPasskeys?: SecondFactorPasskeys;
  fingerprints?: SessionFingerprints;
  signInThrottle?: SignInThrottle;
  newPassword?: NewPassword;
  accountSessions?: AccountSessions;
  auth?: Auth;
  connections?: Connections;
  events?: EventDispatcher;
  clock?: Clock;
  logger?: Logger;
  endings?: SessionEndings;
  event?: (event: object) => object | undefined;
}

/** A {@link GuardContext} for a test that builds a service by hand: the app's names, the parts it hands in, and nothing else. */
export function guardContext(parts: GuardParts = {}): GuardContext {
  return new TestGuardContext(parts);
}

const missing = (): never => ({}) as never;

/** A reset store holding nothing, for a test of something else. */
const NO_RESETS = { forget: async () => {}, forgetEveryone: async () => 0 } as unknown as PasswordResetTokenStore;

const SILENT = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT } as unknown as Logger;

class TestGuardContext extends GuardContext {
  readonly #parts: GuardParts;
  readonly names: GuardNames;

  constructor(parts: GuardParts) {
    super();
    this.#parts = parts;
    this.names = parts.names ?? APP_GUARD_NAMES;
  }

  get settings(): AuthConfig {
    return (this.#parts.settings ?? {}) as AuthConfig;
  }

  get fingerprints(): SessionFingerprints {
    return this.#parts.fingerprints ?? missing();
  }

  get signInThrottle(): SignInThrottle {
    return this.#parts.signInThrottle ?? missing();
  }

  users(): UserProvider {
    return this.#parts.users ?? missing();
  }

  signIns(): SignInStore {
    return this.#parts.signIns ?? missing();
  }

  passwordResets(): PasswordResetTokenStore {
    return this.#parts.passwordResets ?? NO_RESETS;
  }

  accessTokens(): AccessTokenStore | undefined {
    return this.#parts.accessTokens;
  }

  emailChanges(): EmailChangeStore | undefined {
    return this.#parts.emailChanges;
  }

  userSessions(): UserSessions | undefined {
    return this.#parts.userSessions;
  }

  factors(): TwoFactorState {
    return this.#parts.factors ?? new NoTwoFactorState();
  }

  totp(): TwoFactorStore | undefined {
    return this.#parts.totp;
  }

  passkeyStore(): object | undefined {
    return this.#parts.passkeyStore;
  }

  secondFactorPasskeys(): SecondFactorPasskeys {
    return this.#parts.secondFactorPasskeys ?? missing();
  }

  newPassword(): NewPassword {
    return this.#parts.newPassword ?? missing();
  }

  accountSessions(): AccountSessions {
    return this.#parts.accountSessions ?? missing();
  }

  auth(): Auth {
    return this.#parts.auth ?? missing();
  }

  connections(): Connections {
    return this.#parts.connections ?? missing();
  }

  events(): EventDispatcher {
    return this.#parts.events ?? ({ dispatch: async () => {} } as unknown as EventDispatcher);
  }

  clock(): Clock {
    return this.#parts.clock ?? ({ now: () => Date.now() } as Clock);
  }

  logger(): Logger {
    return this.#parts.logger ?? SILENT;
  }

  endings(): SessionEndings | undefined {
    return this.#parts.endings;
  }

  event<E extends object>(event: E): object | undefined {
    return this.#parts.event ? this.#parts.event(event) : event;
  }
}
