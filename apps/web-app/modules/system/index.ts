import { defineModule, listen } from '@bespokecore/core';
import { ScheduledTaskFailed } from '@bespokecore/scheduler';
import { AlertOnFailedTask } from './listeners/AlertOnFailedTask.ts';
import { schedule } from './schedule.ts';

// The tables of the framework's drivers (cache, sessions, queue, …): `bespoke make:*-table` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'system',
  migrations: new URL('./migrations/', import.meta.url),
  // Housekeeping of these tables, by the scheduler (bespoke schedule:work).
  schedule,
  // Every failed scheduled task of the app (any module's) raises an alert (E127).
  listeners: [listen(ScheduledTaskFailed, AlertOnFailedTask)],
});
