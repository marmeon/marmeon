import { defineSchedule } from '@marmeon/scheduler';
import { PruneEmailChanges } from './tasks/PruneEmailChanges.ts';

// The auth module's scheduled work — `marmeon schedule:work` runs it (`marmeon dev` starts one), `marmeon schedule:list`
// shows it. Expired reset, remember-me and API tokens are deleted at night; with several servers by one of them only
// (onOneServer() needs a cache they share: CACHE_DRIVER=database or redis). Private registration (E146): the changes of address
// nobody confirmed in time are cleared at the same hour. Accounts whose address was not confirmed within AUTH_UNVERIFIED_DAYS
// (default 7, E203) are deleted at 03:20 — commands/PruneUnverifiedCommand.ts.
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').onOneServer();
  s.call(PruneEmailChanges).daily().at('03:10').onOneServer().name('auth.prune-email-changes');
  s.command('auth:prune-unverified').daily().at('03:20').onOneServer();
});
