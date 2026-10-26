import { withCode } from '@marmeon/core/internal';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Connection } from '../builder.ts';
import { noMigratorWrites, noSchemaChanges } from '../migrator-connection.ts';
import { Blueprint, blueprintParts, compileColumn, type Driver } from './blueprint.ts';
import { schemaSteps, sealSchema, Schema } from './schema.ts';
import { SchemaError } from './schema-error.ts';

/** What a `schema.raw()` step runs per driver; a driver without a statement runs nothing. */
export interface RawStatements {
  readonly sqlite?: RawBuilder<unknown>;
  readonly pgsql?: RawBuilder<unknown>;
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
): Promise<void> {
  check(driver, steps);
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'data' && aroundData) await aroundData(index, () => run(db, driver, step));
    else await run(db, driver, step);
  }
}

/** Postgres cuts an identifier at 63 bytes without a word. */
function fits(driver: Driver, name: string, what: string): void {
  if (driver !== 'pgsql' || Buffer.byteLength(name) <= 63) return;
  throw new SchemaError(
    withCode('D5', `The ${what} "${name}" is ${Buffer.byteLength(name)} bytes long; Postgres would cut it at 63 and so change it silently. Give it a name of its own that fits (for an index: table.index(columns, 'name')).`),
  );
}

function check(driver: Driver, steps: readonly PlanStep[]): void {
  for (const step of steps) {
    if (step.kind !== 'create' && step.kind !== 'alter') continue;
    for (const index of step.blueprint.allIndexes()) fits(driver, index.name, 'index name');
    const parts = blueprintParts(step.blueprint);
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
    if (step.kind === 'alter' && driver === 'sqlite') {
      const generated = parts.columns.find((spec) => spec.default && 'uuidv7' in spec.default);
      if (generated) {
        throw new SchemaError(
          withCode(
            'D18',
          `schema.alter('${step.table}') cannot add the UUIDv7 column "${generated.name}" on SQLite: SQLite adds no column whose default is computed. ` +
            'Create the table with the column instead (on Postgres, alter works). See docs/migrations.md#uuid-keys.',
          ),
        );
      }
    }
  }
}

async function run(db: Kysely<any>, driver: Driver, step: PlanStep): Promise<void> {
  switch (step.kind) {
    case 'create':
      return create(db, driver, step.blueprint);
    case 'alter':
      return alter(db, driver, step.blueprint);
    case 'drop':
      await (step.ifExists ? db.schema.dropTable(step.table).ifExists() : db.schema.dropTable(step.table)).execute();
      return;
    case 'rename':
      await db.schema.alterTable(step.from).renameTo(step.to).execute();
      if (step.indexes) await (driver === 'pgsql' ? renameNamesPgsql(db, driver, step.from, step.to) : renameIndexesSqlite(db, step.from, step.to));
      return;
    case 'raw': {
      const statement = step.statements[driver];
      if (statement) await statement.execute(db);
      return;
    }
    case 'data':
      // The migrator's tables are its to write, and a schema change here would be missing from the plan.
      await step.run(db.withPlugin(noMigratorWrites()).withPlugin(noSchemaChanges()) as unknown as Connection<any>, { driver });
      return;
  }
}

async function create(db: Kysely<any>, driver: Driver, blueprint: Blueprint): Promise<void> {
  const parts = blueprintParts(blueprint);
  let builder = db.schema.createTable(blueprint.table);
  for (const spec of parts.columns) builder = builder.addColumn(spec.name, ...compileColumn(spec, driver));
  await builder.execute();
  await createIndexes(db, blueprint);
}

/** Every change runs as its own statement, because SQLite's ALTER TABLE takes one change at a time. */
async function alter(db: Kysely<any>, driver: Driver, blueprint: Blueprint): Promise<void> {
  const parts = blueprintParts(blueprint);
  const table = blueprint.table;
  for (const name of parts.dropIndexes) await db.schema.dropIndex(name).execute();
  for (const { from, to } of parts.renames) {
    await db.schema.alterTable(table).renameColumn(from, to).execute();
  }
  for (const spec of parts.columns) await db.schema.alterTable(table).addColumn(spec.name, ...compileColumn(spec, driver)).execute();
  for (const { column, nullable } of parts.nullability) {
    await db.schema.alterTable(table).alterColumn(column, (change) => (nullable ? change.dropNotNull() : change.setNotNull())).execute();
  }
  await createIndexes(db, blueprint);
  for (const column of parts.drops) await db.schema.alterTable(table).dropColumn(column).execute();
}

async function createIndexes(db: Kysely<any>, blueprint: Blueprint): Promise<void> {
  for (const index of blueprint.allIndexes()) {
    let builder = db.schema.createIndex(index.name).on(blueprint.table).columns([...index.columns]);
    if (index.unique) builder = builder.unique();
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
