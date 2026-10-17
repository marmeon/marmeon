import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleDefinition } from '@marmeon/core';
import { CompiledQuery, Kysely, sql, SqliteDialect, type DatabaseConnection, type QueryResult } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appOf, drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import { testEncrypter } from './__fixtures__/encrypter.ts';
import './__fixtures__/relations.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { deriveRelations } from './introspection.ts';
import { MigrationStateError } from './migration-state.ts';
import { emptyProjection, factsOf } from './schema/projection.ts';
import { MarmeonDriver } from './driver.ts';
import { changesSchema, isRawSchemaChange, SchemaMetadata } from './metadata.ts';
import { softDelete, softDeleteFilter } from './schema-resolver.ts';
import { Connections, cursorPaginate, Migrator, Repository } from './index.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'blog', migrations: fixtures('relations') },
];
// A cold `Connections` is a process that starts: it learns the schema from these modules' migrations, cached under `root`.
const root = tempDir('marmeon-metadata-app-');
const app = appOf(modules, root);

class CommentRepository extends Repository<'comments', FixtureTables> {
  static table = 'comments' as const;
}

/** Two `Connections` on one database — the second one a process that has not loaded anything yet. */
async function sharedDatabase(driver: 'sqlite' | 'pgsql', { managed = true }: { managed?: boolean } = {}) {
  const fresh = driver === 'sqlite' ? { options: { driver: 'sqlite' as const, database: join(mkdtempSync(join(tempDir('marmeon-metadata-'), 'db-')), 'app.sqlite') }, drop: async () => {} } : await freshDatabase(driver);
  const options = managed ? fresh.options : { ...fresh.options, managed: false };
  const open = () => new Connections({ connections: { default: options }, root, logger: silent, ...(managed ? { app } : {}) });
  const first = open();
  return { first, open, drop: fresh.drop };
}

describe.each(drivers)('schema metadata on %s', (driver) => {
  let connections: Connections;
  let open: () => Connections;
  let drop: () => Promise<void>;
  const others: Connections[] = [];
  const cold = () => {
    const connections = open();
    others.push(connections);
    return connections;
  };

  beforeAll(async () => {
    ({ first: connections, open, drop } = await sharedDatabase(driver));
    await new Migrator(app, connections).migrate();
  });
  afterAll(async () => {
    for (const other of others) await other.destroy();
    await connections.destroy();
    await drop();
  });
  beforeEach(async () => {
    await connections.get<FixtureTables>().deleteFrom('comments').execute();
    await connections.get<FixtureTables>().deleteFrom('posts').execute();
    await connections.get<FixtureTables>().deleteFrom('users').execute();
  });

  const seed = async (db: Kysely<FixtureTables>) => {
    const ada = await db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).returning('id').executeTakeFirstOrThrow();
    const post = await db.insertInto('posts').values({ author_id: ada.id, title: 'Notes' }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('comments').values([{ post_id: post.id, user_id: ada.id, body: 'kept' }, { post_id: post.id, user_id: ada.id, body: 'deleted', deleted_at: new Date() }]).execute();
  };

  it('loads relations, markers and the columns a relation may load — derived like db:types does', async () => {
    const db = connections.get<FixtureTables>();
    await db.selectFrom('users').select('id').execute();
    const metadata = connections.metadata();
    expect(metadata.relations).toEqual(deriveRelations(factsOf(connections.projection(), driver)).relations);
    expect(metadata.relations.get('posts')?.get('tags')).toMatchObject({ kind: 'belongsToMany', pivot: 'post_tag' });
    expect([...metadata.softDeletes].sort()).toEqual(['comments', 'users']);
    expect([...metadata.timestamps].sort()).toEqual(['comments', 'posts', 'users']);
    expect(metadata.columns.get('post_stats')).toEqual(['post_id', 'views']);
    expect(metadata.problems).toEqual([]);
  });

  it('resolves a soft-delete filter on the first query of a process — before anything was loaded', async () => {
    await seed(connections.get<FixtureTables>());
    const fresh = cold();
    const log: string[] = [];
    fresh.onQuery((query) => log.push(query.sql));
    const bodies = (await new CommentRepository(fresh).query().select('body').execute()).map((row) => row.body);
    expect(bodies).toEqual(['kept']);
    // One query in the log, the SQL that ran — the catalog queries that loaded the metadata are not in it.
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/"comments"\."deleted_at" is null/);
    expect(log[0]).not.toMatch(/__marmeon/);
  });

  it('resolves every read and write of a repository on a process that has loaded nothing yet', async () => {
    await seed(connections.get<FixtureTables>());
    const [kept, deleted] = await connections.get<FixtureTables>().selectFrom('comments').select(['id', 'body']).orderBy('id').execute();
    const comments = () => new CommentRepository(cold());
    expect(await comments().count()).toBe(1);
    expect(await comments().exists(deleted!.id)).toBe(false);
    expect(await comments().find(deleted!.id)).toBeUndefined();
    expect(await comments().resolveRouteBinding(String(deleted!.id), { ctx: {} as never })).toBeUndefined();
    const repository = comments();
    expect((await repository.paginate(repository.query().select('body').orderBy('id'), { page: 1, perPage: 10 })).meta.total).toBe(1);
    expect((await cursorPaginate(comments().query().select(['id', 'body']), { column: 'id', encrypter: testEncrypter() })).data).toEqual([kept]);
    expect(await comments().update(deleted!.id, { body: 'changed' })).toBeUndefined(); // a soft-deleted row is left alone
    const old = '2020-01-01T00:00:00.000Z';
    await connections.get<FixtureTables>().updateTable('comments').set({ updated_at: old }).execute();
    expect((await comments().update(kept!.id, { body: 'changed' }))!.updated_at > old).toBe(true);
    expect(await comments().delete(kept!.id)).toBe(true);
    expect(await comments().delete(kept!.id)).toBe(false);
    expect(await connections.get<FixtureTables>().selectFrom('comments').select('id').execute()).toHaveLength(2); // both still there, deleted softly
  });

  it('refuses a soft delete with parts an update by the WHERE would lose', async () => {
    await expect(connections.get<FixtureTables>().deleteFrom('comments').where(softDelete('comments')).orderBy('id').execute()).rejects.toThrow(
      '[marmeon:D12] A soft delete of "comments" runs as an update of the table by its WHERE; it cannot keep orderBy.',
    );
  });

  it('resolves two executions of one query built while nothing was loaded', async () => {
    await seed(connections.get<FixtureTables>());
    const query = new CommentRepository(cold()).query().select('body');
    const [all, kept] = await Promise.all([query.execute(), query.where('body', '=', 'kept').execute()]);
    expect(all.map((row) => row.body)).toEqual(['kept']);
    expect(kept.map((row) => row.body)).toEqual(['kept']);
  });

  it.runIf(driver === 'sqlite')('resolves a streamed query the same way', async () => {
    await seed(connections.get<FixtureTables>());
    const rows: string[] = [];
    for await (const row of new CommentRepository(cold()).query().select('body').stream()) rows.push(row.body);
    expect(rows).toEqual(['kept']);
  });

  it('resolves only its own queries — an infrastructure connection’s placeholder is refused, not resolved', async () => {
    const fresh = cold();
    const infrastructure = fresh.infrastructure<FixtureTables>();
    await expect(infrastructure.selectFrom('comments').select('body').where(softDeleteFilter('comments')).execute()).rejects.toThrow(
      `only the app's connection resolves — it was not sent: it runs on the database connection "default" without Marmeon's plugins`,
    );
  });
});

// A database another tool manages (`managed: false`): the schema is read from the catalog, and a change to it makes what was loaded stale.
describe.each(drivers)('schema metadata of a connection another tool manages, on %s', (driver) => {
  let connections: Connections;
  let open: () => Connections;
  let drop: () => Promise<void>;
  const others: Connections[] = [];
  const cold = () => {
    const connections = open();
    others.push(connections);
    return connections;
  };

  beforeAll(async () => {
    ({ first: connections, open, drop } = await sharedDatabase(driver, { managed: false }));
    await sql`create table users (id integer primary key, name varchar(255))`.execute(connections.get());
  });
  afterAll(async () => {
    for (const other of others) await other.destroy();
    await connections.destroy();
    await drop();
  });

  it('reads the columns and keys from the catalog, and knows no secret column, no soft delete, no timestamps', async () => {
    const fresh = cold();
    await fresh.get<any>().selectFrom('users').select('id').execute();
    const metadata = fresh.metadata();
    expect([...(metadata.kinds.get('users')?.keys() ?? [])]).toEqual(['id', 'name']);
    expect(metadata.secrets.size).toBe(0);
    expect(metadata.softDeletes.size).toBe(0);
    expect(metadata.timestamps.size).toBe(0);
  });

  it('is not fresh while it loads, and never while a transaction that changed the schema is open', async () => {
    const fresh = cold();
    const metadata = fresh.metadata();
    expect(metadata.fresh).toBe(false);
    const loading = fresh.get<any>().selectFrom('users').select('id').execute();
    await Promise.resolve();
    expect(metadata.fresh).toBe(false);
    await loading;
    expect(metadata.fresh).toBe(true);

    await fresh.transaction(async (transaction) => {
      const trx = transaction as unknown as Kysely<any>;
      await trx.schema.createTable('scratch').addColumn('id', 'integer').execute();
      expect(metadata.fresh).toBe(false);
      await fresh.get<any>().selectFrom('users').select('id').execute(); // joins the transaction and loads again on its connection
      expect(metadata.fresh).toBe(false);
      await trx.schema.dropTable('scratch').execute();
    });
    await fresh.get<any>().selectFrom('users').select('id').execute();
    expect(metadata.fresh).toBe(true);

    await expect(
      fresh.transaction(async (transaction) => {
        const trx = transaction as unknown as Kysely<any>;
        await trx.schema.createTable('scratch').addColumn('id', 'integer').execute();
        throw new Error('undo it');
      }),
    ).rejects.toThrow('undo it');
    expect(metadata.fresh).toBe(false);
    await fresh.get<any>().selectFrom('users').select('id').execute();
    expect(metadata.fresh).toBe(true);
  });

  it('keeps what it loaded when a savepoint without a schema change rolls back — and loads again when one with a change does', async () => {
    const fresh = cold();
    const metadata = fresh.metadata();
    const read = () => fresh.get<any>().selectFrom('users').select('id').execute();
    await read();
    await fresh.transaction(async () => {
      await read();
      // The shape of a tryInsert() on a taken address: a savepoint, rolled back — nothing about the schema changed.
      await expect(
        fresh.transaction(async () => {
          await read();
          throw new Error('undo');
        }),
      ).rejects.toThrow('undo');
      expect(metadata.fresh).toBe(true);
      await expect(
        fresh.transaction(async (transaction) => {
          await (transaction as unknown as Kysely<any>).schema.createTable('scratch').addColumn('id', 'integer').execute();
          await read(); // the transaction's own view, with the table
          expect(metadata.kinds.has('scratch')).toBe(true);
          throw new Error('undo');
        }),
      ).rejects.toThrow('undo');
      expect(metadata.fresh).toBe(false);
      await read();
      expect(metadata.kinds.has('scratch')).toBe(false);
    });
    await read();
    expect(metadata.fresh).toBe(true);
  });

  it('treats a savepoint Kysely rolls back itself the same way', async () => {
    const fresh = cold();
    const metadata = fresh.metadata();
    await fresh.get<any>().selectFrom('users').select('id').execute();
    const trx = await fresh.get<any>().startTransaction().execute();
    try {
      const plain = await trx.savepoint('plain').execute();
      await plain.selectFrom('users').select('id').execute();
      await plain.rollbackToSavepoint('plain').execute();
      expect(metadata.fresh).toBe(true);
      const ddl = await trx.savepoint('ddl').execute();
      await ddl.schema.createTable('scratch').addColumn('id', 'integer').execute();
      await ddl.selectFrom('users').select('id').execute();
      expect(metadata.kinds.has('scratch')).toBe(true);
      await ddl.rollbackToSavepoint('ddl').execute();
      await trx.selectFrom('users').select('id').execute();
      expect(metadata.kinds.has('scratch')).toBe(false);
    } finally {
      await trx.rollback().execute();
    }
    await fresh.get<any>().selectFrom('users').select('id').execute();
    expect(metadata.fresh).toBe(true);
  });

  it('is stale after a schema change outside a transaction — also after an index — not before it ran', async () => {
    const fresh = cold();
    const metadata = fresh.metadata();
    await fresh.get<any>().selectFrom('users').select('id').execute();
    expect(metadata.fresh).toBe(true);
    await fresh.get<any>().schema.createIndex('users_name_index').on('users').column('name').execute();
    expect(metadata.fresh).toBe(false);
    await fresh.get<any>().selectFrom('users').select('id').execute();
    expect(metadata.fresh).toBe(true);
    await fresh.get<any>().schema.dropIndex('users_name_index').execute();
    expect(metadata.fresh).toBe(false);
  });

  it('is stale after raw DDL — outside a transaction, and held inside one', async () => {
    const fresh = cold();
    const metadata = fresh.metadata();
    const db = fresh.get<any>();
    const read = () => db.selectFrom('users').select('id').execute();
    await read();
    await sql`create table raw_probe (id integer)`.execute(db);
    expect(metadata.fresh).toBe(false);
    await read();
    expect(metadata.fresh).toBe(true);
    expect(metadata.kinds.has('raw_probe')).toBe(true);
    await sql`alter table raw_probe add column pinned integer`.execute(db);
    expect(metadata.fresh).toBe(false);
    await read();
    await sql`create unique index raw_probe_pinned on raw_probe (pinned)`.execute(db);
    expect(metadata.fresh).toBe(false);
    await read();
    await fresh.transaction(async (transaction) => {
      await read();
      await sql`drop table raw_probe`.execute(transaction as unknown as Kysely<any>);
      await read(); // the transaction's own view
      expect(metadata.fresh).toBe(false);
    });
    await read();
    expect(metadata.fresh).toBe(true);
    expect(metadata.kinds.has('raw_probe')).toBe(false);
  });

  it('does not reload for raw SQL that only mentions DDL — a reload would be measurably slower', async () => {
    const fresh = cold();
    const metadata = fresh.metadata();
    const db = fresh.get<any>();
    await db.selectFrom('users').select('id').execute();
    expect(metadata.fresh).toBe(true);
    for (const statement of [
      sql`select 'alter table x'`,
      sql`/* create */ select 1`,
      sql`-- drop
select 1`,
      sql`with created as (select 1 as one) select * from created`,
      sql`select 'a; drop table users'`,
    ]) {
      await statement.execute(db);
      expect(metadata.fresh).toBe(true);
    }
  });

  it('gives up waiting for another connection’s schema change after the limit — with an error, never a guess', async () => {
    const fresh = cold();
    await fresh.get<any>().selectFrom('users').select('id').execute();
    const metadata = fresh.metadata();
    const migration = {};
    metadata.hold(migration);
    try {
      await expect(metadata.settle({} as never, {}, { limit: 20, name: 'default' })).rejects.toThrow(
        'A query on the database connection "default" waited 0.02 s for a transaction that changes the schema to end',
      );
    } finally {
      metadata.release(migration);
    }
  });
});

describe('schema metadata, unit', () => {
  /** A connection whose statements answer no rows — `sql` waits on `gate` when it is that statement. */
  const fake = (gated?: { sql: string; gate: Promise<void> }): DatabaseConnection => ({
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      if (gated && query.sql === gated.sql) await gated.gate;
      return { rows: [] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {},
  });
  const gate = () => {
    let open!: () => void;
    return { gate: new Promise<void>((resolve) => (open = resolve)), open: () => open() };
  };

  it('is not fresh while it loads again — what it had is being replaced', async () => {
    const metadata = new SchemaMetadata('sqlite', 'default', false);
    await metadata.refresh(fake());
    expect(metadata.fresh).toBe(true);
    metadata.invalidate();
    const { gate: slow, open } = gate();
    const reloading = metadata.refresh(fake({ sql: (await firstCatalogQuery()), gate: slow }));
    expect(metadata.fresh).toBe(false);
    open();
    await reloading;
    expect(metadata.fresh).toBe(true);
  });

  it('is not ready when a reload comes while the database is compared: the files are compared again, and refused if they must be', async () => {
    const { gate: slow, open } = gate();
    let comparisons = 0;
    const follow = async () => {
      // The first comparison is with the files as they were; the files have a migration the database lacks by the second.
      if (++comparisons === 1) return slow;
      throw new MigrationStateError('pending', 'other', 'pending', ['2026_01_01_000000_new']);
    };
    const metadata = new SchemaMetadata('sqlite', 'other', true, { projection: async () => emptyProjection, follow });
    const loading = metadata.refresh(fake());
    await Promise.resolve();
    metadata.reload();
    open();
    await expect(loading).rejects.toBeInstanceOf(MigrationStateError);
    expect(metadata.ready).toBe(false);
  });

  it('sends no catalog query after a savepoint rolled back without a schema change — and loads again after one with it', async () => {
    const metadata = new SchemaMetadata('sqlite', 'default', false);
    const sent: string[] = [];
    const connection: DatabaseConnection = {
      async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
        sent.push(query.sql);
        return { rows: [] };
      },
      async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {},
    };
    const driver = new MarmeonDriver(
      { init: async () => {}, acquireConnection: async () => connection, releaseConnection: async () => {}, beginTransaction: async () => {}, commitTransaction: async () => {}, rollbackTransaction: async () => {}, destroy: async () => {} },
      { name: 'default', target: 'fake', metadata },
    );
    const acquired = await driver.acquireConnection();
    const loaded = sent.length;
    expect(loaded).toBeGreaterThan(0);
    await driver.beginTransaction(acquired, {});
    await driver.beginTransaction(acquired, {});
    await driver.rollbackTransaction(acquired);
    await metadata.refresh(connection, acquired);
    expect(sent.slice(loaded)).toEqual(['savepoint marmeon_savepoint_1', 'rollback to savepoint marmeon_savepoint_1']);
    expect(metadata.fresh).toBe(true);

    const ddl = new Kysely<any>({ dialect: new SqliteDialect({ database: async () => ({}) as never }) }).schema.createTable('x').addColumn('id', 'integer').compile();
    await driver.beginTransaction(acquired, {});
    await acquired.executeQuery(ddl);
    await metadata.refresh(connection, acquired); // the transaction's own view
    const before = sent.length;
    await driver.rollbackTransaction(acquired);
    await metadata.refresh(connection, acquired);
    expect(sent.length - before).toBeGreaterThan(1); // the rollback, then the catalog again
    await driver.rollbackTransaction(acquired);
    await driver.releaseConnection(acquired);
  });

  it.each([
    ['rollback to savepoint sp', true],
    ['ROLLBACK TO SAVEPOINT "sp"', true],
    ['rollback to sp', true],
    ['/* undo */ rollback to savepoint sp', true],
    ['-- undo\nrollback to savepoint sp', true],
    ['rollback transaction to savepoint sp', true],
    ['rollback work to sp', true],
    ['select 1; rollback to sp', true],
    ['; rollback to sp', true],
    // Any statement that says it: a false alarm costs one load.
    ["select 'rollback to savepoint sp'", true],
    ['release savepoint sp', false],
    ['select 1', false],
  ])('loads again after a hand-written %j while the transaction changed the schema: %s', async (statement, undone) => {
    const metadata = new SchemaMetadata('sqlite', 'default', false);
    const sent: string[] = [];
    const connection: DatabaseConnection = {
      async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
        sent.push(query.sql);
        return { rows: [] };
      },
      async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {},
    };
    const driver = new MarmeonDriver(
      { init: async () => {}, acquireConnection: async () => connection, releaseConnection: async () => {}, beginTransaction: async () => {}, commitTransaction: async () => {}, rollbackTransaction: async () => {}, destroy: async () => {} },
      { name: 'default', target: 'fake', metadata },
    );
    const acquired = await driver.acquireConnection();
    await driver.beginTransaction(acquired, {});
    await acquired.executeQuery(new Kysely<any>({ dialect: new SqliteDialect({ database: async () => ({}) as never }) }).schema.createTable('x').addColumn('id', 'integer').compile());
    await metadata.refresh(connection, acquired);
    await acquired.executeQuery(CompiledQuery.raw(statement));
    const before = sent.length;
    await metadata.refresh(connection, acquired);
    expect(sent.length > before).toBe(undone);
    await driver.rollbackTransaction(acquired);
    await driver.releaseConnection(acquired);
  });

  it('takes DDL for a schema change and a write to a table for none', () => {
    const builder = new Kysely<any>({ dialect: new SqliteDialect({ database: async () => ({}) as never }) });
    expect(changesSchema(builder.schema.createTable('x').addColumn('id', 'integer').toOperationNode())).toBe(true);
    expect(changesSchema(builder.schema.dropTable('x').toOperationNode())).toBe(true);
    expect(changesSchema(builder.insertInto('users').values({ name: 'a' }).toOperationNode())).toBe(false);
    expect(changesSchema(builder.deleteFrom('migrations').toOperationNode())).toBe(false);
  });

  it('is stale after a schema change has run — also when it was loaded again while the change was under way', async () => {
    const metadata = new SchemaMetadata('sqlite', 'default', false);
    const { gate: slow, open } = gate();
    const ddl = new Kysely<any>({ dialect: new SqliteDialect({ database: async () => ({}) as never }) }).schema.createTable('x').addColumn('id', 'integer').compile();
    const connection = fake({ sql: ddl.sql, gate: slow });
    const driver = new MarmeonDriver(
      { init: async () => {}, acquireConnection: async () => connection, releaseConnection: async () => {}, beginTransaction: async () => {}, commitTransaction: async () => {}, rollbackTransaction: async () => {}, destroy: async () => {} },
      { name: 'default', target: 'fake', metadata },
    );
    const acquired = await driver.acquireConnection();
    const running = acquired.executeQuery(ddl);
    await metadata.refresh(fake()); // another connection loads meanwhile — before the table exists
    expect(metadata.fresh).toBe(true);
    open();
    await running;
    expect(metadata.fresh).toBe(false);
    await driver.releaseConnection(acquired);
  });
});

/** The first statement a load sends (to hold it there). */
async function firstCatalogQuery(): Promise<string> {
  const sent: string[] = [];
  await new SchemaMetadata('sqlite', 'default', false).refresh({
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      sent.push(query.sql);
      return { rows: [] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {},
  });
  return sent[0]!;
}

describe('SQLite connections', () => {
  it('enforce foreign keys', async () => {
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: ':memory:' } }, root, logger: silent });
    try {
      const row = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(connections.get());
      expect(row.rows).toEqual([{ foreign_keys: 1 }]);
    } finally {
      await connections.destroy();
    }
  });
});

describe('isRawSchemaChange', () => {
  it('classifies a literal of ten megabytes without overflowing the regex stack', () => {
    expect(isRawSchemaChange(`select '${'a'.repeat(10_000_000)}'`)).toBe(false);
    expect(isRawSchemaChange(`select '${"b''".repeat(5_000_000)}'; drop table x`)).toBe(true);
  });

  it('recognizes a statement that starts with create, alter or drop', () => {
    expect(isRawSchemaChange('ALTER TABLE users ADD COLUMN x integer')).toBe(true);
    expect(isRawSchemaChange('  \n create index i on users (name)')).toBe(true);
    expect(isRawSchemaChange('/* note */ -- more\n drop table users')).toBe(true);
    expect(isRawSchemaChange('select 1; drop table users')).toBe(true);
  });

  it('ignores the words anywhere else', () => {
    expect(isRawSchemaChange('select 1')).toBe(false);
    expect(isRawSchemaChange("select 'drop table x'")).toBe(false);
    expect(isRawSchemaChange('select "alter" from t')).toBe(false);
    expect(isRawSchemaChange('/* create */ select 1')).toBe(false);
    expect(isRawSchemaChange('-- drop\nselect 1')).toBe(false);
    expect(isRawSchemaChange('with created as (select 1) select * from created')).toBe(false);
    expect(isRawSchemaChange('select dropped, altered, creates from t')).toBe(false);
    expect(isRawSchemaChange('select $q$ ; drop table x $q$')).toBe(false);
    expect(isRawSchemaChange(`select $${'t'.repeat(200)}$ ; drop table x $${'t'.repeat(200)}$`)).toBe(false);
    expect(isRawSchemaChange('select a$b$c from t; alter table t add c int')).toBe(true);
    expect(isRawSchemaChange('select $1; select $tag$a$tag$; drop table x')).toBe(true);
  });
});
