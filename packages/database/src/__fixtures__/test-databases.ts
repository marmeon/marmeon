import { createHash } from 'node:crypto';
import type { Logger } from '@marmeon/core';
import { sql } from 'kysely';
import { Connections } from '../connections.ts';
import { PGSQL_URL } from './databases.ts';

/** Its statements are not worth a line; a failure is. */
const quiet: Logger = { debug() {}, info() {}, warn: (message) => console.warn(message), error: (message) => console.error(message), child: () => quiet };

/** Names every test database of this checkout (`<kind>_<tag>_…`): another checkout on the same server has another. */
const TAG = createHash('sha1').update(import.meta.dirname).digest('hex').slice(0, 8);

/** The kinds of database the fixtures create (`marmeon_<kind>_<tag>_…`), and the workers' `<database>_test_<tag>_…`. */
const KINDS = ['test', 'cache', 'queue', 'schedule', 'sessions', 'auth', 'types'];

/** Of the server's databases, the ones a run of the checkout `tag` created — none of another checkout's. */
export function ownDatabases(databases: readonly string[], name: string, tag: string = TAG): string[] {
  const prefixes = KINDS.map((kind) => `${name}_${kind}_${tag}_`);
  return databases.filter((database) => prefixes.some((prefix) => database.startsWith(prefix)));
}

/**
 * Vitest global setup of the repository (`vitest.config.ts`). It tags the run's databases with the checkout
 * (`MARMEON_TEST_DATABASE_TAG`, which the workers inherit). After a run with Postgres (`pnpm test:pgsql`) it drops the test
 * databases of this checkout that are left (`<database>_test_<tag>_*` and the fixtures' `_cache_`, `_queue_`, … ones, e.g.
 * `marmeon_test_<tag>_…`) on the server of `MARMEON_TEST_PGSQL_URL` and nowhere else. Another checkout's databases stay, because its
 * run may be going on. A run that crashed left its databases, and a later run of the same checkout drops them. Never two
 * Postgres runs of one checkout at once.
 */
export function setup(): void {
  process.env.MARMEON_TEST_DATABASE_TAG = TAG;
}

export async function teardown(): Promise<void> {
  if (!PGSQL_URL) return;
  const url = new URL(PGSQL_URL);
  const name = url.pathname.slice(1) || 'marmeon';
  const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL, poolMax: 1 } }, root: '/', logger: quiet });
  try {
    const { rows } = await sql<{ datname: string }>`select datname from pg_database`.execute(admin.get());
    for (const datname of ownDatabases(rows.map((row) => row.datname), name)) {
      await sql`drop database if exists ${sql.id(datname)} with (force)`.execute(admin.get());
    }
  } finally {
    await admin.destroy();
  }
}
