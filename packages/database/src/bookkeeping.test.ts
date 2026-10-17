import { readdirSync, readFileSync } from 'node:fs';
import { ErrorSolutions, type Application, type ModuleDefinition } from '@marmeon/core';
import { AlterTableBuilder, sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { BOOKKEEPING_READERS, isBookkeepingName, LEGACY, MARKER_KINDS, VERSIONS_TABLE } from './bookkeeping.ts';
import { bookkeepingConnection } from './books.ts';
import { drivers, freshConnections, freshDatabase, silent, type TestDriver } from './__fixtures__/databases.ts';
import { MigrateCommand } from './commands/migrate.ts';
import type { TypeGenerator } from './types-gen/generator.ts';
import type { CommandInput } from 'marmeon';
import { BookkeepingVersionError, Connections, DatabaseHealthCheck, Migrator, Repository, Schema, SchemaError, type Migration } from './index.ts';
import { tableColumns } from './introspection.ts';
import { dropAllTables } from './migrations/drop-all.ts';
import { runMigration } from './migrations/run.ts';
import type { TableMarker } from './schema/blueprint.ts';
import { databaseSolutions } from './solutions.ts';
import { SchemaRequirements } from './upgrades.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const formats = new URL('./__fixtures__/formats/bookkeeping/', import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'accounts', migrations: fixtures('accounts') },
  { name: 'drafts', migrations: fixtures('markers') },
];
// SQLite cannot drop a column a foreign key uses, so that migration is loaded on Postgres only.
const pgsqlOnly: ModuleDefinition = { name: 'drafts', migrations: fixtures('markers-pgsql') };
const migrator = (connections: Connections, only: ModuleDefinition[] = modules) =>
  new Migrator({ modules: only === modules && connections.options().driver === 'pgsql' ? [...modules, pgsqlOnly] : only, root: '/' } as unknown as Application, connections);

const NEW = ['marmeon_migrations', 'marmeon_schema_markers', 'marmeon_secret_columns', 'marmeon_table_owners', 'marmeon_versions'];
const OLD = ['migrations', 'schema_markers', 'secret_columns', 'table_owners'];

/** The books exactly as the release before wrote them: its DDL, the rows of a migrated database moved into them. */
async function becomeLegacy(connections: Connections, driver: TestDriver, name = 'default'): Promise<void> {
  const db = bookkeepingConnection(connections, name);
  const records = name === 'default';
  if (records) {
    await db.schema
      .createTable('migrations')
      .addColumn('id', driver === 'sqlite' ? 'integer' : 'bigint', (c) => (driver === 'sqlite' ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity()))
      .addColumn('name', 'varchar(255)', (c) => c.notNull().unique())
      .addColumn('module', 'varchar(255)', (c) => c.notNull())
      .addColumn('batch', 'integer', (c) => c.notNull())
      .execute();
  }
  await db.schema.createTable('table_owners').addColumn('table_name', 'varchar(255)', (c) => c.primaryKey()).addColumn('module', 'varchar(255)', (c) => c.notNull()).execute();
  await db.schema
    .createTable('secret_columns')
    .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
    .addColumn('column_name', 'varchar(255)', (c) => c.notNull())
    .addPrimaryKeyConstraint('secret_columns_pkey', ['table_name', 'column_name'])
    .execute();
  await db.schema
    .createTable('schema_markers')
    .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
    .addColumn('column_name', 'varchar(255)', (c) => c.notNull().defaultTo(''))
    .addColumn('marker', 'varchar(32)', (c) => c.notNull())
    .addColumn('value', 'varchar(255)')
    .addPrimaryKeyConstraint('schema_markers_pkey', ['table_name', 'column_name', 'marker'])
    .execute();
  if (records) await sql`insert into migrations (id, name, module, batch) select id, name, module, batch from marmeon_migrations`.execute(db);
  await sql`insert into table_owners (table_name, module) select table_name, module from marmeon_table_owners`.execute(db);
  await sql`insert into secret_columns (table_name, column_name) select table_name, column_name from marmeon_secret_columns`.execute(db);
  await sql`insert into schema_markers (table_name, column_name, marker, value) select table_name, column_name, marker, value from marmeon_schema_markers`.execute(db);
  if (records && driver === 'pgsql') await sql`select setval(pg_get_serial_sequence('migrations', 'id'), (select max(id) from migrations))`.execute(db);
  for (const table of NEW.filter((table) => records || table !== 'marmeon_migrations')) await db.schema.dropTable(table).execute();
}

/** The bookkeeping tables as the catalog shows them: columns with types, indexes, constraints and sequences by name. */
async function shape(connections: Connections, driver: TestDriver): Promise<unknown> {
  const db = bookkeepingConnection(connections);
  const run = async <R>(query: string) => (await sql.raw<R>(query).execute(db)).rows;
  const { types } = await tableColumns(run, driver);
  const columns = NEW.map((table) => [table, [...(types.get(table) ?? [])]]);
  const names =
    driver === 'sqlite'
      ? await run<{ name: string }>(`select name from sqlite_master where tbl_name like 'marmeon\\_%' escape '\\' and name not like 'marmeon\\_migration\\_lock%' escape '\\' and name not like 'marmeon\\_migration%lock%' order by name`)
      : await run<{ name: string }>(`
          select relname as name from pg_class where relnamespace = (select oid from pg_namespace where nspname = current_schema()) and relname like 'marmeon\\_%' and relname not like 'marmeon\\_migration\\_lock%' order by relname`);
  const constraints =
    driver === 'sqlite' ? [] : await run<{ name: string }>(`select conname as name from pg_constraint where connamespace = (select oid from pg_namespace where nspname = current_schema()) and conname like 'marmeon\\_%' and conname not like 'marmeon\\_migration\\_lock%' order by conname`);
  return { columns, names: names.map((row) => row.name), constraints: constraints.map((row) => row.name) };
}

const allTables = async (db: Kysely<any>) => (await db.introspection.getTables()).map((table) => table.name).sort();

describe.each(drivers)('the migrator keeps its bookkeeping in marmeon_ tables on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeEach(async () => ({ connections, close } = await freshConnections(driver, { bookkeeping: false })));
  afterEach(() => close());

  const seed = async () => {
    const db = connections.get<any>();
    await db.insertInto('users').values([{ name: 'Ada', email: 'ada@example.com' }, { name: 'Gone', email: 'gone@example.com', deleted_at: new Date() }]).execute();
    await db.insertInto('accounts').values({ email: 'ada@example.com', password: 'hash-of-ada', totp_secret: 'key' }).execute();
  };

  class Users extends Repository<'users', any> {
    static table = 'users' as const;
  }

  const expectHidden = async () => {
    const db = connections.get<any>();
    expect((await new Users(connections).query().selectAll().execute()).map((row: any) => row.name as string)).toEqual(['Ada']);
    const [account] = (await db.selectFrom('accounts').selectAll().execute()) as Record<string, unknown>[];
    expect(account).toBeDefined();
    expect(Object.keys(account!)).not.toContain('password');
    expect(Object.keys(account!)).not.toContain('totp_secret');
  };

  it('has only marmeon_ tables on a fresh database, with the version in a row of their own', async () => {
    await migrator(connections).migrate();
    const tables = await allTables(connections.get<any>());
    expect(tables.filter((table) => table.startsWith('marmeon_') && table !== 'marmeon_migration_lock')).toEqual(NEW);
    for (const old of OLD) expect(tables).not.toContain(old);
    expect((await sql<{ name: string; version: number }>`select name, version from marmeon_versions`.execute(connections.get())).rows).toEqual([{ name: 'bookkeeping', version: 1 }]);
  });

  describe('a database the release before it migrated', () => {
    let before: { owners: unknown; secrets: unknown; markers: unknown };

    beforeEach(async () => {
      await migrator(connections).migrate();
      await seed();
      const books = migrator(connections);
      before = { owners: [...(await books.owners())], secrets: [...(await books.secrets())].map(([table, columns]) => [table, [...columns]]), markers: await books.markers() };
      await becomeLegacy(connections, driver);
    });

    it('refuses every query until `migrate` moved the bookkeeping — nothing a secret column or a soft delete hides is shown', async () => {
      const db = connections.get<any>();
      await expect(db.selectFrom('accounts').selectAll().execute()).rejects.toThrow(BookkeepingVersionError);
      await expect(db.selectFrom('users').selectAll().execute()).rejects.toThrow(/\[marmeon:D2\].*"default".*marmeon migrate/s);
      await expect(sql`select 1`.execute(db)).rejects.toThrow(BookkeepingVersionError);
      await expect(migrator(connections).status()).rejects.toThrow(BookkeepingVersionError);
      await expect(migrator(connections).rollback()).rejects.toThrow(/\[marmeon:D2\]/);
      await expect(migrator(connections).owners()).rejects.toThrow(BookkeepingVersionError);
      // Still the old tables, untouched.
      expect(await allTables(bookkeepingConnection(connections))).toEqual(expect.arrayContaining(OLD));
    });

    it('moves the books on `migrate`: owners, secrets and markers are the same, and so is what the guard hides', async () => {
      expect(await migrator(connections).migrate()).toEqual([]);
      const books = migrator(connections);
      expect({ owners: [...(await books.owners())], secrets: [...(await books.secrets())].map(([table, columns]) => [table, [...columns]]), markers: await books.markers() }).toEqual(before);
      expect((await books.status()).every((file) => file.batch !== undefined)).toBe(true);
      await expectHidden();
    });

    it('ends up exactly as a fresh database — columns, index, constraint and sequence names', async () => {
      await migrator(connections).migrate();
      const adopted = await shape(connections, driver);
      const fresh = await freshConnections(driver);
      try {
        await migrator(fresh.connections).migrate();
        expect(adopted).toEqual(await shape(fresh.connections, driver));
      } finally {
        await fresh.close();
      }
    });

    it('leaves a placeholder under every old name — a process of the release before fails on every query instead of running without its list', async () => {
      await migrator(connections).migrate();
      const db = connections.get<any>();
      for (const [old, { to }] of Object.entries(LEGACY)) {
        expect((await sql<{ moved_to: string }>`select moved_to from ${sql.table(old)}`.execute(db)).rows).toEqual([{ moved_to: to }]);
      }
      // What the old release asks, word for word:
      await expect(sql`select table_name, column_name from secret_columns`.execute(db)).rejects.toThrow();
      await expect(sql`select table_name, column_name, marker, value from schema_markers`.execute(db)).rejects.toThrow();
      await expect(sql`insert into migrations (name, module, batch) values ('2026_01_01_000000_again', 'x', 9)`.execute(db)).rejects.toThrow();
      await expect(sql`select table_name, module from table_owners`.execute(db)).rejects.toThrow();
      expect((await migrator(connections).status()).filter((file) => file.batch === undefined)).toEqual([]);
    });

    it('does not mistake the placeholders for the old books, and never reads them', async () => {
      await migrator(connections).migrate();
      await migrator(connections).migrate(); // the second run finds the version and leaves the placeholders alone
      expect(await allTables(connections.get<any>())).toEqual(expect.arrayContaining([...OLD, ...NEW]));
      await expectHidden();
    });

    it('runs migrations that come after, on the moved record', async () => {
      const later: ModuleDefinition = { name: 'later', migrations: fixtures('plurals') };
      const ran = await migrator(connections, [...modules, later]).migrate();
      expect(ran.map((run) => run.module)).toEqual(['later']);
      expect((await sql<{ n: number }>`select count(*) as n from marmeon_migrations`.execute(connections.get())).rows[0]!.n).toBe(driver === 'pgsql' ? 9 : 8); // Postgres has one migration more (the column drop)
    });

    it('leaves the old tables as they were, and no marmeon_ table, when moving fails half way', async () => {
      // The second table's rename fails when it runs, after the first was done.
      const original = AlterTableBuilder.prototype.renameTo;
      let calls = 0;
      const spy = vi.spyOn(AlterTableBuilder.prototype, 'renameTo').mockImplementation(function (this: AlterTableBuilder, ...args: Parameters<typeof original>) {
        if (++calls === 2) return { execute: () => Promise.reject(new Error('boom')) } as never;
        return original.apply(this, args);
      });
      try {
        await expect(migrator(connections).migrate()).rejects.toThrow('boom');
      } finally {
        spy.mockRestore();
      }
      expect(calls).toBeGreaterThanOrEqual(2);
      const tables = await allTables(bookkeepingConnection(connections));
      expect(tables).toEqual(expect.arrayContaining(OLD));
      expect(tables.filter((table) => NEW.includes(table))).toEqual([]);
      await expect(connections.get<any>().selectFrom('users').selectAll().execute()).rejects.toThrow(/\[marmeon:D2\]/);
      expect(await migrator(connections).migrate()).toEqual([]); // and the next run moves them
      await expectHidden();
    });

    it('drops it all on `migrate:fresh`, placeholders included', async () => {
      await migrator(connections).fresh();
      const tables = await allTables(connections.get<any>());
      expect(tables.filter((table) => OLD.includes(table))).toEqual([]);
      await seed();
      await expectHidden();
    });
  });

  describe('bookkeeping it cannot read', () => {
    beforeEach(async () => {
      await migrator(connections).migrate();
      await seed();
      await connections.get<any>().selectFrom('accounts').selectAll().execute();
    });

    const setVersion = async (version: number | string) => {
      await sql`update marmeon_versions set version = ${version} where name = 'bookkeeping'`.execute(bookkeepingConnection(connections));
      connections.metadata().invalidate();
    };

    it('reads a version it has a reader for, and only those — a synthetic version 2 shows the mechanism', async () => {
      BOOKKEEPING_READERS.set(2, BOOKKEEPING_READERS.get(1)!);
      try {
        await setVersion(2);
        await expectHidden();
        await setVersion(3);
        await expect(connections.get<any>().selectFrom('users').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*version 3.*reads 1, 2/s);
      } finally {
        BOOKKEEPING_READERS.delete(2);
      }
      await setVersion(2);
      await expect(connections.get<any>().selectFrom('users').selectAll().execute()).rejects.toThrow(/version 2.*reads 1:/s);
    });

    it('refuses every query, `migrate`, `rollback`, `status` and `migrate:fresh`, and leaves the database as it is — for a newer version', async () => {
      await setVersion(3);
      const db = connections.get<any>();
      await expect(db.selectFrom('accounts').selectAll().execute()).rejects.toThrow(BookkeepingVersionError);
      await expect(sql`select 1`.execute(db)).rejects.toThrow(/newer Marmeon/);
      await expect(connections.transaction(async (trx) => (trx as any).selectFrom('users').selectAll().execute())).rejects.toThrow(BookkeepingVersionError);
      await expect(migrator(connections).migrate()).rejects.toThrow(/\[marmeon:D1\]/);
      await expect(migrator(connections).rollback()).rejects.toThrow(BookkeepingVersionError);
      await expect(migrator(connections).status()).rejects.toThrow(BookkeepingVersionError);
      await expect(migrator(connections).fresh()).rejects.toThrow(BookkeepingVersionError);
      expect((await sql<{ version: number }>`select version from marmeon_versions`.execute(bookkeepingConnection(connections))).rows).toEqual([{ version: 3 }]);
      expect((await sql<{ n: number }>`select count(*) as n from accounts`.execute(bookkeepingConnection(connections))).rows[0]!.n).toBe(1);
    });

    it('refuses a version that is no whole number', async () => {
      for (const odd of [0, -1]) {
        await setVersion(odd);
        await expect(connections.get<any>().selectFrom('users').selectAll().execute()).rejects.toThrow(BookkeepingVersionError);
      }
      await sql`delete from marmeon_versions`.execute(bookkeepingConnection(connections));
      connections.metadata().invalidate();
      await expect(connections.get<any>().selectFrom('users').selectAll().execute()).rejects.toThrow(BookkeepingVersionError);
    });

    it('reports it on readiness, per connection', async () => {
      await setVersion(3);
      const check = new DatabaseHealthCheck(connections, new SchemaRequirements());
      await expect(check.handle()).rejects.toThrow(/The database connection "default" failed: (?!\[marmeon).*version 3/s);
    });

    it('does not read a missing table as "no secret columns"', async () => {
      await sql`drop table marmeon_secret_columns`.execute(bookkeepingConnection(connections));
      await expect(connections.get<any>().selectFrom('accounts').selectAll().execute()).rejects.toThrow(/marmeon_secret_columns is missing/);
      await expect(migrator(connections).migrate()).rejects.toThrow(/marmeon_secret_columns is missing/); // nothing is made up for the table that is gone
    });

    it('does not read a table with other columns, nor tables without a versions table', async () => {
      await sql`alter table marmeon_secret_columns add column extra varchar(10)`.execute(bookkeepingConnection(connections));
      await expect(connections.get<any>().selectFrom('accounts').selectAll().execute()).rejects.toThrow(/does not have the columns/);
      await sql`alter table marmeon_secret_columns drop column extra`.execute(bookkeepingConnection(connections));
      await sql`drop table marmeon_versions`.execute(bookkeepingConnection(connections));
      await expect(connections.get<any>().selectFrom('accounts').selectAll().execute()).rejects.toThrow(/incomplete/);
      await expect(migrator(connections).migrate()).rejects.toThrow(/incomplete/);
    });

    it('knows every marker that the migrator writes', async () => {
      const written = (await sql<{ marker: string }>`select distinct marker from marmeon_schema_markers`.execute(connections.get())).rows.map((row) => row.marker);
      expect(written.length).toBeGreaterThan(0);
      for (const marker of written) expect(Object.keys(MARKER_KINDS)).toContain(marker);
      // Every marker the schema builder can write is one the reader knows.
      expectTypeOf<TableMarker | 'inverse'>().toEqualTypeOf<keyof typeof MARKER_KINDS>();
    });

    it('refuses a marker it does not know — a newer Marmeon wrote it — instead of leaving it out', async () => {
      await sql`insert into marmeon_schema_markers (table_name, column_name, marker, value) values ('accounts', '', 'future', null)`.execute(bookkeepingConnection(connections));
      connections.metadata().invalidate();
      await expect(connections.get<any>().selectFrom('users').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*marker "future"/s);
      await sql`delete from marmeon_schema_markers where marker = 'future'`.execute(bookkeepingConnection(connections));
      connections.metadata().invalidate();
      await expectHidden();
    });

    it('reloads the metadata when the books are written through the builder', async () => {
      const db = connections.get<any>();
      await db.insertInto('marmeon_secret_columns').values({ table_name: 'users', column_name: 'email' }).execute();
      const [user] = await db.selectFrom('users').selectAll().execute();
      expect(Object.keys(user!)).not.toContain('email');
      await db.deleteFrom('marmeon_secret_columns').where('table_name', '=', 'users').execute();
      expect(Object.keys((await db.selectFrom('users').selectAll().execute())[0]!)).toContain('email');
    });
  });

  describe('a table of the app under a name of the bookkeeping', () => {
    it('is no bookkeeping on its own: `migrate` says so, and the connection stays refused', async () => {
      const books = bookkeepingConnection(connections);
      await books.schema.createTable('migrations').addColumn('id', 'integer').addColumn('title', 'varchar(20)').execute();
      await expect(migrator(connections).migrate()).rejects.toThrow(/\[marmeon:D1\].*managed: false/s);
      await expect(connections.get<any>().selectFrom('migrations').selectAll().execute()).rejects.toThrow(BookkeepingVersionError);
      expect((await allTables(books)).filter((table) => table !== 'marmeon_migration_lock')).toEqual(['migrations']);
    });

    it('is a table to rename when the old bookkeeping lies next to it', async () => {
      const books = bookkeepingConnection(connections);
      await books.schema.createTable('migrations').addColumn('id', 'integer').addColumn('title', 'varchar(20)').execute();
      await books.schema.createTable('table_owners').addColumn('table_name', 'varchar(255)', (c) => c.primaryKey()).addColumn('module', 'varchar(255)', (c) => c.notNull()).execute();
      await books.schema
        .createTable('secret_columns')
        .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
        .addColumn('column_name', 'varchar(255)', (c) => c.notNull())
        .execute();
      await books.schema
        .createTable('schema_markers')
        .addColumn('table_name', 'varchar(255)', (c) => c.notNull())
        .addColumn('column_name', 'varchar(255)', (c) => c.notNull())
        .addColumn('marker', 'varchar(32)', (c) => c.notNull())
        .addColumn('value', 'varchar(255)')
        .execute();
      await expect(migrator(connections).migrate()).rejects.toThrow(/\[marmeon:D3\].*"migrations".*rename your table/s);
      expect(await allTables(books)).toEqual(expect.arrayContaining(['migrations', 'secret_columns']));
      expect(await allTables(books)).not.toContain('marmeon_versions');
    });
  });

  describe('a connection with tables and no bookkeeping', () => {
    const createStranger = () => bookkeepingConnection(connections).schema.createTable('stranger').addColumn('id', 'integer').addColumn('secret', 'varchar(20)').execute();

    it('is refused — never read as "no secret columns" — and `migrate` writes nothing', async () => {
      await createStranger();
      await expect(connections.get<any>().selectFrom('stranger').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*managed: false/s);
      await expect(migrator(connections).migrate()).rejects.toThrow(BookkeepingVersionError);
      await expect(migrator(connections).rollback()).rejects.toThrow(BookkeepingVersionError);
      expect((await allTables(bookkeepingConnection(connections))).filter((table) => table !== 'marmeon_migration_lock')).toEqual(['stranger']);
    });

    it('is refused when only part of the old bookkeeping is there', async () => {
      const books = bookkeepingConnection(connections);
      await books.schema.createTable('table_owners').addColumn('table_name', 'varchar(255)', (c) => c.primaryKey()).addColumn('module', 'varchar(255)', (c) => c.notNull()).execute();
      await expect(migrator(connections).migrate()).rejects.toThrow(/\[marmeon:D1\]/);
      expect(await allTables(books)).not.toContain('marmeon_versions');
    });
  });

  describe('the schema builder', () => {
    it('refuses to create, alter, drop or rename a name of the bookkeeping — placeholders and the old names included', async () => {
      await migrator(connections).migrate();
      await sql`select 1`.execute(connections.get()); // loaded
      const schema = new Schema();
      const names = [...NEW, ...OLD, 'Migrations', 'marmeon_migration_lock'];
      for (const name of names) {
        expect(() => schema.create(name, (table) => table.string('x'))).toThrow(SchemaError);
        expect(() => schema.alter(name, (table) => table.string('x'))).toThrow(SchemaError);
        expect(() => schema.drop(name)).toThrow(/\[marmeon:D4\]/);
        expect(() => schema.dropIfExists(name)).toThrow(SchemaError);
        expect(() => schema.rename(name, 'elsewhere')).toThrow(SchemaError);
        expect(() => schema.rename('users', name)).toThrow(SchemaError);
      }
      expect(await allTables(connections.get<any>())).toEqual(expect.arrayContaining([...NEW]));
    });

    it('refuses the same in a migration, which then leaves nothing undone', async () => {
      const drops = (table: string): Migration => ({ up: (schema) => schema.drop(table) }) as Migration;
      for (const table of ['marmeon_secret_columns', 'secret_columns']) {
        const connectionsHere = await freshConnections(driver);
        try {
          await migrator(connectionsHere.connections).migrate();
          const db = connectionsHere.connections.get<any>();
          await expect(runMigration(connectionsHere.connections, drops(table))).rejects.toThrow(SchemaError);
          expect(await allTables(db)).toEqual(expect.arrayContaining(NEW));
        } finally {
          await connectionsHere.close();
        }
      }
    });

    it('knows its names', () => {
      expect([...NEW, ...OLD, 'marmeon_migration_lock'].every(isBookkeepingName)).toBe(true);
      expect(['users', 'jobs', 'sessions'].some(isBookkeepingName)).toBe(false);
      expect(VERSIONS_TABLE).toBe('marmeon_versions');
    });
  });
});

describe.each(drivers)('the bookkeeping on a connection of its own, on %s', (driver) => {
  it('moves its three tables when `migrate` runs — also when none of its migrations is pending — and leaves no placeholder for the record of migrations, which lives on default', async () => {
    const [app, other] = [await freshDatabase(driver), await freshDatabase(driver)];
    const connections = new Connections({ connections: { default: app.options, system: other.options }, root: '/', logger: silent });
    const system: ModuleDefinition = { name: 'system', migrations: fixtures('system') };
    const on = () => new Migrator({ modules: [modules[0]!, system], root: '/', container: { make: () => 'system' } } as unknown as Application, connections);
    try {
      await on().migrate();
      await becomeLegacy(connections, driver, 'system');
      await expect(connections.get<any>('system').selectFrom('audit').selectAll().execute()).rejects.toThrow(/\[marmeon:D2\].*"system"/s);
      expect(await on().migrate()).toEqual([]);
      expect(await connections.get<any>('system').selectFrom('audit').selectAll().execute()).toEqual([]);
      const tables = await allTables(bookkeepingConnection(connections, 'system'));
      expect(tables.filter((table) => table.startsWith('marmeon_') && table !== 'marmeon_migration_lock')).toEqual(NEW.filter((table) => table !== 'marmeon_migrations'));
      expect(tables).toEqual(expect.arrayContaining(['table_owners', 'secret_columns', 'schema_markers']));
      expect(tables).not.toContain('migrations');
    } finally {
      await connections.destroy();
      await app.drop();
      await other.drop();
    }
  });
});

describe.each(drivers)('a dump of version 1 of the bookkeeping on %s', (driver) => {
  const dumps = readdirSync(formats).filter((file) => file.startsWith('v') && file.endsWith(`-${driver}.sql`));

  it('has a dump of every version', () => {
    expect(dumps).toContain(`v1-${driver}.sql`);
  });

  it.each(dumps)('%s is read with the current code — the secret column and the deleted row stay hidden, and it is what a fresh database looks like', async (file) => {
    const dump = await freshConnections(driver, { bookkeeping: false });
    const fresh = await freshConnections(driver);
    try {
      const books = bookkeepingConnection(dump.connections);
      for (const statement of readFileSync(new URL(file, formats), 'utf8').split(/;\n/).map((text) => text.trim()).filter(Boolean)) await sql.raw(statement).execute(books);
      class Accounts extends Repository<'accounts', any> {
        static table = 'accounts' as const;
      }
      const rows = await new Accounts(dump.connections).query().selectAll().execute();
      expect(rows.map((row: any) => row.email as string)).toEqual(['ada@example.com']);
      expect(Object.keys(rows[0]!)).not.toContain('password');
      expect([...dump.connections.metadata().secrets]).toEqual([['accounts', new Set(['password'])]]);
      expect(dump.connections.metadata().softDeletes).toEqual(new Set(['accounts']));
      expect(dump.connections.metadata().relations.get('accounts')?.has('written_notes')).toBe(true);
      expect(await migrator(dump.connections, []).migrate()).toEqual([]); // the version is read: nothing to move
      await migrator(fresh.connections, []).migrate();
      expect(await shape(dump.connections, driver)).toEqual(await shape(fresh.connections, driver));
    } finally {
      await dump.close();
      await fresh.close();
    }
  });
});

describe.each(drivers)('a connection another tool manages, on %s', (driver) => {
  it('is read without bookkeeping (no secret columns, no soft deletes) and left alone by `migrate`', async () => {
    const { connections, close } = await freshConnections(driver, { managed: false });
    try {
      const books = bookkeepingConnection(connections);
      await books.schema.createTable('stranger').addColumn('id', 'integer').addColumn('note', 'varchar(20)').addColumn('deleted_at', 'timestamp').execute();
      await sql`insert into stranger (id, note) values (1, 'x')`.execute(books);
      expect(await connections.get<any>().selectFrom('stranger').selectAll().execute()).toHaveLength(1);
      expect(connections.metadata().secrets.size).toBe(0);
      expect(connections.metadata().softDeletes.size).toBe(0);
      await expect(migrator(connections).migrate()).rejects.toThrow(/not migrated by Marmeon/);
      await expect(migrator(connections).fresh()).rejects.toThrow(/managed: false/);
      await expect(migrator(connections).rollback()).rejects.toThrow(/managed: false/);
      expect((await allTables(books)).filter((table) => table !== 'marmeon_migration_lock')).toEqual(['stranger']);
    } finally {
      await close();
    }
  });

  it.runIf(driver === 'pgsql')('refuses a role that has no privileges on the bookkeeping, instead of seeing no tables and no secrets', async () => {
    const fresh = await freshConnections('pgsql');
    const role = `marmeon_limited_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    let limited: Connections | undefined;
    try {
      await migrator(fresh.connections).migrate();
      const admin = bookkeepingConnection(fresh.connections);
      const { name } = (await sql<{ name: string }>`select current_database() as name`.execute(admin)).rows[0]!;
      await sql`create role ${sql.id(role)} login password 'limited'`.execute(admin);
      await sql`grant connect on database ${sql.id(name)} to ${sql.id(role)}`.execute(admin);
      await sql`grant usage on schema public to ${sql.id(role)}`.execute(admin);
      await sql`grant select on accounts, users to ${sql.id(role)}`.execute(admin);
      const url = new URL((fresh.connections.options() as { url: string }).url);
      url.username = role;
      url.password = 'limited';
      limited = new Connections({ connections: { default: { driver: 'pgsql', url: url.href, poolMax: 1 } }, root: '/', logger: silent });
      await expect(limited.get<any>().selectFrom('accounts').selectAll().execute()).rejects.toThrow(/permission denied/);
    } finally {
      await limited?.destroy();
      await sql`drop owned by ${sql.id(role)}`.execute(bookkeepingConnection(fresh.connections)).catch(() => {});
      await fresh.close();
      const admin = await freshConnections('pgsql');
      await sql`drop role if exists ${sql.id(role)}`.execute(bookkeepingConnection(admin.connections)).catch(() => {});
      await admin.close();
    }
  });
});

describe.each(drivers)('the schema builder and the bookkeeping, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver));
    await migrator(connections).migrate();
  });
  afterEach(() => close());

  it('looks at the last segment of a qualified name', async () => {
    const schema = new Schema();
    const qualified = driver === 'pgsql' ? 'public' : 'main';
    for (const name of ['marmeon_secret_columns', 'secret_columns', 'marmeon_versions']) {
      expect(() => schema.drop(`${qualified}.${name}`)).toThrow(SchemaError);
      expect(() => schema.rename('users', `${qualified}.${name}`)).toThrow(SchemaError);
    }
  });

  it('keeps the migrator tables when it drops every table, and when the migrator does it drops them too', async () => {
    await dropAllTables(connections.get(), driver, false);
    const tables = await allTables(connections.get<any>());
    expect(tables).not.toContain('users');
    expect(tables).toEqual(expect.arrayContaining(NEW));
    await migrator(connections).fresh();
    expect(await allTables(connections.get<any>())).toContain('users');
  });

  it('refuses a write to the books through schema.data() in a migration — and records nothing', async () => {
    const writes: ModuleDefinition = { name: 'writes', migrations: fixtures('writes-books') };
    await expect(migrator(connections, [...modules, writes]).migrate()).rejects.toThrow(/\[marmeon:D4\]/);
    expect((await sql<{ n: number }>`select count(*) as n from marmeon_secret_columns where table_name = 'accounts'`.execute(connections.get())).rows[0]!.n).toBeGreaterThan(0);
  });

  it('gives the migrator a connection that reads its own tables only', async () => {
    const books = bookkeepingConnection(connections);
    await expect(books.selectFrom('users').selectAll().execute()).rejects.toThrow(/migrator's tables only/);
    await expect(books.deleteFrom('accounts').execute()).rejects.toThrow(/migrator's tables only/);
    expect(await books.selectFrom('marmeon_versions').selectAll().execute()).toHaveLength(1);
  });
});

describe.each(drivers)('a database with tables and no bookkeeping, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver, { bookkeeping: false }));
    await bookkeepingConnection(connections).schema.createTable('stranger').addColumn('id', 'integer').addColumn('note', 'varchar(20)').execute();
  });
  afterEach(() => close());

  it('is adopted with `--adopt-existing`: an empty, versioned bookkeeping, and the tables named as taken over unmarked', async () => {
    await expect(connections.get<any>().selectFrom('stranger').selectAll().execute()).rejects.toThrow(/--adopt-existing/);
    await expect(migrator(connections).migrate()).rejects.toThrow(/\[marmeon:D1\]/);
    const adopted: [string, readonly string[]][] = [];
    const ran = await migrator(connections).migrate(undefined, { adoptExisting: (connection, tables) => adopted.push([connection, tables]) });
    expect(ran.length).toBeGreaterThan(0);
    expect(adopted).toEqual([['default', ['stranger']]]);
    expect(await connections.get<any>().selectFrom('stranger').selectAll().execute()).toEqual([]);
    expect([...(await migrator(connections).owners())]).not.toContainEqual(['stranger', expect.anything()]);
    expect((await allTables(connections.get<any>())).filter((table) => NEW.includes(table))).toEqual(NEW);
    // Once: the next run finds a bookkeeping and says nothing.
    adopted.length = 0;
    await migrator(connections).migrate(undefined, { adoptExisting: (connection, tables) => adopted.push([connection, tables]) });
    expect(adopted).toEqual([]);
  });

  it('`marmeon migrate --adopt-existing` warns with the names of the tables, and without the option writes nothing', async () => {
    const run = async (options: Record<string, boolean>) => {
      const printed: string[] = [];
      const say = (kind: string) => (text: string) => void printed.push(`${kind}: ${text}`);
      const output = { line: say('line'), info: say('info'), success: say('success'), warn: say('warn'), error: say('error'), table: () => {} };
      const command = new MigrateCommand(migrator(connections, []), {} as TypeGenerator);
      const code = await command.handle({ options: { force: true, ...options }, output, root: '/' } as unknown as CommandInput).then(
        (value) => value,
        (error: unknown) => {
          printed.push(`thrown: ${(error as Error).message}`);
          return 1;
        },
      );
      return { code, printed };
    };
    const refused = await run({});
    expect(refused.code).toBe(1);
    expect(refused.printed.join('\n')).toMatch(/--adopt-existing/);
    expect(await allTables(bookkeepingConnection(connections))).not.toContain('marmeon_versions');
    const adopted = await run({ 'adopt-existing': true });
    expect(adopted.code).toBe(0);
    expect(adopted.printed.find((line) => line.startsWith('warn:'))).toMatch(/WITHOUT any secret column.*stranger/);
    expect(await allTables(bookkeepingConnection(connections))).toContain('marmeon_versions');
    expect((await run({ 'adopt-existing': true })).printed.some((line) => line.startsWith('warn:'))).toBe(false);
  });

  it('is not adopted when the bookkeeping is only partly there — `--adopt-existing` is for a database without any', async () => {
    await bookkeepingConnection(connections).schema.createTable('marmeon_table_owners').addColumn('table_name', 'varchar(255)', (c) => c.primaryKey()).addColumn('module', 'varchar(255)', (c) => c.notNull()).execute();
    await expect(migrator(connections).migrate(undefined, { adoptExisting: () => {} })).rejects.toThrow(/incomplete/);
  });

  it('names `--adopt-existing` for the own database, and `managed: false` only for a database another tool manages', async () => {
    await expect(connections.get<any>().selectFrom('stranger').selectAll().execute()).rejects.toThrow(/your own database.*--adopt-existing.*Only for a database that another tool manages.*managed: false/s);
  });
});

describe.each(drivers)('`managed: false` on %s', (driver) => {
  it('is refused when the connection has tables of the migrator after all — it would read no secret column', async () => {
    const { connections, close } = await freshConnections(driver, { managed: false });
    try {
      const books = bookkeepingConnection(connections);
      await books.schema.createTable('people').addColumn('id', 'integer').addColumn('hash', 'varchar(20)').execute();
      await books.schema.createTable('marmeon_versions').addColumn('name', 'varchar(64)').addColumn('version', 'integer').execute();
      await expect(connections.get<any>().selectFrom('people').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*managed: false.*marmeon_versions.*Marmeon migrates this database/s);
    } finally {
      await close();
    }
  });

  it('is refused for the lock table and for a placeholder too', async () => {
    const { connections, close } = await freshConnections(driver, { managed: false });
    try {
      const books = bookkeepingConnection(connections);
      await books.schema.createTable('secret_columns').addColumn('moved_to', 'varchar(64)', (c) => c.notNull()).execute();
      await expect(connections.get<any>().selectFrom('secret_columns').selectAll().execute()).rejects.toThrow(/Marmeon migrates this database/);
    } finally {
      await close();
    }
  });

  it('is refused for the secret columns and markers of the release before — their exact format means Marmeon migrated it', async () => {
    const { connections, close } = await freshConnections(driver, { managed: false });
    try {
      await bookkeepingConnection(connections).schema.createTable('secret_columns').addColumn('table_name', 'varchar(255)').addColumn('column_name', 'varchar(255)').execute();
      await expect(connections.get<any>().selectFrom('secret_columns').selectAll().execute()).rejects.toThrow(/Marmeon migrates this database/);
    } finally {
      await close();
    }
  });

  it('reads a table of another shape under such a name as an ordinary table', async () => {
    const { connections, close } = await freshConnections(driver, { managed: false });
    try {
      await bookkeepingConnection(connections).schema.createTable('schema_markers').addColumn('id', 'integer').addColumn('title', 'varchar(20)').execute();
      expect(await connections.get<any>().selectFrom('schema_markers').selectAll().execute()).toEqual([]);
    } finally {
      await close();
    }
  });

  it('reads a foreign tool\'s own `migrations` table as an ordinary table', async () => {
    const { connections, close } = await freshConnections(driver, { managed: false });
    try {
      await bookkeepingConnection(connections).schema.createTable('migrations').addColumn('id', 'integer').addColumn('title', 'varchar(20)').execute();
      expect(await connections.get<any>().selectFrom('migrations').selectAll().execute()).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe.each(drivers)('entries of the bookkeeping that come loose, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ connections, close } = await freshConnections(driver));
    await migrator(connections).migrate();
  });
  afterEach(() => close());

  it.each([
    ['a secret column renamed in raw SQL', 'raw-rename-column', /accounts\.password/],
    ['a table with secret columns renamed in raw SQL', 'raw-rename-table', /secret column accounts\./],
  ])('rolls back a migration that leaves %s, with D4 and the way to do it', async (_name, directory, entry) => {
    const hand: ModuleDefinition = { name: 'hand', migrations: fixtures(directory) };
    await expect(migrator(connections, [...modules, hand]).migrate()).rejects.toThrow(entry);
    await expect(migrator(connections, [...modules, hand]).migrate()).rejects.toThrow(/\[marmeon:D4\].*schema\.alter\(\).*schema\.rename\(\)/s);
    expect(await connections.get<any>().selectFrom('accounts').selectAll().execute()).toEqual([]);
    expect(await migrator(connections, [...modules, hand]).status().then((all) => all.filter((file) => file.batch === undefined).map((file) => file.module))).toEqual(['hand']);
    await sql`select id, password from accounts`.execute(bookkeepingConnection(connections)); // still as it was
  });

  it('refuses every query when an entry already points at nothing', async () => {
    await sql`insert into marmeon_secret_columns (table_name, column_name) values ('accounts', 'gone')`.execute(bookkeepingConnection(connections));
    connections.metadata().invalidate();
    await expect(connections.get<any>().selectFrom('accounts').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*points at nothing: secret column accounts\.gone/s);
  });
});

describe.runIf(drivers.includes('pgsql' as never))('the search path, on Postgres', () => {
  it('sees the tables an unqualified name finds, also when the first schema of the path is an empty one named like the role', async () => {
    const { connections, close } = await freshConnections('pgsql', { bookkeeping: false });
    try {
      const books = bookkeepingConnection(connections);
      await books.schema.createTable('people').addColumn('id', 'integer').addColumn('hash', 'varchar(20)').execute();
      const { role } = (await sql<{ role: string }>`select current_user as role`.execute(books)).rows[0]!;
      await sql`create schema if not exists ${sql.id(role)}`.execute(books);
      expect((await sql<{ schema: string }>`select current_schema() as schema`.execute(books)).rows[0]!.schema).toBe(role);
      await expect(connections.get<any>().selectFrom('people').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*people/s);
      await migrator(connections, []).migrate(undefined, { adoptExisting: () => {} });
      expect(await connections.get<any>().selectFrom('people').selectAll().execute()).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe.runIf(drivers.includes('pgsql' as never))('tables an extension owns, on Postgres', () => {
  it('count for the relation an unqualified name finds: an extension table in a later schema does not hide an app table of the same name', async () => {
    const { connections, close } = await freshConnections('pgsql', { bookkeeping: false });
    try {
      const books = bookkeepingConnection(connections);
      const { role } = (await sql<{ role: string }>`select current_user as role`.execute(books)).rows[0]!;
      await sql`create extension if not exists citext`.execute(books);
      await sql`create table public.spatial_ref_sys (srid integer)`.execute(books);
      await sql`alter extension citext add table public.spatial_ref_sys`.execute(books);
      await sql`create schema if not exists ${sql.id(role)}`.execute(books);
      await sql`create table ${sql.id(role)}.spatial_ref_sys (srid integer, hash varchar(20))`.execute(books);
      await expect(connections.get<any>().selectFrom('spatial_ref_sys').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*spatial_ref_sys/s);
    } finally {
      await close();
    }
  });

  it('are no tables of the app: the connection counts as empty and `migrate` writes its bookkeeping', async () => {
    const { connections, close } = await freshConnections('pgsql', { bookkeeping: false });
    try {
      const books = bookkeepingConnection(connections);
      await sql`create extension if not exists citext`.execute(books);
      await books.schema.createTable('spatial_ref_sys').addColumn('srid', 'integer').execute();
      await sql`alter extension citext add table spatial_ref_sys`.execute(books);
      expect(await connections.get<any>().selectFrom('spatial_ref_sys').selectAll().execute()).toEqual([]);
      await migrator(connections, []).migrate();
      expect(await allTables(connections.get<any>())).toEqual(expect.arrayContaining(NEW));
      await books.schema.createTable('people').addColumn('id', 'integer').execute();
      await sql`drop table marmeon_versions`.execute(books);
      await expect(connections.get<any>().selectFrom('people').selectAll().execute()).rejects.toThrow(/incomplete/);
    } finally {
      await close();
    }
  });
});

describe('the solutions for bookkeeping that cannot be read', () => {
  const read = (code: 'D1' | 'D2' | 'D3', reason: BookkeepingVersionError['reason']) =>
    new ErrorSolutions(databaseSolutions).find(new BookkeepingVersionError(reason, 'default', `[marmeon:${code}] text`));

  it('names the command for a database not yet moved and for a table to rename, and none for a version it cannot read', async () => {
    expect(await read('D2', 'legacy')).toMatchObject([{ code: 'D2', command: 'marmeon migrate' }]);
    expect(await read('D3', 'foreign')).toMatchObject([{ code: 'D3', command: 'marmeon migrate' }]);
    const [newer] = await read('D1', 'newer');
    expect(newer).toMatchObject({ code: 'D1' });
    expect(newer).not.toHaveProperty('command');
  });
});
