import { RecordEditorSignIn, EditorSlot } from '@fixtures/back-office';
import { defineModule, listen } from '@marmeon/core';
import { OfficeAccessServiceProvider } from './OfficeAccessServiceProvider.ts';
import { OfficeUsersSeeder } from './OfficeUsersSeeder.ts';

// The tables of @fixtures/back-office: `marmeon publish @fixtures/back-office` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'back-office',
  // `BACK_OFFICE_USERS=app` only: who is an editor among the app's users.
  providers: [OfficeAccessServiceProvider],
  // The package never registers listeners: the app lists the one that records editor sign-ins, whichever users the back office runs on.
  listeners: [listen(EditorSlot.events.SignedIn, RecordEditorSignIn)],
  migrations: new URL('./migrations/', import.meta.url),
  seeders: [OfficeUsersSeeder],
});
