import { ConsoleLogger, createApplication, defineModule, type Application, type Logger } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, sql } from '@marmeon/database';
import { SearchServiceProvider } from '../provider.ts';
import type { SearchIndexClass } from '../search-index.ts';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`), like the database package's own tests. */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;

const silent: Logger = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

/** The stub migration as the provider ships it to `marmeon publish`, run as it is: the tests cannot drift from what an app gets. */
const STUB_MIGRATIONS = SearchServiceProvider.migrations.from;
/** The `pages` table the indexes of the tests read. */
const PAGE_MIGRATIONS = new URL('./migrations/', import.meta.url);

/**
 * An app on a fresh database with `SEARCH_DRIVER=database`, the given indexes registered and every migration run: the `pages` table and
 * the stub migration of the package, `migrate` passed to the run. `close()` shuts the app down and drops the Postgres database.
 */
export async function migratedApp(driver: 'sqlite' | 'pgsql', indexes: readonly SearchIndexClass[], migrate: Parameters<Migrator['migrate']>[0] = {}): Promise<{ app: Application; close: () => Promise<void> }> {
  let env: Record<string, string> = { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:' };
  let drop = async () => {};
  if (driver === 'pgsql') {
    const name = `marmeon_search_${process.env.MARMEON_TEST_DATABASE_TAG ?? 'untagged'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = new Connections({ connections: { default: { driver: 'pgsql', url: PGSQL_URL! } }, root: '/', logger: silent });
    await sql`create database ${sql.id(name)}`.execute(admin.get());
    const url = new URL(PGSQL_URL!);
    url.pathname = `/${name}`;
    env = { DB_DRIVER: 'pgsql', DB_URL: url.href };
    drop = async () => {
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    };
  }
  let app: Application;
  try {
    app = await createApplication(
      {
        // The migrations come from the repository: a root inside the workspace, as an app's would be.
        root: workspaceTempDir('marmeon-search-'),
        discover: false,
        providers: [DatabaseServiceProvider, SearchServiceProvider],
        // Pages first: the stub's module runs after it, as a published stub runs after the app's own tables.
        modules: [defineModule({ name: 'pages', migrations: PAGE_MIGRATIONS, searchIndexes: [...indexes] }), defineModule({ name: 'system', migrations: STUB_MIGRATIONS })],
      },
      { env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', SEARCH_DRIVER: 'database', ...env } },
    );
    await app.container.make(Migrator).migrate(migrate);
  } catch (error) {
    await drop();
    throw error;
  }
  return {
    app,
    close: async () => {
      await app.shutdown();
      await drop();
    },
  };
}
