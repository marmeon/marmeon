import { readdirSync, existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Application } from '@marmeon/core';
import { sql, type Generated, type Kysely } from 'kysely';
import { Connections } from '../connections.ts';
import { SECRETS_TABLE } from '../metadata.ts';
import { Schema, type SchemaRecorder } from '../schema/schema.ts';
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

export interface MigrationRun {
  readonly name: string;
  readonly module: string;
  readonly ms: number;
}

/** Internal bookkeeping tables — not part of the app's generated `Tables`. */
export const MIGRATIONS_TABLE = 'migrations';
export const OWNERS_TABLE = 'table_owners';
export { SECRETS_TABLE };

interface Bookkeeping {
  migrations: { id: Generated<number>; name: string; module: string; batch: number };
  table_owners: { table_name: string; module: string };
  secret_columns: { table_name: string; column_name: string };
}

/**
 * Runs the migrations of every module, ordered by their timestamp — Laravel's migrator, with
 * batches, plus a record of which module's migration created which table and which
 * columns are secret.
 *
 * A migration may run on another connection (`connection` in `defineMigration`, e.g. the cache's own SQLite
 * file): its record stays on `default` (one order, one batch number for all), the table's owner and secret columns go
 * to the bookkeeping of the connection the table is on.
 */
export class Migrator {
  readonly #app: Application;
  readonly #connections: Connections;
  /** Every migration on `default`, whatever it names (the scratch database of `db:types`). */
  #oneConnection = false;

  constructor(app: Application, connections: Connections) {
    this.#app = app;
    this.#connections = connections;
  }

  /** Runs every migration on `default`, whatever connection it names — for one scratch database of all tables (`db:types`). */
  onOneConnection(): this {
    this.#oneConnection = true;
    return this;
  }

  /** Every migration file of every module, in the order they run. */
  files(): MigrationFile[] {
    const files: MigrationFile[] = [];
    for (const module of this.#app.modules) {
      if (!module.migrations) continue;
      const directory = module.migrations instanceof URL ? fileURLToPath(module.migrations) : resolve(this.#app.root, module.migrations);
      if (!existsSync(directory)) throw new Error(`The migrations directory of module "${module.name}" does not exist: ${directory}`);
      for (const entry of readdirSync(directory)) {
        if (entry.endsWith('.d.ts') || /\.test\./.test(entry)) continue;
        if (!FILE.test(entry)) {
          if (/\.(ts|js|mts|mjs)$/.test(entry)) {
            throw new Error(`Migration file name "${entry}" (module "${module.name}") must look like 2026_10_01_120000_create_users_table.ts.`);
          }
          continue;
        }
        files.push({ name: basename(entry, extname(entry)), module: module.name, path: join(directory, entry) });
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = 1; i < files.length; i++) {
      if (files[i]!.name === files[i - 1]!.name) {
        throw new Error(`Two migrations are named "${files[i]!.name}" (modules "${files[i - 1]!.module}" and "${files[i]!.module}").`);
      }
    }
    return files;
  }

  async status(): Promise<MigrationStatus[]> {
    const ran = new Map((await this.#ran()).map((row) => [row.name, row.batch]));
    return this.files().map((file) => ({ ...file, batch: ran.get(file.name) }));
  }

  /** Runs every pending migration, in one new batch. */
  async migrate(onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    await this.#prepare();
    const db = this.#db();
    const ran = new Set((await this.#ran()).map((row) => row.name));
    const pending = this.files().filter((file) => !ran.has(file.name));
    if (pending.length === 0) return [];

    const batch = (await this.#lastBatch()) + 1;
    const runs: MigrationRun[] = [];
    for (const file of pending) {
      const migration = await load(file);
      const connection = this.#connectionOf(migration, file);
      const started = performance.now();
      // One transaction per migration: a failing one leaves no half-changed schema (SQLite and Postgres both roll back DDL).
      if (connection === 'default') {
        await db.transaction().execute(async (trx) => {
          await migration.up(this.#schema(trx, file.module, connection));
          await trx.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch }).execute();
        });
      } else {
        // On its own connection, then recorded on default — two databases, so two transactions (the record comes last:
        // a migration that failed is not recorded).
        await this.#prepare(connection);
        await this.#db(connection)
          .transaction()
          .execute(async (trx) => {
            await migration.up(this.#schema(trx, file.module, connection));
          });
        await db.insertInto(MIGRATIONS_TABLE).values({ name: file.name, module: file.module, batch }).execute();
      }
      const run = { name: file.name, module: file.module, ms: performance.now() - started };
      runs.push(run);
      onRun?.(run);
    }
    return runs;
  }

  /** Rolls back the last batch — or the last `steps` migrations. */
  async rollback(options: { steps?: number } = {}, onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    await this.#prepare();
    const rows = (await this.#ran()).toReversed();
    const last = rows[0]?.batch;
    const targets = options.steps ? rows.slice(0, options.steps) : rows.filter((row) => row.batch === last);
    return this.#down(targets, onRun);
  }

  /** Rolls back every migration. */
  async reset(onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    await this.#prepare();
    return this.#down((await this.#ran()).toReversed(), onRun);
  }

  /** Drops every table (not only the migrated ones) and migrates from scratch. */
  async fresh(onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    await this.dropAllTables();
    return this.migrate(onRun);
  }

  /**
   * Drops every table of the default connection, the bookkeeping included — and of every other connection a migration
   * runs on (its tables would be in the way of the fresh run). Returns the connections.
   */
  async dropAllTables(): Promise<string[]> {
    const connections = await this.connections();
    for (const connection of connections) await new Schema(this.#db(connection), this.#driver(connection)).dropAllTables();
    return connections;
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

  async #down(rows: readonly { name: string; module: string }[], onRun?: (run: MigrationRun) => void): Promise<MigrationRun[]> {
    const files = new Map(this.files().map((file) => [file.name, file]));
    const db = this.#db();
    const runs: MigrationRun[] = [];
    for (const row of rows) {
      const file = files.get(row.name);
      if (!file) throw new Error(`Cannot roll back "${row.name}" (module "${row.module}"): its file is gone.`);
      const migration = await load(file);
      if (!migration.down) throw new Error(`Cannot roll back "${row.name}" (module "${row.module}"): it has no down().`);
      const connection = this.#connectionOf(migration, file);
      const started = performance.now();
      if (connection === 'default') {
        await db.transaction().execute(async (trx) => {
          await migration.down!(this.#schema(trx, file.module, connection));
          await trx.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
        });
      } else {
        await this.#prepare(connection);
        await this.#db(connection)
          .transaction()
          .execute(async (trx) => {
            await migration.down!(this.#schema(trx, file.module, connection));
          });
        await db.deleteFrom(MIGRATIONS_TABLE).where('name', '=', row.name).execute();
      }
      const run = { name: row.name, module: row.module, ms: performance.now() - started };
      runs.push(run);
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
        `Migration ${file.name} (module "${file.module}") runs on the database connection ${JSON.stringify(name)}, which is not configured. ` +
          `Known: ${this.#connections.names().join(', ')}. Add it with defineConnection(…) in the app's config.`,
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
      },
      dropped: async (table) => {
        await trx.deleteFrom(OWNERS_TABLE).where('table_name', '=', table).execute();
        await trx.deleteFrom(SECRETS_TABLE).where('table_name', '=', table).execute();
      },
      renamed: async (from, to) => {
        await trx.updateTable(OWNERS_TABLE).set({ table_name: to }).where('table_name', '=', from).execute();
        await trx.updateTable(SECRETS_TABLE).set({ table_name: to }).where('table_name', '=', from).execute();
      },
      secret: async (table, column) => {
        await trx.insertInto(SECRETS_TABLE).values({ table_name: table, column_name: column }).execute();
      },
      columnDropped: async (table, column) => {
        await trx.deleteFrom(SECRETS_TABLE).where('table_name', '=', table).where('column_name', '=', column).execute();
      },
      columnRenamed: async (table, from, to) => {
        await trx.updateTable(SECRETS_TABLE).set({ column_name: to }).where('table_name', '=', table).where('column_name', '=', from).execute();
      },
    };
    return new Schema(trx, this.#driver(connection), owners);
  }

  /** The bookkeeping tables: the record of migrations on `default`; table owners and secret columns on every connection with tables. */
  async #prepare(connection = 'default'): Promise<void> {
    const db = this.#db(connection);
    if (connection === 'default') {
      await db.schema
        .createTable(MIGRATIONS_TABLE)
        .ifNotExists()
        .addColumn('id', this.#driver() === 'sqlite' ? 'integer' : 'bigint', (c) =>
          this.#driver() === 'sqlite' ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity(),
        )
        .addColumn('name', 'varchar(255)', (c) => c.notNull().unique())
        .addColumn('module', 'varchar(255)', (c) => c.notNull())
        .addColumn('batch', 'integer', (c) => c.notNull())
        .execute();
    }
    await db.schema
      .createTable(OWNERS_TABLE)
      .ifNotExists()
      .addColumn('table_name', 'varchar(255)', (c) => c.primaryKey())
      .addColumn('module', 'varchar(255)', (c) => c.notNull())
      .execute();
    await db.schema
      .createTable(SECRETS_TABLE)
      .ifNotExists()
      .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
      .addColumn('column_name', 'varchar(255)', (c) => c.notNull())
      .addPrimaryKeyConstraint(`${SECRETS_TABLE}_pkey`, ['table_name', 'column_name'])
      .execute();
  }

  async #ran(): Promise<{ id: number; name: string; module: string; batch: number }[]> {
    if (!(await this.#hasTable(MIGRATIONS_TABLE))) return [];
    return this.#db().selectFrom(MIGRATIONS_TABLE).selectAll().orderBy('batch').orderBy('name').execute();
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

  #driver(connection = 'default') {
    return this.#connections.options(connection).driver;
  }
}

async function load(file: MigrationFile): Promise<Migration> {
  const module = (await import(pathToFileURL(file.path).href)) as { default?: Partial<Migration> };
  if (typeof module.default?.up !== 'function') {
    throw new Error(`Migration ${file.name} (module "${file.module}") must \`export default defineMigration({ up, down })\`.`);
  }
  return module.default as Migration;
}
