import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Application } from '@marmeon/core';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { drivers, freshConnections, type TestDriver } from '../__fixtures__/databases.ts';
import type { Connections } from '../connections.ts';
import { Migrator } from '../index.ts';
import { runMigration } from '../migrations/run.ts';
import type { Blueprint } from './blueprint.ts';
import { planOf } from './plan.ts';
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
    expect(() => schema.raw(sql`select 'migrations' as name`)).not.toThrow();
  });

  it('does not read the comments of a raw statement', () => {
    const schema = new Schema();
    expect(() => schema.raw(sql`-- runs before the migrations that follow
      create index notes_index on notes (id)`)).not.toThrow();
    expect(() => schema.raw(sql`/* migrations */ create index notes_index on notes (id)`)).not.toThrow();
    expect(() => schema.raw(sql`/* note */ drop table migrations`)).toThrow(/names "migrations", a table of the migrator/);
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
