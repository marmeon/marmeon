import { defineSchedule } from '@bespokecore/scheduler';

// The auth module's scheduled work (E88) — `bespoke schedule:work` runs it (`bespoke dev` starts one), `bespoke schedule:list`
// shows it. Expired reset, remember-me and API tokens are deleted at night, by one server only.
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').timezone('Europe/Berlin').onOneServer();
});
