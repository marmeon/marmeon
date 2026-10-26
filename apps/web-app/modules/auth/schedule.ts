import { defineSchedule } from '@marmeon/scheduler';

// The auth module's scheduled work — `marmeon schedule:work` runs it (`marmeon dev` starts one), `marmeon schedule:list`
// shows it. Expired reset, remember-me and API tokens are deleted at night, by one server only — and the changes of address
// nobody confirmed in time (private registration): `auth:prune-tokens` does both.
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').timeZone('Europe/Berlin').onOneServer();
  // Opt-in, turned on here (the module `make:auth` writes has the line commented out): at 03:20 the accounts whose address
  // was not confirmed within AUTH_UNVERIFIED_DAYS (default 7) are deleted — irreversible, see commands/PruneUnverifiedCommand.ts;
  // an account confirmed once never. Sign-ups here are self-service, nobody holds an unconfirmed account for someone else —
  // so whoever signed up with another's address does not keep it.
  s.command('auth:prune-unverified').daily().at('03:20').timeZone('Europe/Berlin').onOneServer();
});
