import { defineModule } from '@bespokecore/core';

// The tables of the framework's drivers (cache, sessions, queue, …): `bespoke make:*-table` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'system',
  migrations: new URL('./migrations/', import.meta.url),
});
