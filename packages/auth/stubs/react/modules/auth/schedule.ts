import { defineSchedule } from '@marmeon/scheduler';
import { PruneEmailChanges } from './tasks/PruneEmailChanges.ts';

// The auth module's scheduled work — `marmeon schedule:work` runs it (`marmeon dev` starts one), `marmeon schedule:list`
// shows it. Expired reset, remember-me and API tokens are deleted at night; with several servers by one of them only
// (onOneServer() needs a cache they share: CACHE_DRIVER=database or redis). Private registration: the changes of address
// nobody confirmed in time are cleared at the same hour.
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').onOneServer();
  s.call(PruneEmailChanges).daily().at('03:10').onOneServer().name('auth.prune-email-changes');
  // Accounts whose address was never confirmed — opt-in, your app's decision: turn this line on to delete them at 03:20
  // once AUTH_UNVERIFIED_DAYS (default 7) have passed since the sign-up. It ends whoever signed up with somebody else's address
  // holding it (pre-hijacked accounts) and keeps no data of sign-ups nobody finished (data minimization) — and it is irreversible:
  // with AUTH_PRIVATE_REGISTRATION=false such accounts were signed in and may have used the app. An account confirmed once
  // (first_verified_at) is never deleted. Leave it off where unconfirmed accounts belong to your model (an invited team, an import);
  // `marmeon auth:prune-unverified` deletes them by hand — commands/PruneUnverifiedCommand.ts, through AccountDeletion.
  // s.command('auth:prune-unverified').daily().at('03:20').onOneServer();
});
