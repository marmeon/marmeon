import { withCode } from '@marmeon/core/internal';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Connection } from '../builder.ts';
import { noMigratorWrites, noSchemaChanges } from '../migrator-connection.ts';
import { mysqlPending } from '../mysql-pending.ts';
import { Blueprint, blueprintParts, compileColumn, foreignKeyName, mysqlForeignKeys, oneOfCondition, oneOfName, type Driver } from './blueprint.ts';
import { schemaSteps, sealSchema, Schema } from './schema.ts';
import { SchemaError } from './schema-error.ts';
import { unknownDriver } from '../supported-driver.ts';

/** What a `schema.raw()` step runs per driver; SQLite and Postgres run nothing without a statement, MySQL refuses the plan (`mysql: null` runs nothing, on purpose). */
export interface RawStatements {
  readonly sqlite?: RawBuilder<unknown>;
  readonly pgsql?: RawBuilder<unknown>;
  /** `null`: nothing on MySQL, said on purpose. */
  readonly mysql?: RawBuilder<unknown> | null;
}

/** What a `schema.data()` callback is told besides the connection. */
export interface DataContext {
  readonly driver: Driver;
}

/** One step of a migration's plan, in the order `up()` or `down()` appended it. */
export type PlanStep =
  | { readonly kind: 'create' | 'alter'; readonly table: string; readonly blueprint: Blueprint }
  | { readonly kind: 'drop'; readonly table: string; readonly ifExists: boolean }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string; readonly indexes: boolean }
  | { readonly kind: 'raw'; readonly statements: RawStatements }
  | { readonly kind: 'data'; readonly run: (db: Connection<any>, context: DataContext) => PromiseLike<unknown> };

/** The parts of a migration the plan is made from. */
interface Planned {
  up(schema: Schema): unknown;
  down?(schema: Schema): unknown;
}

/**
 * The plan `up()` or `down()` builds. They only append steps and run nothing, so they are synchronous; one that returns a promise
 * was written for a `schema` that ran every call, and its steps would come after the plan was closed.
 */
export function planOf(migration: Planned, direction: 'up' | 'down', name = 'A migration'): readonly PlanStep[] {
  const schema = new Schema();
  const build = migration[direction];
  if (typeof build !== 'function') throw new Error(`${name} has no ${direction}().`);
  const result = build.call(migration, schema);
  sealSchema(schema);
  if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
    // Its steps never run; the rejection of the late call into the closed schema is of no interest.
    (result as PromiseLike<unknown>).then(undefined, () => {});
    throw new Error(
      withCode(
        'D14',
        `${name}: ${direction}() returned a promise. It builds a plan and must be synchronous: write \`${direction}: (schema) => { … }\` without \`async\` and \`await\`, ` +
          'and put changes of the data in schema.data(async (db) => …). See docs/migrations.md#changing-the-data.',
      ),
    );
  }
  return schemaSteps(schema);
}

/**
 * Runs a plan on `db`, which is the migration's transaction. What depends on the driver is checked for the whole plan first, so a
 * migration that cannot run on it changes nothing.
 */
export async function executePlan(
  db: Kysely<any>,
  driver: Driver,
  steps: readonly PlanStep[],
  /** Wraps each `data` step, given its position in the plan: the migrator tells the connection what the plan has changed up to there. */
  aroundData?: (index: number, run: () => Promise<void>) => Promise<void>,
  /** Names the constraint of a `oneOf(column, values)` change; a plan that has one cannot run without it. */
  listCheck?: ListCheck,
): Promise<void> {
  check(driver, steps);
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'data' && aroundData) await aroundData(index, () => run(db, driver, step));
    else await run(db, driver, step, listCheck && ((table, column) => listCheck(index, table, column)));
  }
}

/** The constraint behind a column's `oneOf()` list after the step with this index, and whether the column had a list before it; undefined for a column the migrations do not know. */
export type ListCheck = (index: number, table: string, column: string) => { readonly name: string; readonly had: boolean } | undefined;

/** Postgres cuts an identifier at 63 bytes without a word. */
function fits(driver: Driver, name: string, what: string, hint = "Give it a name of its own that fits (for an index: table.index(columns, 'name'); for the constraint of oneOf(): a shorter table or column name, or table.check(name, …) instead)."): void {
  if (driver !== 'pgsql' || Buffer.byteLength(name) <= 63) return;
  throw new SchemaError(
    withCode('D5', `The ${what} "${name}" is ${Buffer.byteLength(name)} bytes long; Postgres would cut it at 63 and so change it silently. ${hint}`),
  );
}

/**
 * MySQL runs no statement written for another driver: a `schema.raw()` step whose object has no `mysql` statement (`null` says nothing runs
 * there; `undefined` is no answer) refuses the plan, naming `who` and the step. Called before the first statement of a run, so nothing is half done.
 */
export function assertRawFitsMysql(steps: readonly PlanStep[], who: string): void {
  for (const [index, step] of steps.entries()) {
    // `undefined` is no answer, only `null` says nothing runs: a condition that ends in `undefined` must not skip the step without a word.
    if (step.kind !== 'raw' || step.statements.mysql !== undefined) continue;
    throw new SchemaError(
      withCode(
        'D18',
        `${who} has a schema.raw() step (step ${index + 1} of its plan) with a statement for ${Object.entries(step.statements).filter(([driver, statement]) => driver !== 'mysql' && statement).map(([driver]) => driver).join(' and ') || 'no driver'} and none for MySQL, ` +
          'which runs no statement written for another driver. Add `mysql: sql`…`` to it, or `mysql: null` when nothing is to run there. See docs/migrations.md#raw-sql.',
      ),
    );
  }
}

/** What the plan cannot do on `driver`, refused before its first statement. `executePlan` calls it; a rollback calls it for every `down()` it is to run. */
export function check(driver: Driver, steps: readonly PlanStep[]): void {
  if (driver === 'mysql') {
    assertRawFitsMysql(steps, 'The plan');
    // Refused here, before the rename itself is committed: a rerun would stop at the table that is already renamed.
    if (steps.some((step) => step.kind === 'rename' && step.indexes)) mysqlPending('Renaming a table with its indexes');
  }
  for (const step of steps) {
    if (step.kind !== 'create' && step.kind !== 'alter') continue;
    for (const index of step.blueprint.allIndexes()) fits(driver, index.name, 'index name');
    const parts = blueprintParts(step.blueprint);
    for (const spec of parts.columns) if (spec.oneOf) fits(driver, oneOfName(step.table, spec.name), 'check constraint name');
    for (const { name } of parts.checks) fits(driver, name, 'check constraint name');
    if (step.kind === 'alter' && driver === 'sqlite' && parts.oneOfChanges.length) {
      throw new SchemaError(
        withCode(
          'D18',
          `schema.alter('${step.table}') cannot use oneOf('${parts.oneOfChanges[0]!.column}', …) on SQLite: SQLite cannot change a constraint of a table in place. ` +
            'Add a new column with oneOf(), copy the values in a schema.data() step, drop the old column and rename the new one; or rebuild the table in raw SQL (schema.raw()). See docs/migrations.md#check-constraints.',
        ),
      );
    }
    for (const { column } of parts.foreignKeys) fits(driver, foreignKeyName(step.table, column), 'foreign key name', 'Use a shorter table or column name.');
    if (step.kind === 'alter' && driver === 'sqlite' && parts.foreignKeys.length) {
      throw new SchemaError(
        withCode(
          'D18',
          `schema.alter('${step.table}') cannot use foreign('${parts.foreignKeys[0]!.column}') on SQLite: SQLite cannot add a foreign key to an existing column. ` +
            'Add a new column with foreignId(…).constrained(), copy the values in a schema.data() step and drop the old column. See docs/migrations.md#a-reference-that-comes-later.',
        ),
      );
    }
    if (step.kind === 'alter' && driver === 'sqlite' && (parts.checks.length || parts.dropChecks.length)) {
      const call = parts.checks.length ? `check('${parts.checks[0]!.name}', …)` : `dropCheck('${parts.dropChecks[0]}')`;
      throw new SchemaError(
        withCode(
          'D18',
          `schema.alter('${step.table}') cannot use ${call} on SQLite: SQLite cannot add or drop a constraint of a table in place. ` +
            'Create the table with the constraint, or rebuild it in raw SQL (schema.raw()). See docs/migrations.md#check-constraints.',
        ),
      );
    }
    if (step.kind === 'alter' && driver === 'sqlite' && parts.nullability.length) {
      const { column, nullable } = parts.nullability[0]!;
      throw new SchemaError(
        withCode(
          'D18',
          `schema.alter('${step.table}') cannot make the column "${column}" ${nullable ? 'nullable' : 'NOT NULL'} on SQLite: SQLite cannot change a column in place. ` +
            'Add the column NOT NULL with a default and fill it in a schema.data() step; rebuilding a table that other tables reference would hit their rows (foreign_keys is on). ' +
            'See docs/migrations.md#changing-the-data.',
        ),
      );
    }
    if (step.kind === 'alter' && (driver === 'sqlite' || driver === 'mysql')) {
      const generated = parts.columns.find((spec) => spec.default && 'uuidv7' in spec.default);
      if (generated) {
        const [database, reason] = driver === 'sqlite' ? ['SQLite', 'SQLite adds no column whose default is computed'] : ['MySQL', 'MySQL refuses to add a column whose default is computed from the time and random bytes (error 1674)'];
        throw new SchemaError(
          withCode(
            'D18',
          `schema.alter('${step.table}') cannot add the UUIDv7 column "${generated.name}" on ${database}: ${reason}. ` +
            'Create the table with the column instead (on Postgres, alter works). See docs/migrations.md#uuid-keys.',
          ),
        );
      }
    }
  }
}

async function run(db: Kysely<any>, driver: Driver, step: PlanStep, listCheck?: (table: string, column: string) => { readonly name: string; readonly had: boolean } | undefined): Promise<void> {
  switch (step.kind) {
    case 'create':
      return create(db, driver, step.blueprint);
    case 'alter':
      return alter(db, driver, step.blueprint, listCheck);
    case 'drop':
      await (step.ifExists ? db.schema.dropTable(step.table).ifExists() : db.schema.dropTable(step.table)).execute();
      return;
    case 'rename':
      await db.schema.alterTable(step.from).renameTo(step.to).execute();
      if (step.indexes) {
        switch (driver) {
          case 'sqlite':
            await renameIndexesSqlite(db, step.from, step.to);
            break;
          case 'pgsql':
            await renameNamesPgsql(db, driver, step.from, step.to);
            break;
          case 'mysql':
            return mysqlPending('Renaming a table with its indexes');
          default:
            return unknownDriver(driver);
        }
      }
      return;
    case 'raw': {
      // MySQL's `null` runs nothing, like a driver without a statement.
      const statement = step.statements[driver];
      if (statement) await statement.execute(db);
      return;
    }
    case 'data': {
      // The migrator's tables are its to write, and a schema change here would be missing from the plan.
      const guarded = async (on: Kysely<any>) => step.run(on.withPlugin(noMigratorWrites()).withPlugin(noSchemaChanges(driver)) as unknown as Connection<any>, { driver });
      // MySQL's migration has no transaction around it (its DDL would end it): the rows of a data step are its own, committed or rolled back with it.
      if (driver === 'mysql' && !db.isTransaction) await db.transaction().execute(guarded);
      else await guarded(db);
      return;
    }
  }
}

async function create(db: Kysely<any>, driver: Driver, blueprint: Blueprint): Promise<void> {
  const parts = blueprintParts(blueprint);
  let builder = db.schema.createTable(blueprint.table);
  for (const spec of parts.columns) builder = builder.addColumn(spec.name, ...compileColumn(spec, driver, blueprint));
  for (const { name, sql: condition } of parts.checks) builder = builder.addCheckConstraint(name, sql.raw(condition));
  if (driver === 'mysql') {
    for (const [name, column, { table, column: referenced, onDelete }] of mysqlForeignKeys(parts.columns, blueprint.table)) {
      builder = builder.addForeignKeyConstraint(name, [column] as never[], table, [referenced], (key) => (onDelete ? key.onDelete(onDelete) : key));
    }
  }
  // The table's own collation, binary like the session's: a token or an email compares byte for byte, as on SQLite and Postgres.
  await (driver === 'mysql' ? builder.modifyEnd(sql`default character set utf8mb4 collate utf8mb4_0900_bin`) : builder).execute();
  await createIndexes(db, blueprint);
}

/** Every change runs as its own statement, because SQLite's ALTER TABLE takes one change at a time. */
async function alter(db: Kysely<any>, driver: Driver, blueprint: Blueprint, listCheck?: (table: string, column: string) => { readonly name: string; readonly had: boolean } | undefined): Promise<void> {
  const parts = blueprintParts(blueprint);
  const table = blueprint.table;
  // MySQL names the table an index is dropped from.
  for (const name of parts.dropIndexes) await (driver === 'mysql' ? db.schema.dropIndex(name).on(table) : db.schema.dropIndex(name)).execute();
  for (const name of parts.dropChecks) await db.schema.alterTable(table).dropConstraint(name).execute();
  for (const { from, to } of parts.renames) {
    await db.schema.alterTable(table).renameColumn(from, to).execute();
  }
  for (const spec of parts.columns) await db.schema.alterTable(table).addColumn(spec.name, ...compileColumn(spec, driver, blueprint)).execute();
  if (driver === 'mysql') {
    for (const [name, column, { table: target, column: referenced, onDelete }] of mysqlForeignKeys(parts.columns, table)) {
      await db.schema.alterTable(table).addForeignKeyConstraint(name, [column], target, [referenced], (key) => (onDelete ? key.onDelete(onDelete) : key)).execute();
    }
  }
  for (const { column, nullable } of parts.nullability) {
    await db.schema.alterTable(table).alterColumn(column, (change) => (nullable ? change.dropNotNull() : change.setNotNull())).execute();
  }
  for (const { column, references } of parts.foreignKeys) {
    const { table: target, column: referenced, onDelete } = references!;
    await db.schema
      .alterTable(table)
      .addForeignKeyConstraint(foreignKeyName(table, column), [column], target, [referenced], (key) => (onDelete ? key.onDelete(onDelete) : key))
      .execute();
  }
  for (const { column, values } of parts.oneOfChanges) {
    const found = listCheck?.(table, column);
    if (!found) {
      throw new SchemaError(withCode('D19', `schema.alter('${table}') gives "${column}" a list with oneOf(), but the migrations do not know which constraint holds it now. Run it through migrate, or name the constraint with dropCheck() and check().`));
    }
    // A column that gets its list in this very alter() has the constraint already.
    const had = found.had || parts.columns.some((spec) => spec.name === column && spec.oneOf);
    if (!had) fits(driver, found.name, 'check constraint name');
    // One statement: no row is unchecked between the old list and the new one.
    const drop = had ? sql`drop constraint ${sql.id(found.name)}, ` : sql``;
    await sql`alter table ${sql.table(table)} ${drop}add constraint ${sql.id(found.name)} ${oneOfCondition(column, values)}`.execute(db);
  }
  for (const { name, sql: condition } of parts.checks) await db.schema.alterTable(table).addCheckConstraint(name, sql.raw(condition)).execute();
  await createIndexes(db, blueprint);
  for (const column of parts.drops) await db.schema.alterTable(table).dropColumn(column).execute();
}

async function createIndexes(db: Kysely<any>, blueprint: Blueprint): Promise<void> {
  for (const index of blueprint.allIndexes()) {
    let builder = db.schema.createIndex(index.name).on(blueprint.table).columns([...index.columns]);
    if (index.unique) builder = builder.unique();
    // Kysely writes these values into the statement as literals, with its own escaping; the blueprint admits no other kind.
    for (const [column, value] of Object.entries(index.where ?? {})) {
      builder = value === null ? builder.where(column, 'is', null) : typeof value === 'object' ? builder.where(column, 'is not', null) : builder.where(column, '=', value);
    }
    await builder.execute();
  }
}

async function renameNamesPgsql(db: Kysely<any>, driver: Driver, from: string, to: string): Promise<void> {
  const prefix = `${from}_`;
  const renamed = (name: string) => `${to}_${name.slice(prefix.length)}`;
  const table = sql`t.oid = to_regclass(quote_ident(${to}::text))`;
  // Every name is read before the first is changed: `to` may itself begin with `<from>_`, and a name already renamed must not be taken for an old one.
  const names = async (query: ReturnType<typeof sql<{ name: string }>>) => (await query.execute(db)).rows.map((row) => row.name).filter((name) => name.startsWith(prefix));
  const constraints = await names(sql<{ name: string }>`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid where ${table} order by c.conname`);
  const indexes = await names(sql<{ name: string }>`select i.relname as name from pg_index x join pg_class t on t.oid = x.indrelid join pg_class i on i.oid = x.indexrelid where ${table} order by i.relname`);
  const sequences = await names(sql<{ name: string }>`
    select s.relname as name from pg_class s
    join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
    join pg_class t on t.oid = d.refobjid
    where s.relkind = 'S' and ${table}
    order by s.relname`);
  for (const name of [...constraints, ...indexes, ...sequences]) fits(driver, renamed(name), 'name after the rename');
  for (const name of constraints) await sql`alter table ${sql.table(to)} rename constraint ${sql.id(name)} to ${sql.id(renamed(name))}`.execute(db);
  // Renaming a constraint renamed the index behind it (the primary key, a unique constraint) too.
  for (const name of indexes) {
    if (!constraints.includes(name)) await sql`alter index ${sql.id(name)} rename to ${sql.id(renamed(name))}`.execute(db);
  }
  for (const name of sequences) await sql`alter sequence ${sql.id(name)} rename to ${sql.id(renamed(name))}`.execute(db);
}

/** SQLite renames no index: it drops each and creates it again under the new name, from the statement it was created with. */
async function renameIndexesSqlite(db: Kysely<any>, from: string, to: string): Promise<void> {
  const prefix = `${from}_`;
  // Indexes behind a primary key or a column's `unique` have no statement (`sql is null`) and no name to choose.
  const indexes = await sql<{ name: string; sql: string }>`select name, sql from sqlite_master where type = 'index' and tbl_name = ${to} and sql is not null order by name`.execute(db);
  for (const { name, sql: statement } of indexes.rows) {
    if (!name.startsWith(prefix)) continue;
    const created = statement.replace(/^(\s*create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?)(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\S+))/i, (_, head: string) => `${head}"${to}_${name.slice(prefix.length)}"`);
    if (created === statement) throw new Error(`Cannot rename the index "${name}": its statement is not a plain "create index" (${statement}).`);
    await sql`drop index ${sql.id(name)}`.execute(db);
    await sql.raw(created).execute(db);
  }
}
