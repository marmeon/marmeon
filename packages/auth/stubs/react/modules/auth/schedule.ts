import { defineSchedule } from '@bespokecore/scheduler';

// The auth module's scheduled work — `bespoke schedule:work` runs it (`bespoke dev` starts one), `bespoke schedule:list`
// shows it. Expired reset, remember-me and API tokens are deleted at night; with several servers by one of them only
// (onOneServer() needs a cache they share: CACHE_DRIVER=database or redis).
export const schedule = defineSchedule((s) => {
  s.command('auth:prune-tokens').daily().at('03:10').onOneServer();
});
