import { defineSchedule } from '@bespokecore/scheduler';

// Housekeeping of the framework's tables in this module (E88): expired sessions (the requests' lottery is off once this
// runs), expired cache entries and locks, failed jobs older than a week, notifications read a month ago. Each on one
// server; a prune that is still running when it is due again is skipped.
export const schedule = defineSchedule((s) => {
  s.command('session:prune').everyFifteenMinutes().withoutOverlapping().onOneServer();
  s.command('cache:prune').hourlyAt(25).withoutOverlapping().onOneServer();
  s.command('queue:prune-failed', ['--hours=168']).daily().at('03:20').timezone('Europe/Berlin').onOneServer();
  // Notifications read more than 30 days ago (unread ones stay).
  s.command('notifications:prune', ['--days=30']).daily().at('03:30').timezone('Europe/Berlin').withoutOverlapping().onOneServer();
});
