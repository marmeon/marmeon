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
}

/** One state from several sources (`TwoFactorStore`, the passkey store): an account has every factor any source reports, each once. */
export function combineFactors(...sources: readonly TwoFactorState[]): TwoFactorState {
  return {
    async factors(userId) {
      const lists = await Promise.all(sources.map((source) => source.factors(userId)));
      return [...new Set(lists.flat())];
    },
    async enabledSince(userId) {
      const dates = (await Promise.all(sources.map((source) => source.enabledSince(userId)))).filter((date): date is Date => date !== undefined);
      return dates.length === 0 ? undefined : new Date(Math.min(...dates.map((date) => date.getTime())));
    },
  };
}
