// Type guarantees of `Auth.attempt()` and `Auth.login()` — checked by `tsc` (typecheck), never run.
import type { Auth } from './auth.ts';

declare const auth: Auth;

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
