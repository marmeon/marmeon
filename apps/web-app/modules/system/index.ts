import { defineModule, listen } from '@marmeon/core';
import { ScheduledTaskFailed } from '@marmeon/scheduler';
import { StorageWritable } from './health/StorageWritable.ts';
import { AlertOnFailedTask } from './listeners/AlertOnFailedTask.ts';
import { schedule } from './schedule.ts';
import { ScratchQueueServiceProvider } from './ScratchQueueServiceProvider.ts';

// The tables of the framework's drivers (cache, sessions, queue, …): `marmeon make:*-table` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'system',
  migrations: new URL('./migrations/', import.meta.url),
  // Housekeeping of these tables, by the scheduler (marmeon schedule:work).
  schedule,
  // Every failed scheduled task of the app (any module's) raises an alert.
  listeners: [listen(ScheduledTaskFailed, AlertOnFailedTask)],
  // `/up/ready` checks the database, cache and queue through their packages — and, here, that the disks take files.
  health: [StorageWritable],
  // A queue driver of the app's own, selectable with QUEUE_CONNECTION=scratch (the default stays `database`).
  providers: [ScratchQueueServiceProvider],
});
