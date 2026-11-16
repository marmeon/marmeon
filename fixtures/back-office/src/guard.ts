import { defineGuard, defineGuardSlot, type GuardAccountSessions, type GuardAuth, type GuardPasskeys, type GuardTwoFactor } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { OfficeUserRepository } from './OfficeUserRepository.ts';
import type { EditorUser, OfficeUser } from './OfficeUser.ts';

/**
 * The guard of the back office's own editors: their table `office_users`, their sign-ins in `office_sign_ins`, an authenticator app with recovery codes
 * (`office_two_factor_*`) and passkeys (`office_passkeys`), a working day of eight hours and no "keep me signed in".
 */
export const OfficeGuard = defineGuard('office', {
  users: OfficeUserRepository,
  tablePrefix: 'office_',
  twoFactor: TwoFactor,
  passkeys: Passkeys,
  settings: { sessionMaxHours: 8, rememberDays: 0, twoFactorIssuer: 'Back Office' },
});

// A type alias and a constant of the same name: a controller takes `auth: OfficeAuth`, and the container finds the guard's service.
export type OfficeAuth = GuardAuth<OfficeUser>;
export const OfficeAuth = OfficeGuard.Auth;
export type OfficeAccountSessions = GuardAccountSessions<OfficeUser>;
export const OfficeAccountSessions = OfficeGuard.AccountSessions;
export type OfficeTwoFactor = GuardTwoFactor<OfficeUser>;
export const OfficeTwoFactor = OfficeGuard.TwoFactor;
export type OfficePasskeys = GuardPasskeys<OfficeUser, Passkeys>;
export const OfficePasskeys = OfficeGuard.Passkeys;

/**
 * The editors, whoever they are: the guard's users in the own mode, the app's users in the other. The back office's policy and overview name the slot.
 * It has no `twoFactor` option, so it forwards no `twoFactor()` middleware: that one would force every editor to set up a factor. Neither mode does. An editor
 * with a factor is asked for it at the guard's sign-in, and an app user at the app's. The package's `confirmedSecondFactor()` is the guard's own, since those
 * routes exist in the mode `own` only, and it demands nothing of an editor who has no factor.
 */
export const EditorSlot = defineGuardSlot<EditorUser>('editor');
