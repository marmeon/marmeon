// What `defineConnection()` accepts — checked by `tsc` (pnpm build / typecheck), never run.
import { env } from '@marmeon/core';
import { defineConnection } from './config.ts';

// `ConnectionOptions` names `mysql` for the types; a definition does not accept it yet.
defineConnection('reporting', {
  env: env({}),
  // @ts-expect-error — `'mysql'` is not a driver a connection definition can return
  resolve: () => ({ driver: 'mysql', url: 'mysql://h/db' }),
});

defineConnection('reporting', { env: env({}), resolve: () => ({ driver: 'pgsql', url: 'postgres://h/db' }) });
