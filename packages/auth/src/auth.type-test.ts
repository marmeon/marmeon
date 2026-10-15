// Type guarantees of `Auth.attempt()` and `Auth.login()` — checked by `tsc` (typecheck), never run.
import type { AccountSessions } from './account-sessions.ts';
import type { Auth } from './auth.ts';
import type { PasswordHash } from './hashing.ts';
import type { UserProvider } from './user.ts';

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

// A provider written before `expected` existed (it returns nothing) is still a provider; one that answers with something else is not.
export const oldProvider: UserProvider = {
  findById: async () => undefined,
  findForLogin: async () => undefined,
  updatePasswordHash: async (_id: unknown, _hash: PasswordHash): Promise<void> => {},
};
export const casProvider: UserProvider = { ...oldProvider, updatePasswordHash: async (_id, _hash, _expected?: PasswordHash): Promise<boolean> => true };
export const wrongProvider: UserProvider = {
  ...oldProvider,
  // @ts-expect-error updatePasswordHash() answers a boolean or nothing
  updatePasswordHash: async (): Promise<string> => 'written',
};

export async function endEveryoneKnowsItsOptions() {
  await accountSessions.endEveryone({ accessTokens: false, resetTokens: false });
  // @ts-expect-error an unknown option is refused
  await accountSessions.endEveryone({ passkeys: true });
}
