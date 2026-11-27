import { AliasNode, DummyDriver, expressionBuilder, FunctionNode, IdentifierNode, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, RawNode, SelectionNode, SelectQueryNode, sql, TableNode } from 'kysely';
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
import { noSchemaChanges, rawText } from './migrator-connection.ts';
import { mysqlCommits } from './schema/mysql-words.ts';
import { executePlan, planOf } from './schema/plan.ts';
import { Schema } from './schema/schema.ts';
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
    ['a relation inside a query', 'A relation inside a query (with())', relation(driver)],
  ])('refuses %s', async (_name, feature, call) => {
    await refuses(call, feature);
  });

  // The record of migrations, the columns, the defaults, the lock, the catalog, emptying the database and renaming a table with its indexes run on MySQL (below, and in mysql-catalog.test.ts); a driver nobody knows still has no form of them.
  if (driver !== mysql) {
    it.each([
      ['renaming a table with its indexes', 'Renaming a table with its indexes', () => executePlan(dummy, driver, [{ kind: 'rename', from: 'a', to: 'b', indexes: true }])],
      ['a uuidv7 default', 'A uuidv7 default', () => ddl((t) => void t.uuid('c').useUuidv7(), driver)()],
      ['a current-time default', 'A current-time default', () => ddl((t) => void t.timestamp('c').useCurrent(), driver)()],
      ['the migration lock', 'The migration lock', () => MigrationLock.acquire(dummy, { driver })],
      ['emptying the database', 'Emptying the database', () => dropAllTables(noTables, driver)],
      ['reading the tables for the migrator', 'Reading the tables of the database', () => migrator(driver).undescribedColumns('default', [])],
      ['the record of migrations', 'The record of migrations', () => createMigrationsTable(dummy, driver)],
      ['reading the columns of the database', 'Reading the columns of the database', () => tableColumns(catalog, driver)],
      ['reading the columns, as introspect starts', 'Reading the columns of the database', () => introspect(catalog, driver)],
    ])('refuses %s', async (_name, feature, call) => {
      await refuses(call, feature);
    });
  }
});

describe('what runs on MySQL', () => {
  it('creates the table of interruptions, then the record of migrations, in the binary collation, with an auto-increment key', async () => {
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
      'create table if not exists `migration_interruption` (`name` varchar(255) primary key, `module` varchar(255) not null, `connection_name` varchar(255) not null, `direction` varchar(4) not null, `batch` integer not null, `started_at` varchar(32) not null, `owner` varchar(255) not null) default character set utf8mb4 collate utf8mb4_0900_bin',
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

  it('reads the names of a raw statement in a data step as names, and keeps a bound value out of it', async () => {
    const outcome = (driver: 'mysql' | 'sqlite' | 'pgsql', statement: ReturnType<typeof sql>) => {
      const { db, statements } = recorder();
      return executePlan(db, driver, plan((schema) => schema.data((on) => statement.execute(on as never)))).then(
        () => 'ran',
        (error: Error) => (statements.length === 0 ? error.message.slice(0, 14) : 'sent'),
      );
    };
    const refused = '[marmeon:D4] C';
    expect(await outcome('mysql', sql`set ${sql.id('autocommit')} = 0`)).toBe(refused);
    expect(await outcome('mysql', sql`set ${sql.ref('@@session.autocommit')} = 0`)).toBe(refused);
    expect(await outcome('mysql', sql`set ${sql.table('autocommit')} = 0`)).toBe(refused);
    expect(await outcome('mysql', sql`${sql.raw('commit')}`)).toBe(refused);
    expect(await outcome('mysql', sql`set ${sql.join([sql.id('autocommit')])} = 0`)).toBe(refused);
    expect(await outcome('mysql', sql`${recorder().db.schema.dropTable('t')}`)).toBe(refused);
    expect(await outcome('sqlite', sql`create table ${sql.id('x')} (id int)`)).toBe(refused);
    expect(await outcome('pgsql', sql`${sql.raw('create')} table ${sql.table('x')} (id int)`)).toBe(refused);
    // A value is data, whatever it says.
    expect(await outcome('mysql', sql`update t set a = ${'autocommit'}`)).toBe('ran');
    expect(await outcome('mysql', sql`update t set a = ${sql.lit('commit')}`)).toBe('ran');
    expect(await outcome('mysql', sql`select ${sql.id('autocommit')} from settings`)).toBe('ran');
    // A part that is no plain name: where its text stands in the statement is not known, so every word counts.
    // `@x` is a user variable, `@@x` a system variable: a name written after the `@` makes the same difference.
    expect(await outcome('mysql', sql`set @${sql.id('autocommit')} = 0`)).toBe('ran');
    expect(await outcome('mysql', sql`set @@${sql.id('autocommit')} = 0`)).toBe(refused);
    expect(await outcome('mysql', sql`${expressionBuilder<any>()(sql.raw('set autocommit'), '=', sql.lit(0))}`)).toBe(refused);
    expect(await outcome('sqlite', sql`${expressionBuilder<any>()(sql.raw('drop table x'), '=', sql.lit(0))}`)).toBe(refused);
    expect(await outcome('mysql', sql`insert into t ${recorder().db.selectFrom('notes').select('id')}`)).toBe('ran');
    // A fragment behind an empty parameter is part of the statement.
    const hidden = RawNode.create(['', '', 'commit'], [RawNode.createWithSql('')]);
    expect(rawText(hidden, 'mysql')).toContain('commit');
    expect(mysqlCommits(rawText(hidden, 'mysql'))).toBe(true);
    // Raw DML on a table of the migrator, which the builder's guard refuses too.
    for (const driver of ['mysql', 'sqlite', 'pgsql'] as const) {
      expect(await outcome(driver, sql`update ${sql.table('migrations')} set batch = 0`), driver).toBe(refused);
      expect(await outcome(driver, sql`update ${sql.table('migrations').as('m')} set batch = 0`), driver).toBe(refused);
    }
    // A name that holds punctuation brings none of it into the text: no false statement, no comment, no way out of a quote.
    expect(await outcome('mysql', sql`select ${sql.id('x;commit')} from settings`)).toBe('ran');
    expect(await outcome('mysql', sql`select ${sql.id('a`; commit; --')} from settings`)).toBe('ran');
    expect(await outcome('mysql', sql`set ${sql.id("x'; autocommit")} = 0`)).toBe(refused);
    expect(await outcome('mysql', sql`${sql.id('--')} set ${sql.id('autocommit')} = 0`)).toBe(refused);
  });

  describe('raw SQL in a write of a data step, and values that only look like SQL', () => {
    const inStep = (driver: 'mysql' | 'sqlite' | 'pgsql', work: (on: Kysely<any>) => PromiseLike<unknown>) => {
      const { db, statements } = recorder();
      return executePlan(db, driver, plan((schema) => schema.data((on) => work(on as never)))).then(
        () => 'ran',
        (error: Error) => (statements.length === 0 ? error.message : 'sent'),
      );
    };
    const nested = recorder().db;

    it.each(['mysql', 'sqlite', 'pgsql'] as const)('refuses raw SQL that names a table of the migrator inside a write, on %s', async (driver) => {
      for (const work of [
        (on: Kysely<any>) => on.updateTable(sql`migrations`.as('m')).set({ batch: 0 }).execute(),
        (on: Kysely<any>) => on.deleteFrom(sql`migrations`.as('m')).execute(),
        (on: Kysely<any>) => on.insertInto('notes').values({ a: sql`(select max(batch) from migrations)` }).execute(),
      ]) {
        expect(await inStep(driver, work)).toMatch(/^\[marmeon:D4\] Cannot read or write "migrations" in raw SQL of a schema\.data\(\) step/);
      }
    });

    it.each(['mysql', 'sqlite', 'pgsql'] as const)('reads the raw SQL of every statement of a data step, a read with a write CTE too, on %s', async (driver) => {
      const refused = /^\[marmeon:D4\] Cannot read or write "migrations" in raw SQL/;
      expect(await inStep(driver, (on) => on.with('gone', () => sql`(delete from migrations returning id)`).selectFrom('gone').selectAll().execute())).toMatch(refused);
      expect(await inStep(driver, (on) => on.selectFrom('notes').select(sql`(select max(batch) from migrations)`.as('b')).execute())).toMatch(refused);
    });

    it.each(['mysql', 'sqlite', 'pgsql'] as const)('reads a raw node once, with its whole text, on %s', async (driver) => {
      // A word in a comment of the outer text is a comment, whatever part it came from.
      expect(await inStep(driver, (on) => sql`select 1 /* ${sql.raw('migrations')} */`.execute(on)), driver).toBe('ran');
      expect(await inStep(driver, (on) => on.selectFrom('notes').select(sql`1 /* ${sql.raw('migrations')} */`.as('x')).execute()), driver).toBe('ran');
      // A string literal of the outer text is a string.
      // (SQLite reads a string as a name where a name is expected, so its strings count: see the next test.)
      if (driver === 'sqlite') expect(await inStep(driver, (on) => sql`select 'migrations' as a`.execute(on))).toMatch(/^\[marmeon:D4\].*on SQLite the words of a string too/);
      else expect(await inStep(driver, (on) => sql`select 'migrations' as a`.execute(on)), driver).toBe('ran');
      // Outside a comment or a string the word counts, from a fragment, a name or a nested query.
      expect(await inStep(driver, (on) => sql`select 1 ${sql.raw('migrations')}`.execute(on)), driver).toMatch(/^\[marmeon:D4\]/);
      expect(await inStep(driver, (on) => sql`select 1 ${sql.id('migrations')}`.execute(on)), driver).toMatch(/^\[marmeon:D4\]/);
      expect(await inStep(driver, (on) => sql`select 1 ${nested.selectFrom('migrations').selectAll()}`.execute(on)), driver).toMatch(/^\[marmeon:D4\]/);
      expect(await inStep(driver, (on) => sql`select 1 ${nested.schema.dropTable('t')}`.execute(on)), driver).toMatch(/^\[marmeon:D4\]/);
    });

    it('reads a literal written into the statement as the text it is, in a data step', async () => {
      const refused = /^\[marmeon:D4\]/;
      expect(await inStep('sqlite', (on) => sql`delete from ${sql.lit('migrations')}`.execute(on))).toMatch(refused);
      expect(await inStep('sqlite', (on) => sql`delete from t where a = ${sql.lit("it's")} and b = ${sql.lit(3)}`.execute(on))).toBe('ran');
      for (const driver of ['pgsql', 'mysql'] as const) expect(await inStep(driver, (on) => sql`delete from ${sql.lit('migrations')}`.execute(on)), driver).toBe('ran');
      // In a nested query the literal is written as it is sent, too: a name on SQLite, a string elsewhere.
      const query = (on: Kysely<any>) => sql`select 1 ${nested.selectFrom('t').selectAll().where('a', '=', sql.lit('migrations'))}`.execute(on);
      expect(await inStep('sqlite', query)).toMatch(refused);
      for (const driver of ['pgsql', 'mysql'] as const) expect(await inStep(driver, query), driver).toBe('ran');
    });

    it('writes a literal as the compiler of the driver does, so a backslash cannot hide a name', async () => {
      // MySQL sends 'x\\' (the string ends); a text with a single backslash would keep the scanner inside the string up to the next quote, and hide the name between.
      const form = (on: Kysely<any>) => sql`select ${sql.lit('x\\')}, migrations, 'y' from t`.execute(on);
      for (const driver of ['mysql', 'sqlite', 'pgsql'] as const) expect(await inStep(driver, form), driver).toMatch(/^\[marmeon:D4\]/);
      expect(rawText(sql`${sql.lit('x\\')}`.toOperationNode() as RawNode, 'mysql')).toBe("'x\\\\'");
      expect(rawText(sql`${sql.lit('x\\')}`.toOperationNode() as RawNode, 'sqlite')).toBe("'x\\'");
      expect(() => new Schema().raw({ mysql: sql`select ${sql.lit('x\\')}, migrations, 'y' from t` })).toThrow(/\[marmeon:D4\]/);
    });

    it('adds no space around a name, so the text keeps the comments and the dollar quotes that are sent', async () => {
      const refused = /^\[marmeon:D4\]/;
      // MySQL sends 1--`a`: a subtraction, so the statement after it runs. On the other drivers `--` is a comment in either text.
      for (const driver of ['mysql', 'sqlite', 'pgsql'] as const) {
        const form = (on: Kysely<any>) => sql`with x as (select 1--${sql.id('a')} from notes) delete from migrations`.execute(on);
        // MySQL runs what follows `1--` (`1 - -`a``), so the statement is refused for naming `migrations`; on the others the rest of the line is a
        // comment in the text that is sent too, and runs nothing.
        if (driver === 'mysql') expect(await inStep(driver, form), driver).toMatch(refused);
        else expect(await inStep(driver, form), driver).toBe('ran');
      }
      expect(rawText(sql`select 1--${sql.id('a')} from t`.toOperationNode() as RawNode, 'mysql')).toBe('select 1--`a` from t');
      // A name that holds `$x$` opens no dollar quote on Postgres.
      expect(await inStep('pgsql', (on) => sql`select ${sql.id('$x$')} from migrations`.execute(on))).toMatch(refused);
      expect(await inStep('pgsql', (on) => sql`select ${sql.id('$x$')}, 'a' from notes where b = $$ ' $$ and c in (select 1 from migrations)`.execute(on))).toMatch(refused);
      // Literals and raw fragments are written as they are: no space around them.
      expect(rawText(sql`a${sql.lit('b')}c${sql.raw('d')}e`.toOperationNode() as RawNode, 'sqlite')).toBe("a'b'cde");
    });

    it.each(['mysql', 'sqlite', 'pgsql'] as const)('finds a write to the migrator wherever the builder puts it, and raw SQL appended to a query, on %s', async (driver) => {
      const refused = /^\[marmeon:D4\]/;
      // A write in a CTE, a subquery or an insert from a select.
      expect(await inStep(driver, (on) => on.with('gone', (d) => d.deleteFrom('migrations')).selectFrom('gone').selectAll().execute())).toMatch(/^\[marmeon:D4\] Cannot write to "migrations"/);
      expect(await inStep(driver, (on) => on.with('x', (d) => d.insertInto('migrations').values({ name: 'a', module: 'b', batch: 1, checksum: null })).selectFrom('x').selectAll().execute())).toMatch(refused);
      expect(await inStep(driver, (on) => on.insertInto('notes').columns(['a']).expression((eb) => eb.selectFrom('migrations').select('name')).execute())).toMatch(refused);
      // Raw SQL anywhere in a query reads the whole text that is sent.
      expect(await inStep(driver, (on) => on.selectFrom('notes').select(sql<number>`(select count(*) from migrations)`.as('n')).execute())).toMatch(refused);
      // Raw SQL put before or after a builder query (`modifyFront` stands after the `select` keyword: it takes a statement of its own after a `;`).
      expect(await inStep(driver, (on) => on.selectNoFrom(sql.lit(1).as('x')).modifyEnd(sql.raw('; drop table notes')).execute())).toMatch(refused);
      expect(await inStep(driver, (on) => on.selectNoFrom(sql.lit(1).as('x')).modifyFront(sql.raw('1; drop table notes; select')).execute())).toMatch(refused);
      // A `commit` ends the step's transaction on MySQL; on the others only a change of the schema is looked for.
      if (driver === 'mysql') expect(await inStep(driver, (on) => on.selectFrom('notes').select('id').modifyEnd(sql.raw('; commit')).execute())).toMatch(refused);
      // A builder read of the migrator's table, and a write to an app table with a CTE, are allowed.
      expect(await inStep(driver, (on) => on.selectFrom('migrations').selectAll().execute()), driver).toBe('ran');
      expect(await inStep(driver, (on) => on.with('src', (d) => d.selectFrom('notes').select('id')).insertInto('t').values({ a: 1 }).execute()), driver).toBe('ran');
      expect(await inStep(driver, (on) => on.selectNoFrom(sql.lit(1).as('x')).modifyEnd(sql.raw('for update')).execute()), driver).toBe('ran');
    });

    it('does not let a comment after a string with a backslash hide a statement that changes the schema, on Postgres', async () => {
      const refused = /^\[marmeon:D4\]/;
      expect(await inStep('pgsql', (on) => sql`select ${sql.lit('C:\\temp')}; /* cleanup */ drop table if exists zz_nothing`.execute(on))).toMatch(refused);
      expect(await inStep('pgsql', (on) => sql.raw("select 'a\\d+';\n-- cleanup\ndrop table zz_nothing").execute(on))).toMatch(refused);
      expect(await inStep('pgsql', (on) => sql`select ${sql.lit('C:\\temp')}; /* nothing */ select 1`.execute(on))).toBe('ran');
    });

    it('leaves a dollar quote whole when it looks for a statement that changes the schema', async () => {
      expect(await inStep('pgsql', (on) => sql`insert into notes(body) values ($$example; drop table notes$$)`.execute(on))).toBe('ran');
      expect(await inStep('pgsql', (on) => sql`do $$ begin drop table t; end $$`.execute(on))).toMatch(/^\[marmeon:D4\]/);
      expect(await inStep('pgsql', (on) => sql`create function f() returns int as $$ select 1; $$ language sql`.execute(on))).toMatch(/^\[marmeon:D4\]/);
    });

    it('says what raw SQL may not do, and reads a statement whose parts are not plain with every word', async () => {
      const read = await inStep('pgsql', (on) => sql`select * from migrations`.execute(on));
      expect(read).toBe(
        '[marmeon:D4] Cannot read or write "migrations" in raw SQL of a schema.data() step: the table belongs to the migrator, and changing it by hand would make it lose track of which migrations ran. Raw SQL is read by its words, and every word outside a string counts; use the query builder to read it. See docs/migrations.md#how-the-migrator-keeps-track.',
      );
      // The builder reads the table, which the guard allows.
      expect(await inStep('sqlite', (on) => on.selectFrom('migrations').selectAll().execute())).toBe('ran');
    });

    it('refuses an expression that commits or changes the schema, on every driver, as the text it compiles to', async () => {
      for (const driver of ['mysql', 'sqlite', 'pgsql'] as const) {
        const text = await inStep(driver, (on) => sql`${expressionBuilder<any>()(sql.raw(driver === 'mysql' ? 'commit' : 'drop table x'), '=', sql.lit(0))}`.execute(on));
        expect(text, driver).toMatch(/^\[marmeon:D4\]/);
      }
    });

    it('reads the compiled text, in which a name is quoted and escaped as it is sent: a quote in a name hides nothing', async () => {
      const refused = /^\[marmeon:D4\]/;
      const form = (on: Kysely<any>) => sql`select '${sql.id("'; delete from migrations; -- ")}'`.execute(on);
      for (const driver of ['pgsql', 'sqlite', 'mysql'] as const) expect(await inStep(driver, form), driver).toMatch(refused);
      expect(rawText(sql`select '${sql.id("'; x")}'`.toOperationNode() as RawNode, 'pgsql')).toBe(`select '"'; x"'`);
    });

    it('does not read a bound value as SQL, and still finds a name in the same places', async () => {
      for (const driver of ['mysql', 'sqlite', 'pgsql'] as const) {
        // A value that looks like a node, and values that say `migrations` or `drop`: data.
        expect(await inStep(driver, (on) => sql`insert into notes ${nested.insertInto('notes').values({ body: 'migrations' })}`.execute(on)), driver).toBe('ran');
        expect(await inStep(driver, (on) => sql`select 1 ${nested.selectFrom('notes').selectAll().where('body', 'in', ['migrations', 'drop'])}`.execute(on)), driver).toBe('ran');
        expect(await inStep(driver, (on) => sql`insert into notes values (${{ kind: 'DropTableNode' }})`.execute(on)), driver).toBe('ran');
        expect(await inStep(driver, (on) => sql`select 1 ${nested.selectFrom('migrations').selectAll()}`.execute(on)), driver).toMatch(/^\[marmeon:D4\]/);
        expect(await inStep(driver, (on) => sql`select 1 ${nested.selectFrom('notes').selectAll().where('body', 'in', [sql`migrations`])}`.execute(on)), driver).toMatch(/^\[marmeon:D4\]/);
        expect(await inStep(driver, (on) => sql`${nested.schema.dropTable('t')}`.execute(on)), driver).toMatch(/^\[marmeon:D4\]/);
      }
    });
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
