import { defineGuard, defineGuardSlot, type GuardAccountSessions, type GuardAuth } from '@marmeon/auth';
import { OfficeUserRepository } from './OfficeUserRepository.ts';
import type { EditorUser, OfficeUser } from './OfficeUser.ts';

/** The guard of the back office's own editors: their table `office_users`, their sign-ins in `office_sign_ins`, a working day of eight hours and no "keep me signed in". */
export const OfficeGuard = defineGuard('office', {
  users: OfficeUserRepository,
  tablePrefix: 'office_',
  settings: { sessionMaxHours: 8, rememberDays: 0 },
});

// A type alias and a constant of the same name: a controller takes `auth: OfficeAuth`, and the container finds the guard's service.
export type OfficeAuth = GuardAuth<OfficeUser>;
export const OfficeAuth = OfficeGuard.Auth;
export type OfficeAccountSessions = GuardAccountSessions<OfficeUser>;
export const OfficeAccountSessions = OfficeGuard.AccountSessions;

/** The editors, whoever they are: the guard's users in the own mode, the app's users in the other. The back office's policy and overview name the slot. */
export const EditorSlot = defineGuardSlot<EditorUser>('editor');
