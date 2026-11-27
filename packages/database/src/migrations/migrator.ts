import { hash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Application } from '@marmeon/core';
import { printable, withCode } from '@marmeon/core/internal';
import { sql, type Generated, type Kysely } from 'kysely';
import { Connections } from '../connections.ts';
import { derivedSchemaOf } from '../derived-schema.ts';
import { tableColumns, type CatalogQuery } from '../introspection.ts';
import { appTables, assertInterruptionReadable, assertNotUnreleased, assertRecordReadable, createMigrationsTable, INTERRUPTION_TABLE, interruptedError, isMigratorTable, isUnreleased, legacyTables, MIGRATIONS_TABLE, MigrationStateError, readInterruption, recordVersion, type Interruption } from '../migration-state.ts';
import { migratorConnection } from '../migrator-connection.ts';
import { unknownDriver } from '../supported-driver.ts';
import type { Driver } from '../schema/blueprint.ts';
import { assertNamesFitPgsql, assertRawFitsMysql, check, executePlan, planOf, pgsqlCuts, pgsqlNames, type PgsqlName, type PlanStep } from '../schema/plan.ts';
import { loadProjection, readProjection } from '../schema/projection-file.ts';
import { applyPlan, differingTables, listCheckOf, emptyProjection, projectMigrations, tablesAtOf, type SchemaProjection } from '../schema/projection.ts';
import { SchemaError } from '../schema/schema.ts';
import { UnsupportedDriverError } from '../supported-driver.ts';
import { migrationChecksum } from './checksum.ts';
import { dropAllTables } from './drop-all.ts';
import { migrationFiles, type MigrationFile } from './files.ts';
import { loadMigration, spendImport } from './load.ts';
import { MigrationLock, ownerOf, type HeldLock, type LockOptions } from './lock.ts';
import type { Migration } from './migration.ts';

export type { MigrationFile };

/** A migration file with the batch it ran in, if it ran. See docs/migrations.md#status. */
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
  /**
   * Called when a MySQL migration or `down()` stopped with its marker still in `migration_interruption`, with that migration, before the
   * error goes on. What the callback throws or rejects with never replaces that error. See `docs/migrations.md#a-migration-that-stopped-halfway`.
   */
  readonly onInterrupted?: (left: InterruptedMigration) => unknown;
  /**
   * @internal — the rows `resolveInterruption('retry')` named after an `up()`: this run runs those migrations again and replaces each row with its own when
   * that migration starts. Any other row refuses the run, and so does a listed migration that is not pending.
   */
  readonly retrying?: readonly { readonly name: string; readonly startedAt: string }[];
}

/** A MySQL migration that stopped with its marker still in `migration_interruption`. */
export interface InterruptedMigration {
  readonly name: string;
  readonly module: string;
  readonly connection: string;
  readonly direction: 'up' | 'down';
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

/** Whether a plan only changes rows: it has no statement that commits as it runs on MySQL, so its steps can share a transaction with the record. */
function dataOnly(plan: readonly PlanStep[]): boolean {
  return plan.every((step) => step.kind === 'data' || (step.kind === 'raw' && step.statements.mysql === null));
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

/** The names SQLite gives the shadow tables of an FTS5 table. */
const FTS5_SHADOWS = ['_data', '_idx', '_content', '_docsize', '_config'];

/**
 * The tables a framework package declared derived that the database has, and on SQLite the FTS5 shadow tables of a declared virtual
 * table — by SQLite's own word (`shadow`), not by name alone, so an app's `docs_data` next to a declared plain `docs` is still named.
 * @internal Also read by the projection test, which leaves out exactly these.
 */
export async function derivedTablesOf(db: Kysely<any>, driver: Driver, declared: ReadonlySet<string>): Promise<Set<string>> {
  const tables = new Set(declared);
  if (driver !== 'sqlite' || declared.size === 0) return tables;
  const listed = (await sql<{ name: string; type: string }>`select name, type from pragma_table_list where schema = 'main' and type in ('virtual', 'shadow')`.execute(db)).rows;
  const virtual = new Set(listed.filter((row) => row.type === 'virtual' && declared.has(row.name)).map((row) => row.name));
  for (const { name, type } of listed) if (type === 'shadow' && FTS5_SHADOWS.some((suffix) => name.endsWith(suffix) && virtual.has(name.slice(0, -suffix.length)))) tables.add(name);
  return tables;
}

function runner(db: Kysely<any>): CatalogQuery {
  return async (query) => (await sql.raw<any>(query).execute(db)).rows;
}

/** Table → its columns, on a connection (a catalog reading). */
async function columnsOf(db: Kysely<any>, driver: Driver): Promise<Map<string, string[]>> {
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
 * @internal — the record of migrations cannot say which columns are secret (no record, a migration whose file is gone or changed). Its
 * message names migrations only, never a path or a value, so a caller may pass it on.
 */
export class UnknownSecretsError extends Error {
  override name = 'UnknownSecretsError';
}

/** `check()`, on MySQL with the migration named in its message (the code stays in front): it is run for the migrations of a run before the first of them, and the message must say which one it is about. It sees each step by itself: what depends on an earlier step of the same migration is held right before that migration's first statement. */
function checkNamed(driver: Driver, plan: readonly PlanStep[], who: string): void {
  // Only MySQL names the migration: the other drivers keep the message they had.
  if (driver !== 'mysql') return check(driver, plan);
  try {
    check(driver, plan);
  } catch (error) {
    const parts = error instanceof SchemaError ? /^(\[marmeon:[A-Z]\d+\]) ([\s\S]*)$/.exec(error.message) : null;
    if (!parts) throw error;
    throw new SchemaError(`${parts[1]} ${who}: ${parts[2]}`, { cause: error });
  }
}


/** A row of `migration_interruption` as the {@link Interruption} it says. */
function interruptionOf(row: Record<string, any>): Interruption {
  return { name: row.name, module: row.module, connection: row.connection_name, direction: row.direction, batch: Number(row.batch), startedAt: row.started_at, owner: row.owner };
}

/** A row of `migration_interruption` with a direction this release does not know: a newer Marmeon wrote it. */
function unknownDirection(row: Interruption): MigrationStateError {
  return new MigrationStateError(
    'newer',
    'default',
    withCode('D1', `The marker of migration ${printable(row.name)} names the direction "${printable(row.direction)}", which this release of Marmeon does not know: a newer Marmeon wrote it. Update @marmeon/*. Nothing was changed.`),
  );
}

/**
 * Runs the migrations of every module in batches, ordered by their timestamp. The database keeps `migrations` for it (which
 * ran, in which batch). On SQLite it keeps `migration_lock` too, and on MySQL `migration_interruption`. What the migrations say about the schema (secret columns, `timestamps()`,
 * `softDeletes()`, `.inverse()`, the owner of a table) is computed from their plans, not stored. After every migration the
 * database is checked against that schema, and a migration that left it different is rolled back (on MySQL, which cannot, it is reported and marked: see docs/migrations.md#a-migration-that-stopped-halfway).
 *
 * A migration may run on another connection (`connection` in `defineMigration`, e.g. the cache's own SQLite
 * file): its record stays on `default` (one order, one batch number for all).
 *
 * `migrations` has exactly the columns `batch, checksum, id, module, name` (or `batch, id, module, name` as Marmeon 0.3 wrote them, which the
 * migrating methods carry over). On MySQL `migration_interruption` has exactly its own columns. Any other set was written by a Marmeon this release does not know and is
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

  /** @internal Built by the container. */
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
      ...(options.driver === 'pgsql' || options.driver === 'mysql' ? { url: options.url } : {}),
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

  /** @internal — the migration that started and has not finished on MySQL (or is running now), if the table of interruptions says so. Reads only. */
  async interruption(): Promise<Interruption | undefined> {
    return this.#interruption();
  }

  /**
   * @internal — ends the refusal of a migration that did not finish, inside the migration lock: the one the table of interruptions
   * names, or undefined when it names none. The caller says what was done by hand, and the database must show it (D3 otherwise,
   * nothing changed): the schema of the migrations that ran, with this migration for `done` after an `up()` and for `retry` after a
   * `down()` (the rollback was undone), without it for `done` after a `down()`. The row's connection must be the one the migration's
   * file runs on now. `done` writes what the migration would have written, in one transaction with the marker's deletion: the record row
   * with the checksum of its file as it is now after an `up()`, the record row deleted after a `down()`. `retry` after a `down()` deletes
   * the marker and keeps the record. `retry` after an `up()` changes nothing: it returns the row with `retrying`, the name and start of every row of an `up()`
   * (each one's file and connection are checked here, and a row of a `down()` or of a migration that is recorded refuses), and the caller passes
   * them to {@link Migrator.migrate}, whose checks decide and which replaces each row when its migration starts. Nothing is run here.
   * See docs/migrations.md#a-migration-that-stopped-halfway.
   */
  async resolveInterruption(how: 'retry' | 'done'): Promise<(Interruption & { readonly retrying?: readonly { readonly name: string; readonly startedAt: string }[] }) | undefined> {
    if (how !== 'retry' && how !== 'done') throw new TypeError(`resolveInterruption() takes 'retry' or 'done', not ${JSON.stringify(how)}.`);
    return this.locked(async () => {
      // The record is judged as every command judges it, before anything is read from or written to it.
      const columns = await columnsOf(this.#books(), this.#driver());
      assertNotUnreleased(columns, 'default');
      assertRecordReadable(columns, 'default');
      const found = await this.#interruption(columns);
      if (found === undefined) return undefined;
      if (found.direction !== 'up' && found.direction !== 'down') throw unknownDirection(found);
      const planned = await this.#plans(this.files());
      // The row says where the migration ran; the plan of its file says where it runs now. They must be one connection, or what is checked is another database.
      const entryOf = (row: Interruption) => {
        const entry = planned.find((candidate) => candidate.file.name === row.name);
        if (entry === undefined) {
          throw new MigrationStateError(
            'interrupted',
            'default',
            withCode('D32', `Migration ${printable(row.name)} (module "${printable(row.module)}") has no file in any module, so Marmeon cannot tell what it left: restore the file. Nothing was changed. See docs/migrations.md#a-migration-that-stopped-halfway.`),
          );
        }
        if (entry.connection !== row.connection) {
          throw new MigrationStateError(
            'interrupted',
            'default',
            withCode(
              'D32',
              `The row of migration ${printable(row.name)} (module "${printable(row.module)}") says it ran on the database connection "${printable(row.connection)}", and its file runs on "${printable(entry.connection)}" now, so what it left cannot be checked. Put the file back as it was. Nothing was changed. See docs/migrations.md#a-migration-that-stopped-halfway.`,
            ),
          );
        }
        return entry;
      };
      const entry = entryOf(found);
      // `retry` after an `up()` covers every row of an `up()`: a run that started a migration before this one left its row too, and the run goes on with all of them.
      // The migrate run checks the database from here on and keeps each row until its migration starts again. A row of a `down()`, or of a migration that is not pending, refuses.
      if (how === 'retry' && found.direction === 'up') {
        const ran = new Set((await this.#ran()).map((row) => row.name));
        const rows = await this.#interruptions();
        for (const row of rows) {
          if (row.direction === 'down') {
            throw new MigrationStateError(
              'interrupted',
              'default',
              withCode('D32', `Migration ${printable(row.name)} (module "${printable(row.module)}") stopped during its down(), and its row stays beside the ones of an up(): resolve it first with "marmeon migrate --interrupted=done" or "--interrupted=retry" when it is the oldest. Nothing was changed. See docs/migrations.md#a-migration-that-stopped-halfway.`),
            );
          }
          if (row.direction !== 'up') throw unknownDirection(row);
          entryOf(row);
          if (ran.has(row.name)) {
            throw new MigrationStateError(
              'interrupted',
              'default',
              withCode('D32', `Migration ${printable(row.name)} (module "${printable(row.module)}") is recorded as ran, so it cannot run again, and its row stays: Marmeon writes no such row, so check the database against the migration and delete the row from migration_interruption by hand. Nothing was changed. See docs/migrations.md#a-migration-that-stopped-halfway.`),
            );
          }
        }
        return { ...found, retrying: rows.map(({ name, startedAt }) => ({ name, startedAt })) };
      }
      const checksum = found.direction === 'up' && how === 'done' ? migrationChecksum(readFileSync(entry.file.path)) : undefined;
      // The database must be what the operator says: `done` after an `up()` has the migration in, `done` after a `down()` has it out, and `retry` after a `down()` has it still in.
      const ran = new Set((await this.#ran()).map((row) => row.name));
      const stays = (found.direction === 'up') === (how === 'done');
      const expected = fold(planned.filter(({ file }) => (ran.has(file.name) || file.name === found.name) && (stays || file.name !== found.name)));
      const { lacking } = await this.#lacking(this.#books(found.connection), found.connection, expected);
      if (lacking.length > 0) {
        throw new SchemaError(
          withCode(
            'D3',
            `Migration ${printable(found.name)} (module "${printable(found.module)}") is not ${how === 'done' ? 'done' : 'undone'}: the database connection "${printable(found.connection)}" lacks ${lacking.slice(0, 5).join(', ')}${lacking.length > 5 ? ', …' : ''}, which the migrations say is there ` +
              `${stays ? (found.direction === 'up' ? 'once it ran' : 'while it counts as ran') : 'after it was rolled back'}. ${how === 'done' ? 'Finish' : 'Undo'} it by hand first. Nothing was changed. See docs/migrations.md#a-migration-that-stopped-halfway.`,
          ),
        );
      }
      await this.#books().transaction().execute(async (trx) => {
        // A lock lost by now rolls the resolution back.
        await this.#held?.heartbeat(trx);
        if (how === 'done') {
          if (found.direction === 'up') await trx.insertInto(MIGRATIONS_TABLE).values({ name: found.name, module: found.module, batch: found.batch, checksum: checksum! }).execute();
          else await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', found.name).execute();
        }
        await trx.deleteFrom(INTERRUPTION_TABLE).where('name', '=', found.name).execute();
      });
      for (const name of this.#connections.names()) this.#connections.metadata(name).reload();
      return found;
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
    const prepared = await this.#prepare(options.retrying);
    let hasRecord = prepared.hasRecord;
    // `retrying` counts only while its row is there: a stale or foreign one (the row gone, another driver) is a plain run.
    const retrying = prepared.retrying;
    await this.#carryOver(options);
    // Every connection a migration runs on, not only those with a migration pending.
    for (const connection of await this.connections()) assertManaged(this.#connections, connection);
    const db = this.#db();
    const rows = await this.#ran();
    const ran = new Set(rows.map((row) => row.name));
    const files = this.files();
    const planned = await this.#plans(files);
    const pending = planned.filter(({ file }) => !ran.has(file.name));
    // `retry` named a migration this run cannot run again (its file is gone, or it is recorded): no other migration runs on top of the row.
    const gone = retrying?.find((row) => !pending.some(({ file }) => file.name === row.name));
    if (gone) {
      throw new MigrationStateError(
        'interrupted',
        'default',
        withCode('D32', `Migration ${printable(gone.name)} is not pending (its file is gone, or it is recorded), so it cannot run again, and its row stays. Nothing was run. See docs/migrations.md#a-migration-that-stopped-halfway.`),
      );
    }
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
      // MySQL runs no statement written for another driver: a raw step without one for it stops the run before the first migration. So does
      // what the plans alone show MySQL cannot do. What depends on the tables is held against the database right before each migration's first statement.
      for (const { file, connection, plan } of pending) {
        const who = `Migration ${file.name} (module "${file.module}")`;
        this.#assertMarkable(connection, `${who} runs`);
        if (this.#driver(connection) !== 'mysql') continue;
        assertRawFitsMysql(plan, who);
        checkNamed('mysql', plan, who);
      }
      // Postgres says whether it would cut a name, in the encoding of its database: asked for the names of the whole run before the first migration.
      const starts: SchemaProjection[] = [];
      let from = state;
      for (const entry of pending) {
        starts.push(from.projection);
        from = fold([entry], from);
      }
      await this.#assertNamesFit(pending, starts);
      // And the database must be what the run starts from: an old mismatch is not the first migration's fault, and a table the run is
      // to create must not be there already (a database that is not this app's).
      await this.#precheck(state, pending);
      const batch = hasRecord ? (await this.#lastBatch()) + 1 : 1;
      // MySQL commits as it runs DDL, so the record cannot be made in the first migration's transaction: it comes first. Its table of
      // interruptions comes with it, so a marker can be written before the first statement of any migration.
      if (!hasRecord && this.#driver() === 'mysql') {
        await createMigrationsTable(this.#books(), 'mysql');
        hasRecord = true;
      }
      for (const entry of pending) {
        const { file, connection } = entry;
        await this.#held?.heartbeat();
        const started = performance.now();
        const after = fold([entry], state);
        // One transaction per migration: a failing one leaves no half-changed schema (SQLite and Postgres both roll back DDL). On a MySQL
        // `default` the same for a migration that only changes rows: the record exists already (it is made before the loop), so no DDL
        // ends the transaction, and the rows commit together with the record or not at all.
        if (connection === 'default' && (this.#driver() !== 'mysql' || dataOnly(entry.plan))) {
          // On MySQL its marker is the first statement of the same transaction: a rollback takes it along, while a statement a data step
          // got past the guard that commits on its own (a prepared `drop`, a procedure that commits) commits the marker with what ran.
          const marker = this.#marker(file, connection, 'up', batch, entry.plan, retrying);
          try {
            await db.transaction().execute(async (trx) => {
              await marker.write?.(trx);
              // The record is made with the first migration, in its transaction: a run that fails leaves no empty record behind, which
              // would turn "tables and no record" into "migrations pending".
              if (!hasRecord) await createMigrationsTable(trx, this.#driver());
              await this.#execute(trx, entry, state.projection, after);
              await this.#held?.heartbeat(trx);
              await trx.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch, checksum: entry.checksum }).execute();
              await marker.clear(trx);
            });
          } catch (error) {
            await this.#reportInterrupted(marker, options.onInterrupted, { name: file.name, module: file.module, connection, direction: 'up' });
            throw error;
          }
          hasRecord = true;
        } else {
          // Not in one transaction with its record, for one of two reasons. Another connection: two databases, so two transactions (the record
          // comes last: a migration that failed is not recorded). MySQL: it commits DDL as it runs, so the migration has no transaction to
          // roll back, and a lock lost meanwhile stops the run with the schema steps that ran left in place. There the marker is committed
          // first and removed with the record, so what stopped halfway is refused afterwards.
          const marker = this.#marker(file, connection, 'up', batch, entry.plan, retrying);
          try {
            await this.#applying(connection, async (trx) => {
              await this.#execute(trx, entry, state.projection, after, state.projection, marker.write);
              await this.#held?.heartbeat(); // with a transaction (not on MySQL) a lock lost here rolls the migration back
            });
            await db.transaction().execute(async (trx) => {
              if (!hasRecord) await createMigrationsTable(trx, this.#driver());
              await this.#held?.heartbeat(trx);
              await trx.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch, checksum: entry.checksum }).execute();
              await marker.clear(trx);
            });
          } catch (error) {
            await this.#reportInterrupted(marker, options.onInterrupted, { name: file.name, module: file.module, connection, direction: 'up' });
            throw error;
          }
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
  async rollback(options: { steps?: number } & Pick<MigrateOptions, 'onRun' | 'onCarriedOver' | 'onChanged' | 'onInterrupted'> = {}): Promise<MigrationRun[]> {
    return this.locked(async () => {
      await this.#refuseInterrupted('rollback');
      await this.#withdrawnOnFailure(() => this.#carryOver(options));
      const rows = (await this.#ran()).toReversed();
      const last = rows[0]?.batch;
      const targets = options.steps ? rows.slice(0, options.steps) : rows.filter((row) => row.batch === last);
      return this.#withdrawnOnFailure(() => this.#down(targets, options));
    });
  }

  /** @internal — rolls back every migration. */
  async reset(options: Pick<MigrateOptions, 'onRun' | 'onCarriedOver' | 'onChanged' | 'onInterrupted'> = {}): Promise<MigrationRun[]> {
    return this.locked(async () =>
      this.#withdrawnOnFailure(async () => {
        await this.#refuseInterrupted('rollback');
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
      // Before anything is dropped: a database dropped by a run that then refuses its migrations would be lost for nothing.
      for (const connection of connections) this.#assertMarkable(connection, 'A migration runs', 'dropped');
      for (const connection of connections) {
        assertManaged(this.#connections, connection);
        // Through the migrator's connection: dropping everything is the way out of a state the app's connection refuses. A record of a
        // newer Marmeon is not dropped, though: what a newer Marmeon wrote is left alone.
        const books = this.#books(connection);
        if (connection === 'default') {
          // A database an unreleased build migrated is the one this command is the way out of; a record of a newer Marmeon is not dropped.
          const columns = await columnsOf(books, this.#driver());
          if (!isUnreleased(columns)) assertRecordReadable(columns, connection);
          // A marker that reads is no obstacle (dropping it is the point of this command), one of a newer Marmeon is left alone like its record.
          if (this.#driver() === 'mysql') assertInterruptionReadable(columns, connection);
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
   * @internal — the connection a migration runs on, or `undefined` when it cannot be told: the file does not load, its connection
   * function throws or it names one that is not configured. Never throws, so that `migrate:status` answers with a half-written file.
   */
  async connectionOf(file: MigrationFile): Promise<string | undefined> {
    try {
      return this.#connectionOf(await loadMigration(file), file);
    } catch {
      return undefined;
    }
  }

  /**
   * The schema the migrations describe, computed from their plans without a database: every table with its columns, keys and marks, as
   * the migrations of all modules leave it. Raw SQL is not looked into: what it makes is unknown. Read from `.marmeon/schema.json` while
   * that fits every migration file, otherwise computed and written back. A copy: the process's connections work with the cached
   * original, so changing what you get changes nothing for them. See `docs/migrations.md#what-the-migrations-describe`.
   */
  async projection(): Promise<SchemaProjection> {
    // The connections' own object is cached for the process: a caller that changes it would change which columns are secret.
    return structuredClone(await loadProjection(this.#app.root, this.files()));
  }

  /** @internal — {@link projection} for a caller that must write nothing: the cached `.marmeon/schema.json` when it fits, otherwise computed and not saved. */
  async readProjection(): Promise<SchemaProjection> {
    return readProjection(this.#app.root, this.files()) ?? projectMigrations(this.files());
  }

  /**
   * @internal — the schema of the migrations that ran, as the record says: what the database holds, where {@link projection} also
   * holds what a pending migration will change. Throws when that cannot be established — tables and no record, a migration whose file
   * is gone or changed — because a column the database still holds could be secret.
   */
  async ranProjection(connection = 'default'): Promise<SchemaProjection> {
    const { rows, tables: ofDefault } = await this.#record();
    // The record is `default`'s; the connection that is queried may hold tables of its own.
    const tables = connection === 'default' ? ofDefault : [...ofDefault, ...(await this.#tablesOf(connection))];
    const unknown = 'Which columns are secret cannot be established';
    if (rows.length === 0 && tables.length > 0) throw new UnknownSecretsError(`${unknown}: the database has tables but no record of migrations. Run marmeon migrate.`);
    const files = this.files();
    const present = new Map(files.map((file) => [file.name, file]));
    const missing = rows.find((row) => !present.has(row.name));
    if (missing) throw new UnknownSecretsError(`${unknown}: the migration ${printable(missing.name)} ran, and no module has its file any more. Restore the file.`);
    const unchecked = rows.find((row) => row.checksum === null);
    if (unchecked) throw new UnknownSecretsError(`${unknown}: the migration ${printable(unchecked.name)} has no recorded checksum (a record from Marmeon 0.3), so a change of its file cannot be seen. See docs/migrations.md#how-the-migrator-keeps-track.`);
    const [changed] = changedOf(rows, (name) => migrationChecksum(readFileSync(present.get(name)!.path)));
    if (changed) throw new UnknownSecretsError(`${unknown}: the migration ${printable(changed.name)} changed after it ran. Restore the file as it was, or see docs/migrations.md#a-migration-that-changed-after-it-ran.`);
    return projectMigrations(files, { only: new Set(rows.map((row) => row.name)) });
  }

  /**
   * A connection's tables with their columns, read without creating or changing anything. `withheld`: SQLite's virtual tables and
   * their shadows, whose columns are not read — a module that is not loaded would fail the reading, and what they hold is not known.
   * Postgres: every schema but the system's, not only those on the search path, so a table off the path counts, by its bare name.
   */
  async #catalog(connection: string): Promise<{ columns: Map<string, string[]>; extension: Set<string>; withheld: Set<string> }> {
    const driver = this.#driver(connection);
    const file = driver === 'sqlite' ? this.#connections.sqliteFile(connection) : undefined;
    if (driver === 'pgsql') {
      const rows = (
        await sql
          .raw<{ table_name: string; column_name: string; extension: number }>(
            `select c.relname::text as table_name, a.attname::text as column_name,
              case when exists (select 1 from pg_catalog.pg_depend d where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e') then 1 else 0 end as extension
              from pg_catalog.pg_class c
                join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                join pg_catalog.pg_attribute a on a.attrelid = c.oid
              where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
                and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
              order by c.relname, a.attnum`,
          )
          .execute(this.#books(connection))
      ).rows;
      const columns = new Map<string, string[]>();
      const extension = new Set<string>();
      for (const row of rows) {
        // A number, not a boolean: an app's own parser for booleans (global to `pg`) may give back a string.
        if (Number(row.extension) === 1) extension.add(row.table_name);
        const known = columns.get(row.table_name) ?? [];
        if (!known.includes(row.column_name)) known.push(row.column_name);
        columns.set(row.table_name, known);
      }
      return { columns, extension, withheld: new Set() };
    }
    if (driver === 'mysql') {
      // The base tables of the connection's database, as far as the role sees them (`tableColumns` says what that leaves out).
      return { columns: await columnsOf(this.#books(connection), driver), extension: new Set(), withheld: new Set() };
    }
    if (driver !== 'sqlite') return unknownDriver(driver);
    if (file === undefined || !existsSync(file)) return { columns: new Map(), extension: new Set(), withheld: new Set() };
    const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
    try {
      const columns = new Map<string, string[]>();
      const withheld = new Set<string>();
      const tables = db.prepare("select name, type from pragma_table_list where schema = 'main' and type in ('table', 'virtual', 'shadow')").all() as { name: string; type: string }[];
      for (const { name, type } of tables) {
        if (type === 'table') columns.set(name, (db.prepare('select name from pragma_table_info(?)').all(name) as { name: string }[]).map((row) => row.name));
        else {
          columns.set(name, []);
          withheld.add(name);
        }
      }
      return { columns, extension: new Set(), withheld };
    } finally {
      db.close();
    }
  }

  async #tablesOf(connection: string): Promise<string[]> {
    const { columns, extension } = await this.#catalog(connection);
    return appTables(columns, this.#driver(connection), extension);
  }

  /**
   * @internal — what the connection's database has that none of `known` describes: the columns, by table (every column of a table they
   * do not describe), and the tables whose columns are not read at all (SQLite's virtual tables). A migration the record lost, or a table
   * made by raw SQL, leaves these, and whether they hold a secret is not known.
   */
  async undescribedColumns(connection: string, known: readonly SchemaProjection[]): Promise<{ columns: Map<string, Set<string>>; withheld: Set<string> }> {
    const catalog = await this.#catalog(connection);
    const found = new Map<string, Set<string>>();
    const withheld = new Set<string>();
    for (const table of appTables(catalog.columns, this.#driver(connection), catalog.extension)) {
      if (catalog.withheld.has(table)) {
        withheld.add(table);
        continue;
      }
      const described = new Set(known.flatMap((projection) => projection.tables.get(table)?.columns.map((column) => column.name) ?? []));
      const missing = catalog.columns.get(table)!.filter((column) => !described.has(column));
      if (missing.length > 0) found.set(table, new Set(missing));
    }
    return { columns: found, withheld };
  }

  /**
   * The record of migrations and the app's tables, read without creating or changing anything: a SQLite file that is not there has
   * neither, and an existing one is opened read-only (the migrator's own connection would create the file and switch it to WAL).
   */
  async #record(): Promise<{ rows: { name: string; module: string; batch: number; checksum: string | null }[]; tables: string[] }> {
    const file = this.#driver() === 'sqlite' ? this.#connections.sqliteFile('default') : undefined;
    if (file === undefined) {
      return { rows: await this.#ran(), tables: await this.#tablesOf('default') };
    }
    if (!existsSync(file)) return { rows: [], tables: [] };
    const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
    try {
      const names = (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((row) => row.name);
      const columns = new Map(names.map((name): [string, string[]] => [name, []]));
      const found = db.prepare(`select name from pragma_table_info('${MIGRATIONS_TABLE}')`).all() as { name: string }[];
      if (found.length > 0) columns.set(MIGRATIONS_TABLE, found.map((row) => row.name));
      const tables = appTables(columns, 'sqlite');
      if (recordVersion(columns, 'default') === undefined) return { rows: [], tables };
      const rows = db.prepare(`select * from ${MIGRATIONS_TABLE} order by batch, id`).all() as { name: string; module: string; batch: number; checksum?: string | null }[];
      return { rows: rows.map((row) => ({ ...row, checksum: row.checksum ?? null })), tables };
    } finally {
      db.close();
    }
  }

  async #down(rows: readonly { name: string; module: string; batch: number; checksum: string | null }[], options: Pick<MigrateOptions, 'onRun' | 'onChanged' | 'onInterrupted'>): Promise<MigrationRun[]> {
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
    // Every `down()` is found, planned and checked for what its plan alone shows the driver cannot do before the first one runs. What depends on the tables on MySQL is held against the database right before each `down()` runs, so a rollback of several migrations can stop between two: the ones rolled back are out of the record, and another call goes on.
    const targets: { row: (typeof rows)[number]; entry: Omit<Planned, 'checksum'> }[] = [];
    for (const row of rows) {
      const who = `Migration ${printable(row.name)} (module "${printable(row.module)}")`;
      const file = files.get(row.name);
      if (!file) throw new Error(withCode('D16', `Cannot roll back "${printable(row.name)}" (module "${printable(row.module)}"): its file is gone.`));
      const migration = await loadMigration(file);
      if (!migration.down) throw new Error(withCode('D16', `Cannot roll back "${printable(row.name)}" (module "${printable(row.module)}"): it has no down().`));
      const connection = this.#connectionOf(migration, file);
      this.#assertMarkable(connection, `${who} runs`);
      const plan = planOf(migration, 'down', who);
      if (this.#driver(connection) === 'mysql') assertRawFitsMysql(plan, who);
      checkNamed(this.#driver(connection), plan, who);
      targets.push({ row, entry: { file, connection, plan } });
    }
    // Each `down()` starts from the schema the migrations that remain after the ones rolled back before it leave.
    const rolledBack = new Set<string>();
    const starts = targets.map(({ row }) => {
      const start = fold(planned.filter(({ file }) => remaining.has(file.name) && !rolledBack.has(file.name))).projection;
      rolledBack.add(row.name);
      return start;
    });
    await this.#assertNamesFit(targets.map(({ entry }) => entry), starts);
    const runs: MigrationRun[] = [];
    for (const { row, entry } of targets) {
      await this.#held?.heartbeat();
      const { connection } = entry;
      const started = performance.now();
      // The schema this rollback starts from: the constraint of a `oneOf()` list is looked up in it.
      const starting = left().projection;
      // What the migrations that remain leave: their plans again, as `down()` is not looked into for the schema (the database is checked against it).
      remaining.delete(row.name);
      const after = left();
      // As in `#migrate`: one transaction with the record where the database rolls DDL back, and for a `down()` of rows alone on a MySQL `default`.
      if (connection === 'default' && (this.#driver() !== 'mysql' || dataOnly(entry.plan))) {
        // The marker of a MySQL `down()` of rows alone is the first statement of this transaction, as in `#migrate`.
        const marker = this.#marker(entry.file, connection, 'down', row.batch, entry.plan);
        try {
          await db.transaction().execute(async (trx) => {
            await marker.write?.(trx);
            await this.#execute(trx, entry, undefined, after, starting);
            await this.#held?.heartbeat(trx);
            await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
            await marker.clear(trx);
          });
        } catch (error) {
          await this.#reportInterrupted(marker, options.onInterrupted, { name: row.name, module: row.module, connection, direction: 'down' });
          throw error;
        }
      } else {
        const marker = this.#marker(entry.file, connection, 'down', row.batch, entry.plan);
        try {
          await this.#applying(connection, async (trx) => {
            await this.#execute(trx, entry, undefined, after, starting, marker.write);
            await this.#held?.heartbeat();
          });
          await db.transaction().execute(async (trx) => {
            await this.#held?.heartbeat(trx);
            await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
            await marker.clear(trx);
          });
        } catch (error) {
          await this.#reportInterrupted(marker, options.onInterrupted, { name: row.name, module: row.module, connection, direction: 'down' });
          throw error;
        }
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
  async #execute(
    trx: Kysely<any>,
    { file, connection, plan }: Omit<Planned, 'checksum'>,
    before: SchemaProjection | undefined,
    after: Folded,
    listFrom: SchemaProjection | undefined = before,
    beforeFirst?: (on: Kysely<any>) => Promise<void>,
  ): Promise<void> {
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
    await executePlan(trx, this.#driver(connection), plan, aroundData, listFrom && listCheckOf(listFrom, plan, file), listFrom && tablesAtOf(listFrom, plan, file), beforeFirst);
    await this.#verify(trx, connection, file, after);
  }

  /**
   * After a migration, in its transaction: every table and column the schema of the migrations puts on this connection is in the
   * database. A rename or drop in raw SQL leaves the migrations' schema naming something that is gone — a secret column, say, that is
   * now called something else and would be read as an ordinary one — so the migration is rolled back instead (on MySQL it is reported only: DDL cannot be rolled back there).
   *
   * The other cause is a name Postgres cut at 63 bytes: the message names the first missing name over 63 bytes of UTF-8 as a possible cause.
   *
   * Not the other way round: what the database has beyond the schema is no error. Raw SQL may add a column, another tool a table, a
   * newer release of the app a migration; `selectAll()` writes out the columns the migrations know, so nothing unknown is read by
   * accident, and `migrate` names what is unknown once it has run.
   */
  async #verify(trx: Kysely<any>, connection: string, file: MigrationFile, folded: Folded): Promise<void> {
    const { lacking, names } = await this.#lacking(trx, connection, folded);
    if (lacking.length === 0) return;
    // UTF-8 is only a guess at the server's bytes (it counts in the database's encoding), so the sentence names the cause conditionally.
    const cut = this.#driver(connection) === 'pgsql' ? names.find(({ name }) => Buffer.byteLength(name) > 63) : undefined;
    throw new SchemaError(
      withCode(
        'D3',
        `Migration ${file.name} (module "${file.module}") left the database without ${lacking.slice(0, 5).join(', ')}${lacking.length > 5 ? ', …' : ''}, which the migrations say is there: ` +
          `a table or column was renamed or dropped with raw SQL, and the schema the migrations describe did not follow. ${this.#driver(connection) === 'mysql' ? 'MySQL cannot undo a schema change: what the migration did stays, and it is not recorded. ' : 'The migration was rolled back. '}` +
          'Use schema.alter() (renameColumn, dropColumn) and schema.rename(), which keep it in step. See docs/migrations.md#raw-sql.' +
          (cut ? ` Or the name ${printable(cut.shown)} is the cause: it is over 63 bytes of UTF-8, and Postgres cuts a name at 63 bytes of the database's encoding without a word. If it cut this one, use a shorter name.` : ''),
      ),
    );
  }

  /** The tables and columns the schema puts on `connection` that the database lacks, as text and as names (`shown` the way the list writes one). */
  async #lacking(db: Kysely<any>, connection: string, { projection, connections }: Folded): Promise<{ lacking: string[]; names: { shown: string; name: string }[] }> {
    const { types } = await tableColumns(runner(db), this.#driver(connection));
    const lacking: string[] = [];
    const names: { shown: string; name: string }[] = [];
    for (const table of projection.tables.values()) {
      if (connections.get(table.name) !== connection) continue;
      const found = types.get(table.name);
      if (found === undefined) {
        lacking.push(`the table ${table.name}`);
        names.push({ shown: table.name, name: table.name });
        continue;
      }
      for (const column of table.columns) {
        if (found.has(column.name)) continue;
        lacking.push(`the column ${table.name}.${column.name}`);
        names.push({ shown: `${table.name}.${column.name}`, name: column.name });
      }
    }
    return { lacking, names };
  }

  /**
   * The names the plans give on Postgres, asked of the server of their connection before the first of them runs (D5); `starts[i]` is the
   * schema the migrations leave before `entries[i]`, which tells the name of the constraint of a list `oneOf()` gives a column. MySQL
   * measures in `check()`, SQLite measures nothing. The names of a rename with `indexes: true` come from the catalog and are asked when
   * their migration runs.
   */
  async #assertNamesFit(entries: readonly { file: MigrationFile; connection: string; plan: readonly PlanStep[] }[], starts: readonly SchemaProjection[]): Promise<void> {
    const byConnection = new Map<string, PgsqlName[]>();
    // The cuts are asked of the connection the plan runs on, the one its names are then checked against.
    for (const [index, { file, connection, plan }] of entries.entries()) {
      if (this.#driver(connection) !== 'pgsql') continue;
      const cuts = await pgsqlCuts(this.#books(connection), plan);
      byConnection.set(connection, [...(byConnection.get(connection) ?? []), ...pgsqlNames(plan, cuts, listCheckOf(starts[index]!, plan, file))]);
    }
    for (const [connection, names] of byConnection) await assertNamesFitPgsql(this.#books(connection), names);
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
      const { lacking } = await this.#lacking(books, connection, state);
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
    // What a framework package declares derived only stays out of this notice. `undescribedColumns` and `#catalog` do not read the
    // declaration: `db:query` and the database MCP keep treating these objects as undescribed and withhold them.
    for (const connection of await this.connections()) {
      const derived = derivedSchemaOf(this.#app, connection);
      const driver = this.#driver(connection);
      const { types, extension } = await tableColumns(runner(this.#books(connection)), driver);
      const columns = new Map([...types].map(([table, found]) => [table, [...found.keys()]]));
      const left = legacyTables(columns);
      if (left.length > 0) options.onLegacy?.(connection, left);
      const derivedTables = await derivedTablesOf(this.#books(connection), driver, derived.tables);
      const tables: string[] = [];
      const extra: string[] = [];
      for (const [table, found] of columns) {
        if (isMigratorTable(table, this.#driver(connection)) || left.includes(table) || table.startsWith('sqlite_') || extension.has(table)) continue;
        const known = state.projection.tables.get(table);
        if (known === undefined || state.connections.get(table) !== connection) {
          if (!derivedTables.has(table)) tables.push(table);
        } else {
          const names = new Set(known.columns.map((column) => column.name));
          const declared = derived.columns.get(table);
          for (const column of found) if (!names.has(column) && !declared?.has(column)) extra.push(`${table}.${column}`);
        }
      }
      if (tables.length > 0 || extra.length > 0) options.onUnknown?.(connection, { tables, columns: extra });
    }
  }

  /** Refuses a record of a newer Marmeon or of an unreleased build; whether `default` has the record yet (the first migration makes it). */
  async #prepare(retrying?: MigrateOptions['retrying']): Promise<{ hasRecord: boolean; retrying: MigrateOptions['retrying'] }> {
    assertManaged(this.#connections, 'default');
    const books = this.#books();
    const columns = await columnsOf(books, this.#driver());
    assertNotUnreleased(columns, 'default');
    assertRecordReadable(columns, 'default');
    const named = await this.#refuseInterrupted('migrate', retrying);
    return { hasRecord: columns.has(MIGRATIONS_TABLE), retrying: named && this.#driver() === 'mysql' ? retrying : undefined };
  }

  /** On MySQL: the migration that started and has not finished, if the table of interruptions says so (or cannot be read). */
  async #interruption(columns?: ReadonlyMap<string, readonly string[]>): Promise<Interruption | undefined> {
    if (this.#driver() !== 'mysql') return undefined;
    const books = this.#books();
    const found = columns ?? (await columnsOf(books, 'mysql'));
    // The record is judged before the marker, as every command judges it: a record this release cannot read is D1, not D32.
    assertNotUnreleased(found, 'default');
    assertRecordReadable(found, 'default');
    return readInterruption(runner(books), found, 'default');
  }

  /** Every row of the table of interruptions, the oldest first. Callers ask on MySQL only, after {@link Migrator.#interruption} found one. */
  async #interruptions(): Promise<Interruption[]> {
    const rows = await this.#books().selectFrom(INTERRUPTION_TABLE).selectAll().orderBy('started_at').orderBy('name').execute();
    return rows.map(interruptionOf);
  }

  /** Refuses a command that would run migrations on top of one that has not finished. Inside the lock: a second `migrate` that waited for it reads the marker after the first one ended. */
  async #refuseInterrupted(refused: 'migrate' | 'rollback', retrying?: MigrateOptions['retrying']): Promise<boolean> {
    const found = await this.#interruption();
    if (found === undefined) return false;
    if (retrying === undefined || refused !== 'migrate') throw interruptedError(found, 'default', refused);
    // The rows `retry` named, exactly (name, start and direction), are what this run replaces. Any other row, the oldest first, refuses it.
    const other = await this.#books()
      .selectFrom(INTERRUPTION_TABLE)
      .selectAll()
      .where((eb) => eb.not(eb.or(retrying.map((row) => eb.and([eb('name', '=', row.name), eb('started_at', '=', row.startedAt), eb('direction', '=', 'up')])))))
      .orderBy('started_at')
      .orderBy('name')
      .limit(1)
      .executeTakeFirst();
    // Nothing else is there, so every row is a named one.
    if (other === undefined) return true;
    throw interruptedError(interruptionOf(other), 'default', 'migrate');
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
    if (this.#driver() === 'mysql') assertInterruptionReadable(columns, 'default');
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

  /**
   * The marker of a migration on MySQL, which commits DDL as it runs and so cannot be rolled back: `write` commits its row on the pinned
   * connection `on` (autocommit, outside any transaction) right before the first statement; a migration of rows alone writes it as the first
   * statement of its own transaction instead. `clear` deletes it inside the transaction that
   * changes the record row, and a run never deletes it any other way (`migrate:fresh` drops the table). On another driver both do nothing: its migration rolls back whole.
   */
  #marker(file: MigrationFile, connection: string, direction: 'up' | 'down', batch: number, plan: readonly PlanStep[], retrying?: MigrateOptions['retrying']) {
    // The row `retry` left is replaced by the one this migration writes, and deleted with its record: also when it writes none of its own.
    const retried = direction === 'up' && retrying?.some((row) => row.name === file.name) === true;
    let written = retried;
    // A plan that sends MySQL no statement (raw steps with `mysql: null`, or none) changes nothing a marker could tell of.
    const mysql = this.#driver(connection) === 'mysql' && !plan.every((step) => step.kind === 'raw' && step.statements.mysql === null);
    return {
      write: mysql
        ? async (on: Kysely<any>) => {
            // On `default` the pinned connection `on`; through the migrator's connection for another database, as the pool of `default` may have one connection only.
            const values = { name: file.name, module: file.module, connection_name: connection, direction, batch, started_at: new Date().toISOString(), owner: this.#lockOptions.owner ?? ownerOf(process.pid) };
            const insert = (connection === 'default' ? on : this.#books()).insertInto(INTERRUPTION_TABLE).values(values);
            // One statement: the old row is never gone while the new one is not there yet.
            await (retried ? insert.onDuplicateKeyUpdate(values) : insert).execute();
            written = true;
          }
        : undefined,
      clear: async (trx: Kysely<any>) => {
        if (written) await trx.deleteFrom(INTERRUPTION_TABLE).where('name', '=', file.name).execute();
      },
      /** Whether the row is in the table now: a rolled-back transaction took it along, an implicit commit did not. Unknown (the read failed) counts as there. */
      stays: async () => {
        if (!written) return false;
        try {
          return (await this.#books().selectFrom(INTERRUPTION_TABLE).select('name').where('name', '=', file.name).executeTakeFirst()) !== undefined;
        } catch {
          return true;
        }
      },
    };
  }

  /** Tells `onInterrupted` of a migration that failed with its marker in the table. What the callback throws never replaces the error of the migration. */
  async #reportInterrupted(marker: { stays: () => Promise<boolean> }, report: MigrateOptions['onInterrupted'], left: InterruptedMigration): Promise<void> {
    if (!report || !(await marker.stays())) return;
    try {
      await report(left);
    } catch {
      // The run's own error is the one to see.
    }
  }

  /** A MySQL connection needs a MySQL `default`: only there is the table of interruptions, and only beside the record can its row be removed with the record's. */
  #assertMarkable(connection: string, what: string, nothing = 'run'): void {
    if (this.#driver(connection) !== 'mysql' || this.#driver() === 'mysql') return;
    throw new UnsupportedDriverError(
      withCode(
        'D29',
        `${what} on the MySQL connection "${connection}", and "default" is ${this.#driver()}: Marmeon marks a MySQL migration that stops halfway beside the record of migrations, which only a MySQL "default" holds. Put "default" on MySQL too. Nothing was ${nothing}. See docs/migrations.md#mysql.`,
      ),
    );
  }

  /**
   * Runs one migration on `connection`: in a transaction where the database rolls DDL back, on one pinned connection without one on
   * MySQL, which commits as it runs DDL and has nothing to roll back (the `data` steps each have a transaction of their own). The
   * pinned connection goes back to the pool when the migration ends, with whatever session state it made reset.
   */
  async #applying(connection: string, work: (db: Kysely<any>) => Promise<void>): Promise<void> {
    const db = this.#db(connection);
    if (this.#driver(connection) === 'mysql') await db.connection().execute(work);
    else await db.transaction().execute(work);
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
