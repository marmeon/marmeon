// Type guarantees of `defineGuard()` — checked by `tsc` (typecheck), never run.
import type { Result, Token } from '@marmeon/core';
import { expectTypeOf } from 'vitest';
import type { AccountSessions } from './account-sessions.ts';
import type { Auth, AttemptError } from './auth.ts';
import { defineGuard, type GuardAccountSessions, type GuardAuth, type GuardDefinition, type GuardPasswordBroker } from './define-guard.ts';
import type { PasswordBroker } from './password-reset.ts';
import type { AuthUser, Credentials, UserProvider } from './user.ts';

interface OfficeUser {
  readonly id: string;
  readonly name: string;
}

declare class OfficeUsers implements UserProvider<OfficeUser> {
  findById(id: string): Promise<Credentials<OfficeUser> | undefined>;
  findForSignIn(identifier: string): Promise<Credentials<OfficeUser> | undefined>;
  updatePasswordHash(id: string, hash: never, options?: { readonly expected?: never; readonly sessionKey?: string; readonly expectedSessionKey?: string | null }): Promise<boolean>;
  updateSessionKey(id: string, key: string, expected: string | null | undefined): Promise<boolean>;
  updateEverySessionKey(key: string): Promise<{ readonly accounts: number; readonly sampleId: string | undefined }>;
}

const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_' });

export async function guardTypes(auth: GuardAuth<OfficeUser>, accounts: GuardAccountSessions<OfficeUser>, broker: GuardPasswordBroker<OfficeUser>) {
  expectTypeOf(OfficeGuard).toEqualTypeOf<GuardDefinition<OfficeUser>>();
  expectTypeOf(OfficeGuard.Auth).toEqualTypeOf<Token<GuardAuth<OfficeUser>>>();
  expectTypeOf(OfficeGuard.AccountSessions).toEqualTypeOf<Token<GuardAccountSessions<OfficeUser>>>();
  expectTypeOf(OfficeGuard.PasswordBroker).toEqualTypeOf<Token<GuardPasswordBroker<OfficeUser>>>();

  const attempted = await auth.attempt('ada@example.com', 'secret');
  expectTypeOf(attempted).toEqualTypeOf<Result<OfficeUser, AttemptError>>();
  expectTypeOf(await auth.user()).toEqualTypeOf<OfficeUser | undefined>();
  expectTypeOf(await auth.id()).toEqualTypeOf<string | undefined>();
  await auth.signIn({ id: 'a', name: 'Ada' });
  // @ts-expect-error the app's user is not a user of the guard
  await auth.signIn({ id: 1, name: 'Ada', email: 'ada@example.com' } satisfies AuthUser);

  await accounts.end('a');
  // @ts-expect-error the id of the guard's users is a string
  await accounts.end(1);

  const token = await broker.createToken('ada@example.com');
  if (token.ok) expectTypeOf(token.value.user).toEqualTypeOf<OfficeUser>();
  const reset = await broker.reset('ada@example.com', 'token', 'password');
  if (reset.ok) expectTypeOf(reset.value).toEqualTypeOf<OfficeUser>();
}

export async function theAppsServicesAreUnchanged(auth: Auth, accounts: AccountSessions, broker: PasswordBroker) {
  expectTypeOf(await auth.user()).toEqualTypeOf<AuthUser | undefined>();
  expectTypeOf(accounts.end).parameter(0).toEqualTypeOf<AuthUser extends { readonly id: infer Id } ? Id : never>();
  expectTypeOf(await broker.reset('a', 'b', 'c')).toEqualTypeOf<Awaited<ReturnType<PasswordBroker['reset']>>>();
}

// @ts-expect-error `users` is a class, not an instance
defineGuard('office', { users: new OfficeUsers(), tablePrefix: 'office_' });
// @ts-expect-error the table prefix is required
defineGuard('office', { users: OfficeUsers });
// @ts-expect-error a setting that does not exist
defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', settings: { rememberDay: 1 } });
