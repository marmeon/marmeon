// Type guarantees of `Auth.attempt()` and `Auth.login()` — checked by `tsc` (typecheck), never run.
import type { AccountSessions } from './account-sessions.ts';
import type { Auth } from './auth.ts';
import type { PasswordHash } from './hashing.ts';
import type { Credentials, UserProvider } from './user.ts';

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
