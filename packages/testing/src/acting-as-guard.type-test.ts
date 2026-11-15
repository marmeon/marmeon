// Type guarantees of `actingAs()` with a guard — checked by `tsc` (typecheck), never run.
import { defineGuard, defineGuardSlot, type AuthUser, type Credentials, type GuardDefinition, type UserProvider } from '@marmeon/auth';
import { authenticatedSession, cookieNames } from '@marmeon/auth/testing';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { expectTypeOf } from 'vitest';
import type { TestApp, TestResponse } from './index.ts';

interface AppUser {
  readonly id: number;
  readonly email: string;
}

// Applies to the whole packages/testing program, not to this file alone.
declare module '@marmeon/auth' {
  interface AuthTypes {
    user: AppUser;
  }
}

interface OfficeUser {
  readonly id: string;
  readonly name: string;
}

interface DepotUser {
  readonly id: string;
  readonly depot: string;
}

declare class OfficeUsers implements UserProvider<OfficeUser> {
  findById(id: string): Promise<Credentials<OfficeUser> | undefined>;
  findForSignIn(identifier: string): Promise<Credentials<OfficeUser> | undefined>;
  updatePasswordHash(id: string, hash: never, options?: { readonly expected?: never; readonly sessionKey?: string; readonly expectedSessionKey?: string | null }): Promise<boolean>;
  updateSessionKey(id: string, key: string, expected: string | null | undefined): Promise<boolean>;
  updateEverySessionKey(key: string): Promise<{ readonly accounts: number; readonly sampleId: string | undefined }>;
}

const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_' });
const FactorGuard = defineGuard('factor', { users: OfficeUsers, tablePrefix: 'factor_', twoFactor: TwoFactor });
const DepotSlot = defineGuardSlot<DepotUser>('depot');
const StaffSlot = defineGuardSlot<OfficeUser>('staff', { twoFactor: true });

declare const app: TestApp;
declare const container: Parameters<typeof authenticatedSession>[0];
declare const officeUser: OfficeUser;
declare const depotUser: DepotUser;
declare const appUser: AuthUser;
declare const maybeGuard: GuardDefinition<OfficeUser> | undefined;

export function actingAsTypes(): void {
  app.actingAs(appUser);
  app.actingAs(appUser, { guard: 'web' });
  app.actingAs(appUser, { guard: 'api', abilities: ['read'] });
  app.actingAs(officeUser, { guard: OfficeGuard });
  app.actingAs(officeUser, { guard: OfficeGuard, twoFactorAt: new Date(), confirmedAt: new Date() });
  app.actingAs(officeUser, { guard: FactorGuard, twoFactorAt: new Date() });
  app.actingAs(depotUser, { guard: DepotSlot });
  app.actingAs(officeUser, { guard: StaffSlot });

  // @ts-expect-error a user of another guard is not a user of this one (the guard's `name` is missing)
  app.actingAs(depotUser, { guard: OfficeGuard });
  // @ts-expect-error the guard's users are not the slot's users (the slot's `depot` is missing)
  app.actingAs(officeUser, { guard: DepotSlot });
  // @ts-expect-error the app's user has no `name`, which the guard's users have
  app.actingAs(appUser, { guard: OfficeGuard });
  // @ts-expect-error the second factor is dated with a Date
  app.actingAs(officeUser, { guard: OfficeGuard, twoFactorAt: Date.now() });
  // @ts-expect-error the password confirmation is dated with a Date
  app.actingAs(officeUser, { guard: OfficeGuard, confirmedAt: '2020-01-01' });
  // @ts-expect-error a guard is named by its definition, never by a string
  app.actingAs(officeUser, { guard: 'office' });
  // @ts-expect-error the app's guard takes no dates: only a package guard's session is dated
  app.actingAs(appUser, { guard: 'web', confirmedAt: new Date() });
  // @ts-expect-error a guard that may be undefined is refused: the app's user would be signed in instead
  app.actingAs(officeUser, { guard: maybeGuard });
}

export async function sessionHelperTypes(): Promise<void> {
  await authenticatedSession(container, appUser);
  await authenticatedSession(container, officeUser, OfficeGuard, { confirmedAt: new Date() });
  await authenticatedSession(container, officeUser, StaffSlot);
  // @ts-expect-error the guard's session is made for a user of the guard (the guard's `name` is missing)
  await authenticatedSession(container, depotUser, OfficeGuard);
  // @ts-expect-error a user without a guard is the app's, and the guard's user is not (the app's `email` is missing)
  await authenticatedSession(container, officeUser);
  // @ts-expect-error a guard passed as undefined would sign in the app's user of that id
  await authenticatedSession(container, officeUser, undefined);
  // @ts-expect-error a guard that may be undefined is refused for the same reason
  await authenticatedSession(container, officeUser, maybeGuard);
  cookieNames(app);
  cookieNames(app, OfficeGuard);
  cookieNames(app, DepotSlot);
  // @ts-expect-error a guard is named by its definition, never by a string
  cookieNames(app, 'office');
  // @ts-expect-error a guard that may be undefined is refused: the app's cookie would be named instead
  cookieNames(app, maybeGuard);
  // @ts-expect-error a guard passed as undefined is refused for the same reason
  cookieNames(app, undefined);
  const definition: GuardDefinition<OfficeUser> = OfficeGuard;
  cookieNames(app, definition);
}

/** What an app's wrapper written against the released signatures reads from them: the last overload. */
export function releasedShapes(): void {
  expectTypeOf<Parameters<TestApp['actingAs']>>().toEqualTypeOf<[user: AppUser, options?: { guard?: 'web' } | { guard: 'api'; abilities?: readonly string[] }]>();
  expectTypeOf<Parameters<typeof authenticatedSession>>().toEqualTypeOf<[container: Parameters<typeof authenticatedSession>[0], user: AppUser]>();
}

export async function assertionTypes(): Promise<void> {
  const response = await app.get('/');
  response.assertAuthenticated(appUser);
  response.assertAuthenticated();
  response.assertAuthenticated(officeUser, { guard: OfficeGuard });
  response.assertAuthenticated(undefined, { guard: DepotSlot });
  response.assertGuest();
  response.assertGuest({ guard: OfficeGuard });
  app.get('/').assertGuest({ guard: StaffSlot }).assertAuthenticated(officeUser, { guard: OfficeGuard });
  // @ts-expect-error a user of another guard is not a user of this one (the guard's `name` is missing)
  response.assertAuthenticated(depotUser, { guard: OfficeGuard });
  // @ts-expect-error a guard that may be undefined is refused: the app's session would be read instead
  response.assertGuest({ guard: maybeGuard });
  // @ts-expect-error a guard is named by its definition, never by a string
  response.assertGuest({ guard: 'office' });
  // @ts-expect-error a guard that may be undefined is refused here too
  app.get('/').assertGuest({ guard: maybeGuard });
  expectTypeOf<Parameters<TestResponse['assertAuthenticated']>>().toEqualTypeOf<[user?: AppUser]>();
  expectTypeOf<Parameters<TestResponse['assertGuest']>>().toEqualTypeOf<[]>();
}
