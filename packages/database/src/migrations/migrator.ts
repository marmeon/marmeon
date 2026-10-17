import { Application } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { sql, type Generated, type Kysely } from 'kysely';
import { assertManaged, isReadable, loadColumns, prepareBookkeeping, runner } from '../bookkeeping-setup.ts';
import { bookkeepingConnection } from '../books.ts';
import { Connections } from '../connections.ts';
import { bookkeepingVersion, classify, danglingEntries, LOCK_TABLE, MARKERS_TABLE, MIGRATIONS_TABLE, OWNERS_TABLE, SECRETS_TABLE, unreadable, VERSIONS_TABLE } from '../bookkeeping.ts';
import { byCodePoint, type SchemaMarker } from '../introspection.ts';
import { assertRecordReadable } from '../migration-state.ts';
import { executePlan, planOf, type PlanStep, type SchemaRecorder } from '../schema/plan.ts';
import { loadProjection } from '../schema/projection-file.ts';
import { applyPlan, emptyProjection, MARKER_COLUMNS, projectMigrations, type SchemaProjection } from '../schema/projection.ts';
import { SchemaError } from '../schema/schema.ts';
import { dropAllTables } from './drop-all.ts';
import { migrationFiles, type MigrationFile } from './files.ts';
import { loadMigration } from './load.ts';
import { MigrationLock, type HeldLock, type LockOptions } from './lock.ts';
import type { Migration } from './migration.ts';

export type { MigrationFile };

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
 * over by the first command that migrates; a database with a version this release does not read is left alone, and the migration
 * commands refuse it ({@link BookkeepingVersionError}). It reads the record of migrations on a connection of its own, so it works
 * on a database whose migrations are not all there, which the app's connections refuse ({@link MigrationStateError}); in a process
 * that migrates it hands the schema it leaves to that process's connections. See `docs/migrations.md#how-the-migrator-keeps-track`.
 */
export class Migrator {
  readonly #app: Application;
  readonly #connections: Connections;
  /** Every migration on `default`, whatever it names (one scratch database of all tables). */
  #oneConnection = false;
  /** The lock while a command holds it: the methods below join it instead of waiting for themselves. */
  #held: HeldLock | undefined;
  #lockOptions: Pick<LockOptions, 'waitSeconds' | 'onTakeover' | 'now' | 'owner'> = {};

  constructor(app: Application, connections: Connections) {
    this.#app = app;
    this.#connections = connections;
  }

  /** Runs every migration on `default`, whatever connection it names — for one scratch database of all tables. */
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
    return migrationFiles(this.#app);
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
    const files = this.files();
    const pending = files.filter((file) => !ran.has(file.name));
    // The schema of the database as it is, handed to this process's connections before anything is asked of them: they would otherwise
    // compare the migration files with a database this run is about to bring up to date, and refuse every query meanwhile.
    let projection = await projectMigrations(files, { only: ran });
    this.#connections.publish(projection);
    if (pending.length === 0) return [];
    // A plan the projection cannot hold (a change of a table raw SQL made) stops the run before the first migration. Computed, not read
    // from `.marmeon/schema.json`: the run decides what the database becomes, and the file is only a copy of that computation.
    await projectMigrations(files);

    const batch = (await this.#lastBatch()) + 1;
    const runs: MigrationRun[] = [];
    // Every plan is made before the first migration runs: one that cannot build its plan leaves the whole run undone.
    const plans = [];
    for (const file of pending) {
      const migration = await loadMigration(file);
      plans.push({ file, connection: this.#connectionOf(migration, file), plan: planOf(migration, 'up', `Migration ${file.name} (module "${file.module}")`) });
    }
    for (const { file, connection, plan } of plans) {
      await this.#held?.heartbeat();
      const started = performance.now();
      // One transaction per migration: a failing one leaves no half-changed schema (SQLite and Postgres both roll back DDL).
      if (connection === 'default') {
        await db.transaction().execute(async (trx) => {
          await this.#execute(trx, file, connection, plan, projection);
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
            await this.#execute(trx, file, connection, plan, projection);
            await this.#held?.heartbeat(); // before the commit: a lock lost meanwhile rolls the migration back
          });
        await db.transaction().execute(async (trx) => {
          await this.#held?.heartbeat(trx);
          await trx.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch }).execute();
        });
      }
      // Committed: from here on the other connections of this process see what the migration made.
      projection = applyPlan(projection, plan, file);
      this.#connections.publish(projection);
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
        await dropAllTables(this.#books(connection), this.#driver(connection), true);
      }
      // Nothing is left of the schema, whatever this process's connections knew.
      this.#connections.publish(emptyProjection);
      return connections;
    });
  }

  /** `default`, and every other connection a migration runs on. */
  async connections(): Promise<string[]> {
    const names = new Set(['default']);
    for (const file of this.files()) names.add(this.#connectionOf(await loadMigration(file), file));
    return [...names];
  }

  /**
   * The schema the migrations describe, computed from their plans without a database: every table with its columns, keys and marks, as
   * the migrations of all modules leave it. Raw SQL is not looked into: what it makes is unknown. Read from `.marmeon/schema.json` while
   * that fits every migration file, otherwise computed and written back. See `docs/migrations.md#what-the-migrations-describe`.
   */
  async projection(): Promise<SchemaProjection> {
    return loadProjection(this.#app.root, this.files());
  }

  /** Table name → owning module, from the migrations that created them. */
  async owners(): Promise<Map<string, string>> {
    await this.#prepare();
    const rows = await this.#books().selectFrom(OWNERS_TABLE).select(['table_name', 'module']).execute();
    return new Map(rows.map((row) => [row.table_name, row.module]));
  }

  /** Table name → its secret columns (`.secret()` in the migrations). */
  async secrets(): Promise<Map<string, Set<string>>> {
    await this.#prepare();
    const secrets = new Map<string, Set<string>>();
    for (const row of await this.#books().selectFrom(SECRETS_TABLE).select(['table_name', 'column_name']).execute()) {
      let columns = secrets.get(row.table_name);
      if (!columns) secrets.set(row.table_name, (columns = new Set()));
      columns.add(row.column_name);
    }
    return secrets;
  }

  /** Every marker the migrations recorded (`timestamps()`, `softDeletes()`, `.inverse()`), ordered by table and column. */
  async markers(): Promise<SchemaMarker[]> {
    await this.#prepare();
    const rows = await this.#books().selectFrom(MARKERS_TABLE).select(['table_name', 'column_name', 'marker', 'value']).execute();
    return rows
      .map((row) => ({ table: row.table_name, column: row.column_name, marker: row.marker as SchemaMarker['marker'], value: row.value }))
      .sort((a, b) => byCodePoint(a.table, b.table) || byCodePoint(a.column, b.column) || byCodePoint(a.marker, b.marker));
  }

  async #down(rows: readonly { name: string; module: string }[], onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    const known = this.files();
    const files = new Map(known.map((file) => [file.name, file]));
    // What the database has before the first rollback, and after each: this process's connections must not refuse queries meanwhile.
    const remaining = new Set((await this.#ran()).map((row) => row.name));
    this.#connections.publish(await projectMigrations(known, { only: remaining }));
    const db = this.#db();
    const runs: MigrationRun[] = [];
    for (const row of rows) {
      await this.#held?.heartbeat();
      const file = files.get(row.name);
      if (!file) throw new Error(withCode('D16', `Cannot roll back "${row.name}" (module "${row.module}"): its file is gone.`));
      const migration = await loadMigration(file);
      if (!migration.down) throw new Error(withCode('D16', `Cannot roll back "${row.name}" (module "${row.module}"): it has no down().`));
      const connection = this.#connectionOf(migration, file);
      const plan = planOf(migration, 'down', `Migration ${row.name} (module "${row.module}")`);
      const started = performance.now();
      if (connection === 'default') {
        await db.transaction().execute(async (trx) => {
          await this.#execute(trx, file, connection, plan);
          await this.#held?.heartbeat(trx);
          await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
        });
      } else {
        await this.#prepare(connection);
        await this.#db(connection)
          .transaction()
          .execute(async (trx) => {
            await this.#execute(trx, file, connection, plan);
            await this.#held?.heartbeat();
          });
        await db.transaction().execute(async (trx) => {
          await this.#held?.heartbeat(trx);
          await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
        });
      }
      // What the migrations that remain leave: their plans again, as `down()` is not looked into.
      remaining.delete(row.name);
      this.#connections.publish(await projectMigrations(known, { only: remaining }));
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

  /**
   * Runs a migration's plan in its transaction, and checks the books against what it left. `before` is the schema the migrations
   * before it left: the `data` steps of the plan see it with what the plan has changed up to them — and no other connection does.
   */
  async #execute(trx: Kysely<Bookkeeping>, file: MigrationFile, connection: string, plan: readonly PlanStep[], before?: SchemaProjection): Promise<void> {
    const metadata = this.#connections.metadata(connection);
    const aroundData = before
      ? async (index: number, run: () => Promise<void>) => {
          // The connection the transaction runs on: what the driver knows it by.
          const owner = await trx.getExecutor().provideConnection(async (held) => held);
          metadata.during(owner, applyPlan(before, plan.slice(0, index), file));
          try {
            await run();
          } finally {
            metadata.after(owner);
          }
        }
      : undefined;
    await executePlan(trx, this.#driver(connection), plan, this.#recorder(trx, file.module), aroundData);
    await this.#verifyBooks(trx, connection, file);
  }

  #recorder(trx: Kysely<Bookkeeping>, module: string): SchemaRecorder {
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
    return owners;
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
    assertRecordReadable((await loadColumns(this.#books(connection), this.#driver(connection))).columns, connection);
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

  /**
   * The migrations that ran, in the order they ran. Read on the bookkeeping connection: this is how a database that lacks migrations
   * is found out, so the app's connection, which refuses every query then, cannot be the one to ask. A bookkeeping this release
   * cannot read is refused here as it is everywhere else.
   */
  async #ran(): Promise<{ id: number; name: string; module: string; batch: number }[]> {
    const books = this.#books();
    const { columns, extension } = await loadColumns(books, this.#driver());
    const state = classify(columns, 'default', extension);
    const refused = unreadable(state, 'default');
    if (refused) throw refused;
    if (state.state === 'none') return [];
    await bookkeepingVersion(runner(books), columns, 'default');
    assertRecordReadable(columns, 'default');
    return (await books.selectFrom(MIGRATIONS_TABLE).selectAll().orderBy('batch').orderBy('id').execute()) as { id: number; name: string; module: string; batch: number }[];
  }

  async #lastBatch(): Promise<number> {
    const row = await this.#books().selectFrom(MIGRATIONS_TABLE).select(sql<number | null>`max(batch)`.as('batch')).executeTakeFirst();
    return row?.batch ?? 0;
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
