import { mkdtempSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { Kysely, sql, SqliteDialect, type CompiledQuery, type DatabaseConnection, type QueryResult } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import { testEncrypter } from './__fixtures__/encrypter.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { deriveRelations, introspect } from './introspection.ts';
import { MarmeonDriver } from './driver.ts';
import { SchemaMetadata } from './metadata.ts';
import { softDelete, softDeleteFilter } from './schema-resolver.ts';
import { Connections, cursorPaginate, Migrator, Repository } from './index.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'blog', migrations: fixtures('relations') },
];

class CommentRepository extends Repository<'comments', FixtureTables> {
  static table = 'comments' as const;
}

/** Two `Connections` on one database — the second one a process that has not loaded anything yet. */
async function sharedDatabase(driver: 'sqlite' | 'pgsql') {
  const fresh = driver === 'sqlite' ? { options: { driver: 'sqlite' as const, database: join(mkdtempSync(join(tempDir('marmeon-metadata-'), 'db-')), 'app.sqlite') }, drop: async () => {} } : await freshDatabase(driver);
  const open = () => new Connections({ connections: { default: fresh.options }, root: '/', logger: silent });
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
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
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
    const run = <R>(query: string) => sql.raw<R>(query).execute(db).then((result) => result.rows);
    expect(metadata.relations).toEqual(deriveRelations(await introspect(run, driver)).relations);
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
      'A soft delete of "comments" runs as an update of the table by its WHERE; it cannot keep orderBy.',
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

  it('resolves only its own queries — an infrastructure connection’s placeholder fails at the database instead', async () => {
    const fresh = cold();
    const infrastructure = fresh.infrastructure<FixtureTables>();
    await expect(infrastructure.selectFrom('comments').select('body').where(softDeleteFilter('comments')).execute()).rejects.toThrow(/__marmeon_unresolved_/);
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

  it.runIf(driver === 'sqlite')('a query built while a migration adds soft deletes waits for it — and filters what it soft-deleted', async () => {
    const db = connections.get<FixtureTables>();
    await seed(db);
    await db.updateTable('comments').set({ deleted_at: null }).execute();
    const posts = cold();
    let started!: () => void;
    const inside = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    // The migration's steps by hand: the column, then the rows it soft-deletes, a query on its own connection (which
    // loads the metadata again, without the marker), and the marker last.
    const migration = posts.transaction(async (transaction) => {
      const trx = transaction as unknown as Kysely<any>;
      await trx.schema.alterTable('posts').addColumn('deleted_at', 'datetime').execute();
      await trx.updateTable('posts').set({ deleted_at: new Date().toISOString() }).execute();
      await posts.get<any>().selectFrom('users').select('id').execute();
      started();
      await finished;
      await trx.insertInto('schema_markers').values({ table_name: 'posts', column_name: '', marker: 'soft_deletes', value: null }).execute();
    });
    await inside;
    class Posts extends Repository<'posts', FixtureTables> {
      static table = 'posts' as const;
    }
    const titles = new Posts(posts).query().select('title').execute(); // built now, runs once the migration let go of the file
    finish();
    await migration;
    expect(await titles).toEqual([]);
    await posts.get<any>().schema.alterTable('posts').dropColumn('deleted_at').execute();
    await posts.get<any>().deleteFrom('schema_markers').where('table_name', '=', 'posts').where('marker', '=', 'soft_deletes').execute();
  });

  // Postgres: the migration holds one connection of the pool, a request uses another. The request's query depends on the marks the
  // migration is changing: it must not be resolved with what was loaded meanwhile — neither the committed view from before the
  // commit, nor the migration's own view of a transaction that then rolls back.
  describe.runIf(driver === 'pgsql')('while a migration on another connection of the pool is open', () => {
    class Posts extends Repository<'posts', FixtureTables> {
      static table = 'posts' as const;
    }
    const pause = () => {
      let resolve!: () => void;
      return { done: new Promise<void>((r) => (resolve = r)), resolve: () => resolve() };
    };
    const titles = async (db: Kysely<any>) => (await db.selectFrom('posts').select('title').orderBy('title').execute()).map((row) => row.title);
    const dropSoftDeletes = async (db: Kysely<any>) => {
      await sql`alter table posts drop column if exists deleted_at`.execute(db);
      await db.deleteFrom('schema_markers').where('table_name', '=', 'posts').where('marker', '=', 'soft_deletes').execute();
    };

    it('waits for its commit — the rows it soft-deleted stay hidden, and a delete stays soft', async () => {
      const app = cold();
      const db = app.get<any>();
      const ada = await db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).returning('id').executeTakeFirstOrThrow();
      await db.insertInto('posts').values([{ author_id: ada.id, title: 'old' }, { author_id: ada.id, title: 'new' }]).execute();
      const newest = await db.selectFrom('posts').select('id').where('title', '=', 'new').executeTakeFirstOrThrow();
      await db.selectFrom('users').select('id').execute(); // loaded: the request below starts warm
      const inside = pause();
      const finish = pause();
      try {
        const migration = app.transaction(async (transaction) => {
          const trx = transaction as unknown as Kysely<any>;
          await trx.schema.alterTable('posts').addColumn('deleted_at', 'timestamptz').execute();
          await trx.updateTable('posts').set({ deleted_at: new Date() }).where('title', '=', 'old').execute();
          await trx.insertInto('schema_markers').values({ table_name: 'posts', column_name: '', marker: 'soft_deletes', value: null }).execute();
          inside.resolve();
          await finish.done;
        });
        await inside.done;
        // Outside the migration's call chain: another connection of the pool, which can load the committed view right now.
        const read = new Posts(app).query().select('title').execute();
        const deleted = new Posts(app).delete(newest.id);
        await sleep(100);
        finish.resolve();
        await migration;
        expect((await read).map((row) => row.title)).not.toContain('old'); // 'new' too, if the delete ran first
        expect(await deleted).toBe(true);
        expect(await titles(db)).toEqual(['new', 'old']); // both rows are still there: the delete was soft
      } finally {
        await dropSoftDeletes(db);
      }
    });

    it('waits for its rollback — a mark it dropped and then rolled back still filters', async () => {
      const app = cold();
      const db = app.get<any>();
      const ada = await db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).returning('id').executeTakeFirstOrThrow();
      await db.schema.alterTable('posts').addColumn('deleted_at', 'timestamptz').execute();
      await db.insertInto('schema_markers').values({ table_name: 'posts', column_name: '', marker: 'soft_deletes', value: null }).execute();
      await db.insertInto('posts').values([{ author_id: ada.id, title: 'kept' }, { author_id: ada.id, title: 'deleted', deleted_at: new Date() }]).execute();
      const inside = pause();
      const finish = pause();
      try {
        const migration = app.transaction(async (transaction) => {
          const trx = transaction as unknown as Kysely<any>;
          await trx.schema.alterTable('posts').dropColumn('deleted_at').execute();
          await trx.deleteFrom('schema_markers').where('table_name', '=', 'posts').where('marker', '=', 'soft_deletes').execute();
          await app.get<any>().selectFrom('users').select('id').execute(); // loads the migration's own view: no soft deletes
          inside.resolve();
          await finish.done;
          throw new Error('the migration failed');
        });
        await inside.done;
        const read = new Posts(app).query().select('title').execute();
        await sleep(100);
        finish.resolve();
        await expect(migration).rejects.toThrow('the migration failed');
        expect(await read).toEqual([{ title: 'kept' }]);
      } finally {
        await dropSoftDeletes(db);
      }
    });
  });

  it('gives up waiting for another connection’s schema change after the limit — with an error, never a guess', async () => {
    const app = cold();
    await app.get<any>().selectFrom('users').select('id').execute();
    const metadata = app.metadata();
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
    const metadata = new SchemaMetadata('sqlite');
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

  it('is stale after a schema change has run — also when it was loaded again while the change was under way', async () => {
    const metadata = new SchemaMetadata('sqlite');
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
  await new SchemaMetadata('sqlite').refresh({
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
    const connections = new Connections({ connections: { default: { driver: 'sqlite', database: ':memory:' } }, root: '/', logger: silent });
    try {
      const row = await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(connections.get());
      expect(row.rows).toEqual([{ foreign_keys: 1 }]);
    } finally {
      await connections.destroy();
    }
  });
});
