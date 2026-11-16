import {
  EditorSlot,
  NotifyEditorOfPasskeyAdded,
  NotifyEditorOfSignIn,
  NotifyEditorOfTwoFactorDisabled,
  NotifyEditorOfTwoFactorEnabled,
  OfficeGuard,
  RecordEditorSignIn,
} from '@fixtures/back-office';
import { defineModule, listen } from '@marmeon/core';
import { OfficeAccessServiceProvider } from './OfficeAccessServiceProvider.ts';
import { OfficeUsersSeeder } from './OfficeUsersSeeder.ts';

// The tables of @fixtures/back-office: `marmeon publish @fixtures/back-office` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'back-office',
  // `BACK_OFFICE_USERS=app` only: who is an editor among the app's users.
  providers: [OfficeAccessServiceProvider],
  // The package never registers listeners: the app lists the one that records editor sign-ins, whichever users the back office runs on, and the four
  // that mail the editors (the mode `own`).
  listeners: [
    listen(EditorSlot.events.SignedIn, RecordEditorSignIn),
    // The mails to the editors go through the guard's own events, never the app's: a listener of the app would mail the customer with the same id. They are
    // for the mode `own`; in the mode `app` the guard has no users and raises nothing.
    listen(OfficeGuard.events.SignedIn, NotifyEditorOfSignIn),
    listen(OfficeGuard.events.TwoFactorEnabled, NotifyEditorOfTwoFactorEnabled),
    listen(OfficeGuard.events.TwoFactorDisabled, NotifyEditorOfTwoFactorDisabled),
    listen(OfficeGuard.events.PasskeyRegistered, NotifyEditorOfPasskeyAdded),
  ],
  migrations: new URL('./migrations/', import.meta.url),
  seeders: [OfficeUsersSeeder],
});
