import { defineModule } from '@marmeon/core';

// The tables of the framework's drivers (cache, sessions, queue, …): `marmeon publish` and `marmeon make:*-table` write their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'system',
  migrations: new URL('./migrations/', import.meta.url),
});
