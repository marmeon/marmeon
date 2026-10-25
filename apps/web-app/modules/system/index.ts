import { defineModule, listen } from '@marmeon/core';
import { ScheduledTaskFailed } from '@marmeon/scheduler';
import { StorageWritable } from './health/StorageWritable.ts';
import { AlertOnFailedTask } from './listeners/AlertOnFailedTask.ts';
import { schedule } from './schedule.ts';
import { ScratchCacheServiceProvider } from './ScratchCacheServiceProvider.ts';
import { ScratchDiskServiceProvider } from './ScratchDiskServiceProvider.ts';
import { ScratchMailServiceProvider } from './ScratchMailServiceProvider.ts';
import { ScratchQueueServiceProvider } from './ScratchQueueServiceProvider.ts';

// The tables of the framework's drivers (cache, sessions, queue, …): `marmeon publish` and `marmeon make:*-table` write their migrations here.
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
  // A queue, a cache, a disk and a mail driver of the app's own: QUEUE_DRIVER=scratch, CACHE_DRIVER=scratch and MAIL_DRIVER=scratch (the defaults stay), and the `scratch` disk.
  providers: [ScratchQueueServiceProvider, ScratchCacheServiceProvider, ScratchDiskServiceProvider, ScratchMailServiceProvider],
});
