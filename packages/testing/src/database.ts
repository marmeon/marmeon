import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { Logger, resolveConfig, type Application } from '@marmeon/core';

type DatabaseModule = typeof import('@marmeon/database');
type Env = Readonly<Record<string, string | undefined>>;

/** Per process (a Vitest worker): the databases already created and migrated. */
const prepared = new Map<string, Promise<void>>();

/**
 * Where a refreshed test app keeps its data: one database per test worker — a SQLite
 * file under the app's `storage/framework/testing/`, or a Postgres database named after the app's with `_test_` and the worker process — so parallel
 * workers never meet. Returns the environment that points the app there.
 */
export interface WorkerDatabase {
  readonly key: string;
  readonly env: Record<string, string>;
  /** Postgres: the app's own database, to create and drop the worker's from. */
  readonly adminUrl?: string;
}

export async function workerDatabase(root: string, env: Env): Promise<WorkerDatabase> {
  const { DatabaseConfig } = await import('@marmeon/database/internal');
  const config = (await resolveConfig([DatabaseConfig], env)).get(DatabaseConfig) as { default: import('@marmeon/database').ConnectionOptions };
  const options = config.default;
  if (options.driver === 'sqlite') {
    // A file, not `:memory:`: an in-memory database lives only as long as its connection, and every test app has its own.
    // Inside the app, not the shared temporary directory: there, other users could predict the name and plant a file or link.
    // Named after the process, not the pool slot: Vitest hands a slot to the next file while the previous file's worker is still
    // shutting down, and the next file deletes and migrates the file anew — under the old worker's open connection.
    const file = join(root, 'storage', 'framework', 'testing', `database-${process.pid}-${threadId}.sqlite`);
    // Before the app boots: the connection check wants the folder to exist.
    mkdirSync(dirname(file), { recursive: true });
    if (!cleaned.has(file)) removeStaleDatabases(dirname(file), file);
    return { key: file, env: { DB_DRIVER: 'sqlite', DB_DATABASE: file } };
  }
  const url = new URL(options.url);
  // Per app too (like the SQLite file): two apps' tests in one worker must not share a schema.
  // A run of the repository's own tests tags its databases with its checkout, so the teardown of another checkout's run leaves them alone.
  const tag = process.env.MARMEON_TEST_DATABASE_TAG ? `${process.env.MARMEON_TEST_DATABASE_TAG}_` : '';
  // Named after the process, not the pool slot (see the SQLite file): Vitest can give one slot to two files at once, and they would drop each other's database.
  const prefix = databasePrefix(url.pathname.slice(1) || 'marmeon', tag, root);
  const name = `${prefix}${process.pid}_${threadId}`;
  // Postgres would cut a longer name silently, and the drop and the sweep would then name another database than the one created.
  if (Buffer.byteLength(name) > 63) throw new Error(`The test database name "${name}" is longer than the 63 bytes Postgres allows: shorten MARMEON_TEST_DATABASE_TAG.`);
  url.pathname = `/${name}`;
  return { key: url.href, env: { DB_DRIVER: 'pgsql', DB_URL: url.href }, adminUrl: options.url };
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

type EmptyingModule = DatabaseModule & Pick<typeof import('@marmeon/database/internal'), 'isMigratorTable' | 'tableColumns'>;

/**
 * Throws unless the app's default connection is the worker's own database: an `override` or a variable that points the app elsewhere
 * must never get that database dropped, recreated or emptied. Checks what the options name; {@link emptyWorkerDatabase} asks the
 * server too, once the database exists.
 */
export function assertWorkerConnection(database: DatabaseModule, app: Application, worker: WorkerDatabase): void {
  const options = app.container.make(database.Connections).options();
  const same =
    options.driver === 'sqlite'
      ? options.database === worker.key
      : options.driver === 'pgsql' && new URL(options.url).host === new URL(worker.key).host && new URL(options.url).pathname === new URL(worker.key).pathname;
  if (!same) throw new Error("A test app with a database must use the worker's own test database; its connection \"default\" names another one (an override of the database configuration?).");
}

/**
 * Empties every table of the app's connection but the migrator's two, so that the next test starts from nothing and a refreshed
 * test after an isolated one finds no leftovers: Postgres in one `truncate … restart identity cascade` (the tables of extensions
 * stay), SQLite a `delete from` per table with foreign keys off, and the counters of `sqlite_sequence`. Only ever runs on the
 * worker's own database: it throws when the connection is another one.
 */
export async function emptyWorkerDatabase(database: EmptyingModule, app: Application, worker: WorkerDatabase): Promise<void> {
  assertWorkerConnection(database, app, worker);
  const connections = app.container.make(database.Connections);
  const db = connections.get();
  const { sql, isMigratorTable, tableColumns } = database;
  const driver = connections.options().driver === 'sqlite' ? 'sqlite' : 'pgsql';
  if (driver === 'pgsql') {
    const { rows } = await sql<{ name: string }>`select current_database() as name`.execute(db);
    if (rows[0]?.name !== new URL(worker.key).pathname.slice(1)) throw new Error("A test app with a database must use the worker's own test database; the server answers for another one.");
  }
  // The tables the app's search path finds (Postgres: `current_schema()` can be an empty schema named like the role).
  const { types, extension } = await tableColumns(async (text) => (await sql.raw(text).execute(db)).rows as never[], driver);
  const names = [...types.keys()].filter((name) => !extension.has(name) && !isMigratorTable(name) && !name.startsWith('sqlite_'));
  if (driver === 'sqlite') {
    await sql`pragma foreign_keys = off`.execute(db);
    try {
      for (const name of names) await sql`delete from ${sql.id(name)}`.execute(db);
      const sequences = await sql`select 1 from sqlite_master where name = 'sqlite_sequence'`.execute(db);
      if (sequences.rows.length > 0) await sql`delete from sqlite_sequence`.execute(db);
    } finally {
      await sql`pragma foreign_keys = on`.execute(db);
    }
    return;
  }
  if (names.length > 0) await sql`truncate ${sql.join(names.map((name) => sql.id(name)))} restart identity cascade`.execute(db);
}

/**
 * Deletes the SQLite files (and their WAL files) of worker processes that are gone, and the files named after a pool slot
 * (`database-<n>.sqlite`), which no live process owns. Vitest ends its workers with a signal, so they cannot clean up
 * after themselves: the next worker that starts in the app does.
 */
function removeStaleDatabases(folder: string, own: string): void {
  cleaned.add(own);
  for (const name of readdirSync(folder)) {
    const match = /^database-(?:(\d+)-\d+|\d+)\.sqlite(?:-wal|-shm)?$/.exec(name);
    if (!match) continue;
    const pid = match[1] === undefined ? undefined : Number(match[1]);
    if (pid !== undefined && (pid === process.pid || alive(pid))) continue;
    rmSync(join(folder, name), { force: true });
  }
}

/** The files of this process the scan has run for. */
const cleaned = new Set<string>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Postgres cuts identifiers at 63 bytes: a long app database name gives way, never the part that tells the roots and processes apart. */
function databasePrefix(base: string, tag: string, root: string): string {
  // The host too: two containers on one server can share a root and a process id, and must not sweep each other's databases.
  const suffix = `_test_${tag}${hash(`${hostname()}\0${root}`)}_`;
  // Room for the longest process and thread ids (10 digits each) and the underscore between them.
  const room = 63 - Buffer.byteLength(suffix) - 21;
  let kept = base;
  while (Buffer.byteLength(kept) > room && kept.length > 1) kept = kept.slice(0, -1);
  return `${kept}${suffix}`;
}

/** Once per process, per server: the worker databases of processes that are gone are dropped. */
const swept = new Set<string>();

/**
 * Drops the databases named like `own` (same app, root and tag) whose process is gone: Vitest ends its workers with a signal, so
 * they cannot drop their database themselves. A live or unknowable process keeps its database; so does anything not named exactly so.
 */
async function dropStaleDatabases(admin: InstanceType<DatabaseModule['Connections']>, database: DatabaseModule, own: string, main: string): Promise<void> {
  const prefix = /^(.*_)\d+_\d+$/.exec(own)?.[1];
  if (prefix === undefined) return;
  const { sql } = database;
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)_\\d+$`);
  const { rows } = await sql<{ datname: string }>`select datname from pg_database`.execute(admin.get());
  for (const { datname } of rows) {
    const match = pattern.exec(datname);
    if (!match || datname === main || datname === own || alive(Number(match[1]))) continue;
    // One that cannot be dropped (not the owner, say) does not stop the rest.
    await sql`drop database if exists ${sql.id(datname)} with (force)`.execute(admin.get()).catch(() => {});
  }
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
    const server = `${new URL(adminUrl).host}/${name.replace(/\d+_\d+$/, '')}`;
    if (!swept.has(server)) {
      swept.add(server);
      await dropStaleDatabases(admin, database, name, new URL(adminUrl).pathname.slice(1)).catch(() => {});
    }
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
