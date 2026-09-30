import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger, resolveConfig, type Application } from '@bespokecore/core';

type DatabaseModule = typeof import('@bespokecore/database');
type Env = Readonly<Record<string, string | undefined>>;

/** Per process (a Vitest worker): the databases already created and migrated. */
const prepared = new Map<string, Promise<void>>();

/**
 * Where a refreshed test app keeps its data: one database per test worker (E21) — a temporary
 * SQLite file, or a Postgres database named after the app's with `_test_<worker>` — so parallel
 * workers never meet. Returns the environment that points the app there.
 */
export interface WorkerDatabase {
  readonly key: string;
  readonly env: Record<string, string>;
  /** Postgres: the app's own database, to create and drop the worker's from. */
  readonly adminUrl?: string;
}

export async function workerDatabase(database: DatabaseModule, root: string, env: Env): Promise<WorkerDatabase> {
  const config = (await resolveConfig([database.DatabaseConfig], env)).get(database.DatabaseConfig) as { default: import('@bespokecore/database').ConnectionOptions };
  const options = config.default;
  // Named after the worker slot, not the process: the next run reuses (and first resets) it, so
  // databases do not pile up — like Laravel's parallel testing. Two runs at once would share them.
  const worker = process.env.VITEST_POOL_ID ?? '0';

  if (options.driver === 'sqlite') {
    // A file, not `:memory:`: an in-memory database lives only as long as its connection, and every test app has its own.
    const file = join(tmpdir(), `bespoke-test-${hash(root)}-${worker}.sqlite`);
    return { key: file, env: { DB_CONNECTION: 'sqlite', DB_DATABASE: file } };
  }
  const url = new URL(options.url);
  // Per app too (like the SQLite file): two apps' tests in one worker must not share a schema.
  url.pathname = `/${url.pathname.slice(1) || 'bespoke'}_test_${hash(root)}_${worker}`;
  return { key: url.href, env: { DB_CONNECTION: 'pgsql', DB_URL: url.href }, adminUrl: options.url };
}

/**
 * Creates and migrates the worker's database once per process (fresh at the start: a stale one from
 * an earlier run is dropped). Runs on the first refreshed app, before it isolates itself.
 */
export function prepareWorkerDatabase(database: DatabaseModule, app: Application, worker: WorkerDatabase): Promise<void> {
  const { key } = worker;
  let ready = prepared.get(key);
  if (!ready) {
    ready = (async () => {
      const connections = app.container.make(database.Connections);
      const options = connections.options();
      if (options.driver === 'sqlite') {
        for (const suffix of ['', '-wal', '-shm']) rmSync(`${options.database}${suffix}`, { force: true });
      } else {
        await recreatePostgresDatabase(database, app, options.url, worker.adminUrl!);
      }
      await app.container.make(database.Migrator).migrate();
    })();
    prepared.set(key, ready);
    // A failed preparation is not cached: the next test tries again and reports the same problem.
    ready.catch(() => prepared.delete(key));
  }
  return ready;
}

async function recreatePostgresDatabase(database: DatabaseModule, app: Application, url: string, adminUrl: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  const admin = new database.Connections({
    connections: { default: { driver: 'pgsql', url: adminUrl, poolMax: 1 } },
    root: app.root,
    logger: app.container.make(Logger),
  });
  const { sql } = database;
  try {
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin.get());
    await sql`create database ${sql.id(name)}`.execute(admin.get());
  } finally {
    await admin.destroy();
  }
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
