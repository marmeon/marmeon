import { sql, type Kysely } from 'kysely';
import { Blueprint, compileColumn, type Driver, type TableMarker } from './blueprint.ts';

/**
 * Keeps the migrator's books: which module owns which table (`table_owners`), which columns are secret
 * (`secret_columns`), and the markers of tables and foreign keys (`schema_markers`).
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
  readonly db: Kysely<any>;
  readonly driver: Driver;
  readonly #owners: SchemaRecorder | undefined;

  constructor(db: Kysely<any>, driver: Driver, owners?: SchemaRecorder) {
    this.db = db;
    this.driver = driver;
    this.#owners = owners;
  }

  /** Creates a table. */
  async create(table: string, build: (table: Blueprint) => void): Promise<void> {
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
    await this.db.schema.dropTable(table).execute();
    await this.#owners?.dropped(table);
  }

  async dropIfExists(table: string): Promise<void> {
    await this.db.schema.dropTable(table).ifExists().execute();
    await this.#owners?.dropped(table);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.db.schema.alterTable(from).renameTo(to).execute();
    await this.#owners?.renamed(from, to);
  }

  async hasTable(table: string): Promise<boolean> {
    return (await this.db.introspection.getTables()).some((t) => t.name === table);
  }

  async hasColumn(table: string, column: string): Promise<boolean> {
    return (await this.db.introspection.getTables()).find((t) => t.name === table)?.columns.some((c) => c.name === column) ?? false;
  }

  /** Drops every table of the connection — `migrate:fresh`. Foreign keys are no obstacle. */
  async dropAllTables(): Promise<void> {
    const tables = await this.db.introspection.getTables();
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
}
