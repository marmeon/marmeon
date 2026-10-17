import { token } from '@marmeon/core';

/** A kind of second factor an account can have. */
export type SecondFactor = 'totp' | 'passkey';

/**
 * Which second factors an account has. Signing in asks it after every correct password: a non-empty answer holds the
 * sign-in back until a factor is proven. The default says "nobody has one" and asks nothing, so an app that binds no
 * source behaves as before. Binding a source switches two-factor on for the accounts that set a factor up — never for the rest.
 *
 * Removing the binding switches it off for everyone: accounts with a factor then sign in with the password alone.
 */
export interface TwoFactorState {
  factors(userId: number | string): Promise<readonly SecondFactor[]>;
  /**
   * Since when the account has had a second factor — the earliest confirmation of the factors it has now — or `undefined` without
   * one. A remember-me token made before that moment never proved a factor, and is refused.
   */
  enabledSince(userId: number | string): Promise<Date | undefined>;
  /**
   * Removes every factor the source holds for the account, recovery codes included — what the reset of an account with an unconfirmed
   * address does (`NewPassword`) and the operator's reset command. Dispatches nothing. A source that keeps a factor here leaves it standing
   * through such a reset: the reset logs an error then.
   */
  removeAll(userId: number | string): Promise<void>;
}
export const TwoFactorState = token<TwoFactorState>('TwoFactorState');

/** The default {@link TwoFactorState}: no account has a factor, and nothing is queried. */
export class NoTwoFactorState implements TwoFactorState {
  async factors(): Promise<readonly SecondFactor[]> {
    return [];
  }

  async enabledSince(): Promise<Date | undefined> {
    return undefined;
  }

  async removeAll(): Promise<void> {}
}

/** One state from several sources (`TwoFactorStore`, the passkey store): an account has every factor any source reports, each once. */
export function combineFactors(...sources: readonly TwoFactorState[]): TwoFactorState {
  const combined: TwoFactorState = {
    async factors(userId) {
      const lists = await Promise.all(sources.map((source) => source.factors(userId)));
      return [...new Set(lists.flat())];
    },
    async enabledSince(userId) {
      const dates = (await Promise.all(sources.map((source) => source.enabledSince(userId)))).filter((date): date is Date => date !== undefined);
      return dates.length === 0 ? undefined : new Date(Math.min(...dates.map((date) => date.getTime())));
    },
    async removeAll(userId) {
      for (const source of sources) await source.removeAll(userId);
    },
  };
  SOURCES.set(combined, sources);
  return combined;
}

const SOURCES = new WeakMap<TwoFactorState, readonly TwoFactorState[]>();

/** The states a state is made of: those {@link combineFactors} joined, down to the ones that read a table; the state itself otherwise. Package-internal. */
export function factorSources(state: TwoFactorState): readonly TwoFactorState[] {
  const parts = SOURCES.get(state);
  return parts ? parts.flatMap(factorSources) : [state];
}

/** A passkey's sign-in response as the browser sent it (`AuthenticationResponseJSON`) — opaque here; the passkeys service checks it. */
export type PasskeyAssertion = object;

/**
 * What a passkey check found: `valid`; `wrong` (a bad signature, a passkey that is unknown, another account's or suspended — a real wrong answer);
 * `stale` (no open challenge, an expired or used one, one of another purpose — a timeout or a double submit, which is no guess).
 */
export type PasskeyVerdict = 'valid' | 'wrong' | 'stale';

/**
 * Checks a passkey as the second factor of an account. The passkeys service binds itself here (`PasskeyServiceProvider`); the default
 * knows no passkeys and refuses every response, so an app without them never loads the WebAuthn library.
 */
export interface SecondFactorPasskeys {
  /**
   * Whether `assertion` proves a passkey of exactly `userId` right now: against the stored passkey (not what the sign-in saw), with the
   * open challenge of this account and of `during` (the waiting sign-in, or the signed-in session's step-up) used up either way. Never throws for a bad response — a verdict other than `valid`. Package-internal (a symbol key):
   * `TwoFactor` calls it after it has read the waiting sign-in and counted the attempt, so an app cannot call it without those.
   */
  [VERIFY_SECOND_FACTOR](userId: number | string, assertion: PasskeyAssertion, during?: 'sign-in' | 'step-up'): Promise<PasskeyVerdict>;
}
/** The key of {@link SecondFactorPasskeys.verify}'s method. */
export const VERIFY_SECOND_FACTOR = Symbol('marmeon.auth.verifySecondFactor');
export const SecondFactorPasskeys = token<SecondFactorPasskeys>('SecondFactorPasskeys');

/** The default {@link SecondFactorPasskeys}: no passkeys, every response refused. */
export class NoSecondFactorPasskeys implements SecondFactorPasskeys {
  async [VERIFY_SECOND_FACTOR](): Promise<PasskeyVerdict> {
    return 'wrong';
  }
}
