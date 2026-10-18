import { defineSchedule } from '@marmeon/scheduler';

// The auth module's scheduled work — `marmeon schedule:work` runs it (`marmeon dev` starts one), `marmeon schedule:list`
// shows it. Expired reset, remember-me and API tokens are deleted at night; with several servers by one of them only
// (onOneServer() needs a cache they share: CACHE_DRIVER=database or redis). The changes of address nobody confirmed in time
// (private registration) go with them.
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').onOneServer();
  // Accounts whose address was never confirmed — opt-in: turn this line on to delete them at 03:20 once AUTH_UNVERIFIED_DAYS
  // (default 7) have passed since the sign-up (pre-hijacked accounts, data minimization). Irreversible — see the command; an
  // account confirmed once is never deleted. Leave it off where unconfirmed accounts belong to your model (an invited team, an
  // import); `marmeon auth:prune-unverified` deletes them by hand (commands/PruneUnverifiedCommand.ts).
  // s.command('auth:prune-unverified').daily().at('03:20').onOneServer();
});
