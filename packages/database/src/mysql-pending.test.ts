import { AliasNode, DummyDriver, FunctionNode, IdentifierNode, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, SelectionNode, SelectQueryNode, sql, TableNode } from 'kysely';
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
import { noSchemaChanges } from './migrator-connection.ts';
import { executePlan, planOf } from './schema/plan.ts';
import { UnsupportedDriverError, unknownDriver } from './supported-driver.ts';

// What has no MySQL form yet says so with D29 and names what it was asked for, for the `mysql` driver; the places that run on MySQL are below.
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
    ['emptying the database', 'Emptying the database', () => dropAllTables(noTables, driver)],
    ['renaming a table with its indexes', 'Renaming a table with its indexes', () => executePlan(dummy, driver, [{ kind: 'rename', from: 'a', to: 'b', indexes: true }])],
    ['reading the tables for the migrator', 'Reading the tables of the database', () => migrator(driver).undescribedColumns('default', [])],
    ['a relation inside a query', 'A relation inside a query (with())', relation(driver)],
  ])('refuses %s', async (_name, feature, call) => {
    await refuses(call, feature);
  });

  // The record of migrations, the columns, the defaults and the lock run on MySQL (below); a driver nobody knows still has no form of them.
  if (driver !== mysql) {
    it.each([
      ['a uuidv7 default', 'A uuidv7 default', () => ddl((t) => void t.uuid('c').useUuidv7(), driver)()],
      ['a current-time default', 'A current-time default', () => ddl((t) => void t.timestamp('c').useCurrent(), driver)()],
      ['the migration lock', 'The migration lock', () => MigrationLock.acquire(dummy, { driver })],
      ['the record of migrations', 'The record of migrations', () => createMigrationsTable(dummy, driver)],
      ['reading the columns of the database', 'Reading the columns of the database', () => tableColumns(catalog, driver)],
      ['reading the columns, as introspect starts', 'Reading the columns of the database', () => introspect(catalog, driver)],
    ])('refuses %s', async (_name, feature, call) => {
      await refuses(call, feature);
    });
  }
});

describe('what runs on MySQL', () => {
  it('creates the record of migrations in the binary collation, with an auto-increment key', async () => {
    const statements: string[] = [];
    const recording = new Kysely<any>({
      dialect: {
        createAdapter: () => new MysqlAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db: Kysely<any>) => new MysqlIntrospector(db),
        createQueryCompiler: () => ({ compileQuery: (node, queryId) => { const compiled = new MysqlQueryCompiler().compileQuery(node, queryId); statements.push(compiled.sql); return compiled; } }),
      },
    });
    await createMigrationsTable(recording, 'mysql');
    expect(statements).toEqual([
      'create table `migrations` (`id` bigint primary key auto_increment, `name` varchar(255) not null unique, `module` varchar(255) not null, `batch` integer not null, `checksum` varchar(80)) default character set utf8mb4 collate utf8mb4_0900_bin',
    ]);
  });

  it('reads the columns of the base tables of its own database from information_schema, with their types and nullability', async () => {
    const asked: string[] = [];
    const rows = [
      { table_name: 'users', column_name: 'id', type: 'bigint', nullable: 0 },
      { table_name: 'users', column_name: 'bio', type: 'varchar(80)', nullable: 1 },
    ];
    const { types, nullable } = await tableColumns((async (text: string) => (asked.push(text), rows)) as never, 'mysql');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/information_schema\.columns[\s\S]*information_schema\.tables[\s\S]*table_schema = database\(\) and t\.table_type = 'BASE TABLE'[\s\S]*order by c\.table_name, c\.ordinal_position/);
    expect([...types.get('users')!]).toEqual([['id', 'bigint'], ['bio', 'varchar(80)']]);
    expect([...nullable]).toEqual(['users\0bio']);
  });
});

/** A Kysely that compiles for MySQL, runs nothing and says what it was asked to run. */
function recorder() {
  const statements: string[] = [];
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely: Kysely<any>) => new MysqlIntrospector(kysely),
      createQueryCompiler: () => ({ compileQuery: (node, queryId) => { const compiled = new MysqlQueryCompiler().compileQuery(node, queryId); statements.push(compiled.sql); return compiled; } }),
    },
  });
  return { db, statements };
}

describe('the DDL MySQL gets', () => {
  const plan = (up: (schema: Parameters<typeof planOf>[0]['up'] extends (schema: infer S) => unknown ? S : never) => void) => planOf({ up }, 'up');

  it('gives every table the binary collation, and names the table an index is dropped from', async () => {
    const { db, statements } = recorder();
    await executePlan(db, 'mysql', plan((schema) => {
      schema.create('notes', (table) => table.id());
      schema.alter('notes', (table) => {
        table.dropIndex('notes_title_index');
        table.dropCheck('notes_title_check');
      });
    }));
    expect(statements).toEqual([
      'create table `notes` (`id` bigint primary key auto_increment) default character set utf8mb4 collate utf8mb4_0900_bin',
      'drop index `notes_title_index` on `notes`',
      'alter table `notes` drop constraint `notes_title_check`',
    ]);
  });

  it('writes a default as MySQL takes it: a function or a column that holds text or JSON in parentheses, a date as UTC text', async () => {
    const { db, statements } = recorder();
    await executePlan(db, 'mysql', plan((schema) => schema.create('defaults', (table) => {
      table.timestamp('stamped').useCurrent();
      table.text('body').default("it's");
      table.json('settings').default({ a: [1] });
      table.string('kind').default('plain');
      table.integer('count').default(0);
      table.timestamp('opened_at').default(new Date('2026-10-01T08:00:00.123Z'));
    })));
    expect(statements[0]).toContain('`stamped` datetime(3) default (utc_timestamp(3)) not null');
    expect(statements[0]).toContain("`body` longtext default ('it''s') not null");
    expect(statements[0]).toContain('`settings` json default (cast(\'{"a":[1]}\' as json)) not null');
    expect(statements[0]).toContain("`kind` varchar(255) default 'plain' not null");
    expect(statements[0]).toContain('`count` integer default 0 not null');
    expect(statements[0]).toContain("`opened_at` datetime(3) default '2026-10-01 08:00:00.123' not null");
  });

  it('states a foreign key as a constraint of the table, which MySQL keeps (a REFERENCES in the column is dropped), also for a column added later', async () => {
    const { db, statements } = recorder();
    await executePlan(db, 'mysql', plan((schema) => {
      schema.create('posts', (table) => {
        table.id();
        table.foreignId('user_id').constrained().cascadeOnDelete();
      });
      schema.alter('posts', (table) => void table.foreignId('editor_id').constrained('users').nullable());
    }));
    expect(statements).toEqual([
      'create table `posts` (`id` bigint primary key auto_increment, `user_id` bigint not null, constraint `posts_user_id_fkey` foreign key (`user_id`) references `users` (`id`) on delete cascade) default character set utf8mb4 collate utf8mb4_0900_bin',
      'alter table `posts` add column `editor_id` bigint',
      'alter table `posts` add constraint `posts_editor_id_fkey` foreign key (`editor_id`) references `users` (`id`)',
    ]);
  });

  it('says what the statement does in a data step, and that every word counts with an executable comment', async () => {
    const run = (text: string) => executePlan(recorder().db, 'mysql', plan((schema) => schema.data((on) => sql.raw(text).execute(on as never)))).catch((error: Error) => error.message);
    expect(await run('commit')).toBe(
      '[marmeon:D4] Cannot run this statement in a schema.data() step: it ends or steers the transaction of the step, which the migrator controls, and a schema change would be missing from the plan of the migration. Use schema.create(), schema.alter() or schema.raw() instead. See docs/migrations.md#changing-the-data.',
    );
    expect(await run('/*! drop table x */')).toContain('the transaction of the step, which the migrator controls, and a schema change would be missing from the plan of the migration. A statement with a /*! or /*+ comment is read with every word, those in strings and comments included. Use');
  });

  it('refuses a driver it does not know when the guard is made', () => {
    expect(() => noSchemaChanges('oracle' as Driver)).toThrow(new UnsupportedDriverError(notKnown));
  });

  it('needs the driver to read a statement by its rules', () => {
    // @ts-expect-error — without it the text would be read by the rules of SQLite and Postgres
    expect(() => noSchemaChanges()).toThrow(UnsupportedDriverError);
  });

  it('treats a `mysql` that is undefined like a missing one: only null says nothing runs', async () => {
    const { db, statements } = recorder();
    const ready = [].length > 0;
    for (const mysql of [undefined, ready ? sql`select 1` : undefined]) {
      await expect(executePlan(db, 'mysql', plan((schema) => schema.raw({ sqlite: sql`select 1`, mysql })))).rejects.toThrow(/^\[marmeon:D18\] The plan has a schema\.raw\(\) step \(step 1 of its plan\) with a statement for sqlite and none for MySQL/);
    }
    expect(statements).toEqual([]);
  });

  it('refuses a rename with its indexes before it renames anything', async () => {
    const { db, statements } = recorder();
    await expect(
      executePlan(db, 'mysql', plan((schema) => {
        schema.create('first', (table) => table.id());
        schema.rename('first', 'second', { indexes: true });
      })),
    ).rejects.toThrow('[marmeon:D29] Renaming a table with its indexes does not run on MySQL yet.');
    expect(statements).toEqual([]);
  });

  it('stops a statement in a data step that would commit the transaction, before it is sent', async () => {
    const guarded = (text: string) => {
      const { db, statements } = recorder();
      return executePlan(db, 'mysql', plan((schema) => schema.data((on) => sql.raw(text).execute(on as never)))).then(
        () => 'ran',
        (error: Error) => (statements.length === 0 ? error.message.slice(0, 14) : 'sent'),
      );
    };
    for (const text of ['# note\ncreate table x (id int)', '/*! create table x (id int) */', '/*!99999 \' */ create table x (id int) /*!99999 \' */', 'truncate table x', 'rename table x to y', 'lock tables x write', 'set autocommit = 1', "select 1; alter table x add y int", 'begin', 'flush tables', 'create/**/table x (id int)', 'check table x', "set password for 'marmeon_nobody'@'%' = 'x'", "set password = 'x'", 'rollback to savepoint a', 'set autocommit = 0', "set@@autocommit=0", "set@@session.autocommit=0", "set@@local.autocommit=0", "set @@`autocommit` = 0", "set @@session.`autocommit` = 0", "set @@session .autocommit = 0", "set @@session. autocommit = 0", "set @@session . autocommit = 0", "set @@session./**/autocommit = 0", "set @@session/**/.autocommit = 0", "set @@session.\nautocommit = 0", "set @@session .autocommit = 0 /*! */", "set default role none to 'x'@'%'", "set default role all to 'x'@'%'", "set @@session.password = 1", 'set session autocommit = 0', 'set @@autocommit = 0', 'set @@session.autocommit = 0', 'set global autocommit=1', 'set @a = 1, autocommit = 0', 'set password to random', 'commit', 'commit and chain', 'commit work', 'rollback', 'rollback work and no chain', '/*! set password = 1 */']) {
      expect(await guarded(text), text).toBe('[marmeon:D4] C');
    }
    for (const text of ['select 1', 'set @password = 1', 'set @autocommit = 0', 'set @x = (select autocommit from settings limit 1)', 'set @x = (select password from settings limit 1)', 'select autocommit, password from settings', 'set transaction isolation level read committed', 'set role none', 'set role default', 'set @autocommit = 1', 'set @x = (select autocommit from settings)', 'set @x = (select password from users)', "update x set a = 'create table y'", 'delete from x -- drop table x', '# drop\nselect 1', 'insert into x values (1)']) expect(await guarded(text), text).toBe('ran');
  });

  it('keeps a literal default on a text column that a key made a varchar', async () => {
    const { db, statements } = recorder();
    await executePlan(db, 'mysql', plan((schema) => schema.create('keyed', (table) => void table.text('slug').unique().default('x'))));
    expect(statements[0]).toContain("`slug` varchar(768) default 'x' not null");
  });

  it('refuses a plan with a raw step that has no statement for MySQL before it sends anything, and runs the others', async () => {
    const { db, statements } = recorder();
    const refused = plan((schema) => {
      schema.create('first', (table) => table.id());
      schema.raw({ sqlite: sql`select 1`, pgsql: sql`select 1` });
    });
    await expect(executePlan(db, 'mysql', refused)).rejects.toThrow(/^\[marmeon:D18\] The plan has a schema.raw\(\) step \(step 2 of its plan\) with a statement for sqlite and pgsql and none for MySQL/);
    expect(statements).toEqual([]);
    await executePlan(
      db,
      'mysql',
      plan((schema) => {
        schema.raw({ sqlite: sql`select 1`, mysql: null });
        schema.raw({ mysql: sql`select 2` });
        schema.raw(sql`select 3`);
      }),
    );
    expect(statements).toEqual(['select 2', 'select 3']);
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

  it.each(['sqlite', 'pgsql', 'mysql'] as const)('writes no type that arrives as text into the statement, on %s', (driver) => {
    for (const type of ['10), "is_admin" boolean default (1', '-1', '2.5']) expect(ddl((t) => void t.string('name', type as never), driver)).toThrow(/invalid column data type/);
  });

  it('writes the three type names of MySQL that Kysely does not list', () => {
    expect(ddl((t) => void t.text('c'), 'mysql')()).toBe('create table `t` (`c` longtext not null)');
    expect(ddl((t) => void t.binary('c'), 'mysql')()).toBe('create table `t` (`c` longblob not null)');
    expect(ddl((t) => void t.float('c'), 'mysql')()).toBe('create table `t` (`c` double not null)');
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
