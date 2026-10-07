import { defineSchedule } from '@marmeon/scheduler';
import { PruneEmailChanges } from './tasks/PruneEmailChanges.ts';

// The auth module's scheduled work (E88) — `marmeon schedule:work` runs it (`marmeon dev` starts one), `marmeon schedule:list`
// shows it. Expired reset, remember-me and API tokens are deleted at night, by one server only — and the changes of address
// nobody confirmed in time (private registration, E146) are cleared.
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').timezone('Europe/Berlin').onOneServer();
  s.call(PruneEmailChanges).daily().at('03:10').timezone('Europe/Berlin').onOneServer().name('auth.prune-email-changes');
});
