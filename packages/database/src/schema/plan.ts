import { printable, withCode } from '@marmeon/core/internal';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Connection } from '../builder.ts';
import { noMigratorWrites, noSchemaChanges } from '../migrator-connection.ts';
import { Blueprint, blueprintParts, compileColumn, foreignKeyName, mysqlForeignKeys, oneOfCondition, oneOfName, type Driver } from './blueprint.ts';
import { checkMysqlPlan, checkMysqlState, fitsMysql, indexRenamesOf, mysqlStateTables, NO_STATE, readMysqlState, refuseNamedConstraints } from './mysql-checks.ts';
import type { ProjectedTable } from './projection.ts';
import { rollbackSchema, schemaSteps, sealSchema, Schema } from './schema.ts';
import { tableParts } from './table-name.ts';
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
  if (direction === 'down') rollbackSchema(schema);
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
  /** The tables the migrations know before each step. Used for the types of columns that an earlier step of the plan makes, which the database does not have yet; the columns that exist, and those dropped, come from the database. */
  tablesAt?: TablesAt,
): Promise<void> {
  check(driver, steps);
  if (driver === 'pgsql') await assertNamesFitPgsql(db, pgsqlNames(steps, await pgsqlCuts(db, steps)));
  if (driver === 'mysql') {
    checkMysqlLists(steps, listCheck);
    const tables = mysqlStateTables(steps);
    // Nothing is read for a plan that needs nothing of the database (one that only creates tables, say).
    checkMysqlState(steps, tables.length ? await readMysqlState(db, tables) : NO_STATE, tablesAt);
  }
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'data' && aroundData) await aroundData(index, () => run(db, driver, step));
    else await run(db, driver, step, listCheck && ((table, column) => listCheck(index, table, column)));
  }
}

/** The constraint behind a column's `oneOf()` list after the step with this index, and whether the column had a list before it; undefined for a column the migrations do not know. */
export type ListCheck = (index: number, table: string, column: string) => { readonly name: string; readonly had: boolean } | undefined;

/**
 * The tables the migrations leave before the step with this index, or undefined when they cannot be told (a plan the projection does not
 * hold: the check then skips what it needs them for, and the run says what is wrong where it is meant to).
 */
export type TablesAt = (index: number) => ReadonlyMap<string, ProjectedTable> | undefined;

const DEFAULT_NAME_HINT = "Give it a name of its own that fits (for an index: table.index(columns, 'name'); for the constraint of oneOf(): a shorter table or column name, or table.check(name, …) instead).";

/** MySQL refuses an identifier over 64 characters. Postgres is asked, not guessed: {@link assertNamesFitPgsql}. */
function fits(driver: Driver, name: string, what: string, hint = DEFAULT_NAME_HINT): void {
  if (driver === 'mysql') fitsMysql(name, what, hint);
}

/** A name to be asked of Postgres, one a plan gives or one it only acts on: `what` says which kind it is, `hint` how to give it one that fits. */
export interface PgsqlName {
  readonly name: string;
  readonly what: string;
  readonly hint: string;
  /** The clause after the name in the message; the default says Postgres would cut a name the migration gives. Set it for a name the plan only acts on. Starts with a comma, ends with a period. */
  readonly effect?: string;
}

/**
 * The names a plan gives, and those it acts on, that Postgres may cut: it alone knows where it cuts one (63 bytes of the database's
 * encoding), so nothing is measured here: `cuts` holds what Postgres makes of each name the plan compares ({@link pgsqlCuts}, or
 * {@link pgsqlCompared} for the names), and the result goes to {@link assertNamesFitPgsql}. The names a plan gives are those `check()` measures on MySQL.
 *
 * A name a plan only acts on is collected when a step names a table, column, index or check constraint that Postgres would take for the
 * one its first 63 bytes name: the table of `drop`, `rename` (its `from`) and `alter` (each part of a qualified name), the columns of
 * `dropColumn`, `renameColumn` (its `from`), `notNull`, `nullable` and a `oneOf` change, and the names of `dropIndex`, `dropUnique` and
 * `dropCheck`, the table and column a foreign key points at, and the columns of an index and of its `where`. Not those an earlier step of the plan made (created, renamed to, added), which the plan holds under the long name. A name in
 * `raw()` and `data()` steps is not collected.
 */
export function pgsqlNames(steps: readonly PlanStep[], cuts: ReadonlyMap<string, string>, listCheck?: ListCheck): PgsqlName[] {
  const names: PgsqlName[] = [];
  const cut = (name: string) => {
    const found = cuts.get(name);
    if (found === undefined) throw new Error(`No cut of the name "${printable(name)}" was given to pgsqlNames(); ask for every name pgsqlCompared() lists.`);
    return found;
  };
  const add = (name: string, what: string, hint = DEFAULT_NAME_HINT, effect?: string) => names.push({ name, what, hint, ...(effect ? { effect } : {}) });
  // What the plan has made so far, which a later step may name as it was given: the tables (by the whole string, as given), the columns added to each table, and the indexes and check constraints.
  const created = new Set<string>();
  const added = new Map<string, Set<string>>();
  const indexes = new Set<string>();
  // Check constraint names are scoped by table in Postgres, unlike index names.
  const checks = new Map<string, Set<string>>();
  const checksOf = (table: string) => checks.get(table) ?? checks.set(table, new Set()).get(table)!;
  const columnsOf = (table: string) => added.get(table) ?? added.set(table, new Set()).get(table)!;
  const acts = (kind: string, method: string, name: string, known: boolean, parts: readonly { kind: string; name: string }[] = [{ kind, name }]) => {
    if (known) return;
    for (const part of parts) add(part.name, part.kind, `Name the ${part.kind} as Postgres stored it.`, `, so ${method} would act on the ${part.kind} its first 63 bytes name.`);
  };
  // Two names are the same object for Postgres when they are equal once it has cut them; the server says where, not this code.
  const sameName = (a: string, b: string) => cut(a) === cut(b);
  // Two tables are the same object when their table parts are, and their schemas: a name without a schema may resolve to any schema of the search path, so it matches every one (`public.S` is the table S).
  const sameTable = (a: string, b: string) => {
    const [x, y] = [tableParts(a), tableParts(b)];
    const [xs, ys] = [x.find((part) => part.kind === 'schema'), y.find((part) => part.kind === 'schema')];
    return sameName(x.at(-1)!.name, y.at(-1)!.name) && (!xs || !ys || sameName(xs.name, ys.name));
  };
  // A step on a name withdraws what the plan holds under one Postgres would read as it.
  const withdraw = (set: Set<string>, name: string, table = false) => {
    for (const entry of set) {
      if (entry === name) continue;
      if (table ? sameTable(entry, name) : sameName(entry, name)) set.delete(entry);
    }
  };
  const actsOnTable = (method: string, table: string) => acts('table', method, table, created.has(table), tableParts(table));
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'drop') {
      actsOnTable(step.ifExists ? 'dropIfExists()' : 'drop()', step.table);
      withdraw(created, step.table, true);
      created.delete(step.table);
      added.delete(step.table);
      checks.delete(step.table);
    }
    if (step.kind === 'rename') {
      actsOnTable('rename()', step.from);
      const columns = added.get(step.from);
      const constraints = checks.get(step.from);
      withdraw(created, step.from, true);
      withdraw(created, step.to, true);
      created.delete(step.from);
      added.delete(step.from);
      checks.delete(step.from);
      if (constraints) checks.set(step.to, constraints);
      created.add(step.to);
      if (columns) added.set(step.to, columns);
    }
    if (step.kind !== 'create' && step.kind !== 'alter') continue;
    const parts = blueprintParts(step.blueprint);
    if (step.kind === 'create') {
      withdraw(created, step.table, true);
      created.add(step.table);
      added.set(step.table, new Set());
    } else actsOnTable('alter()', step.table);
    const columns = columnsOf(step.table);
    // An alter runs, in this order: the drops of indexes and checks, the renames, the additions, nullability, foreign keys, the lists, checks, the indexes, and last the drops of columns; the walk below follows it.
    for (const name of step.kind === 'alter' ? parts.dropIndexes : []) {
      acts('index', parts.dropUniques.includes(name) ? 'dropUnique()' : 'dropIndex()', name, indexes.has(name));
      indexes.delete(name);
    }
    for (const name of step.kind === 'alter' ? parts.dropChecks : []) {
      acts('check constraint', 'dropCheck()', name, checksOf(step.table).has(name));
      checksOf(step.table).delete(name);
    }
    for (const { from, to } of step.kind === 'alter' ? parts.renames : []) {
      acts('column', 'renameColumn()', from, columns.has(from));
      withdraw(columns, from);
      withdraw(columns, to);
      columns.delete(from);
      columns.add(to);
    }
    for (const spec of parts.columns) {
      withdraw(columns, spec.name);
      columns.add(spec.name);
    }
    for (const { column, nullable } of step.kind === 'alter' ? parts.nullability : []) acts('column', nullable ? 'nullable()' : 'notNull()', column, columns.has(column));
    for (const { column } of step.kind === 'alter' ? parts.oneOfChanges : []) acts('column', 'oneOf()', column, columns.has(column));
    // What a foreign key points at, and the columns an index covers (the projection reads these in an up(), not in a down()).
    for (const { references } of [...parts.columns, ...(step.kind === 'alter' ? parts.foreignKeys : [])]) {
      if (!references) continue;
      actsOnTable('the foreign key', references.table);
      acts('column', 'the foreign key', references.column, added.get(references.table)?.has(references.column) ?? false);
    }
    for (const index of step.blueprint.allIndexes()) {
      for (const column of [...index.columns, ...Object.keys(index.where ?? {})]) acts('column', 'the index', column, columns.has(column));
      add(index.name, 'index name');
      indexes.add(index.name);
    }
    for (const spec of parts.columns) {
      if (!spec.oneOf) continue;
      add(oneOfName(step.table, spec.name), 'check constraint name');
      checksOf(step.table).add(oneOfName(step.table, spec.name));
    }
    for (const { name } of parts.checks) {
      add(name, 'check constraint name');
      checksOf(step.table).add(name);
    }
    for (const { column } of parts.foreignKeys) add(foreignKeyName(step.table, column), 'foreign key name', 'Use a shorter table or column name.');
    // The constraint a oneOf() gives a column that has no list yet: the migrations know its name before the run.
    for (const { column } of step.kind === 'alter' ? parts.oneOfChanges : []) {
      const found = listCheck?.(index, step.table, column);
      if (found) checksOf(step.table).add(found.name);
      if (found && !hadList(found, parts, column)) add(found.name, 'check constraint name');
    }
    // The drops of columns run last, after the foreign keys, indexes and checks that may still name the column.
    for (const column of step.kind === 'alter' ? parts.drops : []) {
      acts('column', 'dropColumn()', column, columns.has(column));
      withdraw(columns, column);
      columns.delete(column);
    }
  }
  return names;
}

/**
 * The names `pgsqlNames` compares to tell whether Postgres reads two of them as one object: each part of the tables of create, drop,
 * rename (`from` and `to`) and alter steps, and the column names of the blueprints (added, renamed from and to, dropped).
 */
export function pgsqlCompared(steps: readonly PlanStep[]): string[] {
  const found = new Set<string>();
  const table = (name: string) => tableParts(name).forEach((part) => found.add(part.name));
  for (const step of steps) {
    if (step.kind === 'drop') table(step.table);
    if (step.kind === 'rename') {
      table(step.from);
      table(step.to);
    }
    if (step.kind !== 'create' && step.kind !== 'alter') continue;
    table(step.table);
    const parts = blueprintParts(step.blueprint);
    for (const { name } of parts.columns) found.add(name);
    for (const { from, to } of parts.renames) {
      found.add(from);
      found.add(to);
    }
    for (const column of parts.drops) found.add(column);
  }
  return [...found];
}

/**
 * What Postgres makes of each name of {@link pgsqlCompared}: the server casts it to `name`, which clips at 63 bytes in the encoding of the
 * database, the cut every statement makes. The cut comes back as the hex of the bytes the server holds, so two cuts are equal exactly when
 * Postgres reads the two names as one, whatever a client makes of bytes that are no character of the encoding; it is only ever compared,
 * never shown. The rows are matched to the names by position, not by the text they carry back, which a client may change (a lone surrogate).
 * Asked of `db`, the connection the plan runs on. A name the encoding cannot hold is refused (D5); any other error of the query is not
 * caught, and an answer that is not one row per name is an error too: the plan then does not run.
 */
export async function pgsqlCuts(db: Kysely<any>, steps: readonly PlanStep[]): Promise<Map<string, string>> {
  const asked = pgsqlCompared(steps);
  const cuts = new Map<string, string>();
  if (asked.length === 0) return cuts;
  let rows: { c: string }[];
  try {
    ({ rows } = await sql<{ c: string }>`select encode(convert_to(n::name::text, current_setting('server_encoding')), 'hex') as c from unnest(${asked}::text[]) with ordinality as t(n, i) order by i`.execute(db));
  } catch (error) {
    throw untranslatable(error, asked);
  }
  if (rows.length !== asked.length) throw new Error(`Postgres answered ${rows.length} cuts for ${asked.length} names.`);
  for (const [index, name] of asked.entries()) cuts.set(name, rows[index]!.c);
  return cuts;
}

/** The SQLSTATEs of a name the encoding of the database cannot hold: a character the encoding does not have, or a byte sequence it does not allow. */
const UNTRANSLATABLE = new Set(['22P05', '22021']);

/** The D5 for a name the encoding cannot hold; any other error of a query asking the server is returned as it is, to be thrown: the plan then does not run. */
function untranslatable(error: unknown, names: readonly string[]): unknown {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || !UNTRANSLATABLE.has(code)) return error;
  const listed = names.filter((name) => /\P{ASCII}|\0/u.test(name)).map((name) => `"${printable(name)}"`);
  return new SchemaError(
    withCode('D5', `One of these names cannot be held in this database's encoding: ${(listed.length ? listed : names.map((name) => `"${printable(name)}"`)).join(', ')}. Give it a name made of characters the database's encoding has.`),
    { cause: error },
  );
}

/**
 * Refuses (D5) the first of `names` that Postgres would cut at 63 bytes without a word, whether a migration gives it or only acts on it. The server measures: casting to `name` clips at
 * the limit in the encoding of the database, which is the cut every statement makes, so no guess about the encoding is made here. Only
 * the names that differ after the cast come back, so what a driver makes of a boolean is of no consequence. A name the encoding cannot hold
 * is refused too (D5); any other error of the query is not caught: the plan then does not run.
 */
export async function assertNamesFitPgsql(db: Kysely<any>, names: readonly PgsqlName[]): Promise<void> {
  if (names.length === 0) return;
  let rows: { n: string }[];
  try {
    ({ rows } = await sql<{ n: string }>`select n from unnest(${names.map((entry) => entry.name)}::text[]) with ordinality as t(n, i) where n::name::text is distinct from n order by i limit 1`.execute(db));
  } catch (error) {
    throw untranslatable(error, names.map((entry) => entry.name));
  }
  if (rows.length === 0) return;
  const { name, what, hint, effect } = names.find((entry) => entry.name === rows[0]!.n) ?? { name: rows[0]!.n, what: 'name', hint: DEFAULT_NAME_HINT, effect: undefined };
  throw new SchemaError(
    withCode('D5', `The ${what} "${printable(name)}" is longer than Postgres's 63 bytes in this database's encoding${effect ?? '; Postgres would cut it and so change it silently.'} ${hint}`),
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

/**
 * What each step of the plan shows by itself it cannot do on `driver` (not what depends on an earlier step of the same migration, such as an index on a column it adds), refused before its first statement; no database is asked (so Postgres's cut of a name is not here: {@link assertNamesFitPgsql}). `executePlan` calls it; a
 * rollback calls it for every `down()` it is to run, and a run on MySQL for every migration it is to run. What depends on the tables on MySQL is
 * held in `executePlan`, against the database as it is when the migration starts.
 */
export function check(driver: Driver, steps: readonly PlanStep[]): void {
  if (driver === 'mysql') {
    assertRawFitsMysql(steps, 'The plan');
    // MySQL commits every DDL statement as it runs, so what it refuses has to be found here: a plan that stops half way leaves the first half in place, and a rerun fails on it.
    checkMysqlPlan(steps);
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
    case 'rename': {
      if (driver === 'mysql') {
        // The indexes follow the table in the one statement that renames it: they change their names together, or none does. They are read, and
        // their new names held, before it: a refusal then leaves the table as it was.
        const renames = step.indexes ? await mysqlRenames(db, step.from, step.to) : [];
        if (renames.length) await sql`alter table ${sql.table(step.from)} rename to ${sql.table(step.to)}, ${sql.join(renames.map(([from, to]) => sql`rename index ${sql.id(from)} to ${sql.id(to)}`))}`.execute(db);
        else await db.schema.alterTable(step.from).renameTo(step.to).execute();
        return;
      }
      await db.schema.alterTable(step.from).renameTo(step.to).execute();
      if (step.indexes) {
        switch (driver) {
          case 'sqlite':
            await renameIndexesSqlite(db, step.from, step.to);
            break;
          case 'pgsql':
            await renameNamesPgsql(db, step.from, step.to);
            break;
          default:
            return unknownDriver(driver);
        }
      }
      return;
    }
    case 'raw': {
      // MySQL's `null` runs nothing, like a driver without a statement.
      const statement = step.statements[driver];
      if (statement) await statement.execute(db);
      return;
    }
    case 'data': {
      // The migrator's tables are its to write, and a schema change here would be missing from the plan.
      const guarded = async (on: Kysely<any>) => step.run(on.withPlugin(noMigratorWrites(driver)).withPlugin(noSchemaChanges(driver)) as unknown as Connection<any>, { driver });
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
    if (!found) throw unknownList(table, column);
    const had = hadList(found, parts, column);
    if (!had) {
      if (driver === 'pgsql') await assertNamesFitPgsql(db, [{ name: found.name, what: 'check constraint name', hint: DEFAULT_NAME_HINT }]);
      else fits(driver, found.name, 'check constraint name');
    }
    // One statement: no row is unchecked between the old list and the new one.
    const drop = had ? sql`drop constraint ${sql.id(found.name)}, ` : sql``;
    await sql`alter table ${sql.table(table)} ${drop}add constraint ${sql.id(found.name)} ${oneOfCondition(column, values)}`.execute(db);
  }
  for (const { name, sql: condition } of parts.checks) await db.schema.alterTable(table).addCheckConstraint(name, sql.raw(condition)).execute();
  await createIndexes(db, blueprint);
  for (const column of parts.drops) await db.schema.alterTable(table).dropColumn(column).execute();
}

function unknownList(table: string, column: string): SchemaError {
  return new SchemaError(withCode('D19', `schema.alter('${table}') gives "${column}" a list with oneOf(), but the migrations do not know which constraint holds it now. Run it through migrate, or name the constraint with dropCheck() and check().`));
}

/** Whether the column has a list to replace: one from before, or one that this very alter() gives it with its column. */
export function hadList(found: { readonly had: boolean }, parts: ReturnType<typeof blueprintParts>, column: string): boolean {
  return found.had || parts.columns.some((spec) => spec.name === column && spec.oneOf);
}

/** What `alter()` finds out about the lists of `oneOf()` while it runs, found out before the first statement of the plan: the migrations must know the constraint, and a new one needs a name MySQL takes. */
function checkMysqlLists(steps: readonly PlanStep[], listCheck: ListCheck | undefined): void {
  for (const [index, step] of steps.entries()) {
    if (step.kind !== 'alter') continue;
    const parts = blueprintParts(step.blueprint);
    for (const { column } of parts.oneOfChanges) {
      const found = listCheck?.(index, step.table, column);
      if (!found) throw unknownList(step.table, column);
      if (!hadList(found, parts, column)) fits('mysql', found.name, 'check constraint name');
    }
  }
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

async function renameNamesPgsql(db: Kysely<any>, from: string, to: string): Promise<void> {
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
  await assertNamesFitPgsql(db, [...constraints, ...indexes, ...sequences].map((name) => ({ name: renamed(name), what: 'name after the rename', hint: DEFAULT_NAME_HINT })));
  for (const name of constraints) await sql`alter table ${sql.table(to)} rename constraint ${sql.id(name)} to ${sql.id(renamed(name))}`.execute(db);
  // Renaming a constraint renamed the index behind it (the primary key, a unique constraint) too.
  for (const name of indexes) {
    if (!constraints.includes(name)) await sql`alter index ${sql.id(name)} rename to ${sql.id(renamed(name))}`.execute(db);
  }
  for (const name of sequences) await sql`alter sequence ${sql.id(name)} rename to ${sql.id(renamed(name))}`.execute(db);
}

/**
 * The indexes of `from` on MySQL that follow the table to `to`, as `[old, new]`, read from the server (which has the ones raw SQL made too).
 * Refuses a table with a foreign key or check named after it first: MySQL renames neither.
 */
async function mysqlRenames(db: Kysely<any>, from: string, to: string): Promise<[string, string][]> {
  const constraints = await sql<{ name: string }>`select constraint_name as name from information_schema.table_constraints where table_schema = database() and table_name = ${from} and constraint_type in ('CHECK', 'FOREIGN KEY')`.execute(db);
  refuseNamedConstraints(from, to, constraints.rows.map((row) => row.name));
  const indexes = await sql<{ name: string }>`select distinct index_name as name from information_schema.statistics where table_schema = database() and table_name = ${from} and index_name <> 'PRIMARY' order by index_name`.execute(db);
  return indexRenamesOf(from, to, indexes.rows.map((row) => row.name));
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
