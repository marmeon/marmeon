import { defineModule } from '@bespokecore/core';
import { schedule } from './schedule.ts';

// The tables of the framework's drivers (cache, sessions, queue, …): `bespoke make:*-table` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'system',
  migrations: new URL('./migrations/', import.meta.url),
  // Housekeeping of these tables, by the scheduler (bespoke schedule:work).
  schedule,
});
