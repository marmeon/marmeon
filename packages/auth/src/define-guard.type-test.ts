// Type guarantees of `defineGuard()` — checked by `tsc` (typecheck), never run.
import type { Result, Token } from '@marmeon/core';
import type { MiddlewareClass } from '@marmeon/router';
import { expectTypeOf } from 'vitest';
import type { AccountSessions } from './account-sessions.ts';
import type { Auth, AttemptError } from './auth.ts';
import { defineGuard, type GuardAccountSessions, type GuardAuth, type GuardDefinition, type GuardOptions, type GuardPasskeys, type GuardPasskeysDefinition, type GuardPasswordBroker, type GuardTwoFactor, type GuardTwoFactorDefinition } from './define-guard.ts';
import type { PasswordBroker } from './password-reset.ts';
import { Passkeys, type PasskeyError } from './passkeys/passkeys.ts';
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

export function theOptionsPromiseWhatTheyDeliver() {
  // @ts-expect-error a guard typed as having two-factor authentication must be given the class
  const missing: GuardOptions<OfficeUser, typeof TwoFactor> = { users: OfficeUsers, tablePrefix: 'office_' };
  const promised = defineGuard('office', missing);
  promised.twoFactor;

  const given: GuardOptions<OfficeUser, typeof TwoFactor> = { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor };
  expectTypeOf(defineGuard('office', given).TwoFactor).toEqualTypeOf<Token<GuardTwoFactor<OfficeUser>>>();

  // The second generic stays optional: `GuardOptions<U>` has no `twoFactor`, or an undefined one.
  const plain: GuardOptions<OfficeUser> = { users: OfficeUsers, tablePrefix: 'office_' };
  const undefinedOption: GuardOptions<OfficeUser> = { users: OfficeUsers, tablePrefix: 'office_', twoFactor: undefined };
  expectTypeOf(defineGuard('office', plain)).toEqualTypeOf<GuardDefinition<OfficeUser>>();
  expectTypeOf(defineGuard('office', undefinedOption)).toEqualTypeOf<GuardDefinition<OfficeUser>>();
  // @ts-expect-error without the option the guard has no TwoFactor
  defineGuard('office', plain).TwoFactor;
  // @ts-expect-error GuardOptions<U> takes no TwoFactor class
  const wrong: GuardOptions<OfficeUser> = { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor };
  return wrong;
}

export function aMaybeOptionPromisesNothing(maybe: typeof TwoFactor | undefined) {
  // @ts-expect-error a value that may be undefined cannot promise the TwoFactor services
  defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', twoFactor: maybe });
  // @ts-expect-error naming the class as the second generic still needs the option
  defineGuard<OfficeUser, typeof TwoFactor>('office', { users: OfficeUsers, tablePrefix: 'office_' });
}

const PasskeysGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor, passkeys: Passkeys });

export async function passkeysTypes(passkeys: GuardPasskeys<OfficeUser, Passkeys>) {
  expectTypeOf(PasskeysGuard).toEqualTypeOf<GuardDefinition<OfficeUser> & GuardTwoFactorDefinition<OfficeUser> & GuardPasskeysDefinition<OfficeUser, Passkeys>>();
  expectTypeOf(PasskeysGuard.Passkeys).toEqualTypeOf<Token<GuardPasskeys<OfficeUser, Passkeys>>>();
  const signedIn = await passkeys.signIn({} as never);
  expectTypeOf(signedIn).toEqualTypeOf<Result<OfficeUser, PasskeyError>>();
  // What does not name a user is the app's service as it is.
  expectTypeOf(passkeys.list).toEqualTypeOf<Passkeys['list']>();
}

export function aGuardWithoutPasskeysHasNone() {
  // @ts-expect-error the guard was defined without `passkeys`
  TwoFactorGuard.Passkeys;
  // The type only asks for a class with a `signIn`; the brand of the Passkeys class is checked when `defineGuard()` runs (error A8).
  // @ts-expect-error a class without `signIn` is not the Passkeys class
  defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: class Other {} });
  // @ts-expect-error nor is the TwoFactor class, which has no `signIn`
  defineGuard('depot', { users: OfficeUsers, tablePrefix: 'depot_', twoFactor: TwoFactor, passkeys: TwoFactor });
}

export function thePasskeysOptionPromisesWhatItDelivers(maybe: typeof Passkeys | undefined) {
  // @ts-expect-error passkeys without twoFactor does not compile: a passkey is a second factor
  defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', passkeys: Passkeys });
  // @ts-expect-error nor does the option type, with no TwoFactor class to go with it
  const noFactor: GuardOptions<OfficeUser, undefined, typeof Passkeys> = { users: OfficeUsers, tablePrefix: 'office_', passkeys: Passkeys };
  void noFactor;
  // @ts-expect-error a guard typed as having passkeys must be given the class
  const missing: GuardOptions<OfficeUser, typeof TwoFactor, typeof Passkeys> = { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor };
  defineGuard('office', missing).Passkeys;

  const given: GuardOptions<OfficeUser, typeof TwoFactor, typeof Passkeys> = { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor, passkeys: Passkeys };
  expectTypeOf(defineGuard('office', given).Passkeys).toEqualTypeOf<Token<GuardPasskeys<OfficeUser, Passkeys>>>();

  // The third generic stays optional: `GuardOptions<U, TF>` has no `passkeys`, or an undefined one.
  const plain: GuardOptions<OfficeUser, typeof TwoFactor> = { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor, passkeys: undefined };
  // @ts-expect-error without the option the guard has no Passkeys
  defineGuard('office', plain).Passkeys;
  // @ts-expect-error GuardOptions<U, TF> takes no Passkeys class
  const wrong: GuardOptions<OfficeUser, typeof TwoFactor> = { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor, passkeys: Passkeys };

  // @ts-expect-error a value that may be undefined cannot promise the Passkeys services
  defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor, passkeys: maybe });
  // @ts-expect-error naming the class as the third generic still needs the option
  defineGuard<OfficeUser, typeof TwoFactor, typeof Passkeys>('office', { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor });
  return wrong;
}
