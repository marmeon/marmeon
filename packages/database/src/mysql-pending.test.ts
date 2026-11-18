import { AliasNode, DummyDriver, FunctionNode, IdentifierNode, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, SelectionNode, SelectQueryNode, TableNode } from 'kysely';
import { describe, expect, it } from 'vitest';
import { introspect, tableColumns } from './introspection.ts';
import { SchemaMetadata } from './metadata.ts';
import { createMigrationsTable } from './migration-state.ts';
import { Migrator } from './migrations/migrator.ts';
import { dropAllTables } from './migrations/drop-all.ts';
import { MigrationLock } from './migrations/lock.ts';
import { MANY } from './placeholders.ts';
import { RelationsPlugin } from './relations.ts';
import { parameterLimit } from './repository.ts';
import { Blueprint, blueprintParts, compileColumn, mysqlTypeOf, typeOf, type Driver } from './schema/blueprint.ts';
import { executePlan } from './schema/plan.ts';
import { UnsupportedDriverError, unknownDriver } from './supported-driver.ts';

// A connection of the `mysql` driver cannot be opened yet, so every place that chooses by driver says so with D29 and names what it was asked for.
// A driver the types do not name (a JavaScript caller, a cast) is refused the same way, as one Marmeon does not know.

const mysql = 'mysql' as Driver;
const unknown = 'oracle' as Driver;
const pending = (feature: string) => `[marmeon:D29] ${feature} does not run on MySQL yet.`;
const notKnown = '[marmeon:D29] The database driver "oracle" is not one Marmeon knows; use sqlite or pgsql.';

/** A Kysely that compiles for MySQL and runs nothing. */
const dummy = new Kysely<any>({
  dialect: { createAdapter: () => new MysqlAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (db: Kysely<any>) => new MysqlIntrospector(db), createQueryCompiler: () => new MysqlQueryCompiler() },
});
const noTables = { introspection: { getTables: async () => [] } } as never;

function column(make: (t: Blueprint) => void) {
  const blueprint = new Blueprint('t');
  make(blueprint);
  return { blueprint, spec: blueprintParts(blueprint).columns[0]! };
}
const ddl = (make: (t: Blueprint) => void, driver: Driver) => {
  const { blueprint, spec } = column(make);
  const [type, modify] = compileColumn(spec, driver, blueprint);
  return () => dummy.schema.createTable('t').addColumn(spec.name, type, modify).compile().sql;
};

const catalog = (async () => []) as never;
const migrator = (driver: string) => new Migrator({} as never, { options: () => ({ driver, managed: true }) } as never);
const relation = (driver: Driver) => {
  const node = SelectQueryNode.cloneWithSelections(SelectQueryNode.createFrom([TableNode.create('t')]), [
    SelectionNode.create(AliasNode.create(FunctionNode.create(MANY, [SelectQueryNode.createFrom([TableNode.create('u')])]), IdentifierNode.create('x'))),
  ]);
  return () => new RelationsPlugin(driver, new SchemaMetadata(driver)).transform(node, {} as never);
};

describe.each([
  ['mysql', mysql, (feature: string) => pending(feature)],
  ['a driver the types do not name', unknown, () => notKnown],
] as const)('the branches of %s', (_, driver, message) => {
  const refuses = async (call: () => unknown, feature: string) => {
    const error = await Promise.resolve()
      .then(call)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(UnsupportedDriverError);
    expect((error as Error).message).toBe(message(feature));
  };

  it.each([
    ['a uuidv7 default', 'A uuidv7 default', () => ddl((t) => void t.uuid('c').useUuidv7(), driver)()],
    ['a current-time default', 'A current-time default', () => ddl((t) => void t.timestamp('c').useCurrent(), driver)()],
    ['the record of migrations', 'The record of migrations', () => createMigrationsTable(dummy, driver)],
    ['emptying the database', 'Emptying the database', () => dropAllTables(noTables, driver)],
    ['the migration lock', 'The migration lock', () => MigrationLock.acquire(dummy, { driver })],
    ['renaming a table with its indexes', 'Renaming a table with its indexes', () => executePlan(dummy, driver, [{ kind: 'rename', from: 'a', to: 'b', indexes: true }])],
    ['reading the columns of the database', 'Reading the columns of the database', () => tableColumns(catalog, driver)],
    ['reading the columns, as introspect starts', 'Reading the columns of the database', () => introspect(catalog, driver)],
    ['reading the tables for the migrator', 'Reading the tables of the database', () => migrator(driver).undescribedColumns('default', [])],
    ['a relation inside a query', 'A relation inside a query (with())', relation(driver)],
  ])('refuses %s', async (_name, feature, call) => {
    await refuses(call, feature);
  });
});

describe('the types of a column on MySQL', () => {
  it('writes the DDL of a table with the type of each column and AUTO_INCREMENT for an identity key', () => {
    const { blueprint, spec } = column((t) => void t.id());
    const [type, modify] = compileColumn(spec, mysql, blueprint);
    expect(dummy.schema.createTable('t').addColumn('id', type, modify).compile().sql).toBe('create table `t` (`id` bigint primary key auto_increment)');
  });

  it('reads a type the same through typeOf and mysqlTypeOf, and refuses a driver it does not know', () => {
    const { blueprint, spec } = column((t) => void t.text('body').unique());
    expect(typeOf(spec, 'mysql', blueprint)).toBe('varchar(768)');
    expect(mysqlTypeOf(spec, blueprint)).toBe('varchar(768)');
    expect(() => typeOf(spec, unknown, blueprint)).toThrow(new UnsupportedDriverError(notKnown));
  });

  it('refuses a column of a driver it does not know', () => {
    expect(() => ddl((t) => void t.id(), unknown)()).toThrow(new UnsupportedDriverError(notKnown));
  });
});

describe('the number of parameters of one statement', () => {
  it.each([
    ['pgsql', 65_535],
    ['mysql', 65_535],
    ['sqlite', 32_766],
    [undefined, 32_766],
  ] as const)('is %s: %i', (driver, limit) => {
    expect(parameterLimit(driver)).toBe(limit);
  });

  it('refuses a driver it does not know', () => {
    expect(() => parameterLimit(unknown)).toThrow(new UnsupportedDriverError(notKnown));
  });
});

describe('unknownDriver', () => {
  it('throws D29 as an UnsupportedDriverError that names the driver', () => {
    expect(() => unknownDriver('oracle' as never)).toThrow(new UnsupportedDriverError(notKnown));
  });
});
