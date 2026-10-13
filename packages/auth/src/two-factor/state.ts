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
}
export const TwoFactorState = token<TwoFactorState>('TwoFactorState');

/** The default {@link TwoFactorState}: no account has a factor, and nothing is queried. */
export class NoTwoFactorState implements TwoFactorState {
  async factors(): Promise<readonly SecondFactor[]> {
    return [];
  }
}

/** One state from several sources (`TwoFactorStore`, the passkey store): an account has every factor any source reports, each once. */
export function combineFactors(...sources: readonly TwoFactorState[]): TwoFactorState {
  return {
    async factors(userId) {
      const lists = await Promise.all(sources.map((source) => source.factors(userId)));
      return [...new Set(lists.flat())];
    },
  };
}
