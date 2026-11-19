import { withCode } from '@marmeon/core/internal';
import { byCodePoint, type ForeignKey, type Introspected, type SchemaMarker } from '../introspection.ts';
import { loadMigration, type MigrationSource } from '../migrations/load.ts';
import { blueprintParts, isStringType, mysqlTypeOf, oneOfName, type Blueprint, type ColumnSpec, type IndexCondition, type Driver, type TableMarker } from './blueprint.ts';
import { planOf, type ListCheck, type PlanStep } from './plan.ts';
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
  /** The value of `default(value)` is `null`, which a unique index never counts twice. Present only when set. */
  readonly nullDefault?: true;
  readonly secret: boolean;
  /**
   * Taken out of use with `retire()`: the database still has it, Marmeon does not know it any more — except that a secret one stays
   * secret. Present only when set, so a projection that retires nothing reads the same as before.
   */
  readonly retired?: boolean;
  /** The values `oneOf()` holds the column to. Present only when set. */
  readonly values?: readonly string[];
  /** The name of the constraint behind {@link values}: the column's name when it was added, so it stays after a rename. Present with `values`. */
  readonly valuesCheck?: string;
}

/** A named check constraint a migration added with `check()`. */
export interface ProjectedCheck {
  readonly name: string;
  readonly sql: string;
}

/** One index as a migration describes it. */
export interface ProjectedIndex {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  /** The condition of a partial index (see `IndexCondition`); present only when set. Such an index identifies no row of the table, so it is no unique set. */
  readonly where?: IndexCondition;
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

/** One table as the migrations describe it. See docs/migrations.md#what-the-migrations-describe. */
export interface ProjectedTable {
  readonly name: string;
  /** The module whose migration created it. */
  readonly module: string;
  /** In the order the database has them: new ones last, a renamed one where it was. Retired ones are among them; see {@link knownColumns}. */
  readonly columns: readonly ProjectedColumn[];
  /** The column sets that identify a row: the primary key and the unique indexes. */
  readonly uniques: readonly (readonly string[])[];
  readonly indexes: readonly ProjectedIndex[];
  readonly foreignKeys: readonly ProjectedForeignKey[];
  /** `timestamps()` and `softDeletes()`. */
  readonly markers: readonly TableMarker[];
  /** The constraints `check()` added and `dropCheck()` did not drop; the ones of `oneOf()` are on the columns. Present only when there are some. */
  readonly checks?: readonly ProjectedCheck[];
  /** `false` after `notPivot()`: a table with two unique foreign keys that is a record of its own. Absent otherwise. */
  readonly pivot?: false;
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

function retiredColumn(where: string, table: string, column: string): SchemaError {
  return new SchemaError(withCode('D19', `${where} changes "${table}.${column}", which an earlier migration retired. A retired column can only be dropped with dropColumn().`));
}

/** Every driver, from the keys of a record that must name them all: a driver added to the type fails to compile here. */
const DRIVERS = Object.keys({ sqlite: 0, pgsql: 0, mysql: 0 } satisfies Record<Driver, 0>) as Driver[];

/** Another mistake in a plan that makes the projection impossible (a name taken twice, a column that is there already). */
function conflict(message: string): SchemaError {
  return new SchemaError(withCode('D19', message));
}

/** The columns of a table that Marmeon knows: all but the retired ones. */
export function knownColumns(table: ProjectedTable): ProjectedColumn[] {
  return table.columns.filter((column) => !column.retired);
}

/**
 * For {@link executePlan}: what the plan needs to replace the list of a column at the step with this index — the name of the constraint after the step
 * (the one the column's list was made with, also after a rename in the same `alter()`, or the one the step makes) and whether the column had a list before it.
 * The column is not found when the migrations do not know it.
 */
export function listCheckOf(before: SchemaProjection, steps: readonly PlanStep[], file: Pick<MigrationSource, 'name' | 'module'>): ListCheck {
  return (index, table, column) => {
    const name = applyPlan(before, steps.slice(0, index + 1), file).tables.get(table)?.columns.find((c) => c.name === column)?.valuesCheck;
    if (name === undefined) return undefined;
    // A dropCheck() of the same alter() has dropped it by then.
    const step = steps[index];
    const dropped = step?.kind === 'alter' && blueprintParts(step.blueprint).dropChecks.includes(name);
    const had = !dropped && (applyPlan(before, steps.slice(0, index), file).tables.get(table)?.columns.some((c) => c.valuesCheck === name) ?? false);
    return { name, had };
  };
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
        referencesLive(tables, step.blueprint, where);
        break;
      }
      case 'alter': {
        if (!tables.has(step.table)) throw unknown(where, `table "${step.table}"`);
        alter(tables, step.blueprint, where);
        referencesLive(tables, step.blueprint, where);
        tiedColumns(tables, step.blueprint, where);
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

/** A table as a string that is the same for tables with the same columns, keys and marks, whatever the order they were added in. */
function signature(table: ProjectedTable): string {
  const sorted = <T>(items: readonly T[], key: (item: T) => string) => items.toSorted((a, b) => byCodePoint(key(a), key(b)));
  return JSON.stringify({
    module: table.module,
    columns: sorted(table.columns, (column) => column.name),
    uniques: sorted(table.uniques.map((set) => [...set].toSorted(byCodePoint)), (set) => set.join('\0')),
    indexes: sorted(table.indexes, (index) => index.name),
    foreignKeys: sorted(table.foreignKeys, (key) => key.column),
    markers: [...table.markers].toSorted(byCodePoint),
    checks: table.checks && sorted(table.checks, (check) => check.name),
    pivot: table.pivot,
  });
}

/**
 * The names of the tables that are in one projection only, or that the two describe differently. The order of a table's columns does
 * not count: two migrations that add a column each, in either order, leave the same table.
 */
export function differingTables(a: SchemaProjection, b: SchemaProjection): string[] {
  const names = new Set([...a.tables.keys(), ...b.tables.keys()]);
  return [...names].filter((name) => {
    const left = a.tables.get(name);
    const right = b.tables.get(name);
    return left === undefined || right === undefined || signature(left) !== signature(right);
  }).toSorted(byCodePoint);
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
  const primaryKeys = new Map<string, string[]>();
  for (const table of projection.tables.values()) {
    const known = knownColumns(table);
    columns.set(table.name, known.map((column) => column.name));
    types.set(table.name, new Map(known.map((column) => [column.name, column.type[driver]])));
    // A retired column stays secret until it is dropped: reading it explicitly is still refused.
    for (const column of table.columns) if (column.secret) secretColumns.push({ table: table.name, column: column.name });
    for (const marker of table.markers) markers.push({ table: table.name, column: '', marker, value: null });
    if (table.pivot === false) markers.push({ table: table.name, column: '', marker: 'not_pivot', value: null });
    const primary = known.filter((column) => column.primary).map((column) => column.name);
    if (primary.length) primaryKeys.set(table.name, primary);
    const nullable = new Map(known.map((column) => [column.name, column.nullable]));
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
    primaryKeys: new Map([...primaryKeys].sort(([a], [b]) => byCodePoint(a, b))),
  };
}

/** A foreign key that a blueprint adds must not point at a column an earlier migration retired. */
function referencesLive(tables: ReadonlyMap<string, ProjectedTable>, blueprint: Blueprint, where: string): void {
  const parts = blueprintParts(blueprint);
  for (const spec of parts.columns) {
    if (!spec.references) continue;
    const target = tables.get(spec.references.table)?.columns.find((c) => c.name === spec.references!.column);
    if (target?.retired) {
      throw conflict(`${where} makes "${blueprint.table}.${spec.name}" reference "${spec.references.table}.${spec.references.column}", which an earlier migration retired. A retired column can only be dropped.`);
    }
  }
}

/** The kind of value a column holds, for telling whether a foreign key can join two columns. */
function family(type: string): string {
  if (/^(integer|bigint)$/.test(type)) return 'integer';
  if (/^(varchar|text|longtext)\b/.test(type)) return 'string';
  return type;
}

/** The kind of a column for the value of a partial index's condition; `other` for a type the projection leaves alone. */
function conditionKind(column: ProjectedColumn): 'boolean' | 'integer' | 'string' | 'other' {
  const kinds = DRIVERS.map((driver) => family(column.type[driver]));
  if (kinds.some((kind) => kind !== kinds[0])) return 'other';
  return kinds[0] === 'boolean' ? 'boolean' : kinds[0] === 'integer' ? 'integer' : kinds[0] === 'string' ? 'string' : 'other';
}

/** A column that `foreign()` ties to a table must find its target there, of a type that fits; this is known before the first statement runs. */
function tiedColumns(tables: ReadonlyMap<string, ProjectedTable>, blueprint: Blueprint, where: string): void {
  const source = tables.get(blueprint.table)!;
  for (const { column, references } of blueprintParts(blueprint).foreignKeys) {
    const { table, column: referenced } = references!;
    const target = tables.get(table);
    if (!target) throw conflict(`${where} ties "${blueprint.table}.${column}" to table "${table}", which no migration created.`);
    const to = target.columns.find((c) => c.name === referenced && !c.retired);
    if (!to) throw conflict(`${where} ties "${blueprint.table}.${column}" to "${table}.${referenced}", which is not a column of that table (or an earlier migration retired it).`);
    const from = source.columns.find((c) => c.name === column);
    if (!from) throw conflict(`${where} ties "${blueprint.table}.${column}" to "${table}.${referenced}", but the same alter() drops the column.`);
    for (const driver of DRIVERS) {
      if (family(from.type[driver]) !== family(to.type[driver])) {
        throw conflict(`${where} ties "${blueprint.table}.${column}" (${from.type[driver]}) to "${table}.${referenced}" (${to.type[driver]}), which hold different kinds of values. A foreign key joins an integer to an integer and a uuid to a uuid.`);
      }
    }
  }
}

/** Changes a known table; the foreign keys that point at a column it renames follow, as the database makes them. */
function alter(tables: Map<string, ProjectedTable>, blueprint: Blueprint, where: string): void {
  const parts = blueprintParts(blueprint);
  const before = tables.get(blueprint.table)!;
  for (const column of parts.retirements) {
    const reference = [...tables.values()].find((other) => other.foreignKeys.some((k) => k.references === blueprint.table && k.referenced === column));
    if (reference) throw conflict(`${where} retires "${blueprint.table}.${column}", which a foreign key of "${reference.name}" references. Drop that foreign key's column first.`);
  }
  const after = change(before, blueprint, where);
  tables.set(blueprint.table, after);
  for (const { from, to } of parts.renames) {
    for (const [name, other] of tables) {
      if (!other.foreignKeys.some((k) => k.references === blueprint.table && k.referenced === from)) continue;
      tables.set(name, { ...other, foreignKeys: other.foreignKeys.map((k) => (k.references === blueprint.table && k.referenced === from ? { ...k, referenced: to } : k)) });
    }
  }
}

function blank(name: string, module: string): ProjectedTable {
  return { name, module, columns: [], uniques: [], indexes: [], foreignKeys: [], markers: [] };
}

function columnOf(spec: ColumnSpec, blueprint: Blueprint): ProjectedColumn {
  const { type } = spec;
  return {
    name: spec.name,
    type: { sqlite: String(type.sqlite), pgsql: String(type.pgsql), mysql: String(mysqlTypeOf(spec, blueprint)) },
    // A primary key is never NULL, whatever the blueprint says of the column.
    nullable: spec.nullable && !spec.primary,
    primary: spec.primary,
    identity: spec.identity,
    default: spec.default ? ('now' in spec.default ? 'now' : 'uuidv7' in spec.default ? 'uuidv7' : 'value') : null,
    ...(spec.default && 'value' in spec.default && spec.default.value === null ? { nullDefault: true as const } : {}),
    secret: spec.secret,
    ...(spec.oneOf ? { values: [...spec.oneOf], valuesCheck: oneOfName(spec.table, spec.name) } : {}),
  };
}

/** Applies a blueprint to a table in the order `alter()` runs it (a `create` has only columns, indexes and markers). */
function change(table: ProjectedTable, blueprint: Blueprint, where: string): ProjectedTable {
  const parts = blueprintParts(blueprint);
  let { columns, indexes, foreignKeys, markers } = table;
  let checks = table.checks ?? [];
  const name = table.name;
  const has = (column: string) => columns.some((c) => c.name === column);
  // A retired column can only be dropped: anything else would change what Marmeon has stopped knowing.
  const live = (column: string, what: string) => {
    if (!has(column)) throw unknown(where, `column "${name}.${column}"${what}`);
    if (columns.some((c) => c.name === column && c.retired)) throw retiredColumn(where, name, column);
  };

  for (const index of parts.dropIndexes) indexes = indexes.filter((other) => other.name !== index);

  for (const dropped of parts.dropChecks) {
    const column = columns.find((c) => c.valuesCheck === dropped);
    if (column) {
      const { values: _values, valuesCheck: _check, ...rest } = column;
      columns = columns.map((c) => (c === column ? rest : c));
    } else if (checks.some((check) => check.name === dropped)) {
      checks = checks.filter((check) => check.name !== dropped);
    } else {
      throw unknown(where, `check constraint "${dropped}" of table "${name}"`);
    }
  }

  for (const { from, to } of parts.renames) {
    live(from, '');
    if (has(to)) throw conflict(`${where} renames "${name}.${from}" to "${to}", but the table has a column of that name.`);
    columns = columns.map((c) => (c.name === from ? { ...c, name: to } : c));
    indexes = indexes.map((i) => ({
      ...i,
      columns: i.columns.map((c) => (c === from ? to : c)),
      ...(i.where ? { where: Object.fromEntries(Object.entries(i.where).map(([c, value]) => [c === from ? to : c, value])) } : {}),
    }));
    foreignKeys = foreignKeys.map((k) => (k.column === from ? { ...k, column: to } : k));
    // `inverse` stays with its key; `deleted_at` under another name is no soft delete any more.
    if (MARKER_COLUMNS[from]) markers = markers.filter((m) => m !== MARKER_COLUMNS[from]);
  }

  for (const spec of parts.columns) {
    if (has(spec.name)) throw conflict(`${where} adds column "${spec.name}" to "${name}", which has it already.`);
    if (spec.oneOf && (checks.some((check) => check.name === oneOfName(name, spec.name)) || columns.some((c) => c.valuesCheck === oneOfName(name, spec.name)))) {
      throw conflict(`${where} makes the check constraint "${oneOfName(name, spec.name)}" of "${name}.${spec.name}" with oneOf(), but the table has one of that name. Drop it with dropCheck() or name the other one differently.`);
    }
    columns = [...columns, columnOf(spec, blueprint)];
    if (spec.references) {
      const { table: references, column: referenced, onDelete, inverse } = spec.references;
      foreignKeys = [...foreignKeys, { column: spec.name, references, referenced, ...(onDelete ? { onDelete } : {}),...(inverse ? { inverse } : {}) }];
    }
  }

  for (const { name: added, sql } of parts.checks) {
    if (checks.some((check) => check.name === added) || columns.some((c) => c.valuesCheck === added)) {
      throw conflict(`${where} adds the check constraint "${added}" to "${name}", which has one of that name. Drop it with dropCheck() first.`);
    }
    checks = [...checks, { name: added, sql }];
  }

  for (const { column } of parts.nullability) live(column, '');
  for (const { column, nullable } of parts.nullability) columns = columns.map((c) => (c.name === column ? { ...c, nullable: nullable && !c.primary } : c));

  for (const { column, values } of parts.oneOfChanges) {
    live(column, '');
    const found = columns.find((c) => c.name === column)!;
    if (!isStringType(found.type.sqlite)) throw conflict(`${where} gives "${name}.${column}" a list with oneOf(), but it is no string() or text() column.`);
    if (found.valuesCheck === undefined) {
      const made = oneOfName(name, column);
      if (checks.some((check) => check.name === made) || columns.some((c) => c.valuesCheck === made)) {
        throw conflict(`${where} gives "${name}.${column}" a list with oneOf(), which makes the check constraint "${made}", but the table has one of that name. Drop it with dropCheck() or name the other one differently.`);
      }
    }
    // The constraint keeps the name it was made with, also after the column was renamed.
    columns = columns.map((c) => (c === found ? { ...c, values: [...values], valuesCheck: c.valuesCheck ?? oneOfName(name, column) } : c));
  }

  for (const { column, references } of parts.foreignKeys) {
    live(column, '');
    if (parts.retirements.includes(column)) {
      throw conflict(`${where} ties "${name}.${column}" to a table with foreign() and retires the column in the same alter(): the constraint would exist in the database, and Marmeon would not know the relation. Tie the column in an alter() of its own, or do not retire it.`);
    }
    if (foreignKeys.some((key) => key.column === column)) {
      throw conflict(`${where} ties "${name}.${column}" to a table with foreign(), but a foreign key of an earlier migration holds it already.`);
    }
    const { table: target, column: referenced, onDelete, inverse } = references!;
    foreignKeys = [...foreignKeys, { column, references: target, referenced, ...(onDelete ? { onDelete } : {}), ...(inverse ? { inverse } : {}) }];
  }

  for (const index of blueprint.allIndexes()) {
    for (const column of index.columns) live(column, ` (in index "${index.name}")`);
    for (const [column, value] of Object.entries(index.where ?? {})) {
      live(column, ` (in the where of index "${index.name}")`);
      const found = columns.find((c) => c.name === column)!;
      const kind = conditionKind(found);
      // A whole number as a string is the way to write a bigint above 2^53, and both drivers read it as the number.
      const refused =
        (typeof value === 'string' && (kind === 'boolean' || (kind === 'integer' && !/^-?(0|[1-9]\d*)$/.test(value)))) ||
        (typeof value === 'number' && (kind === 'boolean' || kind === 'string')) ||
        (typeof value === 'boolean' && (kind === 'string' || kind === 'integer'));
      if (refused) {
        throw conflict(
          `${where} gives the where of index "${index.name}" ${JSON.stringify(value)} for "${name}.${column}", a ${kind} column. The where of an index takes a value of the column's kind: true or false for a boolean, a number (or a whole number as a string) for an integer, a string for a string.`,
        );
      }
    }
    indexes = [...indexes.filter((other) => other.name !== index.name), { name: index.name, columns: index.columns, unique: index.unique, ...(index.where ? { where: index.where } : {}) }];
  }

  for (const marker of parts.markers) if (!markers.includes(marker)) markers = [...markers, marker];

  for (const column of parts.retirements) {
    const found = columns.find((c) => c.name === column);
    if (!found) throw unknown(where, `column "${name}.${column}"`);
    if (found.retired) throw conflict(`${where} retires "${name}.${column}", which an earlier migration retired. Drop it with dropColumn().`);
    const conditioned = indexes.find((i) => i.where && Object.hasOwn(i.where, column));
    if (conditioned) {
      throw conflict(`${where} retires "${name}.${column}", which the where of the index "${conditioned.name}" names: the index would keep reading a column Marmeon no longer knows. Drop the index first with dropIndex('${conditioned.name}') or dropUnique('${conditioned.name}'), in this or an earlier alter.`);
    }
    if (found.primary || (MARKER_COLUMNS[column] !== undefined && markers.includes(MARKER_COLUMNS[column]))) {
      throw conflict(`${where} retires "${name}.${column}", which is ${found.primary ? 'part of the primary key' : 'the column of a timestamps() or softDeletes() mark'}; Marmeon needs it.`);
    }
    // The new release inserts without a column it does not know; the database has to accept that.
    if (!found.nullable && found.default === null && !found.identity) {
      throw conflict(
        `${where} retires "${name}.${column}", which is NOT NULL and has no default: the inserts of the release that no longer knows it would fail. ` +
          `Make it nullable in an earlier migration (table.nullable('${column}'), Postgres only), or drop it with dropColumn() once no process of the previous release is running. See docs/migrations.md#deploying-new-migrations.`,
      );
    }
    // Every insert of the new release would write the same value, and a unique index could refuse the second. A partial unique index counts too:
    // the release still writes the columns of its condition, so a row it inserts can fall under the index. The refusal is the default; only a plan
    // that proves no two rows can collide gets past it (see `cannotCollide`).
    const unique = indexes.find((i) => i.unique && i.columns.includes(column) && !cannotCollide(i, found, columns, parts.retirements));
    if (unique && (found.default === 'value' || found.default === 'now')) {
      const condition = unique.where ? ` (where ${describeCondition(unique.where)})` : '';
      const same = found.default === 'now' ? 'rows it writes at the same moment get the same value' : 'every row of the release that no longer knows it gets the same value';
      throw conflict(
        `${where} retires "${name}.${column}", which has a fixed default and is in the unique index "${unique.name}"${condition}: ${same}, so ${unique.columns.length > 1 ? 'the other columns of the index could become unique on their own among the rows it covers' : 'a second row the index covers could collide'}, and the migrations do not prove that no row can. ` +
          `Drop the unique index first with dropUnique('${unique.name}'), in this or an earlier alter. See docs/migrations.md#retiring-a-column.`,
      );
    }
    columns = columns.map((c) => (c.name === column ? { ...c, retired: true } : c));
    // The relation and the finders that rested on it are gone; the constraint stays in the database.
    foreignKeys = foreignKeys.filter((k) => k.column !== column);
  }

  for (const column of parts.drops) {
    columns = columns.filter((c) => c.name !== column);
    foreignKeys = foreignKeys.filter((k) => k.column !== column);
    // Postgres drops an index with a column it covers or its condition uses; SQLite refuses to drop either.
    indexes = indexes.filter((i) => !i.columns.includes(column) && !(i.where && Object.hasOwn(i.where, column)));
    if (MARKER_COLUMNS[column]) markers = markers.filter((m) => m !== MARKER_COLUMNS[column]);
  }

  // A retirement may rest on a condition no row can meet, which holds only while it stays so: whatever this alter did, a unique index over a retired
  // column with a fixed default has to be one that still cannot collide.
  for (const index of indexes) {
    if (!index.unique) continue;
    const open = columns.find((c) => c.retired && index.columns.includes(c.name) && (c.default === 'value' || c.default === 'now') && !cannotCollide(index, c, columns, []));
    if (open) {
      throw conflict(
        `${where} leaves the unique index "${index.name}"${index.where ? ` (where ${describeCondition(index.where)})` : ''} over "${name}.${open.name}", which was retired with a fixed default, with rows that could collide: the retirement rested on a condition no row could meet. ` +
          `Drop the unique index first with dropUnique('${index.name}'), in this or an earlier alter. See docs/migrations.md#retiring-a-column.`,
      );
    }
  }

  const { checks: _before, ...rest } = table;
  return { ...rest, columns, indexes, foreignKeys, markers: markers.toSorted(byCodePoint), uniques: uniqueSets(columns, indexes), ...(checks.length ? { checks } : {}), ...(parts.notPivot ? { pivot: false as const } : {}) };
}

/** The primary key, and every unique index, as column sets without a repeated one. */
function uniqueSets(columns: readonly ProjectedColumn[], indexes: readonly ProjectedIndex[]): string[][] {
  const sets: string[][] = [];
  const retired = new Set(columns.filter((c) => c.retired).map((c) => c.name));
  const add = (set: string[]) => {
    // A set with a retired column identifies no row for the code that no longer knows the column.
    if (set.length && !set.some((column) => retired.has(column)) && !sets.some((other) => other.join('\0') === set.join('\0'))) sets.push(set);
  };
  add(columns.filter((c) => c.primary).map((c) => c.name));
  // A partial unique index is unique among the rows that match only: it identifies no row, so it makes no hasOne, no pivot, no unique set.
  for (const index of indexes) if (index.unique && !index.where) add([...index.columns]);
  return sets;
}

/** A renamed table keeps its columns, marks and owner; the foreign keys that point at it follow, as the database does. */
function rename(tables: Map<string, ProjectedTable>, from: string, to: string, indexes: boolean, where: string): void {
  const table = tables.get(from);
  if (!table) throw unknown(where, `table "${from}"`);
  if (tables.has(to)) throw conflict(`${where} renames "${from}" to "${to}", which is the name of another table.`);
  const prefix = `${from}_`;
  const again = (name: string) => (name.startsWith(prefix) ? `${to}_${name.slice(prefix.length)}` : name);
  const renamed = indexes ? table.indexes.map((i) => ({ ...i, name: again(i.name) })) : table.indexes;
  // Postgres renames its constraints with the indexes; SQLite has the names it had.
  const columns = indexes ? table.columns.map((c) => (c.valuesCheck ? { ...c, valuesCheck: again(c.valuesCheck) } : c)) : table.columns;
  const checks = indexes && table.checks ? table.checks.map((check) => ({ ...check, name: again(check.name) })) : table.checks;
  tables.delete(from);
  tables.set(to, { ...table, name: to, indexes: renamed, columns, ...(checks ? { checks } : {}) });
  for (const [name, other] of tables) {
    if (!other.foreignKeys.some((k) => k.references === from)) continue;
    tables.set(name, { ...other, foreignKeys: other.foreignKeys.map((k) => (k.references === from ? { ...k, references: to } : k)) });
  }
}

function describeCondition(where: IndexCondition): string {
  return Object.entries(where)
    .map(([column, value]) => {
      if (value === null) return `${column} is null`;
      if (typeof value === 'object') return `${column} is not null`;
      return `${column} = ${JSON.stringify(value)}`;
    })
    .join(' and ');
}

/**
 * Whether the plan proves that no two rows of the release that no longer knows `retired` can collide in `index`: the column holds NULL (a NULL default),
 * another column of the index is retired too and holds NULL in every row, or the condition of a partial index is one no row can meet.
 */
function cannotCollide(index: ProjectedIndex, retired: ProjectedColumn, columns: readonly ProjectedColumn[], retiring: readonly string[]): boolean {
  if (retired.nullable && retired.nullDefault) return true;
  const alwaysNull = (c: ProjectedColumn) => c.nullable && (c.default === null || c.nullDefault === true);
  const others = index.columns.filter((c) => c !== retired.name).map((c) => columns.find((other) => other.name === c));
  if (others.some((c) => c && (c.retired || retiring.includes(c.name)) && alwaysNull(c))) return true;
  return Object.entries(index.where ?? {}).some(([column, value]) => {
    const held = columns.find((c) => c.name === column);
    if (!held) return false;
    // A primary key is NOT NULL on Postgres; on SQLite only an identity or an `integer` key (the rowid) is, any other can hold NULL.
    if (value === null) return !held.nullable && (!held.primary || held.identity || held.type.sqlite === 'integer');
    return typeof value === 'string' && held.values !== undefined && !held.values.includes(value);
  });
}
