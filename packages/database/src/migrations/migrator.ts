import { hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Application } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { sql, type Generated, type Kysely } from 'kysely';
import { Connections } from '../connections.ts';
import { tableColumns, type CatalogQuery } from '../introspection.ts';
import { assertNotUnreleased, assertRecordReadable, createMigrationsTable, isMigratorTable, isUnreleased, legacyTables, MIGRATIONS_TABLE, recordVersion } from '../migration-state.ts';
import { migratorConnection } from '../migrator-connection.ts';
import { executePlan, planOf, type PlanStep } from '../schema/plan.ts';
import { loadProjection } from '../schema/projection-file.ts';
import { applyPlan, differingTables, emptyProjection, type SchemaProjection } from '../schema/projection.ts';
import { SchemaError } from '../schema/schema.ts';
import { migrationChecksum } from './checksum.ts';
import { dropAllTables } from './drop-all.ts';
import { migrationFiles, type MigrationFile } from './files.ts';
import { loadMigration, spendImport } from './load.ts';
import { MigrationLock, type HeldLock, type LockOptions } from './lock.ts';
import type { Migration } from './migration.ts';

export type { MigrationFile };

export interface MigrationStatus extends MigrationFile {
  /** The batch it ran in, or undefined while pending. */
  readonly batch: number | undefined;
}

/** What a database has that no migration made. */
export interface UnknownSchema {
  /** Tables no migration created. */
  readonly tables: readonly string[];
  /** `table.column` of tables the migrations created, for columns they did not add. */
  readonly columns: readonly string[];
}

export interface MigrateOptions {
  /** Called after each migration that ran, with its name, module and duration. */
  readonly onRun?: (run: MigrationRun) => void;
  /**
   * Called per connection, after the run, with the tables and columns the database has and no migration made (raw SQL, another tool): the
   * schema the migrations describe does not know them, so `selectAll()` leaves such columns out and such tables are not protected.
   */
  readonly onUnknown?: (connection: string, found: UnknownSchema) => void;
  /** Called with the tables of Marmeon 0.3 that `migrate` found on `default` and left where they are. */
  readonly onLegacy?: (connection: string, tables: readonly string[]) => void;
  /**
   * Called once when this run carried the record of migrations over from the form Marmeon 0.3 wrote: `recorded` migrations got the
   * checksum of their file as it is now, `unknown` have no file and keep no checksum. See `docs/migrations.md#how-the-migrator-keeps-track`.
   */
  readonly onCarriedOver?: (carried: { readonly recorded: number; readonly unknown: readonly string[] }) => void;
  /**
   * Called once, before the first pending migration (also when none is), with the migrations that ran and whose file differs from what
   * it was when they ran. Never stops the run. `rollback` and `reset` call it before the first `down()`, with the migrations they roll back only. See `docs/migrations.md#a-migration-that-changed-after-it-ran`.
   */
  readonly onChanged?: (changed: readonly ChangedMigration[]) => void;
}

/** A migration that ran and whose file has another checksum now than when it ran. */
export interface ChangedMigration {
  readonly name: string;
  readonly module: string;
  readonly batch: number;
  /** The checksum recorded when the migration ran. */
  readonly recorded: string;
  /** The checksum of the file now. */
  readonly current: string;
}

export interface MigrationRun {
  readonly name: string;
  readonly module: string;
  readonly ms: number;
}

interface MigrationRecord {
  migrations: { id: Generated<number>; name: string; module: string; batch: number; checksum: string | null };
}

/** The recorded migrations whose checksum is not the one `current` gives for their file, by name. A row without a checksum or a file is left out. */
function changedOf(rows: readonly { name: string; module: string; batch: number; checksum: string | null }[], current: (name: string) => string | undefined): ChangedMigration[] {
  return rows
    .flatMap(({ name, module, batch, checksum }) => {
      const now = checksum === null ? undefined : current(name);
      return checksum !== null && now !== undefined && now !== checksum ? [{ name, module, batch, recorded: checksum, current: now }] : [];
    })
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A migration with the plan of its `up()` and the connection it runs on. */
interface Planned {
  readonly file: MigrationFile;
  readonly connection: string;
  readonly plan: readonly PlanStep[];
  /** The checksum of the bytes of the file the plan was made from. */
  readonly checksum: string;
}

/** The schema a sequence of plans leaves, and the connection each of its tables is on. */
interface Folded {
  readonly projection: SchemaProjection;
  readonly connections: ReadonlyMap<string, string>;
}

const nothing: Folded = { projection: emptyProjection, connections: new Map() };

/** Applies the plans one after another, in the order given. Pure. */
function fold(planned: readonly Planned[], from: Folded = nothing): Folded {
  let projection = from.projection;
  const connections = new Map(from.connections);
  for (const { file, connection: on, plan } of planned) {
    projection = applyPlan(projection, plan, file);
    for (const step of plan) {
      if (step.kind === 'create') connections.set(step.table, on);
      else if (step.kind === 'drop') connections.delete(step.table);
      else if (step.kind === 'rename') {
        const was = connections.get(step.from) ?? on;
        connections.delete(step.from);
        connections.set(step.to, was);
      }
    }
  }
  return { projection, connections };
}

function runner(db: Kysely<any>): CatalogQuery {
  return async (query) => (await sql.raw<any>(query).execute(db)).rows;
}

/** Table → its columns, on a connection (a catalog reading). */
async function columnsOf(db: Kysely<any>, driver: 'sqlite' | 'pgsql'): Promise<Map<string, string[]>> {
  const { types } = await tableColumns(runner(db), driver);
  return new Map([...types].map(([table, columns]) => [table, [...columns.keys()]]));
}

/** A connection with `managed: false` is another tool's: nothing of the migrator touches it. */
function assertManaged(connections: Connections, connection: string): void {
  if (connections.options(connection).managed === false) {
    throw new Error(
      `The database connection "${connection}" is not migrated by Marmeon (\`managed: false\`): the migrations cannot run on it. ` +
        'Run them on a connection Marmeon manages, or remove the option. See docs/database.md#a-database-another-tool-manages.',
    );
  }
}

/**
 * Runs the migrations of every module in batches, ordered by their timestamp. The database keeps two tables for it, `migrations` (which
 * ran, in which batch) and, on SQLite, `migration_lock`; what the migrations say about the schema (secret columns, `timestamps()`,
 * `softDeletes()`, `.inverse()`, the owner of a table) is computed from their plans, not stored. After every migration the
 * database is checked against that schema, and a migration that left it different is rolled back.
 *
 * A migration may run on another connection (`connection` in `defineMigration`, e.g. the cache's own SQLite
 * file): its record stays on `default` (one order, one batch number for all).
 *
 * `migrations` has exactly the columns `batch, checksum, id, module, name` (or `batch, id, module, name` as Marmeon 0.3 wrote them, which the
 * migrating methods carry over); any other set was written by a Marmeon this release does not know and is
 * refused ({@link MigrationStateError}). It reads the record on a connection of its own, so it works on a database whose migrations
 * are not all there, which the app's connections refuse; in a process that migrates it hands the schema it leaves to that process's
 * connections. See `docs/migrations.md#how-the-migrator-keeps-track`.
 */
export class Migrator {
  readonly #app: Application;
  readonly #connections: Connections;
  /** The lock while a command holds it: the methods below join it instead of waiting for themselves. */
  #held: HeldLock | undefined;
  #lockOptions: Pick<LockOptions, 'waitSeconds' | 'onTakeover' | 'now' | 'owner'> = {};

  constructor(app: Application, connections: Connections) {
    this.#app = app;
    this.#connections = connections;
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
    // Not through `#db()`: a database whose migrations are not all there is the one this lock is taken to migrate.
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

  /** The migrations the record says ran and no module has a file for any more. Reads only. */
  async missing(): Promise<{ name: string; module: string; batch: number }[]> {
    const names = new Set(this.files().map((file) => file.name));
    return (await this.#ran()).filter((row) => !names.has(row.name)).map(({ name, module, batch }) => ({ name, module, batch }));
  }

  /**
   * The migrations that ran with a checksum and whose file differs from it now, by name. A row without a checksum is unknown, never
   * changed; a file without a row is pending. Reads only.
   */
  async changed(): Promise<ChangedMigration[]> {
    const files = new Map(this.files().map((file) => [file.name, file]));
    return changedOf(await this.#ran(), (name) => {
      const file = files.get(name);
      return file === undefined ? undefined : migrationChecksum(readFileSync(file.path));
    });
  }

  /** @internal — runs every pending migration, in one new batch. Apps run migrations with `marmeon migrate`. */
  async migrate(options: MigrateOptions = {}): Promise<MigrationRun[]> {
    return this.locked(() => this.#withdrawnOnFailure(() => this.#migrate(options)));
  }

  /**
   * A run (migrate, rollback or reset) that fails leaves the database at the last migration that committed, which this process's connections were handed. They are
   * handed back: the next query checks the state like a process that starts (pending, newer …), instead of trusting a run that did not finish.
   */
  async #withdrawnOnFailure<R>(work: () => Promise<R>): Promise<R> {
    try {
      return await work();
    } catch (error) {
      for (const name of this.#connections.names()) this.#connections.metadata(name).reload();
      throw error;
    }
  }

  async #migrate(options: MigrateOptions): Promise<MigrationRun[]> {
    const { onRun } = options;
    let hasRecord = await this.#prepare();
    await this.#carryOver(options);
    // Every connection a migration runs on, not only those with a migration pending.
    for (const connection of await this.connections()) assertManaged(this.#connections, connection);
    const db = this.#db();
    const rows = await this.#ran();
    const ran = new Set(rows.map((row) => row.name));
    const files = this.files();
    const planned = await this.#plans(files);
    const pending = planned.filter(({ file }) => !ran.has(file.name));
    const byName = new Map(planned.map((entry) => [entry.file.name, entry]));
    const changed = changedOf(rows, (name) => byName.get(name)?.checksum);
    if (changed.length > 0) options.onChanged?.(changed);
    // The schema of the database as it is, handed to this process's connections before anything is asked of them: they would otherwise
    // compare the migration files with a database this run is about to bring up to date, and refuse every query meanwhile.
    const done = rows.flatMap((row) => byName.get(row.name) ?? []);
    let state = fold(done);
    this.#connections.publish(state.projection);
    const runs: MigrationRun[] = [];
    if (pending.length > 0) {
      // A plan the projection cannot hold (a change of a table raw SQL made), or an order of the run that gives another schema than the
      // names do, stops the run before the first migration. Computed, not read from `.marmeon/schema.json`: the run decides what the
      // database becomes, and the file is only a copy of that computation.
      assertOrder(planned, done, pending);
      // And the database must be what the run starts from: an old mismatch is not the first migration's fault, and a table the run is
      // to create must not be there already (a database that is not this app's).
      await this.#precheck(state, pending);
      const batch = hasRecord ? (await this.#lastBatch()) + 1 : 1;
      for (const entry of pending) {
        const { file, connection } = entry;
        await this.#held?.heartbeat();
        const started = performance.now();
        const after = fold([entry], state);
        // One transaction per migration: a failing one leaves no half-changed schema (SQLite and Postgres both roll back DDL).
        if (connection === 'default') {
          await db.transaction().execute(async (trx) => {
            // The record is made with the first migration, in its transaction: a run that fails leaves no empty record behind, which
            // would turn "tables and no record" into "migrations pending".
            if (!hasRecord) await createMigrationsTable(trx, this.#driver());
            await this.#execute(trx, entry, state.projection, after);
            await this.#held?.heartbeat(trx);
            await trx.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch, checksum: entry.checksum }).execute();
          });
          hasRecord = true;
        } else {
          // On its own connection, then recorded on default — two databases, so two transactions (the record comes last:
          // a migration that failed is not recorded).
          await this.#db(connection)
            .transaction()
            .execute(async (trx) => {
              await this.#execute(trx, entry, state.projection, after);
              await this.#held?.heartbeat(); // before the commit: a lock lost meanwhile rolls the migration back
            });
          await db.transaction().execute(async (trx) => {
            if (!hasRecord) await createMigrationsTable(trx, this.#driver());
            await this.#held?.heartbeat(trx);
            await trx.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch, checksum: entry.checksum }).execute();
          });
          hasRecord = true;
        }
        // Committed: from here on the other connections of this process see what the migration made.
        state = after;
        this.#connections.publish(state.projection);
        const run = { name: file.name, module: file.module, ms: performance.now() - started };
        runs.push(run);
        await this.#held?.heartbeat();
        onRun?.(run);
      }
    } else if (!hasRecord) {
      // Nothing to run and nothing that can fail: the database is migrated, with nothing recorded.
      await createMigrationsTable(this.#books(), this.#driver());
    }
    await this.#notice(state, options);
    return runs;
  }

  /** @internal — rolls back the last batch, or the last `steps` migrations. */
  async rollback(options: { steps?: number } & Pick<MigrateOptions, 'onRun' | 'onCarriedOver' | 'onChanged'> = {}): Promise<MigrationRun[]> {
    return this.locked(async () => {
      await this.#withdrawnOnFailure(() => this.#carryOver(options));
      const rows = (await this.#ran()).toReversed();
      const last = rows[0]?.batch;
      const targets = options.steps ? rows.slice(0, options.steps) : rows.filter((row) => row.batch === last);
      return this.#withdrawnOnFailure(() => this.#down(targets, options));
    });
  }

  /** @internal — rolls back every migration. */
  async reset(options: Pick<MigrateOptions, 'onRun' | 'onCarriedOver' | 'onChanged'> = {}): Promise<MigrationRun[]> {
    return this.locked(async () =>
      this.#withdrawnOnFailure(async () => {
        await this.#carryOver(options);
        return this.#down((await this.#ran()).toReversed(), options);
      }),
    );
  }

  /** @internal — drops every table (not only the migrated ones) and migrates from scratch. */
  async fresh(options: Pick<MigrateOptions, 'onRun'> = {}): Promise<MigrationRun[]> {
    return this.locked(async () => {
      await this.dropAllTables();
      return this.migrate(options);
    });
  }

  /**
   * @internal — drops every table of the default connection, the record of migrations included — and of every other connection a migration
   * runs on (its tables would be in the way of the fresh run). Returns the connections.
   */
  async dropAllTables(): Promise<string[]> {
    return this.locked(async () => {
      const connections = await this.connections();
      for (const connection of connections) {
        assertManaged(this.#connections, connection);
        // Through the migrator's connection: dropping everything is the way out of a state the app's connection refuses. A record of a
        // newer Marmeon is not dropped, though: what a newer Marmeon wrote is left alone.
        const books = this.#books(connection);
        if (connection === 'default') {
          // A database an unreleased build migrated is the one this command is the way out of; a record of a newer Marmeon is not dropped.
          const columns = await columnsOf(books, this.#driver());
          if (!isUnreleased(columns)) assertRecordReadable(columns, connection);
        }
        await dropAllTables(books, this.#driver(connection));
      }
      // Nothing is left of the schema, whatever this process's connections knew.
      this.#connections.publish(emptyProjection);
      return connections;
    });
  }

  /** @internal — `default`, and every other connection a migration runs on. */
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

  async #down(rows: readonly { name: string; module: string; batch: number; checksum: string | null }[], options: Pick<MigrateOptions, 'onRun' | 'onChanged'>): Promise<MigrationRun[]> {
    const { onRun } = options;
    const known = this.files();
    const files = new Map(known.map((file) => [file.name, file]));
    const planned = await this.#plans(known);
    // The `down()` that runs is the one of the file as it is now, so a target whose file changed is named first.
    const byName = new Map(planned.map((entry) => [entry.file.name, entry]));
    const changed = changedOf(rows, (name) => byName.get(name)?.checksum);
    if (changed.length > 0) options.onChanged?.(changed);
    // What the database has before the first rollback, and after each: this process's connections must not refuse queries meanwhile.
    const remaining = new Set((await this.#ran()).map((row) => row.name));
    const left = () => fold(planned.filter(({ file }) => remaining.has(file.name)));
    this.#connections.publish(left().projection);
    const db = this.#db();
    const runs: MigrationRun[] = [];
    for (const row of rows) {
      await this.#held?.heartbeat();
      const file = files.get(row.name);
      if (!file) throw new Error(withCode('D16', `Cannot roll back "${row.name}" (module "${row.module}"): its file is gone.`));
      const migration = await loadMigration(file);
      if (!migration.down) throw new Error(withCode('D16', `Cannot roll back "${row.name}" (module "${row.module}"): it has no down().`));
      const connection = this.#connectionOf(migration, file);
      const entry = { file, connection, plan: planOf(migration, 'down', `Migration ${row.name} (module "${row.module}")`) };
      const started = performance.now();
      // What the migrations that remain leave: their plans again, as `down()` is not looked into for the schema (the database is checked against it).
      remaining.delete(row.name);
      const after = left();
      if (connection === 'default') {
        await db.transaction().execute(async (trx) => {
          await this.#execute(trx, entry, undefined, after);
          await this.#held?.heartbeat(trx);
          await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
        });
      } else {
        await this.#db(connection)
          .transaction()
          .execute(async (trx) => {
            await this.#execute(trx, entry, undefined, after);
            await this.#held?.heartbeat();
          });
        await db.transaction().execute(async (trx) => {
          await this.#held?.heartbeat(trx);
          await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
        });
      }
      this.#connections.publish(after.projection);
      const run = { name: row.name, module: row.module, ms: performance.now() - started };
      runs.push(run);
      await this.#held?.heartbeat();
      onRun?.(run);
    }
    return runs;
  }

  /** The connection a migration runs on (checked: a configured one). */
  #connectionOf(migration: Migration, file: MigrationFile): string {
    if (migration.connection === undefined) return 'default';
    const name = typeof migration.connection === 'function' ? migration.connection(this.#app.container) : migration.connection;
    if (typeof name !== 'string' || !this.#connections.names().includes(name)) {
      throw new Error(
        withCode('D14', `Migration ${file.name} (module "${file.module}") runs on the database connection ${JSON.stringify(name)}, which is not configured. ` +
          `Known: ${this.#connections.names().join(', ')}. Add it with defineConnection(…) in the app's config.`),
      );
    }
    return name;
  }

  /** The `up()` plan of every file, made before the first migration runs: one that cannot build its plan leaves the whole run undone. */
  async #plans(files: readonly MigrationFile[]): Promise<Planned[]> {
    const planned: Planned[] = [];
    for (const file of files) {
      // One read for both: the checksum is of exactly the bytes the plan is made from.
      const bytes = readFileSync(file.path);
      const sha256 = hash('sha256', bytes, 'hex');
      const migration = await loadMigration({ ...file, sha256 });
      // The import reads the file itself: one edited between the read and the import gives a plan that is not the one of `bytes`, and a
      // checksum that would be of the other version. The import under this hash is not trusted again, and the run stops.
      if (hash('sha256', readFileSync(file.path), 'hex') !== sha256) {
        spendImport(file.path, sha256);
        throw new Error(withCode('D14', `Migration ${file.name} (module "${file.module}") changed while it was read. Nothing was run; run the command again.`));
      }
      planned.push({
        file,
        connection: this.#connectionOf(migration, file),
        plan: planOf(migration, 'up', `Migration ${file.name} (module "${file.module}")`),
        checksum: migrationChecksum(bytes),
      });
    }
    return planned;
  }

  /**
   * Runs a migration's plan in its transaction, and checks the database against the schema that is to be left. `before` is the schema
   * the migrations before it left: the `data` steps of the plan see it with what the plan has changed up to them — and no other
   * connection does.
   */
  async #execute(trx: Kysely<any>, { file, connection, plan }: Omit<Planned, 'checksum'>, before: SchemaProjection | undefined, after: Folded): Promise<void> {
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
    await executePlan(trx, this.#driver(connection), plan, aroundData);
    await this.#verify(trx, connection, file, after);
  }

  /**
   * After a migration, in its transaction: every table and column the schema of the migrations puts on this connection is in the
   * database. A rename or drop in raw SQL leaves the migrations' schema naming something that is gone — a secret column, say, that is
   * now called something else and would be read as an ordinary one — so the migration is rolled back instead.
   *
   * Not the other way round: what the database has beyond the schema is no error. Raw SQL may add a column, another tool a table, a
   * newer release of the app a migration; `selectAll()` writes out the columns the migrations know, so nothing unknown is read by
   * accident, and `migrate` names what is unknown once it has run.
   */
  async #verify(trx: Kysely<any>, connection: string, file: MigrationFile, folded: Folded): Promise<void> {
    const lacking = await this.#lacking(trx, connection, folded);
    if (lacking.length === 0) return;
    throw new SchemaError(
      withCode(
        'D3',
        `Migration ${file.name} (module "${file.module}") left the database without ${lacking.slice(0, 5).join(', ')}${lacking.length > 5 ? ', …' : ''}, which the migrations say is there: ` +
          'a table or column was renamed or dropped with raw SQL, and the schema the migrations describe did not follow. The migration was rolled back. ' +
          'Use schema.alter() (renameColumn, dropColumn) and schema.rename(), which keep it in step. See docs/migrations.md#raw-sql.',
      ),
    );
  }

  /** The tables and columns the schema puts on `connection` that the database lacks. */
  async #lacking(db: Kysely<any>, connection: string, { projection, connections }: Folded): Promise<string[]> {
    const { types } = await tableColumns(runner(db), this.#driver(connection));
    const lacking: string[] = [];
    for (const table of projection.tables.values()) {
      if (connections.get(table.name) !== connection) continue;
      const found = types.get(table.name);
      if (found === undefined) {
        lacking.push(`the table ${table.name}`);
        continue;
      }
      for (const column of table.columns) if (!found.has(column.name)) lacking.push(`the column ${table.name}.${column.name}`);
    }
    return lacking;
  }

  /**
   * Before the first migration of a run: the database has what the migrations that ran say (otherwise the first migration of the run
   * would be blamed for an old mismatch), and none of the tables the run creates (it is not this app's database).
   */
  async #precheck(state: Folded, pending: readonly Planned[]): Promise<void> {
    const connections = new Set(pending.map((entry) => entry.connection));
    const present = new Map<string, Set<string>>();
    for (const connection of connections) {
      const books = this.#books(connection);
      const lacking = await this.#lacking(books, connection, state);
      if (lacking.length > 0) {
        throw new SchemaError(
          withCode(
            'D3',
            `The database connection "${connection}" already lacks ${lacking.slice(0, 5).join(', ')}${lacking.length > 5 ? ', …' : ''}, which the migrations that ran say is there, before this run: ` +
              'a table or column was renamed or dropped outside the migrations. Nothing was run. See docs/migrations.md#raw-sql.',
          ),
        );
      }
      present.set(connection, new Set((await columnsOf(books, this.#driver(connection))).keys()));
    }
    for (const { file, connection, plan } of pending) {
      const tables = present.get(connection)!;
      for (const step of plan) {
        if (step.kind === 'create') {
          if (tables.has(step.table)) {
            throw new SchemaError(
              withCode(
                'D3',
                `The database connection "${connection}" already has the table ${step.table}, which migration ${file.name} (module "${file.module}") creates — is this the database you mean? Nothing was run. ` +
                  'See docs/migrations.md#how-the-migrator-keeps-track.',
              ),
            );
          }
          tables.add(step.table);
        } else if (step.kind === 'drop') tables.delete(step.table);
        else if (step.kind === 'rename') {
          tables.delete(step.from);
          tables.add(step.to);
        }
      }
    }
  }

  /** What the database has that no migration made, said once per connection after a run; and the tables 0.3 left. */
  async #notice(state: Folded, options: MigrateOptions): Promise<void> {
    if (!options.onUnknown && !options.onLegacy) return;
    for (const connection of await this.connections()) {
      const { types, extension } = await tableColumns(runner(this.#books(connection)), this.#driver(connection));
      const columns = new Map([...types].map(([table, found]) => [table, [...found.keys()]]));
      const left = legacyTables(columns);
      if (left.length > 0) options.onLegacy?.(connection, left);
      const tables: string[] = [];
      const extra: string[] = [];
      for (const [table, found] of columns) {
        if (isMigratorTable(table) || left.includes(table) || table.startsWith('sqlite_') || extension.has(table)) continue;
        const known = state.projection.tables.get(table);
        if (known === undefined || state.connections.get(table) !== connection) tables.push(table);
        else {
          const names = new Set(known.columns.map((column) => column.name));
          for (const column of found) if (!names.has(column)) extra.push(`${table}.${column}`);
        }
      }
      if (tables.length > 0 || extra.length > 0) options.onUnknown?.(connection, { tables, columns: extra });
    }
  }

  /** Refuses a record of a newer Marmeon or of an unreleased build; whether `default` has the record yet (the first migration makes it). */
  async #prepare(): Promise<boolean> {
    assertManaged(this.#connections, 'default');
    const books = this.#books();
    const columns = await columnsOf(books, this.#driver());
    assertNotUnreleased(columns, 'default');
    assertRecordReadable(columns, 'default');
    return columns.has(MIGRATIONS_TABLE);
  }

  /**
   * The migrations that ran, in the order they ran. Read on the migrator's connection: this is how a database that lacks migrations
   * is found out, so the app's connection, which refuses every query then, cannot be the one to ask. A record this release cannot read
   * is refused here as it is everywhere else.
   */
  async #ran(): Promise<{ id: number; name: string; module: string; batch: number; checksum: string | null }[]> {
    const books = this.#books();
    const columns = await columnsOf(books, this.#driver());
    const version = recordVersion(columns, 'default');
    if (version === undefined) return [];
    const rows = (await books.selectFrom(MIGRATIONS_TABLE).selectAll().orderBy('batch').orderBy('id').execute()) as {
      id: number;
      name: string;
      module: string;
      batch: number;
      checksum?: string | null;
    }[];
    // The form of 0.3 has no checksum: every migration is unknown, never changed.
    return rows.map((row) => ({ ...row, checksum: row.checksum ?? null }));
  }

  /**
   * Carries a record in the form Marmeon 0.3 wrote over to the one with a checksum, in one transaction: the column is added and each
   * row whose file is there gets the checksum of the file as it is now. A row without a file stays `null`, which means unknown — and is
   * never filled in later: this is the one moment a file becomes the reference without having been checked. A record in the current form is left alone.
   */
  async #carryOver(options: Pick<MigrateOptions, 'onCarriedOver'>): Promise<void> {
    const books = this.#books();
    if (recordVersion(await columnsOf(books, this.#driver()), 'default') !== 1) return;
    const files = new Map(this.files().map((file) => [file.name, file]));
    const unknown: string[] = [];
    let recorded = 0;
    await books.transaction().execute(async (trx) => {
      await trx.schema.alterTable(MIGRATIONS_TABLE).addColumn('checksum', 'varchar(80)').execute();
      for (const row of await trx.selectFrom(MIGRATIONS_TABLE).select('name').orderBy('batch').orderBy('id').execute()) {
        const file = files.get(row.name);
        if (file === undefined) {
          unknown.push(row.name);
          continue;
        }
        await trx.updateTable(MIGRATIONS_TABLE).set({ checksum: migrationChecksum(readFileSync(file.path)) }).where('name', '=', row.name).execute();
        recorded++;
      }
      await this.#held?.heartbeat(trx);
    });
    options.onCarriedOver?.({ recorded, unknown });
  }

  async #lastBatch(): Promise<number> {
    const row = await this.#books().selectFrom(MIGRATIONS_TABLE).select(sql<number | null>`max(batch)`.as('batch')).executeTakeFirst();
    return row?.batch ?? 0;
  }

  #db(connection = 'default'): Kysely<MigrationRecord> {
    return this.#connections.get<MigrationRecord>(connection);
  }

  /** The connection that reaches a database `#db()` refuses: for the lock, the record of migrations and dropping everything. */
  #books(connection = 'default'): Kysely<any> {
    return migratorConnection(this.#connections, connection);
  }

  #driver(connection = 'default') {
    return this.#connections.options(connection).driver;
  }
}

/**
 * Refuses a run whose order gives another schema than the names do. The projection everywhere else (other processes, the file in
 * `.marmeon/`, the generated types) replays the migrations by name; the database gets them in the order they ran — the ones that
 * ran, then the pending ones by name. A pending migration with an older timestamp than one that ran (a branch merged late) is
 * harmless while they touch different tables, and is refused when they touch the same one: the schema the app is built on would be
 * a different one from the schema of the database.
 */
function assertOrder(planned: readonly Planned[], done: readonly Planned[], pending: readonly Planned[]): void {
  const asRun = [...done, ...pending];
  const sameOrder = asRun.length === planned.length && asRun.every((entry, i) => entry === planned[i]);
  let byRun: SchemaProjection;
  try {
    byRun = fold(asRun).projection;
  } catch (error) {
    if (sameOrder) throw error;
    throw orderError(planned, asRun, pending, `they cannot be applied in the order they run in: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sameOrder) return;
  let byName: SchemaProjection;
  try {
    byName = fold(planned).projection;
  } catch (error) {
    throw orderError(planned, asRun, pending, `they cannot be applied in the order of their names: ${error instanceof Error ? error.message : String(error)}`);
  }
  const differing = differingTables(byRun, byName);
  if (differing.length > 0) throw orderError(planned, asRun, pending, `${differing.slice(0, 5).join(', ')} would differ${differing.length > 5 ? ', …' : ''}`);
}

function orderError(planned: readonly Planned[], asRun: readonly Planned[], pending: readonly Planned[], what: string): SchemaError {
  const at = asRun.findIndex((entry, i) => entry !== planned[i]);
  const early = planned[at]!.file.name;
  const late = asRun[at]!.file.name;
  const advice = pending.some((entry) => entry.file.name === early)
    ? `Migration ${early} has not run, but its name sorts before ${late}, which has. Rename ${early} so that its name sorts after ${late} (change the timestamp in front), then migrate. On a database where ${early} already ran, change its row in migrations to the new name as well, or it runs again.`
    : `Migration ${early} ran after ${late}, but its name sorts first: the record of migrations (column id) and the file names disagree. Rename the files, and change the \`name\` of the rows of those that already ran in migrations too, so both order alike.`;
  return new SchemaError(
    withCode(
      'D3',
      `The migrations run in an order their names do not give, and it matters: ${what}. Everything but this run replays the migrations by name, so the schema the app expects would not be the database's. ${advice} See docs/migrations.md#how-the-migrator-keeps-track.`,
    ),
  );
}
