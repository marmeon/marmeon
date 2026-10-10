import { defineSchedule } from '@marmeon/scheduler';

// Housekeeping of the framework's tables in this module: expired sessions (the requests' lottery is off once this
// runs), expired cache entries and locks, failed jobs older than a week, notifications read a month ago, uploads older than
// a day. Each on one server; a prune that is still running when it is due again is skipped.
export const schedule = defineSchedule((s) => {
  s.command('session:prune').everyFifteenMinutes().withoutOverlapping().onOneServer();
  s.command('cache:prune').hourlyAt(25).withoutOverlapping().onOneServer();
  s.command('queue:prune-failed', ['--hours=168']).daily().at('03:20').timezone('Europe/Berlin').onOneServer();
  // Notifications read more than 30 days ago (unread ones stay).
  s.command('notifications:prune', ['--days=30']).daily().at('03:30').timezone('Europe/Berlin').withoutOverlapping().onOneServer();
  // Uploads older than a day — used, expired or never sent: their rows first, then their files on the `uploads` disk. One
  // server here: the uploads disk is local to this machine (with several, run it on each — without onOneServer).
  s.command('uploads:prune').hourly().withoutOverlapping().onOneServer();
  // The devtools' ring — on a developer's machine only (APP_ENV local, the default with NODE_ENV=development), where they
  // record (their package is a dev dependency, absent in production). Each writing process keeps it within 50 MB / 24 h by itself;
  // this catches an evening's files the next morning.
  s.command('devtools:prune').hourlyAt(40).environments('local');
});
