import { defineSchedule } from '@marmeon/scheduler';
import { PruneEmailChanges } from './tasks/PruneEmailChanges.ts';

// The auth module's scheduled work (E88) — `marmeon schedule:work` runs it (`marmeon dev` starts one), `marmeon schedule:list`
// shows it. Expired reset, remember-me and API tokens are deleted at night, by one server only — and the changes of address
// nobody confirmed in time (private registration, E146) are cleared.
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').timezone('Europe/Berlin').onOneServer();
  s.call(PruneEmailChanges).daily().at('03:10').timezone('Europe/Berlin').onOneServer().name('auth.prune-email-changes');
  // Opt-in, E209 — this app's decision (the module `make:auth` writes has the line commented out): at 03:20 the accounts whose
  // address was not confirmed within AUTH_UNVERIFIED_DAYS (default 7, E203) are deleted — commands/PruneUnverifiedCommand.ts,
  // through AccountDeletion; an account confirmed once never. Sign-ups here are self-service, nobody holds an unconfirmed account
  // for someone else — so whoever signed up with another's address does not keep it.
  s.command('auth:prune-unverified').daily().at('03:20').timezone('Europe/Berlin').onOneServer();
});
