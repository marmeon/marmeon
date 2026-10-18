// Type guarantees of `Auth.attempt()` and `Auth.login()` — checked by `tsc` (typecheck), never run.
import { expectTypeOf } from 'vitest';
import type { AccountSessions } from './account-sessions.ts';
import type { Auth } from './auth.ts';
import type { Hasher, PasswordHash } from './hashing.ts';
import { PasswordResetTokenStore } from './password-reset.ts';
import { AccessTokenStore } from './tokens.ts';
import { TwoFactorState } from './two-factor/state.ts';
import type { PasskeyRecord } from './passkeys/store.ts';
import type { AccessToken } from './tokens.ts';
import type { AuthUserId, Credentials, UserProvider } from './user.ts';

declare const auth: Auth;
declare const accountSessions: AccountSessions;

export async function exhaustive() {
  const result = await auth.attempt('ada@example.com', 'secret');
  if (!result.ok) {
    switch (result.error.kind) {
      case 'invalid-credentials':
        return 'invalid';
      case 'two-factor-required':
        return result.error.factors;
    }
  }
  return undefined;
}

export async function missingCase() {
  const result = await auth.attempt('ada@example.com', 'secret');
  if (!result.ok) {
    switch (result.error.kind) {
      case 'invalid-credentials':
        return 'invalid';
      default:
        // @ts-expect-error the new `two-factor-required` case has to be handled
        result.error.kind satisfies 'invalid-credentials';
    }
  }
  return undefined;
}

export async function loginResult() {
  const outcome: 'signed-in' | 'two-factor-required' = await auth.login({} as never);
  // @ts-expect-error login() no longer returns nothing
  const nothing: void = await auth.login({} as never);
  return [outcome, nothing];
}

export async function signInsAreReadOnly() {
  // @ts-expect-error an id is a string
  await auth.endSignIn(1);
  const [signIn] = await auth.signIns();
  // @ts-expect-error a listed sign-in is read-only
  signIn!.current = false;
  const ended = await auth.endSignIn('id');
  if (!ended.ok) {
    const kind: 'missing' | 'current' = ended.error.kind;
    return kind;
  }
  return undefined;
}

export async function everyoneEndedIsReadOnly() {
  const ended = await accountSessions.endEveryone();
  // @ts-expect-error what endEveryone() did is read-only
  ended.accounts = 1;
  return ended.rememberTokens + ended.signIns;
}

// A provider keeps the whole contract: the session-key methods, and a password write that says whether it wrote.
export const fullProvider: UserProvider = {
  findById: async () => undefined,
  findForLogin: async () => undefined,
  updatePasswordHash: async (_id, _hash, _options): Promise<boolean> => true,
  updateSessionKey: async (): Promise<boolean> => true,
  updateEverySessionKey: async () => ({ accounts: 0, sampleId: undefined }),
};
// @ts-expect-error updateSessionKey() is required: without it nobody could be signed out
export const withoutSessionKey: UserProvider = { ...fullProvider, updateSessionKey: undefined };
// @ts-expect-error updateEverySessionKey() is required
export const withoutEveryKey: UserProvider = { ...fullProvider, updateEverySessionKey: undefined };
export const wrongProvider: UserProvider = {
  ...fullProvider,
  // @ts-expect-error updatePasswordHash() answers whether it wrote — nothing is not an answer
  updatePasswordHash: async (): Promise<void> => {},
};
export const blindProvider: UserProvider = {
  ...fullProvider,
  // @ts-expect-error the old third parameter, the expected hash, is an option now
  updatePasswordHash: async (_id: number, _hash: PasswordHash, _expected?: PasswordHash): Promise<boolean> => true,
};
// @ts-expect-error Credentials without sessionKey
export const keylessCredentials: Credentials = { user: { id: 1 } as never, passwordHash: null };

export async function endEveryoneKnowsItsOptions() {
  await accountSessions.endEveryone({ accessTokens: false, resetTokens: false });
  // @ts-expect-error an unknown option is refused
  await accountSessions.endEveryone({ passkeys: true });
}

// The stores are abstract classes: a store extends one and implements every method, none has a default.
export class CompleteResets extends PasswordResetTokenStore {
  async create() {
    return { ok: true as const, value: 'token' };
  }
  async consume() {
    return { ok: true as const, value: undefined };
  }
  async forget() {}
  async prune() {
    return 0;
  }
  async forgetEveryone() {
    return 0;
  }
}
// @ts-expect-error forgetEveryone() is required: without it the emergency switch would leave reset links alive
export class ResetsWithoutEveryone extends PasswordResetTokenStore {
  async create() {
    return { ok: true as const, value: 'token' };
  }
  async consume() {
    return { ok: true as const, value: undefined };
  }
  async forget() {}
  async prune() {
    return 0;
  }
}

// @ts-expect-error a store that only implements the contract does not fit: it has to extend the class
export class ResetsByImplements implements PasswordResetTokenStore {
  async create() {
    return { ok: true as const, value: 'token' };
  }
  async consume() {
    return { ok: true as const, value: undefined };
  }
  async forget() {}
  async prune() {
    return 0;
  }
  async forgetEveryone() {
    return 0;
  }
}
// @ts-expect-error an object literal is no PasswordResetTokenStore either
export const resetsLiteral: PasswordResetTokenStore = { create: async () => ({ ok: true as const, value: 'token' }), consume: async () => ({ ok: true as const, value: undefined }), forget: async () => {}, prune: async () => 0, forgetEveryone: async () => 0 };

export class CompleteTokens extends AccessTokenStore {
  async create(): Promise<never> {
    throw new Error('unused');
  }
  async find() {
    return undefined;
  }
  async touch() {}
  async list() {
    return [];
  }
  async revoke() {
    return false;
  }
  async revokeAll() {
    return 0;
  }
  async prune() {
    return 0;
  }
  async revokeEveryone() {
    return 0;
  }
}
// @ts-expect-error revokeEveryone() is required: without it the emergency switch would leave API tokens alive
export class TokensWithoutEveryone extends AccessTokenStore {
  async create(): Promise<never> {
    throw new Error('unused');
  }
  async find() {
    return undefined;
  }
  async touch() {}
  async list() {
    return [];
  }
  async revoke() {
    return false;
  }
  async revokeAll() {
    return 0;
  }
  async prune() {
    return 0;
  }
}
// @ts-expect-error a store that only implements the contract does not fit: it has to extend the class
export class TokensByImplements implements AccessTokenStore {
  async create(): Promise<never> {
    throw new Error('unused');
  }
  async find() {
    return undefined;
  }
  async touch() {}
  async list() {
    return [];
  }
  async revoke() {
    return false;
  }
  async revokeAll() {
    return 0;
  }
  async prune() {
    return 0;
  }
  async revokeEveryone() {
    return 0;
  }
}
// @ts-expect-error an object literal is no AccessTokenStore either
export const tokensLiteral: AccessTokenStore = { create: async () => ({}) as never, find: async () => undefined, touch: async () => {}, list: async () => [], revoke: async () => false, revokeAll: async () => 0, prune: async () => 0, revokeEveryone: async () => 0 };

export class CompleteFactors extends TwoFactorState {
  async factors() {
    return [];
  }
  async enabledSince() {
    return undefined;
  }
  async removeAll() {}
}
// @ts-expect-error removeAll() is required: a reset would leave a factor standing
export class FactorsWithoutRemoveAll extends TwoFactorState {
  async factors() {
    return [];
  }
  async enabledSince() {
    return undefined;
  }
}
// @ts-expect-error a source that only implements the contract does not fit: it has to extend the class
export class FactorsByImplements implements TwoFactorState {
  async factors() {
    return [];
  }
  async enabledSince() {
    return undefined;
  }
  async removeAll() {}
}

// @ts-expect-error an object literal is no TwoFactorState either
export const factorsLiteral: TwoFactorState = { factors: async () => [], enabledSince: async () => undefined, removeAll: async () => {} };

declare const tokens: AccessTokenStore;
export async function userIdIsTheApps() {
  await tokens.revokeAll(1);
  // @ts-expect-error the package's test user has a number as its id, and the stores take that type
  await tokens.revokeAll('1');
}

// A hasher states how long a failed sign-in is padded to.
declare const hasherParts: Omit<Hasher, 'failureFloorMs'>;
export const fullHasher: Hasher = { ...hasherParts, failureFloorMs: () => 0 };
// @ts-expect-error failureFloorMs() is required: without it the response time tells which addresses have an account
export const floorlessHasher: Hasher = { ...hasherParts };

// The id every store takes is the app's: AuthUserId, in each method and in the records that carry one.
declare const factors: TwoFactorState;
export function storesTakeTheAppsUserId() {
  expectTypeOf<Parameters<AccessTokenStore['create']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<AccessTokenStore['list']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<AccessTokenStore['revoke']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<AccessTokenStore['revokeAll']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<TwoFactorState['factors']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<TwoFactorState['enabledSince']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<TwoFactorState['removeAll']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<AccessToken['userId']>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<PasskeyRecord['userId']>().toEqualTypeOf<AuthUserId>();
  // @ts-expect-error the package's test user has a number as its id
  return factors.factors('1');
}
