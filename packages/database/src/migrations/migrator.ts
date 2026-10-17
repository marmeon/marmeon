import { readdirSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Application } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { sql, type Generated, type Kysely } from 'kysely';
import { assertManaged, isReadable, loadColumns, prepareBookkeeping } from '../bookkeeping-setup.ts';
import { bookkeepingAccess, bookkeepingConnection, noBookkeepingWrites } from '../books.ts';
import { Connections } from '../connections.ts';
import { danglingEntries, LOCK_TABLE, MARKERS_TABLE, MIGRATIONS_TABLE, OWNERS_TABLE, SECRETS_TABLE, VERSIONS_TABLE } from '../bookkeeping.ts';
import { byCodePoint, type SchemaMarker } from '../introspection.ts';
import { Schema, SchemaError, type SchemaRecorder } from '../schema/schema.ts';
import { MigrationLock, type HeldLock, type LockOptions } from './lock.ts';
import type { Migration } from './migration.ts';

/** `2026_10_01_120000_create_users_table.ts` — the timestamp orders migrations across all modules. */
const FILE = /^\d{4}_\d\d_\d\d_\d{6}_[a-z0-9_]+\.(ts|js|mts|mjs)$/;

export interface MigrationFile {
  /** File name without extension — unique across the app. */
  readonly name: string;
  readonly module: string;
  readonly path: string;
}

export interface MigrationStatus extends MigrationFile {
  /** The batch it ran in, or undefined while pending. */
  readonly batch: number | undefined;
}

export interface MigrateOptions {
  /**
   * `migrate --adopt-existing`: a connection with tables of the app and no bookkeeping gets an empty, versioned one instead of being
   * refused. Called with the connection and the tables taken over unmarked.
   */
  readonly adoptExisting?: (connection: string, tables: readonly string[]) => void;
}

export interface MigrationRun {
  readonly name: string;
  readonly module: string;
  readonly ms: number;
}

/** Internal bookkeeping tables — not part of the app's generated `Tables`. */
export { LOCK_TABLE, MARKERS_TABLE, MIGRATIONS_TABLE, OWNERS_TABLE, SECRETS_TABLE, VERSIONS_TABLE };

interface Bookkeeping {
  marmeon_migrations: { id: Generated<number>; name: string; module: string; batch: number };
  marmeon_table_owners: { table_name: string; module: string };
  marmeon_secret_columns: { table_name: string; column_name: string };
  marmeon_schema_markers: { table_name: string; column_name: string; marker: string; value: string | null };
}

/** The columns a table-level marker stands for: dropping or renaming one of them takes the marker with it. */
const MARKER_COLUMNS: Readonly<Record<string, SchemaMarker['marker']>> = { deleted_at: 'soft_deletes', created_at: 'timestamps', updated_at: 'timestamps' };

/**
 * Runs the migrations of every module in batches, ordered by their timestamp, and records which module's
 * migration created which table, which columns are secret and what the migrations marked (`timestamps()`, `softDeletes()`,
 * `.inverse()`).
 *
 * A migration may run on another connection (`connection` in `defineMigration`, e.g. the cache's own SQLite
 * file): its record stays on `default` (one order, one batch number for all), the table's owner, secret columns and marks
 * go to the bookkeeping of the connection the table is on.
 *
 * The bookkeeping is version 1 of the `marmeon_` tables. A database that still has the tables of the release before it is moved
 * over by the first command that migrates; a database with a version this release does not read is left alone, and every query
 * on it fails ({@link BookkeepingVersionError}). See `docs/migrations.md#how-the-migrator-keeps-track`.
 */
export class Migrator {
  readonly #app: Application;
  readonly #connections: Connections;
  /** Every migration on `default`, whatever it names (the scratch database of `db:types`). */
  #oneConnection = false;
  /** The lock while a command holds it: the methods below join it instead of waiting for themselves. */
  #held: HeldLock | undefined;
  #lockOptions: Pick<LockOptions, 'waitSeconds' | 'onTakeover' | 'now' | 'owner'> = {};

  constructor(app: Application, connections: Connections) {
    this.#app = app;
    this.#connections = connections;
  }

  /** Runs every migration on `default`, whatever connection it names — for one scratch database of all tables (`db:types`). */
  onOneConnection(): this {
    this.#oneConnection = true;
    return this;
  }

  /**
   * @internal — how long the migrating methods wait for another migration to end (`waitSeconds`, default 60),, and what is said
   * when a dead process's lock is taken over (`onTakeover`).
   */
  lockWith(options: Pick<LockOptions, 'waitSeconds' | 'onTakeover' | 'now' | 'owner'>): this {
    this.#lockOptions = options;
    return this;
  }

  /**
   * @internal — runs `callback` while holding the migration lock of the default connection, so no other migrator runs at the same
   * time. The migrating methods take it themselves; the commands hold it across several (`migrate:fresh`: drop, then migrate). A
   * call inside `callback` joins the lock held.
   */
  async locked<R>(callback: () => Promise<R>): Promise<R> {
    assertManaged(this.#connections, 'default');
    if (this.#held) return callback();
    const options = this.#connections.options();
    // Not through `#db()`: a database whose bookkeeping is not yet readable is the one this lock is taken to repair.
    const lock = await MigrationLock.acquire(this.#books(), {
      ...this.#lockOptions,
      driver: options.driver,
      ...(options.driver === 'pgsql' ? { url: options.url } : {}),
    });
    this.#held = lock;
    let result: R;
    try {
      result = await callback();
    } catch (error) {
      this.#held = undefined;
      // The callback's error is the one to see, not a failure to let go after it.
      await lock.release().catch(() => {});
      throw error;
    }
    this.#held = undefined;
    await lock.release();
    return result;
  }

  /** Every migration file of every module, in the order they run. */
  files(): MigrationFile[] {
    const files: MigrationFile[] = [];
    for (const module of this.#app.modules) {
      if (!module.migrations) continue;
      const directory = module.migrations instanceof URL ? fileURLToPath(module.migrations) : resolve(this.#app.root, module.migrations);
      if (!existsSync(directory)) throw new Error(withCode('D14', `The migrations directory of module "${module.name}" does not exist: ${directory}`));
      for (const entry of readdirSync(directory)) {
        if (entry.endsWith('.d.ts') || /\.test\./.test(entry)) continue;
        if (!FILE.test(entry)) {
          if (/\.(ts|js|mts|mjs)$/.test(entry)) {
            throw new Error(withCode('D14', `Migration file name "${entry}" (module "${module.name}") must look like 2026_10_01_120000_create_users_table.ts.`));
          }
          continue;
        }
        files.push({ name: basename(entry, extname(entry)), module: module.name, path: join(directory, entry) });
      }
    }
    files.sort((a, b) => byCodePoint(a.name, b.name));
    for (let i = 1; i < files.length; i++) {
      if (files[i]!.name === files[i - 1]!.name) {
        throw new Error(withCode('D15', `Two migrations are named "${files[i]!.name}" (modules "${files[i - 1]!.module}" and "${files[i]!.module}").`));
      }
    }
    return files;
  }

  async status(): Promise<MigrationStatus[]> {
    const ran = new Map((await this.#ran()).map((row) => [row.name, row.batch]));
    return this.files().map((file) => ({ ...file, batch: ran.get(file.name) }));
  }

  /** The migrations the bookkeeping says ran and no module has a file for any more. Reads only. */
  async missing(): Promise<{ name: string; module: string; batch: number }[]> {
    const names = new Set(this.files().map((file) => file.name));
    return (await this.#ran()).filter((row) => !names.has(row.name)).map(({ name, module, batch }) => ({ name, module, batch }));
  }

  /** Runs every pending migration, in one new batch. */
  async migrate(onRun?: (run: MigrationRun) => void, options: MigrateOptions = {}): Promise<MigrationRun[]> {
    return this.locked(() => this.#migrate(onRun, options));
  }

  async #migrate(onRun: ((run: MigrationRun) => void) | undefined, options: MigrateOptions): Promise<MigrationRun[]> {
    await this.#prepare('default', true, options.adoptExisting);
    // Every connection a migration runs on, not only those with a migration pending: its bookkeeping is moved now, or its queries stay refused.
    for (const connection of await this.connections()) if (connection !== 'default') await this.#prepare(connection, true, options.adoptExisting);
    const db = this.#db();
    const ran = new Set((await this.#ran()).map((row) => row.name));
    const pending = this.files().filter((file) => !ran.has(file.name));
    if (pending.length === 0) return [];

    const batch = (await this.#lastBatch()) + 1;
    const runs: MigrationRun[] = [];
    for (const file of pending) {
      await this.#held?.heartbeat();
      const migration = await load(file);
      const connection = this.#connectionOf(migration, file);
      const started = performance.now();
      // One transaction per migration: a failing one leaves no half-changed schema (SQLite and Postgres both roll back DDL).
      if (connection === 'default') {
        await db.transaction().execute(async (trx) => {
          await migration.up(this.#schema(trx, file.module, connection));
          await this.#verifyBooks(trx, connection, file);
          await this.#held?.heartbeat(trx);
          await trx.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch }).execute();
        });
      } else {
        // On its own connection, then recorded on default — two databases, so two transactions (the record comes last:
        // a migration that failed is not recorded).
        await this.#prepare(connection, true);
        await this.#db(connection)
          .transaction()
          .execute(async (trx) => {
            await migration.up(this.#schema(trx, file.module, connection));
            await this.#verifyBooks(trx, connection, file);
            await this.#held?.heartbeat(); // before the commit: a lock lost meanwhile rolls the migration back
          });
        await db.transaction().execute(async (trx) => {
          await this.#held?.heartbeat(trx);
          await trx.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch }).execute();
        });
      }
      const run = { name: file.name, module: file.module, ms: performance.now() - started };
      runs.push(run);
      await this.#held?.heartbeat();
      onRun?.(run);
    }
    return runs;
  }

  /** Rolls back the last batch — or the last `steps` migrations. */
  async rollback(options: { steps?: number } = {}, onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    return this.locked(async () => {
      await this.#prepare();
      const rows = (await this.#ran()).toReversed();
      const last = rows[0]?.batch;
      const targets = options.steps ? rows.slice(0, options.steps) : rows.filter((row) => row.batch === last);
      return this.#down(targets, onRun);
    });
  }

  /** Rolls back every migration. */
  async reset(onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    return this.locked(async () => {
      await this.#prepare();
      return this.#down((await this.#ran()).toReversed(), onRun);
    });
  }

  /** Drops every table (not only the migrated ones) and migrates from scratch. */
  async fresh(onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    return this.locked(async () => {
      await this.dropAllTables();
      return this.migrate(onRun);
    });
  }

  /**
   * Drops every table of the default connection, the bookkeeping included — and of every other connection a migration
   * runs on (its tables would be in the way of the fresh run). Returns the connections.
   */
  async dropAllTables(): Promise<string[]> {
    return this.locked(async () => {
      const connections = await this.connections();
      for (const connection of connections) {
        assertManaged(this.#connections, connection);
        await this.#refuseNewer(connection);
        // Through the bookkeeping connection: dropping everything is the way out of bookkeeping the app's connection refuses (an earlier release's).
        const schema = new Schema(this.#books(connection), this.#driver(connection));
        bookkeepingAccess.add(schema);
        await schema.dropAllTables();
      }
      return connections;
    });
  }

  /** `default`, and every other connection a migration runs on. */
  async connections(): Promise<string[]> {
    const names = new Set(['default']);
    for (const file of this.files()) names.add(this.#connectionOf(await load(file), file));
    return [...names];
  }

  /** Table name → owning module, from the migrations that created them. */
  async owners(): Promise<Map<string, string>> {
    await this.#prepare();
    const rows = await this.#db().selectFrom(OWNERS_TABLE).select(['table_name', 'module']).execute();
    return new Map(rows.map((row) => [row.table_name, row.module]));
  }

  /** Table name → its secret columns (`.secret()` in the migrations). */
  async secrets(): Promise<Map<string, Set<string>>> {
    await this.#prepare();
    const secrets = new Map<string, Set<string>>();
    for (const row of await this.#db().selectFrom(SECRETS_TABLE).select(['table_name', 'column_name']).execute()) {
      let columns = secrets.get(row.table_name);
      if (!columns) secrets.set(row.table_name, (columns = new Set()));
      columns.add(row.column_name);
    }
    return secrets;
  }

  /** Every marker the migrations recorded (`timestamps()`, `softDeletes()`, `.inverse()`), ordered by table and column. */
  async markers(): Promise<SchemaMarker[]> {
    await this.#prepare();
    const rows = await this.#db().selectFrom(MARKERS_TABLE).select(['table_name', 'column_name', 'marker', 'value']).execute();
    return rows
      .map((row) => ({ table: row.table_name, column: row.column_name, marker: row.marker as SchemaMarker['marker'], value: row.value }))
      .sort((a, b) => byCodePoint(a.table, b.table) || byCodePoint(a.column, b.column) || byCodePoint(a.marker, b.marker));
  }

  async #down(rows: readonly { name: string; module: string }[], onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    const files = new Map(this.files().map((file) => [file.name, file]));
    const db = this.#db();
    const runs: MigrationRun[] = [];
    for (const row of rows) {
      await this.#held?.heartbeat();
      const file = files.get(row.name);
      if (!file) throw new Error(withCode('D16', `Cannot roll back "${row.name}" (module "${row.module}"): its file is gone.`));
      const migration = await load(file);
      if (!migration.down) throw new Error(withCode('D16', `Cannot roll back "${row.name}" (module "${row.module}"): it has no down().`));
      const connection = this.#connectionOf(migration, file);
      const started = performance.now();
      if (connection === 'default') {
        await db.transaction().execute(async (trx) => {
          await migration.down!(this.#schema(trx, file.module, connection));
          await this.#verifyBooks(trx, connection, file);
          await this.#held?.heartbeat(trx);
          await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
        });
      } else {
        await this.#prepare(connection);
        await this.#db(connection)
          .transaction()
          .execute(async (trx) => {
            await migration.down!(this.#schema(trx, file.module, connection));
            await this.#verifyBooks(trx, connection, file);
            await this.#held?.heartbeat();
          });
        await db.transaction().execute(async (trx) => {
          await this.#held?.heartbeat(trx);
          await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
        });
      }
      const run = { name: row.name, module: row.module, ms: performance.now() - started };
      runs.push(run);
      await this.#held?.heartbeat();
      onRun?.(run);
    }
    return runs;
  }

  /** The connection a migration runs on (checked: a configured one). */
  #connectionOf(migration: Migration, file: MigrationFile): string {
    if (this.#oneConnection || migration.connection === undefined) return 'default';
    const name = typeof migration.connection === 'function' ? migration.connection(this.#app.container) : migration.connection;
    if (typeof name !== 'string' || !this.#connections.names().includes(name)) {
      throw new Error(
        withCode('D14', `Migration ${file.name} (module "${file.module}") runs on the database connection ${JSON.stringify(name)}, which is not configured. ` +
          `Known: ${this.#connections.names().join(', ')}. Add it with defineConnection(…) in the app's config.`),
      );
    }
    return name;
  }

  #schema(trx: Kysely<Bookkeeping>, module: string, connection: string): Schema {
    const owners: SchemaRecorder = {
      created: async (table) => {
        await trx.deleteFrom(OWNERS_TABLE).where('table_name', '=', table).execute();
        await trx.insertInto(OWNERS_TABLE).values({ table_name: table, module }).execute();
        await trx.deleteFrom(SECRETS_TABLE).where('table_name', '=', table).execute();
        await trx.deleteFrom(MARKERS_TABLE).where('table_name', '=', table).execute();
      },
      dropped: async (table) => {
        await trx.deleteFrom(OWNERS_TABLE).where('table_name', '=', table).execute();
        await trx.deleteFrom(SECRETS_TABLE).where('table_name', '=', table).execute();
        await trx.deleteFrom(MARKERS_TABLE).where('table_name', '=', table).execute();
      },
      renamed: async (from, to) => {
        await trx.updateTable(OWNERS_TABLE).set({ table_name: to }).where('table_name', '=', from).execute();
        await trx.updateTable(SECRETS_TABLE).set({ table_name: to }).where('table_name', '=', from).execute();
        await trx.updateTable(MARKERS_TABLE).set({ table_name: to }).where('table_name', '=', from).execute();
      },
      secret: async (table, column) => {
        await trx.insertInto(SECRETS_TABLE).values({ table_name: table, column_name: column }).execute();
      },
      marker: async (table, column, marker, value) => {
        await trx.deleteFrom(MARKERS_TABLE).where('table_name', '=', table).where('column_name', '=', column).where('marker', '=', marker).execute();
        await trx.insertInto(MARKERS_TABLE).values({ table_name: table, column_name: column, marker, value }).execute();
      },
      columnDropped: async (table, column) => {
        await trx.deleteFrom(SECRETS_TABLE).where('table_name', '=', table).where('column_name', '=', column).execute();
        await this.#columnGone(trx, table, column);
      },
      columnRenamed: async (table, from, to) => {
        await trx.updateTable(SECRETS_TABLE).set({ column_name: to }).where('table_name', '=', table).where('column_name', '=', from).execute();
        // A foreign key keeps its inverse name; `deleted_at` under another name is no soft delete any more.
        await trx.updateTable(MARKERS_TABLE).set({ column_name: to }).where('table_name', '=', table).where('column_name', '=', from).execute();
        if (MARKER_COLUMNS[from]) await trx.deleteFrom(MARKERS_TABLE).where('table_name', '=', table).where('column_name', '=', '').where('marker', '=', MARKER_COLUMNS[from]).execute();
      },
    };
    // The recorder writes the books with `trx` itself; what a migration holds as `schema.db` cannot.
    return new Schema(trx.withPlugin(noBookkeepingWrites()), this.#driver(connection), owners);
  }

  /** The markers of a dropped column: its own (an inverse name), and the table's marker it stood for. */
  async #columnGone(trx: Kysely<Bookkeeping>, table: string, column: string): Promise<void> {
    await trx.deleteFrom(MARKERS_TABLE).where('table_name', '=', table).where('column_name', '=', column).execute();
    const marker = MARKER_COLUMNS[column];
    if (marker) await trx.deleteFrom(MARKERS_TABLE).where('table_name', '=', table).where('column_name', '=', '').where('marker', '=', marker).execute();
  }

  /** See {@link prepareBookkeeping}. */
  async #prepare(connection = 'default', adopt = false, adoptExisting?: MigrateOptions['adoptExisting']): Promise<void> {
    await prepareBookkeeping(this.#connections, connection, { adopt, ...(adoptExisting ? { adoptExisting } : {}) });
  }

  /** Refuses to go on over bookkeeping of a newer version (`migrate:fresh` would drop what a newer Marmeon wrote). */
  async #refuseNewer(connection: string): Promise<void> {
    await isReadable(this.#books(connection), this.#driver(connection), connection);
  }

  /**
   * After a migration, in its transaction: every secret column and marker still points at a table and column that exist. A rename or
   * drop in raw SQL leaves the mark behind and the column unprotected — so the migration is rolled back instead.
   */
  async #verifyBooks(trx: Kysely<any>, connection: string, file: MigrationFile): Promise<void> {
    const { columns } = await loadColumns(trx, this.#driver(connection));
    if (!columns.has(VERSIONS_TABLE)) return;
    const secrets = (await sql<{ table_name: string; column_name: string }>`select table_name, column_name from ${sql.table(SECRETS_TABLE)}`.execute(trx)).rows.map((row) => ({ table: row.table_name, column: row.column_name }));
    const markers = (await sql<{ table_name: string; column_name: string; marker: SchemaMarker['marker'] }>`select table_name, column_name, marker from ${sql.table(MARKERS_TABLE)}`.execute(trx)).rows.map((row) => ({ table: row.table_name, column: row.column_name, marker: row.marker, value: null }));
    const dangling = danglingEntries(columns, { secrets, markers });
    if (dangling.length === 0) return;
    throw new SchemaError(
      withCode(
        'D4',
        `Migration ${file.name} (module "${file.module}") left ${dangling.slice(0, 5).join(', ')}${dangling.length > 5 ? ', …' : ''} pointing at nothing: a table or column was renamed or dropped with raw SQL, and its secret or marker entry did not follow. ` +
          'It was rolled back. Use schema.alter() and schema.rename() (renameColumn, dropColumn), which keep the entries in step. See docs/migrations.md#how-the-migrator-keeps-track.',
      ),
    );
  }

  async #ran(): Promise<{ id: number; name: string; module: string; batch: number }[]> {
    if (!(await this.#hasTable(MIGRATIONS_TABLE))) return [];
    return this.#db().selectFrom(MIGRATIONS_TABLE).selectAll().orderBy('batch').orderBy('id').execute();
  }

  async #lastBatch(): Promise<number> {
    const row = await this.#db().selectFrom(MIGRATIONS_TABLE).select(sql<number | null>`max(batch)`.as('batch')).executeTakeFirst();
    return row?.batch ?? 0;
  }

  async #hasTable(table: string): Promise<boolean> {
    return (await this.#db().introspection.getTables()).some((t) => t.name === table);
  }

  #db(connection = 'default'): Kysely<Bookkeeping> {
    return this.#connections.get<Bookkeeping>(connection);
  }

  /** The connection that reaches a database whose bookkeeping `#db()` refuses: for the lock, `#prepare` and dropping everything. */
  #books(connection = 'default'): Kysely<any> {
    return bookkeepingConnection(this.#connections, connection);
  }

  #driver(connection = 'default') {
    return this.#connections.options(connection).driver;
  }
}

async function load(file: MigrationFile): Promise<Migration> {
  const module = (await import(pathToFileURL(file.path).href)) as { default?: Partial<Migration> };
  if (typeof module.default?.up !== 'function') {
    throw new Error(withCode('D14', `Migration ${file.name} (module "${file.module}") must \`export default defineMigration({ up, down })\`.`));
  }
  return module.default as Migration;
}
