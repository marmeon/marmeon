// Type guarantees of `Auth.attempt()` and `Auth.login()` — checked by `tsc` (typecheck), never run.
import { expectTypeOf } from 'vitest';
import type { AccountSessions } from './account-sessions.ts';
import type { Auth } from './auth.ts';
import { Lockout } from './events.ts';
import type { Hasher, PasswordHash } from './hashing.ts';
import { PasswordResetTokenStore } from './password-reset.ts';
import { SignInStore, type RememberedDevice, type RememberTokenError, type SignInRecord } from './sign-ins.ts';
import { AccessTokenStore } from './tokens.ts';
import { TwoFactorState } from './two-factor/state.ts';
import type { TwoFactor } from './two-factor/two-factor.ts';
import type { PasswordCheckError } from './password-throttle.ts';
import type { PasskeyRecord } from './passkeys/store.ts';
import type { AccessToken } from './tokens.ts';
import type { Result } from '@marmeon/core';
import type { AuthUserId, Credentials, UserProvider } from './user.ts';

declare const auth: Auth;
declare const twoFactor: TwoFactor;
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
  return ended.resetTokens + ended.signIns;
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

// The same for the sign-ins: a store extends the class and implements every method — the remember-me ones included.
export class CompleteSignIns extends SignInStore {
  async create() {
    return 'id';
  }
  async seen() {
    return true;
  }
  async list(): Promise<readonly SignInRecord[]> {
    return [];
  }
  async end() {
    return false;
  }
  async endAll() {
    return 0;
  }
  async endEveryone() {
    return 0;
  }
  async prune() {
    return 0;
  }
  async issueToken() {
    return 'selector.validator';
  }
  async dropToken() {}
  async consume(): Promise<Result<RememberedDevice, RememberTokenError>> {
    return { ok: false, error: { kind: 'invalid' } };
  }
  async remembered() {
    return false;
  }
  async forgetToken() {}
  async rebind(): Promise<Result<void, RememberTokenError>> {
    return { ok: true, value: undefined };
  }
}
// @ts-expect-error consume() is required: without it no remember-me cookie could be checked, or a copy of one reported
export class SignInsWithoutConsume extends SignInStore {
  async create() {
    return 'id';
  }
  async seen() {
    return true;
  }
  async list(): Promise<readonly SignInRecord[]> {
    return [];
  }
  async end() {
    return false;
  }
  async endAll() {
    return 0;
  }
  async endEveryone() {
    return 0;
  }
  async prune() {
    return 0;
  }
  async issueToken() {
    return 'selector.validator';
  }
  async dropToken() {}
  async remembered() {
    return false;
  }
  async forgetToken() {}
  async rebind(): Promise<Result<void, RememberTokenError>> {
    return { ok: true, value: undefined };
  }
}
// @ts-expect-error a store that only implements the contract does not fit: it has to extend the class
export class SignInsByImplements implements SignInStore {
  async create() {
    return 'id';
  }
  async seen() {
    return true;
  }
  async list(): Promise<readonly SignInRecord[]> {
    return [];
  }
  async end() {
    return false;
  }
  async endAll() {
    return 0;
  }
  async endEveryone() {
    return 0;
  }
  async prune() {
    return 0;
  }
  async issueToken() {
    return 'selector.validator';
  }
  async dropToken() {}
  async consume(): Promise<Result<RememberedDevice, RememberTokenError>> {
    return { ok: false, error: { kind: 'invalid' } };
  }
  async remembered() {
    return false;
  }
  async forgetToken() {}
  async rebind(): Promise<Result<void, RememberTokenError>> {
    return { ok: true, value: undefined };
  }
}
// @ts-expect-error an object literal is no SignInStore either
export const signInsLiteral: SignInStore = {
  create: async () => 'id',
  seen: async () => true,
  list: async () => [],
  end: async () => false,
  endAll: async () => 0,
  endEveryone: async () => 0,
  prune: async () => 0,
  issueToken: async () => 'selector.validator',
  dropToken: async () => {},
  consume: async () => ({ ok: false, error: { kind: 'invalid' } }),
  remembered: async () => false,
  forgetToken: async () => {},
  rebind: async () => ({ ok: true, value: undefined }),
};

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
  expectTypeOf<Parameters<SignInStore['create']>[0]['userId']>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<SignInStore['seen']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<SignInStore['list']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<SignInStore['end']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<SignInStore['endAll']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<SignInStore['issueToken']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<SignInStore['dropToken']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<Parameters<SignInStore['rebind']>[0]>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<SignInRecord['userId']>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<RememberedDevice['userId']>().toEqualTypeOf<AuthUserId>();
  // The window of a prune is not optional any more: a store that forgets the days leaves tokens a raised setting would revive.
  // @ts-expect-error the number of days is required
  void ((store: SignInStore) => store.prune({ idleSeconds: 1, maxSeconds: 1 }));
  expectTypeOf<AccessToken['userId']>().toEqualTypeOf<AuthUserId>();
  expectTypeOf<PasskeyRecord['userId']>().toEqualTypeOf<AuthUserId>();
  // @ts-expect-error the package's test user has a number as its id
  return factors.factors('1');
}

export async function checkPasswordIsAResult() {
  const checked = await auth.checkPassword('secret');
  expectTypeOf(checked).toEqualTypeOf<Result<void, PasswordCheckError>>();
  if (!checked.ok) {
    switch (checked.error.kind) {
      case 'invalid-password':
        return 'invalid';
      case 'throttled':
        return checked.error.retryAfter;
    }
  }
  return undefined;
}

export async function theUnthrottledChecksAreGone() {
  // @ts-expect-error a Result is always truthy, so `if (await auth.confirmPassword(p))` would pass every check: the method is gone
  await auth.confirmPassword('secret');
  // @ts-expect-error replaced by `checkPassword()` followed by `updateSessionKey()`
  await auth.logoutOtherDevices('secret');
}

export async function disablingTwoFactorIsAResult() {
  expectTypeOf(await twoFactor.disable('secret')).toEqualTypeOf<Result<void, PasswordCheckError>>();
  // @ts-expect-error a Result is not a boolean: `if (await twoFactor.disable(p))` would be true for a wrong password
  const disabled: boolean = await twoFactor.disable('secret');
  return disabled;
}

// A Lockout says which limit it is: building one without `scope` is a type error.
// @ts-expect-error scope is required
new Lockout('ada@example.com', '203.0.113.1');
expectTypeOf(new Lockout('ada@example.com', undefined, 'client').scope).toEqualTypeOf<'client' | 'account'>();
