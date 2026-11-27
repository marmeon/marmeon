import { withCode } from '@marmeon/core/internal';
import { sql, type Kysely, type RawNode } from 'kysely';
import { INTERRUPTION_TABLE } from '../migration-state.ts';
import { lastSegment, rawText, statementWords } from '../migrator-connection.ts';
import { blueprintParts, foreignKeyName, mysqlTypeOf } from './blueprint.ts';
import { MYSQL_KEY_BYTES, MYSQL_KEY_PARTS, mysqlCatalogKeyBytes, mysqlKeyBytes, type CatalogColumn } from './mysql-keys.ts';
import type { PlanStep, TablesAt } from './plan.ts';
import { SchemaError } from './schema-error.ts';
import { tableParts } from './table-name.ts';

// What MySQL refuses before a migration's first statement, in two stages. MySQL commits every DDL statement as it runs, so one that fails
// half way leaves the first half in place, and a rerun fails on it.
//
// The first stage (`checkMysqlPlan`) needs no facts: it reads what the plan shows alone. The second (`checkMysqlState`) holds what depends on the
// tables against the database as it is when the migration starts, with what the earlier steps of the same plan do to it applied. Where a
// row of the catalog is seen, the plan is refused; where none is, the server decides.

const MYSQL_DOCS = 'See docs/migrations.md#what-mysql-refuses-before-a-migration-runs.';

/** Refuses with D18 and the pointer to the docs. */
export function refuseMysql(message: string): never {
  throw new SchemaError(withCode('D18', `${message} ${MYSQL_DOCS}`));
}

/** MySQL refuses an identifier over 64 characters (code points, not bytes). */
export function fitsMysql(name: string, what: string, hint: string): void {
  const length = [...name].length;
  if (length <= 64) return;
  throw new SchemaError(withCode('D5', `The ${what} "${name}" is ${length} characters long; MySQL allows 64 and refuses a longer name. ${hint}`));
}

/**
 * `migration_interruption` is the migrator's table on MySQL only (a plan is read against the names of every driver when it is made, and
 * on SQLite and Postgres the name is the app's), so it is refused here, when a MySQL migration is about to run. The other two names are
 * refused when the plan is made.
 */
function refuseInterruptionTable(step: PlanStep): void {
  // The last segment, as `schema.create()` reads a name, and the table Kysely sends (`db. migration_interruption`).
  const named = (table: string) => [lastSegment(table), tableParts(table).at(-1)!.name].some((name) => name.toLowerCase() === INTERRUPTION_TABLE);
  const refuse = (table: string, what: string): never => {
    throw new SchemaError(
      withCode('D4', `Cannot ${what} "${table}": the name belongs to the migrator on MySQL, which holds the row of a migration that has not finished. Choose another name. See docs/migrations.md#how-the-migrator-keeps-track.`),
    );
  };
  switch (step.kind) {
    case 'create':
    case 'alter':
    case 'drop':
      if (named(step.table)) refuse(step.table, { create: 'create the table', alter: 'alter the table', drop: 'drop the table' }[step.kind]);
      return;
    case 'rename':
      if (named(step.from)) refuse(step.from, 'rename the table');
      if (named(step.to)) refuse(step.to, 'rename a table to');
      return;
    case 'raw': {
      const statement = step.statements.mysql;
      if (!statement) return;
      const found = statementWords(rawText(statement.toOperationNode() as RawNode, 'mysql'), 'mysql').find((word) => word.toLowerCase() === INTERRUPTION_TABLE);
      if (found === undefined) return;
      throw new SchemaError(
        withCode(
          'D4',
          `The raw SQL names "${found}", a table of the migrator on MySQL (as a table, column or alias), which holds the row of a migration that has not finished. Choose another name. See docs/migrations.md#how-the-migrator-keeps-track.`,
        ),
      );
    }
    case 'data':
      return;
  }
}

/** The first stage: what the plan alone shows, from the columns each blueprint adds. */
export function checkMysqlPlan(steps: readonly PlanStep[]): void {
  for (const step of steps) {
    refuseInterruptionTable(step);
    if (step.kind === 'rename') {
      fitsMysql(step.to, 'table name', 'Use a shorter table name.');
      continue;
    }
    if (step.kind !== 'create' && step.kind !== 'alter') continue;
    const parts = blueprintParts(step.blueprint);
    const where = `schema.${step.kind}('${step.table}')`;
    if (step.kind === 'create') fitsMysql(step.table, 'table name', 'Use a shorter table name.');
    for (const spec of parts.columns) fitsMysql(spec.name, 'column name', 'Use a shorter column name.');
    for (const { to } of parts.renames) fitsMysql(to, 'column name', 'Use a shorter column name.');
    for (const spec of parts.columns) {
      if (spec.references) fitsMysql(foreignKeyName(step.table, spec.name), 'foreign key name', 'Use a shorter table or column name.');
    }
    if (step.kind === 'alter' && parts.nullability.length) {
      const { column, nullable } = parts.nullability[0]!;
      refuseMysql(
        `${where} cannot make the column "${column}" ${nullable ? 'nullable' : 'NOT NULL'} on MySQL: its ALTER TABLE has no such change, it takes the whole column definition again. ` +
          'Change it in raw SQL (schema.raw() with a `mysql` statement, `alter table … modify column …`), or add a new column and copy the values in a schema.data() step.',
      );
    }
    for (const key of keysOf(step)) {
      if (key.where) {
        refuseMysql(
          `${where} cannot make ${key.label} partial (where) on MySQL: MySQL has no partial indexes, and a plain one would hold the rows the condition leaves out. ` +
            'Make it a plain index, or keep the rule in code; for a unique rule among some of the rows, add a generated column in raw SQL (schema.raw()) that is NULL for the other rows and put the unique index on it.',
        );
      }
      if (key.columns.length > MYSQL_KEY_PARTS) {
        refuseMysql(`${where} makes ${key.label} over ${key.columns.length} columns on MySQL, which allows ${MYSQL_KEY_PARTS} in one index. Index fewer columns.`);
      }
      const blueprint = new Map(parts.columns.map((spec) => [spec.name, String(mysqlTypeOf(spec, step.blueprint))]));
      // A table `create()` makes is utf8mb4. A column an `alter()` adds takes the default of its table, which an earlier migration may have changed: here only what holds with the narrowest character set is refused.
      holdKey(where, key, key.columns.map((column) => blueprintKey(blueprint.get(column), step.kind === 'create' ? 4 : 1, step.kind === 'alter')));
    }
  }
}

/** One index of a step, the primary key included (a `create` makes one, and an `alter()` can add a column that is one). */
function keysOf(step: Extract<PlanStep, { kind: 'create' | 'alter' }>) {
  const keys = step.blueprint.allIndexes().map((key) => ({ ...key, label: `the index "${key.name}"` }));
  const primary = blueprintParts(step.blueprint).columns.filter((spec) => spec.primary).map((spec) => spec.name);
  if (primary.length) keys.push({ name: 'primary', columns: primary, unique: true, label: 'the primary key' });
  return keys;
}

/** What a column of a key takes, and what to say of it when no index can hold it. */
interface KeyPart {
  readonly bytes: number | 'unindexable' | undefined;
  /** The bytes are a floor: a character column counted at a byte a character, because the character set of its table is not known yet. */
  readonly floor?: boolean;
  readonly what: string;
  readonly advice: string;
}

const NO_INDEX_ON_JSON = 'Index a string() column that holds what is looked up (for JSON, a generated column on a path in raw SQL).';
const NO_INDEX_ON_TEXT = 'Add a string(name, length) column, copy the values in a schema.data() step and index that one; a text() column is only indexable in the schema.create() or schema.alter() that adds it.';

/** A column whose type is not known: it is left out of the sum. */
const UNKNOWN: KeyPart = { bytes: undefined, what: '', advice: '' };

/** A column of the blueprint of the step itself, by its MySQL type. */
function blueprintKey(type: string | undefined, perCharacter: number | undefined, floor = false): KeyPart {
  if (type !== undefined && /^(?:var)?char\(/.test(type) && perCharacter === undefined) return UNKNOWN;
  const bytes = type === undefined ? undefined : mysqlKeyBytes(type, perCharacter);
  return { bytes, floor: floor && type !== undefined && /^(?:var)?char\(/.test(type), what: type === 'json' ? 'a json() column' : 'a binary() column', advice: NO_INDEX_ON_JSON };
}

/** A column an earlier step of the plan made, by the type the schema of the migrations holds for it. */
function planKey(type: string | undefined, perCharacter: number | undefined): KeyPart {
  if (type !== undefined && /^(?:var)?char\(/.test(type) && perCharacter === undefined) return UNKNOWN;
  const bytes = type === undefined ? undefined : mysqlKeyBytes(type, perCharacter);
  if (type === 'longtext') return { bytes, what: 'a text() column of an earlier step, which MySQL holds as longtext', advice: NO_INDEX_ON_TEXT };
  return { bytes, what: type === 'json' ? 'a json() column' : 'a binary() column', advice: NO_INDEX_ON_JSON };
}

/** A column the database has, by what the catalog reports. */
function catalogKey(column: CatalogColumn): KeyPart {
  const bytes = mysqlCatalogKeyBytes(column);
  if (column.dataType === 'json') return { bytes, what: 'a json column', advice: NO_INDEX_ON_JSON };
  if (column.dataType.endsWith('blob')) return { bytes, what: 'a blob column (binary())', advice: NO_INDEX_ON_JSON };
  return { bytes, what: 'a text column (MySQL holds a text() column of an earlier step or migration as longtext)', advice: NO_INDEX_ON_TEXT };
}

/** Refuses a key that has a column no index can hold, or is wider than MySQL allows. A column of a type not known to the byte is left out of the sum. */
function holdKey(where: string, key: { readonly label: string; readonly columns: readonly string[] }, parts: readonly KeyPart[]): void {
  let bytes = 0;
  let unknown = false;
  for (const [index, part] of parts.entries()) {
    if (part.bytes === 'unindexable') {
      refuseMysql(`${where} puts the column "${key.columns[index]}" in ${key.label} on MySQL, but it is ${part.what}, and MySQL indexes no such column without a prefix length. ${part.advice}`);
    }
    if (part.bytes === undefined) unknown = true;
    else {
      bytes += part.bytes;
      if (part.floor) unknown = true;
    }
  }
  if (bytes > MYSQL_KEY_BYTES) {
    refuseMysql(
      `${where} makes ${key.label} ${unknown ? 'at least ' : ''}${bytes} bytes wide on MySQL, which allows ${MYSQL_KEY_BYTES} (a string() or uuid() column counts four bytes a character). ` +
        'Index fewer or shorter columns: a shorter string(name, length), or only the columns the lookup needs.',
    );
  }
}

/** A foreign key as the catalog has it, with the columns of every part. */
export interface CatalogForeignKey {
  readonly name: string;
  readonly table: string;
  /** The table is in the database of the connection. */
  readonly local: boolean;
  readonly references: string;
  readonly referencedLocal: boolean;
  /** The rows the role sees, by ordinal position (1-based): a missing 1 or a gap means part of the key is hidden. */
  readonly parts: readonly { readonly column: string; readonly position: number; readonly referenced: string }[];
}

export interface CatalogConstraint {
  readonly name: string;
  readonly type: 'CHECK' | 'FOREIGN KEY';
  /** The expression of a check, as MySQL writes it: ``(`n` > 0)``. */
  readonly clause: string | null;
}

export interface CatalogIndexPart {
  readonly column: string | null;
  /** The whole column is in the key (`sub_part` is null), not a prefix. */
  readonly whole: boolean;
}

/** What the plan is held against: the tables it names, as the database has them when the migration starts. */
export interface MysqlState {
  readonly columns: ReadonlyMap<string, ReadonlyMap<string, CatalogColumn>>;
  readonly foreignKeys: readonly CatalogForeignKey[];
  readonly constraints: ReadonlyMap<string, readonly CatalogConstraint[]>;
  /** By table, then index name (`PRIMARY` included); the parts by position in the index. */
  readonly indexes: ReadonlyMap<string, ReadonlyMap<string, readonly CatalogIndexPart[]>>;
  readonly foreignKeyChecks: boolean;
  /** The most bytes a character takes in the default character set of each table (4 for utf8mb4, 1 for latin1). */
  readonly maxlen: ReadonlyMap<string, number>;
  /** The tables it was read for: a check that asks for another table would read an empty state and let the plan through, so it fails instead. */
  readonly tables: ReadonlySet<string>;
}

/** What a plan that needs nothing of the database is held against. */
export const NO_STATE: MysqlState = { columns: new Map(), foreignKeys: [], constraints: new Map(), indexes: new Map(), foreignKeyChecks: false, maxlen: new Map(), tables: new Set() };

/** Asks for the table of the snapshot `table`; one that was not read is a mistake of `mysqlStateTables`, said aloud instead of passing the plan on an empty state. */
function seen(state: MysqlState, table: string): void {
  if (!state.tables.has(table)) throw new Error(`mysqlStateTables did not name the table "${table}", which a check asked the catalog about.`);
}

const flag = (value: unknown): boolean => Number(value) === 1;

/**
 * Reads the catalog for `tables`: its own queries, not the reader of relations, which leaves out composite keys, keys from other
 * databases and keys that are not unique, all of which count to MySQL. The names go in as parameters.
 */
export async function readMysqlState(db: Kysely<any>, tables: readonly string[]): Promise<MysqlState> {
  const list = sql.join(tables.map((table) => sql`${table}`));
  const columnRows = await sql<{ table_name: string; column_name: string; data_type: string; column_type: string; octets: number | string | null }>`
    select table_name as table_name, column_name as column_name, data_type as data_type, column_type as column_type, character_octet_length as octets
    from information_schema.columns where table_schema = database() and table_name in (${list})`.execute(db);
  const keyRows = await sql<{ table_schema: string; local: unknown; table_name: string; constraint_name: string; column_name: string; position: number | string; referenced_local: unknown; referenced_table: string; referenced_column: string }>`
    select k.table_schema as table_schema, k.table_schema = database() as local, k.table_name as table_name, k.constraint_name as constraint_name, k.column_name as column_name,
      k.ordinal_position as position, k.referenced_table_schema = database() as referenced_local, k.referenced_table_name as referenced_table, k.referenced_column_name as referenced_column
    from information_schema.key_column_usage k
    where k.referenced_table_name is not null
      and ((k.table_schema = database() and k.table_name in (${list})) or (k.referenced_table_schema = database() and k.referenced_table_name in (${list})))
    order by k.table_schema, k.table_name, k.constraint_name, k.ordinal_position`.execute(db);
  const constraintRows = await sql<{ table_name: string; constraint_name: string; constraint_type: string; clause: string | null }>`
    select tc.table_name as table_name, tc.constraint_name as constraint_name, tc.constraint_type as constraint_type, cc.check_clause as clause
    from information_schema.table_constraints tc
    left join information_schema.check_constraints cc on cc.constraint_schema = tc.constraint_schema and cc.constraint_name = tc.constraint_name
    where tc.table_schema = database() and tc.table_name in (${list}) and tc.constraint_type in ('CHECK', 'FOREIGN KEY')`.execute(db);
  const indexRows = await sql<{ table_name: string; index_name: string; column_name: string | null; sub_part: number | string | null }>`
    select table_name as table_name, index_name as index_name, column_name as column_name, sub_part as sub_part
    from information_schema.statistics where table_schema = database() and table_name in (${list})
    order by table_name, index_name, seq_in_index`.execute(db);
  const charsetRows = await sql<{ table_name: string; maxlen: number | string }>`
    select t.table_name as table_name, cs.maxlen as maxlen
    from information_schema.tables t
    join information_schema.collation_character_set_applicability a on a.collation_name = t.table_collation
    join information_schema.character_sets cs on cs.character_set_name = a.character_set_name
    where t.table_schema = database() and t.table_name in (${list})`.execute(db);
  const checks = await sql<{ checks: unknown }>`select @@session.foreign_key_checks as checks`.execute(db);

  const columns = new Map<string, Map<string, CatalogColumn>>();
  for (const row of columnRows.rows) {
    const own = columns.get(row.table_name) ?? new Map<string, CatalogColumn>();
    own.set(row.column_name, { dataType: String(row.data_type).toLowerCase(), columnType: String(row.column_type).toLowerCase(), octets: row.octets === null ? null : Number(row.octets) });
    columns.set(row.table_name, own);
  }
  const keys = new Map<string, { name: string; table: string; local: boolean; references: string; referencedLocal: boolean; parts: { column: string; position: number; referenced: string }[] }>();
  for (const row of keyRows.rows) {
    const id = `${row.table_schema}\0${row.table_name}\0${row.constraint_name}`;
    const key = keys.get(id) ?? { name: row.constraint_name, table: row.table_name, local: flag(row.local), references: row.referenced_table, referencedLocal: flag(row.referenced_local), parts: [] };
    key.parts.push({ column: row.column_name, position: Number(row.position), referenced: row.referenced_column });
    keys.set(id, key);
  }
  const constraints = new Map<string, CatalogConstraint[]>();
  for (const row of constraintRows.rows) {
    if (row.constraint_type !== 'CHECK' && row.constraint_type !== 'FOREIGN KEY') continue;
    const own = constraints.get(row.table_name) ?? [];
    own.push({ name: row.constraint_name, type: row.constraint_type, clause: row.clause });
    constraints.set(row.table_name, own);
  }
  const indexes = new Map<string, Map<string, CatalogIndexPart[]>>();
  for (const row of indexRows.rows) {
    const own = indexes.get(row.table_name) ?? new Map<string, CatalogIndexPart[]>();
    const parts = own.get(row.index_name) ?? [];
    parts.push({ column: row.column_name, whole: row.sub_part === null });
    own.set(row.index_name, parts);
    indexes.set(row.table_name, own);
  }
  return { columns, foreignKeys: [...keys.values()], constraints, indexes, foreignKeyChecks: flag(checks.rows[0]?.checks), maxlen: new Map(charsetRows.rows.map((row) => [row.table_name, Number(row.maxlen)])), tables: new Set(tables) };
}

/** A table of the database as the earlier steps of the plan left it. */
type Origin =
  | {
      readonly kind: 'catalog';
      /** The table's name in the snapshot. */
      readonly table: string;
      readonly renamed: boolean;
      readonly altered: boolean;
      readonly droppedColumns: boolean;
      /** Lower case. */
      readonly droppedChecks: ReadonlySet<string>;
      /** The indexes earlier steps dropped (lower case) and made (as named). */
      readonly droppedIndexes: ReadonlySet<string>;
      readonly addedIndexes: ReadonlySet<string>;
      /** Current column name → its name in the snapshot; null: an earlier step added it; undefined: gone. A name not in the map is the same as in the snapshot. */
      readonly columns: ReadonlyMap<string, string | null | undefined>;
    }
  | { readonly kind: 'plan' };

/** The tables before step `index`, or undefined when a raw step comes before it: what raw SQL changed is unknown, so nothing later is held against the database. */
function originsAt(steps: readonly PlanStep[], index: number): { of(table: string): Origin | undefined } | undefined {
  const tables = new Map<string, Origin | null>();
  const of = (name: string): Origin | undefined => {
    if (!tables.has(name)) return { kind: 'catalog', table: name, renamed: false, altered: false, droppedColumns: false, droppedChecks: new Set(), droppedIndexes: new Set(), addedIndexes: new Set(), columns: new Map() };
    return tables.get(name) ?? undefined;
  };
  for (const step of steps.slice(0, index)) {
    switch (step.kind) {
      case 'raw':
        return undefined;
      case 'data':
        break;
      case 'create':
        tables.set(step.table, { kind: 'plan' });
        break;
      case 'drop':
        tables.set(step.table, null);
        break;
      case 'rename': {
        const origin = of(step.from);
        tables.set(step.from, null);
        tables.set(step.to, origin === undefined ? null : origin.kind === 'catalog' ? { ...origin, renamed: true } : origin);
        break;
      }
      case 'alter': {
        const origin = of(step.table);
        if (origin?.kind !== 'catalog') break;
        const parts = blueprintParts(step.blueprint);
        const columns = new Map(origin.columns);
        const lookup = (column: string) => (columns.has(column) ? columns.get(column) : column);
        for (const { from, to } of parts.renames) {
          columns.set(to, lookup(from));
          columns.set(from, undefined);
        }
        for (const spec of parts.columns) columns.set(spec.name, null);
        for (const column of parts.drops) columns.set(column, undefined);
        tables.set(step.table, {
          ...origin,
          altered: true,
          droppedColumns: origin.droppedColumns || parts.drops.length > 0,
          droppedChecks: new Set([...origin.droppedChecks, ...parts.dropChecks.map((name) => name.toLowerCase())]),
          droppedIndexes: new Set([...origin.droppedIndexes, ...parts.dropIndexes.map((name) => name.toLowerCase())]),
          // In the order of the steps: an alter() drops first, then makes its indexes.
          addedIndexes: new Set([...[...origin.addedIndexes].filter((name) => !parts.dropIndexes.some((dropped) => dropped.toLowerCase() === name.toLowerCase())), ...step.blueprint.allIndexes().map((one) => one.name)]),
          columns,
        });
        break;
      }
    }
  }
  return { of };
}

/** The names a step before `index` made, dropped or renamed: a table of the catalog under one of them is not the one the snapshot has. */
function touchedBefore(steps: readonly PlanStep[], index: number): Set<string> {
  const names = new Set<string>();
  for (const step of steps.slice(0, index)) {
    if (step.kind === 'create' || step.kind === 'drop') names.add(step.table);
    if (step.kind === 'rename') names.add(step.from).add(step.to);
  }
  return names;
}

/** The snapshot names of the tables of the database that the second stage needs to read; empty when it reads nothing. */
export function mysqlStateTables(steps: readonly PlanStep[]): string[] {
  const needed = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const origins = originsAt(steps, index);
    if (!origins) break;
    if (step.kind === 'drop' || (step.kind === 'rename' && step.indexes)) {
      const origin = origins.of(step.kind === 'drop' ? step.table : step.from);
      if (origin?.kind === 'catalog') needed.add(origin.table);
    }
    if (step.kind !== 'alter') continue;
    const parts = blueprintParts(step.blueprint);
    const added = new Set(parts.columns.map((spec) => spec.name));
    const outside = step.blueprint.allIndexes().some((key) => key.columns.some((column) => !added.has(column)));
    const keyed = keysOf(step).length > 0;
    if (!outside && !keyed && !parts.drops.length && !parts.dropIndexes.length && !parts.renames.length) continue;
    const origin = origins.of(step.table);
    if (origin?.kind === 'catalog') needed.add(origin.table);
  }
  return [...needed];
}

/** MySQL renames the indexes of a table by name; the ones that start with `<from>_` follow the table. Refuses a name that is too long or taken by an index that stays. */
export function indexRenamesOf(from: string, to: string, names: readonly string[]): [string, string][] {
  const prefix = `${from}_`;
  const renames = names.filter((name) => name.startsWith(prefix)).map((name): [string, string] => [name, `${to}_${name.slice(prefix.length)}`]);
  // MySQL compares index names without regard to case. A name that another index leaves is no clash: a chain of renames goes through in one statement.
  const staying = new Set(names.filter((name) => !name.startsWith(prefix)).map((name) => name.toLowerCase()));
  for (const [name, renamed] of renames) {
    fitsMysql(renamed, 'name after the rename', 'Use a shorter table name, or rename the table without `indexes: true`.');
    if (staying.has(renamed.toLowerCase())) {
      refuseMysql(`schema.rename('${from}', '${to}', { indexes: true }) would give the index "${name}" the name "${renamed}", which another index of the table has. Rename the table without \`indexes: true\`, or drop the other index first.`);
    }
  }
  return renames;
}

/** MySQL renames no foreign key and no check: a table that has some whose names start with `<from>_` cannot follow its new name with `indexes: true`. */
export function refuseNamedConstraints(from: string, to: string, names: readonly string[]): void {
  const prefix = `${from}_`;
  const found = names.filter((name) => name.startsWith(prefix));
  if (!found.length) return;
  refuseMysql(
    `schema.rename('${from}', '${to}', { indexes: true }) cannot run on MySQL: the table has constraints named after it (${found.slice(0, 3).map((name) => `"${name}"`).join(', ')}${found.length > 3 ? ', …' : ''}), ` +
      'and MySQL renames no foreign key or check constraint. Rename the table without `indexes: true` (the constraints keep their names), or create the new table and copy the rows.',
  );
}

/**
 * The second stage: holds the steps against `state`, the database before the first of them. `tablesAt` gives the types of columns that an earlier
 * step of the plan made, which the catalog does not have yet.
 */
export function checkMysqlState(steps: readonly PlanStep[], state: MysqlState, tablesAt: TablesAt | undefined): void {
  for (const [index, step] of steps.entries()) {
    const origins = originsAt(steps, index);
    if (!origins) return;
    if (step.kind === 'drop') {
      const origin = origins.of(step.table);
      // A data step may have set `foreign_key_checks` for the session, which the snapshot cannot know: nothing is held after one.
      if (origin?.kind !== 'catalog' || origin.renamed || !state.foreignKeyChecks || steps.slice(0, index).some((other) => other.kind === 'data')) continue;
      seen(state, origin.table);
      // A key of another table that points at a table which is not there (an orphan) holds nothing: only a table the catalog has is held.
      if (!state.columns.has(origin.table)) continue;
      const touched = touchedBefore(steps, index);
      const holder = state.foreignKeys.find((key) => key.referencedLocal && key.references === origin.table && !(key.local && key.table === origin.table) && !(key.local && touched.has(key.table)));
      if (holder) {
        refuseMysql(
          `schema.drop('${step.table}') cannot run on MySQL: the foreign key "${holder.name}" of "${holder.table}" references the table, and MySQL refuses to drop a table a foreign key references (error 3730). ` +
            'Drop the other table first, or drop the foreign key in raw SQL (schema.raw() with a `mysql` statement, `alter table … drop foreign key …`).',
        );
      }
      continue;
    }
    if (step.kind === 'rename') {
      const origin = origins.of(step.from);
      if (!step.indexes || origin?.kind !== 'catalog' || origin.renamed) continue;
      seen(state, origin.table);
      if (!origin.droppedColumns) {
        refuseNamedConstraints(step.from, step.to, (state.constraints.get(origin.table) ?? []).filter((one) => !origin.droppedChecks.has(one.name.toLowerCase())).map((one) => one.name));
      }
      // The indexes after the earlier alters of the table: the ones the snapshot has, less those dropped, and those made. A dropped column takes its indexes
      // with it in ways the plan does not follow, so the names are not held then; and an index made leaves the one MySQL made for a foreign key, which is not counted.
      const indexes = state.indexes.get(origin.table);
      if (!origin.droppedColumns && indexes) {
        const implicit = new Set(origin.addedIndexes.size ? (state.constraints.get(origin.table) ?? []).filter((one) => one.type === 'FOREIGN KEY').map((one) => one.name) : []);
        const names = [...indexes.keys()].filter((name) => name !== 'PRIMARY' && !origin.droppedIndexes.has(name.toLowerCase()) && !implicit.has(name));
        for (const name of origin.addedIndexes) if (!names.includes(name)) names.push(name);
        indexRenamesOf(step.from, step.to, names);
      }
      continue;
    }
    if (step.kind !== 'alter') continue;
    checkMysqlAlter(steps, index, step, origins.of(step.table), state, tablesAt);
  }
}

function checkMysqlAlter(steps: readonly PlanStep[], index: number, step: Extract<PlanStep, { kind: 'create' | 'alter' }>, origin: Origin | undefined, state: MysqlState, tablesAt: TablesAt | undefined): void {
  const parts = blueprintParts(step.blueprint);
  const where = `schema.alter('${step.table}')`;
  const added = new Map(parts.columns.map((spec) => [spec.name, spec]));
  /**
   * The name a column had when this alter() began, given the name it has after its first `upTo` renames: they run one by one, so a chain
   * (p to q, q to r) leads back to p, and a name that a rename gave to another column is not the old column's.
   */
  const before = (column: string, upTo = parts.renames.length) => {
    let name = column;
    for (const { from, to } of parts.renames.slice(0, upTo).reverse()) if (to === name) name = from;
    return name;
  };
  const lookup = (column: string): string | null | undefined => {
    if (origin?.kind !== 'catalog') return undefined;
    return origin.columns.has(column) ? origin.columns.get(column) : column;
  };
  const known = tablesAt?.(index)?.get(step.table);
  const typeBefore = (column: string) => known?.columns.find((c) => c.name === column)?.type.mysql;

  // The width and kind of every key of the step, with the character set the columns get: the table's own default, as the database has it now, for a table the
  // database had; utf8mb4 for one this plan made. A table whose default is not known leaves the columns the blueprint adds out of the sum.
  const keys = keysOf(step);
  if (origin !== undefined && keys.length) {
    if (origin.kind === 'catalog') seen(state, origin.table);
    const perCharacter = origin.kind === 'plan' ? 4 : state.maxlen.get(origin.table);
    for (const key of keys) {
      holdKey(
        where,
        key,
        key.columns.map((column): KeyPart => {
          const spec = added.get(column);
          if (spec) return blueprintKey(String(mysqlTypeOf(spec, step.blueprint)), perCharacter);
          const old = before(column);
          if (origin.kind === 'plan') return planKey(typeBefore(old), perCharacter);
          const name = lookup(old);
          if (name === null) return planKey(typeBefore(old), perCharacter);
          const found = typeof name === 'string' ? state.columns.get(origin.table)?.get(name) : undefined;
          return found ? catalogKey(found) : UNKNOWN;
        }),
      );
    }
  }

  if (origin?.kind !== 'catalog') return;

  // A column a foreign key holds, as the child or as the referenced one, cannot be dropped (errors 1828 and 1829).
  const touched = touchedBefore(steps, index);
  for (const column of parts.drops) {
    const name = lookup(before(column));
    if (origin.renamed || typeof name !== 'string' || added.has(column)) continue;
    seen(state, origin.table);
    const child = state.foreignKeys.find((key) => key.local && key.table === origin.table && key.parts.some((part) => part.column === name));
    if (child) {
      const part = child.parts.find((one) => one.column === name)!;
      refuseMysql(
        `${where} cannot drop the column "${column}" on MySQL: the foreign key "${child.name}" holds it, to "${child.references}.${part.referenced}", and MySQL refuses to drop a column a foreign key needs. ` +
          'Drop the foreign key first in raw SQL (schema.raw() with a `mysql` statement, `alter table … drop foreign key …`, before this step).',
      );
    }
    const parent = state.foreignKeys.find((key) => key.referencedLocal && key.references === origin.table && key.parts.some((part) => part.referenced === name) && !(key.local && touched.has(key.table)));
    if (parent) {
      refuseMysql(
        `${where} cannot drop the column "${column}" on MySQL: the foreign key "${parent.name}" of "${parent.table}" references it, and MySQL refuses to drop a column a foreign key needs. ` +
          'Drop the foreign key first in raw SQL (schema.raw() with a `mysql` statement, `alter table … drop foreign key …`, before this step).',
      );
    }
  }

  // The last index a foreign key can stand on is not dropped (error 1553): the drops of an alter() run first, so an index it makes does not count.
  if (!origin.renamed && !origin.altered && parts.dropIndexes.length) seen(state, origin.table);
  const indexes = state.indexes.get(origin.table);
  if (!origin.renamed && !origin.altered && indexes && parts.dropIndexes.length) {
    const dropped = new Set(parts.dropIndexes.map((name) => name.toLowerCase()));
    for (const key of state.foreignKeys.filter((one) => one.local && one.table === origin.table)) {
      const ordered = key.parts.toSorted((a, b) => a.position - b.position);
      if (!ordered.every((part, position) => part.position === position + 1)) continue;
      const columns = ordered.map((part) => part.column);
      const usable = (candidate: readonly CatalogIndexPart[]) => candidate.length >= columns.length && columns.every((column, position) => candidate[position]!.column === column && candidate[position]!.whole);
      const entries = [...indexes];
      if (entries.some(([name, one]) => dropped.has(name.toLowerCase()) && usable(one)) && !entries.some(([name, one]) => !dropped.has(name.toLowerCase()) && usable(one))) {
        refuseMysql(
          `${where} cannot drop the last index that the foreign key "${key.name}" stands on (${columns.map((column) => `"${column}"`).join(', ')}) on MySQL, which refuses it (error 1553). ` +
            'Add another index that starts with the same columns first, in an earlier schema.alter().',
        );
      }
    }
  }

  // A column a check names cannot be renamed (error 3959): the check of oneOf() and check() start with the column when it is the only one they name.
  if (!origin.renamed && !origin.droppedColumns) {
    for (const [position, { from, to }] of parts.renames.entries()) {
      const name = lookup(before(from, position));
      if (typeof name !== 'string') continue;
      const start = `(\`${name.replaceAll('`', '``')}\``;
      seen(state, origin.table);
      const named = (state.constraints.get(origin.table) ?? []).find(
        (one) => one.type === 'CHECK' && one.clause?.startsWith(start) && !origin.droppedChecks.has(one.name.toLowerCase()) && !parts.dropChecks.some((dropped) => dropped.toLowerCase() === one.name.toLowerCase()),
      );
      if (named) {
        refuseMysql(
          `${where} cannot rename the column "${from}" to "${to}" on MySQL: the check "${named.name}" names it, and MySQL refuses to rename a column a check names (error 3959). ` +
            `Drop the check in the same alter() with dropCheck('${named.name}'), rename the column, and add the check again in a later one.`,
        );
      }
    }
  }
}
