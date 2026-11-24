import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application } from '@marmeon/core';
import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql, type RawBuilder } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { drivers, freshConnections, type TestDriver } from '../__fixtures__/databases.ts';
import type { Connections } from '../connections.ts';
import { Migrator } from '../index.ts';
import { runMigration } from '../migrations/run.ts';
import type { Blueprint } from './blueprint.ts';
import { assertNamesFitPgsql, pgsqlNames, planOf } from './plan.ts';
import { Schema, SchemaError } from './schema.ts';

describe.each(drivers)('the plan of a migration on %s', (driver: TestDriver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeEach(async () => ({ connections, close } = await freshConnections(driver)));
  afterEach(() => close());

  const tables = async () => (await connections.get<any>().introspection.getTables()).map((table) => table.name);

  it.runIf(driver === 'pgsql')('runs a schema change, a data change and the schema change after it in the order they were added', async () => {
    await runMigration(connections, {
      up: (schema) => {
        schema.create('notes', (table) => {
          table.id();
          table.string('title');
        });
        schema.data(async (db) => {
          await db.insertInto('notes').values([{ title: 'a' }, { title: 'b' }]).execute();
        });
        schema.alter('notes', (table) => table.string('slug').nullable());
        schema.data(async (db) => {
          await sql`update notes set slug = title`.execute(db);
        });
        schema.alter('notes', (table) => table.notNull('slug'));
      },
    });
    const db = connections.get<any>();
    expect(await db.selectFrom('notes').select(['title', 'slug']).orderBy('id').execute()).toEqual([
      { title: 'a', slug: 'a' },
      { title: 'b', slug: 'b' },
    ]);
    await expect(db.insertInto('notes').values({ title: 'c', slug: null }).execute()).rejects.toThrow(/not-null|null value/i);
  });

  it('refuses to make a column NOT NULL on SQLite before any step runs, and does it on Postgres', async () => {
    await runMigration(connections, { up: (schema) => schema.create('notes', (table) => { table.id(); table.string('slug').nullable(); }) });
    const change = runMigration(connections, {
      up: (schema) => {
        schema.create('other', (table) => table.id());
        schema.alter('notes', (table) => table.notNull('slug'));
      },
    });
    if (driver === 'sqlite') {
      await expect(change).rejects.toThrow(/D18.*cannot make the column "slug" NOT NULL on SQLite.*docs\/migrations\.md#changing-the-data/s);
      expect(await tables()).not.toContain('other');
    } else {
      await change;
      const db = connections.get<any>();
      await expect(db.insertInto('notes').values({ slug: null }).execute()).rejects.toThrow(/not-null|null value/i);
    }
  });

  it.runIf(driver === 'sqlite')('refuses nullable() on SQLite with D18', async () => {
    await runMigration(connections, { up: (schema) => schema.create('notes', (table) => { table.id(); table.string('slug'); }) });
    await expect(runMigration(connections, { up: (schema) => schema.alter('notes', (table) => table.nullable('slug')) })).rejects.toThrow(/D18.*nullable on SQLite/s);
  });

  it.runIf(driver === 'pgsql')('runs rename, new column, nullability change and drop in that order', async () => {
    await runMigration(connections, { up: (schema) => schema.create('notes', (table) => { table.id(); table.string('a').nullable(); table.string('z').nullable(); }) });
    const statements: string[] = [];
    connections.onQuery((query) => statements.push(query.sql));
    await runMigration(connections, {
      up: (schema) =>
        schema.alter('notes', (table) => {
          table.dropColumn('z');
          table.notNull('b');
          table.string('c').nullable();
          table.renameColumn('a', 'b');
        }),
    });
    expect(statements.filter((text) => /^alter table/i.test(text))).toEqual([
      'alter table "notes" rename column "a" to "b"',
      'alter table "notes" add column "c" varchar(255)',
      'alter table "notes" alter column "b" set not null',
      'alter table "notes" drop column "z"',
    ]);
  });

  it.runIf(driver === 'pgsql')('lets a column hold NULL again with nullable(), and writes one ALTER per change', async () => {
    await runMigration(connections, { up: (schema) => schema.create('notes', (table) => { table.id(); table.string('slug'); }) });
    const statements: string[] = [];
    connections.onQuery((query) => statements.push(query.sql));
    await runMigration(connections, { up: (schema) => schema.alter('notes', (table) => table.nullable('slug')) });
    expect(statements.filter((text) => /^alter table/i.test(text))).toEqual(['alter table "notes" alter column "slug" drop not null']);
    await connections.get<any>().insertInto('notes').values({ slug: null }).execute();
  });

  it.runIf(driver === 'pgsql')('rolls the whole migration back when a row still holds NULL', async () => {
    await runMigration(connections, {
      up: (schema) => {
        schema.create('notes', (table) => { table.id(); table.string('slug').nullable(); });
        schema.data(async (db) => { await db.insertInto('notes').values({ slug: null }).execute(); });
      },
    });
    await expect(
      runMigration(connections, {
        up: (schema) => {
          schema.create('other', (table) => table.id());
          schema.alter('notes', (table) => table.notNull('slug'));
        },
      }),
    ).rejects.toThrow(/null/i);
    expect(await tables()).not.toContain('other');
    await connections.get<any>().insertInto('notes').values({ slug: null }).execute();
  });

  it('refuses notNull() when a table is created, and a column named twice', () => {
    expect(() => planOf({ up: (schema) => schema.create('notes', (table) => { table.id(); table.notNull('id'); }) }, 'up')).toThrow(/only work when changing a table/);
    expect(() => planOf({ up: (schema) => schema.alter('notes', (table) => { table.notNull('slug'); table.nullable('slug'); }) }, 'up')).toThrow(/twice/);
  });

  it('hands the data step the driver', async () => {
    let seen: string | undefined;
    await runMigration(connections, {
      up: (schema) =>
        schema.data(async (_db, context) => {
          seen = context.driver;
        }),
    });
    expect(seen).toBe(driver);
  });

  it('runs the statement of the connection\'s driver only, and nothing for a driver without one', async () => {
    await runMigration(connections, {
      up: (schema) => {
        schema.raw({ sqlite: sql`create table from_sqlite (id integer)` });
        schema.raw({ pgsql: sql`create table from_pgsql (id integer)` });
        schema.raw(sql`create table from_both (id integer)`);
      },
    });
    expect((await tables()).filter((name) => name.startsWith('from_')).sort()).toEqual(driver === 'sqlite' ? ['from_both', 'from_sqlite'] : ['from_both', 'from_pgsql']);
  });

  it('rolls back the schema changes before a data step that fails', async () => {
    await expect(
      runMigration(connections, {
        up: (schema) => {
          schema.create('half', (table) => table.id());
          schema.data(async () => {
            throw new Error('the backfill failed');
          });
        },
      }),
    ).rejects.toThrow('the backfill failed');
    expect(await tables()).not.toContain('half');
  });

  it('closes the plan when up() returns: a later call from a data step throws and the transaction is rolled back', async () => {
    await expect(
      runMigration(connections, {
        up: (schema) => {
          schema.create('first', (table) => table.id());
          schema.data(async () => {
            schema.create('late', (table) => table.id());
          });
        },
      }),
    ).rejects.toThrow(/plan of this migration is closed/);
    expect(await tables()).not.toContain('first');
    expect(await tables()).not.toContain('late');
  });

  it('refuses a data step added after the plan is closed', () => {
    let kept: Schema | undefined;
    planOf({ up: (schema) => void (kept = schema) }, 'up');
    expect(() => kept!.data(async () => {})).toThrow(/closed/);
    expect(() => kept!.raw(sql`select 1`)).toThrow(/closed/);
  });

  it('refuses an up() that returns a promise with D14, and runs nothing of it', async () => {
    const asynchronous = {
      // What a migration written for the schema that ran every call looks like.
      up: async (schema: Schema) => {
        schema.create('eager', (table) => table.id());
        await Promise.resolve();
        schema.create('late', (table) => table.id());
      },
    };
    await expect(runMigration(connections, asynchronous)).rejects.toThrow(/^\[marmeon:D14\] .*up\(\) returned a promise.*docs\/migrations\.md#changing-the-data/s);
    expect(await tables()).not.toContain('eager');
    expect(await tables()).not.toContain('late');
  });

  it('names the file of an async migration the migrator refuses, and leaves the record empty', async () => {
    const dir = mkdtempSync(join(tempDir('marmeon-plan-'), 'm-'));
    writeFileSync(join(dir, '2026_01_01_000000_async_one.ts'), "export default { up: async (schema: any) => { schema.create('eager', (table: any) => table.id()); } };");
    const migrator = new Migrator({ modules: [{ name: 'x', migrations: dir }], root: '/' } as unknown as Application, connections);
    await expect(migrator.migrate()).rejects.toThrow(/^\[marmeon:D14\] Migration 2026_01_01_000000_async_one \(module "x"\): up\(\) returned a promise/);
    expect(await tables()).not.toContain('eager');
    expect((await migrator.status()).map((file) => file.batch)).toEqual([undefined]);
  });

  it('makes the plans of every pending migration before it runs the first', async () => {
    const dir = mkdtempSync(join(tempDir('marmeon-plan-'), 'm-'));
    for (const [name, up] of [
      ['2026_01_01_000000_first', "(schema: any) => schema.create('one', (table: any) => table.id())"],
      ['2026_01_02_000000_second', "(schema: any) => schema.create('two', (table: any) => table.id())"],
      ['2026_01_03_000000_third', "async (schema: any) => { schema.create('three', (table: any) => table.id()); }"],
    ] as const) {
      writeFileSync(join(dir, `${name}.ts`), `export default { up: ${up} };`);
    }
    const migrator = new Migrator({ modules: [{ name: 'x', migrations: dir }], root: '/' } as unknown as Application, connections);
    await expect(migrator.migrate()).rejects.toThrow(/\[marmeon:D14\] Migration 2026_01_03_000000_third/);
    expect(await tables()).not.toContain('one');
    expect((await migrator.status()).map((file) => file.batch)).toEqual([undefined, undefined, undefined]);
  });

  it('refuses the same for down()', async () => {
    await runMigration(connections, { up: (schema) => schema.create('kept', (table) => table.id()) });
    const migration = { up: () => {}, down: async (schema: Schema) => schema.drop('kept') };
    await expect(runMigration(connections, migration, { direction: 'down' })).rejects.toThrow(/\[marmeon:D14\].*down\(\) returned a promise/s);
    expect(await tables()).toContain('kept');
  });

  describe('the description of a table is closed when its callback returns', () => {
    it('refuses a callback that returns a promise with D14', () => {
      expect(() =>
        planOf(
          {
            up: (schema) =>
              schema.create('late_columns', async (table) => {
                table.id();
                await Promise.resolve();
                table.string('late');
              }),
          },
          'up',
        ),
      ).toThrow(/\[marmeon:D14\].*late_columns.*promise/s);
    });

    it('refuses a column, an index and a modifier added later from a data step, and rolls back', async () => {
      let blueprint: Blueprint | undefined;
      let column: { nullable(): unknown } | undefined;
      const later: Array<() => unknown> = [() => blueprint!.string('injected'), () => blueprint!.index('id'), () => column!.nullable(), () => blueprint!.notNull('name')];
      for (const attempt of later) {
        await expect(
          runMigration(connections, {
            up: (schema) => {
              schema.create('sealed', (table) => {
                blueprint = table;
                table.id();
                column = table.string('name');
              });
              schema.data(async () => void attempt());
            },
          }),
       ).rejects.toThrow(/plan of this migration is closed/ );
        expect(await tables()).not.toContain('sealed');
      }
    });
  });

  describe('a data step may not change the schema', () => {
    const inData = (run: (db: any) => Promise<unknown>) => runMigration(connections, { up: (schema) => schema.data(async (db) => void (await run(db))) });

    it('refuses the DDL of the query builder with D4', async () => {
      await expect(inData((db) => db.schema.createTable('sneaky').addColumn('id', 'integer').execute())).rejects.toThrow(/^\[marmeon:D4\]/);
      await expect(inData((db) => db.schema.createIndex('sneaky_index').on('migrations').column('name').execute())).rejects.toThrow(/\[marmeon:D4\]/);
      expect(await tables()).not.toContain('sneaky');
    });

    it('refuses raw DDL with D4, and allows raw SQL that only mentions the words', async () => {
      await expect(inData((db) => sql`alter table notes add column x integer`.execute(db))).rejects.toThrow(/\[marmeon:D4\]/);
      await expect(inData((db) => sql`select 1; drop table notes`.execute(db))).rejects.toThrow(/\[marmeon:D4\]/);
      await expect(inData((db) => sql`select 'create table x' as created`.execute(db))).resolves.toBeUndefined();
    });

    it('refuses DDL inside a nested raw fragment, and a Postgres DO block', async () => {
      await expect(inData((db) => sql`${sql.raw('create table nested (id integer)')}`.execute(db))).rejects.toThrow(/\[marmeon:D4\]/);
      await expect(inData((db) => sql`${sql`${sql.raw('drop table nested')}`}`.execute(db))).rejects.toThrow(/\[marmeon:D4\]/);
      await expect(inData((db) => sql`-- block\n DO ${sql.raw('$' + '$')} begin execute 'create table viado (id int)'; end ${sql.raw('$' + '$')}`.execute(db))).rejects.toThrow(/\[marmeon:D4\]/);
      await expect(inData((db) => sql`select 1; ${sql.raw('do')} ${sql.raw('$' + '$')} begin end ${sql.raw('$' + '$')}`.execute(db))).rejects.toThrow(/\[marmeon:D4\]/);
      expect(await tables()).not.toContain('nested');
    });

    it('refuses a write to the tables of the migrator with D4', async () => {
      await expect(inData((db) => db.insertInto('migrations').values({ name: 'forged', module: 'x', batch: 1 }).execute())).rejects.toThrow(/\[marmeon:D4\]/);
      await expect(inData((db) => db.deleteFrom('migration_lock').execute())).rejects.toThrow(SchemaError);
    });
  });

  describe('is checked as a whole before its first step', () => {
    it('refuses what the driver cannot do, before any step has run', async () => {
      let ran = false;
      const migration = {
        up: (schema: Schema) => {
          schema.create('before_the_refused_one', (table) => table.id());
          schema.data(async () => {
            ran = true;
          });
          if (driver === 'sqlite') {
            // SQLite adds no column whose default is computed.
            schema.alter('before_the_refused_one', (table) => table.uuid('public_id').useUuidv7());
          } else {
            // Postgres would cut the default name of this index at 63 bytes.
            schema.create('another_long_table_name_here', (table) => {
              table.string('first_long_column_name');
              table.string('second_long_column_name');
              table.index(['first_long_column_name', 'second_long_column_name']);
            });
          }
        },
      };
      await expect(runMigration(connections, migration)).rejects.toThrow(driver === 'sqlite' ? /UUIDv7 column/ : /\[marmeon:D5\]/);
      expect(ran).toBe(false);
      expect(await tables()).not.toContain('before_the_refused_one');
    });
  });
});

describe('what up() refuses while it builds the plan', () => {
  it('refuses raw SQL that names a table of the migrator, and allows a literal that only says its name', () => {
    const schema = new Schema();
    for (const name of ['migrations', 'migration_lock']) {
      expect(() => schema.raw(sql`drop table ${sql.raw(name)}`)).toThrow(/\[marmeon:D4\]/);
      expect(() => schema.raw({ pgsql: sql`delete from "${sql.raw(name)}"` })).toThrow(SchemaError);
    }
    expect(() => schema.raw({ pgsql: sql`select 'migrations' as name`, mysql: sql`select 'migrations' as name` })).not.toThrow();
    // SQLite takes a string for a name where a name is expected (`delete from 'migrations'`), so it counts there.
    expect(() => schema.raw({ sqlite: sql`select 'migrations' as name` })).toThrow(/\[marmeon:D4\]/);
    expect(() => schema.raw({ sqlite: sql`delete from 'migrations'` })).toThrow(/\[marmeon:D4\]/);
  });

  it('does not read the comments of a raw statement', () => {
    const schema = new Schema();
    expect(() => schema.raw(sql`-- runs before the migrations that follow
      create index notes_index on notes (id)`)).not.toThrow();
    expect(() => schema.raw(sql`/* migrations */ create index notes_index on notes (id)`)).not.toThrow();
    expect(() => schema.raw(sql`/* note */ drop table migrations`)).toThrow(/names "migrations", a table of the migrator/);
  });

  describe('the mysql statement of schema.raw(), lexed as MySQL does', () => {
    const mysql = (text: string) => () => new Schema().raw({ mysql: sql.raw(text) });

    it.each([
      ['a plain name', 'drop table migrations'],
      ['a name in backticks', 'drop table `migrations`'],
      ['a name in double quotes (ANSI_QUOTES)', 'drop table "migration_lock"'],
      ['an executable comment', '/*! drop table migrations */ select 1'],
      ['an executable comment with a version', 'select 1 /*!50100 , (select count(*) from migrations) */'],
      ['an optimizer hint', 'select /*+ no_index(migrations) */ 1'],
      ['a string that a backslash keeps open until the quote after the escaped one', "select '\\'' ; delete from migrations ; select ''"],
      ['a statement after a # comment with an apostrophe in it', "select 1 # it's\n; delete from migrations\n# don't"],
      ['a statement after a comment with an apostrophe in it', "/* it's */ delete from migrations; /* don't */"],
      ['arithmetic that only looks like a -- comment', 'select 1--1 ; delete from migrations'],
      ['a quote inside an executable comment that the server may skip', "delete /*!99999 ' */ from migrations /*!99999 ' */"],
      ['a quote inside an optimizer hint', "delete /*+ ' */ from migrations /*+ ' */"],
      ['an unterminated string', "select 'abc ; delete from migrations"],
      ['an unterminated comment', 'select 1 /* delete from migrations'],
    ])('refuses %s with D4', (_name, text) => {
      expect(mysql(text)).toThrow(/\[marmeon:D4\].*a table of the migrator/);
    });

    it.each([
      ['the name in a string', "select 'migrations' as name"],
      ['a string with an escaped quote that holds the name', "select 'it\\'s migrations'"],
      ['a string with a doubled quote that holds the name', "select 'it''s migrations'"],
      ['a comment with the name', '/* migrations */ create index notes_index on notes (id)'],
      ['a # comment with the name', 'select 1 # migrations\n, 2'],
      ['a -- comment with the name', 'select 1 -- migrations\n, 2'],
      ['a name with a longer name around it', 'select * from migrations_archive'],
      ['an optimizer hint that names no table of the migrator', "select /*+ no_index(t) */ 'note' from t"],
    ])('allows %s', (_name, text) => {
      expect(mysql(text)).not.toThrow();
    });

    it('says that every word counts when the statement has an executable comment', () => {
      expect(mysql('select /*! 1 */ 2 from migrations')).toThrow(/a statement with a \/\*! or \/\*\+ comment is read with every word/);
      expect(mysql('select 2 from migrations')).toThrow(/^(?!.*every word)/s);
    });

    it('reads a name made with sql.id(), sql.table() or sql.ref() as the name it is', () => {
      for (const name of [sql.id('migrations'), sql.table('migration_lock'), sql.ref('migrations.id')]) {
        expect(() => new Schema().raw({ mysql: sql`select 1 from ${name}` })).toThrow(/\[marmeon:D4\]/);
        expect(() => new Schema().raw({ pgsql: sql`select 1 from ${name}` })).toThrow(/\[marmeon:D4\]/);
      }
      expect(() => new Schema().raw({ mysql: sql`select ${'migrations'}` })).not.toThrow();
      // A name that holds `--` or a quote must not hide what follows it from the guard.
      for (const driver of ['pgsql', 'sqlite'] as const) {
        expect(() => new Schema().raw({ [driver]: sql`with ${sql.id('--')} as (select 1) delete from migrations` })).toThrow(/\[marmeon:D4\]/);
        expect(() => new Schema().raw({ [driver]: sql`select ${sql.id("'")} from ${sql.id('migrations')}, ${sql.id("'")}` })).toThrow(/\[marmeon:D4\]/);
      }
      expect(() => new Schema().raw({ mysql: sql`select ${sql.id('--')} from ${sql.id('migrations')}` })).toThrow(/\[marmeon:D4\]/);
    });

    describe('a part that is no plain name or value still shows its words', () => {
      const db = new Kysely<any>({ dialect: { createAdapter: () => new MysqlAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (d: Kysely<any>) => new MysqlIntrospector(d), createQueryCompiler: () => new MysqlQueryCompiler() } });
      const forms: [string, RawBuilder<unknown>][] = [
        ['sql.table().as()', sql`update ${sql.table('migrations').as('m')} set batch = 0`],
        ['sql.id().as()', sql`update ${sql.id('migrations').as('m')} set batch = 0`],
        ['sql``.as()', sql`update ${sql`migrations`.as('m')} set batch = 0`],
        ['db.dynamic.table().as()', sql`update ${db.dynamic.table('migrations').as('m')} set batch = 0`],
        ['a function over a reference', sql`select ${db.fn.max(sql.ref('migrations.batch'))}`],
        ['a nested select', sql`insert into t ${db.selectFrom('migrations').select('id')}`],
        ['a nested update', sql`${db.updateTable('migrations').set({ batch: 0 })}`],
        ['a fragment behind an empty parameter', sql`${sql``}${sql.raw('select')} * from migrations`],
      ];
      it.each(forms.flatMap(([name, form]) => (['pgsql', 'sqlite', 'mysql'] as const).map((driver) => [name, driver, form] as const)))('refuses %s on %s', (_name, driver, form) => {
        expect(() => new Schema().raw({ [driver]: form })).toThrow(/\[marmeon:D4\]/);
      });

      it('does not read a bound value in a nested query, and still reads its names', () => {
        expect(() => new Schema().raw({ pgsql: sql`insert into t ${db.insertInto('notes').values({ body: 'migrations' })}` })).not.toThrow();
        expect(() => new Schema().raw({ pgsql: sql`select 1 ${db.selectFrom('notes').selectAll().where('body', 'in', ['migrations', 'drop'])}` })).not.toThrow();
        expect(() => new Schema().raw({ pgsql: sql`select ${{ kind: 'DropTableNode' }}` })).not.toThrow();
        expect(() => new Schema().raw({ pgsql: sql`select 1 ${db.selectFrom('notes').selectAll().where('body', 'in', [sql`migrations`])}` })).toThrow(/\[marmeon:D4\]/);
      });

      it('keeps a part that names nothing of the migrator, and the word in a bound value', () => {
        expect(() => new Schema().raw({ mysql: sql`update ${sql.table('notes').as('n')} set a = ${'migrations'}` })).not.toThrow();
        expect(() => new Schema().raw({ pgsql: sql`insert into t ${db.selectFrom('notes').select('id')}` })).not.toThrow();
      });
    });

    it.each([
      ['sqlite', "/* ' */ update migrations set name = 'x'"],
      ['sqlite', "/* it's */ delete from migrations /* don't */"],
      ['sqlite', "-- it's\ndelete from migrations"],
      ['sqlite', 'with "--" as (select 1) delete from migrations'],
      ['sqlite', 'with [it\'s] as (select 1) delete from migrations'],
      ['sqlite', 'with `it\'s` as (select 1) delete from migrations'],
      ['pgsql', "/* it's */ delete from migrations /* don't */"],
      ['pgsql', "with \"it's\" as (select 1) delete from migrations"],
      ['pgsql', "select $$ ' $$; delete from migrations"],
      ['pgsql', "select $t$ ' $t$; delete from migrations; select '"],
      ['pgsql', "select E'\\''; delete from migrations; select '"],
      ['pgsql', 'do $$ begin delete from migrations; end $$'],
      ['pgsql', "/* outer /* inner */ ' */ update migrations set name = 'x'"],
      ['pgsql', "/* /* */ ' */ delete from migrations /* ' */"],
      ['pgsql', '/* /* */ -- */ delete from migrations'],
      ['pgsql', '-- x\rdelete from migrations'],
      ['pgsql', "with x as (select 1 \u00e9$$, ' $$ ') delete from migrations /* ' */"],
      ['pgsql', "select \u00e9E'\\' from migrations /* ' */"],
      ['pgsql', `select $${'t'.repeat(300)}$ ' $${'t'.repeat(300)}$; delete from migrations; select '`],
      ['sqlite', "delete from 'migrations'"],
      ['pgsql', 'delete from U&"migr\\0061tions"'],
      ['pgsql', "delete from U&\"migr!0061tions\" UESCAPE '!'"],
      ['pgsql', "delete from U&\"migr!0061tions\" /* /* */ */ uescape '!'"],
      ['sqlite', "with x as (select $a(')) delete from migrations where $a(') is null"],
      ['sqlite', "with x as (select @a(')) delete from migrations where @a(') is null"],
      ['sqlite', "with x as (select :a(')) delete from migrations where :a(') is null"],
      ['sqlite', "with x as (select #a(')) delete from migrations where #a(') is null"],
    ] as const)('reads the %s statement %s by its own lexing, and finds the table', (driver, text) => {
      expect(() => new Schema().raw({ [driver]: sql.raw(text) })).toThrow(/\[marmeon:D4\]/);
    });

    it.each(['sqlite', 'pgsql', 'mysql'] as const)('reads a name that holds a quote and a statement as the compiled text has it, on %s', (driver) => {
      const form = sql`select '${sql.id("'; delete from migrations; -- ")}'`;
      expect(() => new Schema().raw({ [driver]: form })).toThrow(/\[marmeon:D4\]/);
    });

    it('reads a literal that Kysely writes into the statement as the text it is: a name on SQLite, a string elsewhere', () => {
      const lit = sql`delete from ${sql.lit('migrations')}`;
      expect(() => new Schema().raw({ sqlite: lit })).toThrow(/\[marmeon:D4\]/);
      expect(() => new Schema().raw({ pgsql: lit, mysql: lit })).not.toThrow();
      // A bound value is no part of the text.
      expect(() => new Schema().raw({ sqlite: sql`delete from t where a = ${'migrations'}` })).not.toThrow();
    });

    it.each(['sqlite', 'pgsql'] as const)('allows the name of a migrator table in a comment on %s, and in a string on Postgres only', (driver) => {
      for (const text of ['select 1 /* migrations */', 'select 1 -- migrations\n, 2']) expect(() => new Schema().raw({ [driver]: sql.raw(text) }), text).not.toThrow();
      for (const text of ["select 'migrations'", "select 'it''s migrations'"]) {
        const raw = () => new Schema().raw({ [driver]: sql.raw(text) });
        if (driver === 'pgsql') expect(raw, text).not.toThrow();
        else expect(raw, text).toThrow(/\[marmeon:D4\]/);
      }
    });

    it('still reads the statements for the other drivers as before: a # is no comment there, a backslash no escape', () => {
      expect(() => new Schema().raw({ pgsql: sql`select 1 # migrations` })).toThrow(/\[marmeon:D4\]/);
      expect(() => new Schema().raw({ sqlite: sql`/*! drop table migrations */ select 1` })).not.toThrow();
    });
  });

  it('refuses a table without columns, a drop in create() and a column named twice', () => {
    const schema = new Schema();
    expect(() => schema.create('empty', () => {})).toThrow('Table "empty" needs at least one column.');
    expect(() =>
      schema.create('t', (table) => {
        table.id();
        table.dropColumn('x');
      }),
    ).toThrow(/only work when changing a table/);
    expect(() =>
      schema.alter('t', (table) => {
        table.string('a');
        table.string('a');
      }),
    ).toThrow('Column "a" is defined twice on table "t".');
  });

  it('refuses a name of the migrator\'s tables while the plan is built', () => {
    expect(() =>
      planOf(
        {
          up: (schema) => {
            schema.create('ok', (table) => table.id());
            schema.drop('migration_lock');
          },
        },
        'up',
      ),
    ).toThrow(/\[marmeon:D4\]/);
  });
});

/** A Postgres-flavoured Kysely whose server answers every query with `answer` (rows) or fails with `failure`. */
function answering(answer: () => unknown[]): Kysely<any> {
  const driver = {
    init: async () => {},
    acquireConnection: async () => ({ executeQuery: async () => ({ rows: answer() }), streamQuery: async function* () {} }),
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<any>({
    dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => driver as never, createIntrospector: (db) => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler() },
  });
}

describe('asking Postgres whether the names of a plan fit', () => {
  const names = [
    { name: 'short_index', what: 'index name', hint: 'Shorten it.' },
    { name: 'the_long_one', what: 'index name', hint: 'Shorten it.' },
  ];

  it('refuses the name the server sends back, whatever the app makes of booleans', async () => {
    // The query returns the misfits only, so no row of it is a boolean a parser could turn into the string 'f'.
    await expect(assertNamesFitPgsql(answering(() => [{ n: 'the_long_one' }]), names)).rejects.toThrow(/^\[marmeon:D5\] The index name "the_long_one" is longer than Postgres's 63 bytes in this database's encoding.*Shorten it\./);
  });

  it('lets a plan through when the server sends nothing back, and asks nothing for no names', async () => {
    let asked = 0;
    await assertNamesFitPgsql(answering(() => (asked++, [])), names);
    await assertNamesFitPgsql(answering(() => (asked++, [{ n: 'x' }])), []);
    expect(asked).toBe(1);
  });

  it.each(['22P05', '22021'])('refuses a name the encoding cannot hold (%s) with D5 and the names, and keeps the error as the cause', async (code) => {
    const failure = Object.assign(new Error('character has no equivalent'), { code });
    const error = await assertNamesFitPgsql(
      answering(() => { throw failure; }),
      [...names, { name: 'indéx_日本', what: 'index name', hint: '' }],
    ).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).message).toMatch(/^\[marmeon:D5\] One of these names cannot be held in this database's encoding: "indéx_日本"\./);
    expect((error as SchemaError).cause).toBe(failure);
  });

  it('names a name with a NUL character among the ones the encoding cannot hold, besides the non-ASCII ones', async () => {
    const failure = Object.assign(new Error('invalid byte sequence'), { code: '22021' });
    const error = await assertNamesFitPgsql(
      answering(() => { throw failure; }),
      [...names, { name: 'nul\0name', what: 'index name', hint: '' }, { name: 'indéx', what: 'index name', hint: '' }],
    ).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).message).toContain('"nul\0name", "indéx"');
    expect((error as SchemaError).message).not.toContain('short_index');
  });

  it('lets every other error of the query through unchanged', async () => {
    const failure = Object.assign(new Error('connection lost'), { code: '08006' });
    await expect(assertNamesFitPgsql(answering(() => { throw failure; }), names)).rejects.toBe(failure);
  });

  it('collects the name a oneOf() gives a column that had no list, from what the migrations know', () => {
    const steps = planOf({ up: (schema) => schema.alter('items', (table) => table.oneOf('state', ['a', 'b'])) }, 'up');
    expect(pgsqlNames(steps, () => ({ name: 'items_state_check', had: false })).map((entry) => entry.name)).toEqual(['items_state_check']);
    expect(pgsqlNames(steps, () => ({ name: 'items_state_check', had: true }))).toEqual([]);
    expect(pgsqlNames(steps)).toEqual([]);
  });
});
