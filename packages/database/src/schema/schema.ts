import { withCode } from '@marmeon/core/internal';
import { sql } from 'kysely';
import { isBookkeepingName } from '../bookkeeping.ts';
import { bookkeepingAccess, lastSegment } from '../books.ts';
import type { Connection } from '../builder.ts';
import { LOCK_TABLE } from '../migrations/lock.ts';
import { Blueprint, compileColumn, type Driver, type TableMarker } from './blueprint.ts';
import { SchemaError } from './schema-error.ts';

export { SchemaError };

/**
 * Keeps the migrator's books: which module owns which table (`marmeon_table_owners`), which columns are secret
 * (`marmeon_secret_columns`), and the markers of tables and foreign keys (`marmeon_schema_markers`).
 */
export interface SchemaRecorder {
  created(table: string): Promise<void>;
  dropped(table: string): Promise<void>;
  renamed(from: string, to: string): Promise<void>;
  /** A column was marked `.secret()`. */
  secret(table: string, column: string): Promise<void>;
  /** A table was marked (`timestamps()`, `softDeletes()`), or a foreign key named its inverse relation. */
  marker(table: string, column: string, marker: TableMarker | 'inverse', value: string | null): Promise<void>;
  columnDropped(table: string, column: string): Promise<void>;
  columnRenamed(table: string, from: string, to: string): Promise<void>;
}

/**
 * Creates, changes, renames and drops tables — what a migration gets:
 *
 * ```ts
 * up: (schema) => schema.create('users', (table) => { table.id(); table.string('email').unique(); table.timestamps(); })
 * ```
 *
 * `schema.db` is the connection (inside the migration's transaction) for data changes and for
 * anything the blueprint does not cover (`schema.db.schema…`, `sql\`…\``).
 */
export class Schema {
  readonly db: Connection<any>;
  readonly driver: Driver;
  readonly #owners: SchemaRecorder | undefined;

  constructor(db: Connection<any>, driver: Driver, owners?: SchemaRecorder) {
    this.db = db;
    this.driver = driver;
    this.#owners = owners;
  }

  /** Refuses a name the migrator keeps its books under (`marmeon_migrations`, …, and the old `migrations`, `secret_columns`, … that stay taken until 1.0). */
  #allowed(table: string, action: string): void {
    // The last segment: `public.marmeon_secret_columns` and `main.marmeon_secret_columns` are the same table.
    if (bookkeepingAccess.has(this) || !isBookkeepingName(lastSegment(table))) return;
    throw new SchemaError(
      withCode(
        'D4',
        `Cannot ${action} "${table}": the name belongs to the migrator's bookkeeping, and changing it would make the secret columns or the soft deletes unreadable. ` +
          'Choose another name. See docs/migrations.md#how-the-migrator-keeps-track.',
      ),
    );
  }

  /** Creates a table. */
  async create(table: string, build: (table: Blueprint) => void): Promise<void> {
    this.#allowed(table, 'create the table');
    const blueprint = new Blueprint(table);
    build(blueprint);
    if (blueprint.columns.length === 0) throw new Error(`Table "${table}" needs at least one column.`);
    if (blueprint.drops.length || blueprint.renames.length || blueprint.dropIndexes.length) {
      throw new Error('dropColumn(), renameColumn() and dropIndex() only work when changing a table (schema.alter).');
    }

    let builder = this.db.schema.createTable(table);
    for (const spec of blueprint.columns) builder = builder.addColumn(spec.name, ...compileColumn(spec, this.driver));
    await builder.execute();
    await this.#createIndexes(blueprint);
    await this.#owners?.created(table);
    await this.#recordSecrets(blueprint);
    await this.#recordMarkers(blueprint);
  }

  /**
   * Changes a table. Every change runs as its own statement, because
   * SQLite's ALTER TABLE takes one change at a time. On SQLite a new NOT NULL column needs a default and cannot get a generated UUID
   * (`useUuidv7()`): `alter` refuses it before changing anything. See `docs/migrations.md#uuid-keys`.
   */
  async alter(table: string, build: (table: Blueprint) => void): Promise<void> {
    this.#allowed(table, 'alter the table');
    const blueprint = new Blueprint(table);
    build(blueprint);
    if (this.driver === 'sqlite') {
      const generated = blueprint.columns.find((spec) => spec.default && 'uuidv7' in spec.default);
      if (generated) {
        throw new Error(
          `schema.alter('${table}') cannot add the UUIDv7 column "${generated.name}" on SQLite: SQLite adds no column whose default is computed. ` +
            'Create the table with the column instead (on Postgres, alter works). See docs/migrations.md#uuid-keys.',
        );
      }
    }
    for (const name of blueprint.dropIndexes) await this.db.schema.dropIndex(name).execute();
    for (const { from, to } of blueprint.renames) {
      await this.db.schema.alterTable(table).renameColumn(from, to).execute();
      await this.#owners?.columnRenamed(table, from, to);
    }
    for (const spec of blueprint.columns) await this.db.schema.alterTable(table).addColumn(spec.name, ...compileColumn(spec, this.driver)).execute();
    await this.#createIndexes(blueprint);
    await this.#recordSecrets(blueprint);
    await this.#recordMarkers(blueprint);
    for (const column of blueprint.drops) {
      await this.db.schema.alterTable(table).dropColumn(column).execute();
      await this.#owners?.columnDropped(table, column);
    }
  }

  async #recordSecrets(blueprint: Blueprint): Promise<void> {
    for (const spec of blueprint.columns) if (spec.secret) await this.#owners?.secret(blueprint.table, spec.name);
  }

  async #recordMarkers(blueprint: Blueprint): Promise<void> {
    for (const marker of blueprint.markers) await this.#owners?.marker(blueprint.table, '', marker, null);
    for (const spec of blueprint.columns) {
      if (spec.references?.inverse) await this.#owners?.marker(blueprint.table, spec.name, 'inverse', spec.references.inverse);
    }
  }

  async #createIndexes(blueprint: Blueprint): Promise<void> {
    for (const index of blueprint.allIndexes()) {
      let builder = this.db.schema.createIndex(index.name).on(blueprint.table).columns([...index.columns]);
      if (index.unique) builder = builder.unique();
      await builder.execute();
    }
  }

  async drop(table: string): Promise<void> {
    this.#allowed(table, 'drop the table');
    await this.db.schema.dropTable(table).execute();
    await this.#owners?.dropped(table);
  }

  async dropIfExists(table: string): Promise<void> {
    this.#allowed(table, 'drop the table');
    await this.db.schema.dropTable(table).ifExists().execute();
    await this.#owners?.dropped(table);
  }

  /**
   * Renames a table. Its indexes and constraints keep their names, which begin with the old one (`notes_user_id_index`), unless
   * `indexes` is set: then those that begin with `<from>_` are renamed to begin with `<to>_` — so the table ends up as one
   * created under the new name (and, on Postgres, its identity sequences too). Opt-in: the default must not change what a
   * migration written earlier does.
   */
  async rename(from: string, to: string, options: { readonly indexes?: boolean } = {}): Promise<void> {
    this.#allowed(from, 'rename the table');
    this.#allowed(to, 'rename a table to');
    await this.db.schema.alterTable(from).renameTo(to).execute();
    if (options.indexes) await (this.driver === 'pgsql' ? this.#renameNamesPgsql(from, to) : this.#renameIndexesSqlite(from, to));
    await this.#owners?.renamed(from, to);
  }

  async #renameNamesPgsql(from: string, to: string): Promise<void> {
    const prefix = `${from}_`;
    const renamed = (name: string) => `${to}_${name.slice(prefix.length)}`;
    const table = sql`t.oid = to_regclass(quote_ident(${to}::text))`;
    // Every name is read before the first is changed: `to` may itself begin with `<from>_`, and a name already renamed must not be taken for an old one.
    const names = async (query: ReturnType<typeof sql<{ name: string }>>) => (await query.execute(this.db)).rows.map((row) => row.name).filter((name) => name.startsWith(prefix));
    const constraints = await names(sql<{ name: string }>`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid where ${table}`);
    const indexes = await names(sql<{ name: string }>`select i.relname as name from pg_index x join pg_class t on t.oid = x.indrelid join pg_class i on i.oid = x.indexrelid where ${table}`);
    const sequences = await names(sql<{ name: string }>`
      select s.relname as name from pg_class s
      join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
      join pg_class t on t.oid = d.refobjid
      where s.relkind = 'S' and ${table}`);
    for (const name of constraints) await sql`alter table ${sql.table(to)} rename constraint ${sql.id(name)} to ${sql.id(renamed(name))}`.execute(this.db);
    // Renaming a constraint renamed the index behind it (the primary key, a unique constraint) too.
    for (const name of indexes) {
      if (!constraints.includes(name)) await sql`alter index ${sql.id(name)} rename to ${sql.id(renamed(name))}`.execute(this.db);
    }
    for (const name of sequences) await sql`alter sequence ${sql.id(name)} rename to ${sql.id(renamed(name))}`.execute(this.db);
  }

  /** SQLite renames no index: it drops each and creates it again under the new name, from the statement it was created with. */
  async #renameIndexesSqlite(from: string, to: string): Promise<void> {
    const prefix = `${from}_`;
    // Indexes behind a primary key or a column's `unique` have no statement (`sql is null`) and no name to choose.
    const indexes = await sql<{ name: string; sql: string }>`select name, sql from sqlite_master where type = 'index' and tbl_name = ${to} and sql is not null`.execute(this.db);
    for (const { name, sql: statement } of indexes.rows) {
      if (!name.startsWith(prefix)) continue;
      const created = statement.replace(/^(\s*create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?)(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\S+))/i, (_, head: string) => `${head}"${to}_${name.slice(prefix.length)}"`);
      if (created === statement) throw new Error(`Cannot rename the index "${name}": its statement is not a plain "create index" (${statement}).`);
      await sql`drop index ${sql.id(name)}`.execute(this.db);
      await sql.raw(created).execute(this.db);
    }
  }

  async hasTable(table: string): Promise<boolean> {
    return (await this.db.introspection.getTables()).some((t) => t.name === table);
  }

  async hasColumn(table: string, column: string): Promise<boolean> {
    return (await this.db.introspection.getTables()).find((t) => t.name === table)?.columns.some((c) => c.name === column) ?? false;
  }

  /** Drops every table of the connection — `migrate:fresh`. Foreign keys are no obstacle. */
  async dropAllTables(): Promise<void> {
    // The migration lock of SQLite is a row in a table: the run that drops everything holds it.
    // The migrator's own tables stay, unless the migrator itself drops everything (`migrate:fresh`).
    await this.#forgetMigrated();
    const tables = (await this.db.introspection.getTables()).filter((t) => t.name !== LOCK_TABLE && (bookkeepingAccess.has(this) || !isBookkeepingName(t.name)));
    if (this.driver === 'pgsql') {
      for (const t of tables) await sql`drop table if exists ${sql.table(t.schema ? `${t.schema}.${t.name}` : t.name)} cascade`.execute(this.db);
      return;
    }
    await sql`pragma foreign_keys = off`.execute(this.db);
    try {
      for (const t of tables) await this.db.schema.dropTable(t.name).ifExists().execute();
    } finally {
      await sql`pragma foreign_keys = on`.execute(this.db);
    }
  }

  /** Before the tables go, the migrator's entries about them go (its own tables stay): left behind, they would point at nothing. */
  async #forgetMigrated(): Promise<void> {
    if (bookkeepingAccess.has(this)) return;
    const present = new Set((await this.db.introspection.getTables()).map((t) => t.name));
    for (const table of ['marmeon_migrations', 'marmeon_table_owners', 'marmeon_secret_columns', 'marmeon_schema_markers']) {
      if (present.has(table)) await sql`delete from ${sql.table(table)}`.execute(this.db);
    }
  }
}
