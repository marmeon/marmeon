// Type guarantees of `defineGuard()` — checked by `tsc` (typecheck), never run.
import type { Result, Token } from '@marmeon/core';
import type { MiddlewareClass } from '@marmeon/router';
import { expectTypeOf } from 'vitest';
import type { AccountSessions } from './account-sessions.ts';
import type { Auth, AttemptError } from './auth.ts';
import { defineGuard, type GuardAccountSessions, type GuardAuth, type GuardDefinition, type GuardPasswordBroker, type GuardTwoFactor, type GuardTwoFactorDefinition } from './define-guard.ts';
import type { PasswordBroker } from './password-reset.ts';
import type { ChallengeError } from './two-factor/two-factor.ts';
import { TwoFactor } from './two-factor/two-factor.ts';
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

export function guardMiddlewareTypes() {
  expectTypeOf(OfficeGuard.authenticate({ loginRoute: 'office.login' })).toEqualTypeOf<MiddlewareClass<{}, { readonly user: OfficeUser }>>();
  expectTypeOf(OfficeGuard.confirmedPassword({ confirmRoute: 'office.confirm' })).toEqualTypeOf<MiddlewareClass<{ readonly user: OfficeUser }, {}>>();
  expectTypeOf(OfficeGuard.guest({ homeRoute: 'office.home' })).toEqualTypeOf<MiddlewareClass<{}, {}>>();
  expectTypeOf(OfficeGuard.throttle('login')).toEqualTypeOf<MiddlewareClass<{}, {}>>();

  // @ts-expect-error the app's login page is the app's: the guard names its own
  OfficeGuard.authenticate();
  // @ts-expect-error the app's confirmation page is the app's
  OfficeGuard.confirmedPassword({});
  // @ts-expect-error the guest's home is required too
  OfficeGuard.guest({});
  // @ts-expect-error only the limits of the auth routes
  OfficeGuard.throttle('invoices');
  // @ts-expect-error a guard has no e-mail verification
  OfficeGuard.throttle('verification');
  // @ts-expect-error nor a change of address
  OfficeGuard.throttle('email-change');
  // @ts-expect-error the limiter's full name is not the guard's name for it
  OfficeGuard.throttle('auth.login');
}

const TwoFactorGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor });

export async function twoFactorTypes(factor: GuardTwoFactor<OfficeUser>) {
  expectTypeOf(TwoFactorGuard).toEqualTypeOf<GuardDefinition<OfficeUser> & GuardTwoFactorDefinition<OfficeUser>>();
  expectTypeOf(TwoFactorGuard.TwoFactor).toEqualTypeOf<Token<GuardTwoFactor<OfficeUser>>>();
  const challenged = await factor.challenge({ code: '123456' });
  expectTypeOf(challenged).toEqualTypeOf<Result<OfficeUser, ChallengeError>>();
  expectTypeOf(TwoFactorGuard.twoFactor({ setup: 'a', verify: 'b', loginRoute: 'c' } as never)).toEqualTypeOf<MiddlewareClass<{ readonly user: OfficeUser }, {}>>();
  // @ts-expect-error the guard's login page is the guard's own
  TwoFactorGuard.twoFactor({ setup: 'a', verify: 'b' });
  // @ts-expect-error the guard's login page is the guard's own
  TwoFactorGuard.confirmedSecondFactor({ verify: 'b' });
}

export function aGuardWithoutTwoFactorHasNone() {
  // @ts-expect-error the guard was defined without `twoFactor`
  OfficeGuard.TwoFactor;
  // @ts-expect-error the guard was defined without `twoFactor`
  OfficeGuard.twoFactor({ setup: 'a', verify: 'b', loginRoute: 'c' });
  // @ts-expect-error only the TwoFactor class is one
  defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: class Other {} });
}
