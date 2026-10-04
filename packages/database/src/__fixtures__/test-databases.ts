import type { Logger } from '@bespokecore/core';
import { sql } from 'kysely';
import { Connections } from '../connections.ts';
import { PGSQL_URL } from './databases.ts';

/** Its statements are not worth a line; a failure is. */
const quiet: Logger = { debug() {}, info() {}, warn: (message) => console.warn(message), error: (message) => console.error(message), child: () => quiet };

/**
 * Vitest global setup of the repository (`vitest.config.ts`): after a run with Postgres (`pnpm test:pgsql`), drops the test
 * databases that are left — `<database>_test_*` and the fixtures' `_cache_`, `_queue_`, `_schedule_`, `_types_` ones
 * (`bespoke_test_…`) on the server of `BESPOKE_TEST_PGSQL_URL` and nowhere else. The worker databases of `createTestApp` are
 * named after the app's directory, so every `make:auth` copy in a temporary directory made new ones, and a run that crashed
 * left its fixtures' databases; a later run recreates what it needs. Never two Postgres runs at once (they share the server).
 */
export async function teardown(): Promise<void> {
  if (!PGSQL_URL) return;
  const url = new URL(PGSQL_URL);
  const name = url.pathname.slice(1) || 'bespoke';
  const prefixes = ['test', 'cache', 'queue', 'schedule', 'types'].map((kind) => `${name}_${kind}_`);
  const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL, poolMax: 1 } }, root: '/', logger: quiet });
  try {
    const { rows } = await sql<{ datname: string }>`select datname from pg_database`.execute(admin.get());
    for (const { datname } of rows) {
      if (!prefixes.some((prefix) => datname.startsWith(prefix))) continue;
      await sql`drop database if exists ${sql.id(datname)} with (force)`.execute(admin.get());
    }
  } finally {
    await admin.destroy();
  }
}
