import { withCode } from '@marmeon/core/internal';
import { byCodePoint, type ForeignKey, type Introspected, type SchemaMarker } from '../introspection.ts';
import { loadMigration, type MigrationSource } from '../migrations/load.ts';
import type { Blueprint, ColumnSpec, Driver, TableMarker } from './blueprint.ts';
import { planOf, type PlanStep } from './plan.ts';
import { SchemaError } from './schema-error.ts';

// What the migrations say about the schema, computed from their plans alone: no database, nothing executed. The one place that knows
// how a plan step changes a table — the order of an `alter` follows `alter()` in plan.ts, because the database does it in that order.

/** One column as a migration describes it. */
export interface ProjectedColumn {
  readonly name: string;
  /** The type the blueprint writes for each driver (`varchar(255)`, `bigint`), before the catalog reports it in its own words. */
  readonly type: Readonly<Record<Driver, string>>;
  readonly nullable: boolean;
  readonly primary: boolean;
  /** An auto-incrementing key. */
  readonly identity: boolean;
  readonly default: 'value' | 'now' | 'uuidv7' | null;
  readonly secret: boolean;
}

export interface ProjectedIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

/** A single-column foreign key. */
export interface ProjectedForeignKey {
  readonly column: string;
  readonly references: string;
  readonly referenced: string;
  readonly onDelete?: 'cascade' | 'set null' | 'restrict' | 'no action';
  /** The name of the relation the referenced table gets back (`.inverse()`). */
  readonly inverse?: string;
}

export interface ProjectedTable {
  readonly name: string;
  /** The module whose migration created it. */
  readonly module: string;
  /** In the order the database has them: new ones last, a renamed one where it was. */
  readonly columns: readonly ProjectedColumn[];
  /** The column sets that identify a row: the primary key and the unique indexes. */
  readonly uniques: readonly (readonly string[])[];
  readonly indexes: readonly ProjectedIndex[];
  readonly foreignKeys: readonly ProjectedForeignKey[];
  /** `timestamps()` and `softDeletes()`. */
  readonly markers: readonly TableMarker[];
}

/** The schema the migrations leave: tables by name, one namespace for every connection. */
export interface SchemaProjection {
  /** The migrations it was computed from, in the order they ran. */
  readonly migrations: readonly { readonly name: string; readonly module: string }[];
  readonly tables: ReadonlyMap<string, ProjectedTable>;
}

/** The columns a table-level marker stands for: dropping or renaming one of them takes the marker with it. */
export const MARKER_COLUMNS: Readonly<Record<string, TableMarker>> = { deleted_at: 'soft_deletes', created_at: 'timestamps', updated_at: 'timestamps' };

/** A change of something no migration created with the blueprint: the projection would not hold it, and a mark such as `.secret()` would be lost. */
function unknown(where: string, what: string): SchemaError {
  return new SchemaError(
    withCode('D19', `${where} changes ${what}, which no migration created with the blueprint. Create it with schema.create(): a change in raw SQL keeps no secret, soft-delete or timestamps mark. See docs/migrations.md#raw-sql.`),
  );
}

/** Another mistake in a plan that makes the projection impossible (a name taken twice, a column that is there already). */
function conflict(message: string): SchemaError {
  return new SchemaError(withCode('D19', message));
}

export const emptyProjection: SchemaProjection = { migrations: [], tables: new Map() };

/**
 * The projection after one migration's plan. Pure: the projection it is given is not changed. `raw` and `data` steps change nothing —
 * what raw SQL makes is unknown to the projection.
 */
export function applyPlan(projection: SchemaProjection, steps: readonly PlanStep[], file: Pick<MigrationSource, 'name' | 'module'>): SchemaProjection {
  const tables = new Map(projection.tables);
  const where = `Migration ${file.name} (module "${file.module}")`;
  for (const step of steps) {
    switch (step.kind) {
      case 'create': {
        if (tables.has(step.table)) {
          throw conflict(`${where} creates table "${step.table}", which an earlier migration created and no migration dropped. Every connection shares one namespace of table names.`);
        }
        tables.set(step.table, change(blank(step.table, file.module), step.blueprint, where));
        break;
      }
      case 'alter': {
        if (!tables.has(step.table)) throw unknown(where, `table "${step.table}"`);
        alter(tables, step.blueprint, where);
        break;
      }
      case 'drop':
        tables.delete(step.table);
        break;
      case 'rename':
        rename(tables, step.from, step.to, step.indexes, where);
        break;
      case 'raw':
      case 'data':
        break;
    }
  }
  return { migrations: [...projection.migrations, { name: file.name, module: file.module }], tables };
}

/**
 * The projection of migrations, in the order given: each file is loaded and its `up()` plan applied. `only` names the migrations to
 * take — the ones that remain after a rollback.
 */
export async function projectMigrations(files: readonly MigrationSource[], options: { readonly only?: ReadonlySet<string> } = {}): Promise<SchemaProjection> {
  let projection = emptyProjection;
  for (const file of files) {
    if (options.only && !options.only.has(file.name)) continue;
    const migration = await loadMigration(file);
    projection = applyPlan(projection, planOf(migration, 'up', `Migration ${file.name} (module "${file.module}")`), file);
  }
  return projection;
}

/**
 * The projection in the form of a catalog reading, so relations and column kinds are derived from it by the code that derives them
 * from the database. The type of a column is the one the blueprint writes for `driver`.
 */
export function factsOf(projection: SchemaProjection, driver: Driver): Introspected {
  const foreignKeys: ForeignKey[] = [];
  const uniques = new Map<string, string[][]>();
  const columns = new Map<string, string[]>();
  const types = new Map<string, Map<string, string>>();
  const markers: SchemaMarker[] = [];
  const secretColumns: { table: string; column: string }[] = [];
  for (const table of projection.tables.values()) {
    columns.set(table.name, table.columns.map((column) => column.name));
    types.set(table.name, new Map(table.columns.map((column) => [column.name, column.type[driver]])));
    for (const column of table.columns) if (column.secret) secretColumns.push({ table: table.name, column: column.name });
    for (const marker of table.markers) markers.push({ table: table.name, column: '', marker, value: null });
    const nullable = new Map(table.columns.map((column) => [column.name, column.nullable]));
    for (const key of table.foreignKeys) {
      foreignKeys.push({ table: table.name, column: key.column, references: key.references, referenced: key.referenced, nullable: nullable.get(key.column) ?? false });
      if (key.inverse) markers.push({ table: table.name, column: key.column, marker: 'inverse', value: key.inverse });
    }
    if (table.uniques.length) uniques.set(table.name, table.uniques.map((set) => [...set]).sort((a, b) => byCodePoint(a.join('\0'), b.join('\0'))));
  }
  return {
    foreignKeys: foreignKeys.sort((a, b) => byCodePoint(a.table, b.table) || byCodePoint(a.column, b.column)),
    uniques: new Map([...uniques].sort(([a], [b]) => byCodePoint(a, b))),
    columns,
    markers: markers.sort((a, b) => byCodePoint(a.table, b.table) || byCodePoint(a.column, b.column) || byCodePoint(a.marker, b.marker)),
    types,
    secretColumns,
  };
}

/** Changes a known table; the foreign keys that point at a column it renames follow, as the database makes them. */
function alter(tables: Map<string, ProjectedTable>, blueprint: Blueprint, where: string): void {
  const before = tables.get(blueprint.table)!;
  const after = change(before, blueprint, where);
  tables.set(blueprint.table, after);
  for (const { from, to } of blueprint.renames) {
    for (const [name, other] of tables) {
      if (!other.foreignKeys.some((k) => k.references === blueprint.table && k.referenced === from)) continue;
      tables.set(name, { ...other, foreignKeys: other.foreignKeys.map((k) => (k.references === blueprint.table && k.referenced === from ? { ...k, referenced: to } : k)) });
    }
  }
}

function blank(name: string, module: string): ProjectedTable {
  return { name, module, columns: [], uniques: [], indexes: [], foreignKeys: [], markers: [] };
}

function columnOf(spec: ColumnSpec): ProjectedColumn {
  const { type } = spec;
  return {
    name: spec.name,
    type: { sqlite: String(type.sqlite), pgsql: String(type.pgsql) },
    // A primary key is never NULL, whatever the blueprint says of the column.
    nullable: spec.nullable && !spec.primary,
    primary: spec.primary,
    identity: spec.identity,
    default: spec.default ? ('now' in spec.default ? 'now' : 'uuidv7' in spec.default ? 'uuidv7' : 'value') : null,
    secret: spec.secret,
  };
}

/** Applies a blueprint to a table in the order `alter()` runs it (a `create` has only columns, indexes and markers). */
function change(table: ProjectedTable, blueprint: Blueprint, where: string): ProjectedTable {
  let { columns, indexes, foreignKeys, markers } = table;
  const name = table.name;
  const has = (column: string) => columns.some((c) => c.name === column);

  for (const index of blueprint.dropIndexes) indexes = indexes.filter((other) => other.name !== index);

  for (const { from, to } of blueprint.renames) {
    if (!has(from)) throw unknown(where, `column "${name}.${from}"`);
    if (has(to)) throw conflict(`${where} renames "${name}.${from}" to "${to}", but the table has a column of that name.`);
    columns = columns.map((c) => (c.name === from ? { ...c, name: to } : c));
    indexes = indexes.map((i) => ({ ...i, columns: i.columns.map((c) => (c === from ? to : c)) }));
    foreignKeys = foreignKeys.map((k) => (k.column === from ? { ...k, column: to } : k));
    // `inverse` stays with its key; `deleted_at` under another name is no soft delete any more.
    if (MARKER_COLUMNS[from]) markers = markers.filter((m) => m !== MARKER_COLUMNS[from]);
  }

  for (const spec of blueprint.columns) {
    if (has(spec.name)) throw conflict(`${where} adds column "${spec.name}" to "${name}", which has it already.`);
    columns = [...columns, columnOf(spec)];
    if (spec.references) {
      const { table: references, column: referenced, onDelete, inverse } = spec.references;
      foreignKeys = [...foreignKeys, { column: spec.name, references, referenced, ...(onDelete ? { onDelete } : {}),...(inverse ? { inverse } : {}) }];
    }
  }

  for (const { column } of blueprint.nullability) if (!has(column)) throw unknown(where, `column "${name}.${column}"`);
  for (const { column, nullable } of blueprint.nullability) columns = columns.map((c) => (c.name === column ? { ...c, nullable: nullable && !c.primary } : c));

  for (const index of blueprint.allIndexes()) {
    for (const column of index.columns) if (!has(column)) throw unknown(where, `column "${name}.${column}" (in index "${index.name}")`);
    indexes = [...indexes.filter((other) => other.name !== index.name), { name: index.name, columns: index.columns, unique: index.unique }];
  }

  for (const marker of blueprint.markers) if (!markers.includes(marker)) markers = [...markers, marker];

  for (const column of blueprint.drops) {
    columns = columns.filter((c) => c.name !== column);
    foreignKeys = foreignKeys.filter((k) => k.column !== column);
    // The database drops an index with a column it covers.
    indexes = indexes.filter((i) => !i.columns.includes(column));
    if (MARKER_COLUMNS[column]) markers = markers.filter((m) => m !== MARKER_COLUMNS[column]);
  }

  return { ...table, columns, indexes, foreignKeys, markers: markers.toSorted(byCodePoint), uniques: uniqueSets(columns, indexes) };
}

/** The primary key, and every unique index, as column sets without a repeated one. */
function uniqueSets(columns: readonly ProjectedColumn[], indexes: readonly ProjectedIndex[]): string[][] {
  const sets: string[][] = [];
  const add = (set: string[]) => {
    if (set.length && !sets.some((other) => other.join('\0') === set.join('\0'))) sets.push(set);
  };
  add(columns.filter((c) => c.primary).map((c) => c.name));
  for (const index of indexes) if (index.unique) add([...index.columns]);
  return sets;
}

/** A renamed table keeps its columns, marks and owner; the foreign keys that point at it follow, as the database does. */
function rename(tables: Map<string, ProjectedTable>, from: string, to: string, indexes: boolean, where: string): void {
  const table = tables.get(from);
  if (!table) throw unknown(where, `table "${from}"`);
  if (tables.has(to)) throw conflict(`${where} renames "${from}" to "${to}", which is the name of another table.`);
  const prefix = `${from}_`;
  const renamed = indexes ? table.indexes.map((i) => (i.name.startsWith(prefix) ? { ...i, name: `${to}_${i.name.slice(prefix.length)}` } : i)) : table.indexes;
  tables.delete(from);
  tables.set(to, { ...table, name: to, indexes: renamed });
  for (const [name, other] of tables) {
    if (!other.foreignKeys.some((k) => k.references === from)) continue;
    tables.set(name, { ...other, foreignKeys: other.foreignKeys.map((k) => (k.references === from ? { ...k, references: to } : k)) });
  }
}
