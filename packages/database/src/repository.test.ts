import type { Application, ModuleDefinition, Result } from '@marmeon/core';
import type { Generated } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { isUniqueViolation, Migrator, RecordNotFoundError, Repository, type Connections, type RowOf } from './index.ts';

type Row = RowOf<FixtureTables['users']>;

// `users` has soft deletes and timestamps — its migration says so (`softDeletes()`, `timestamps()`); `articles` neither.
class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;

  findByEmail(email: string) {
    return this.query().select(['id', 'name']).where('email', '=', email).executeTakeFirst();
  }
}

class ArticleRepository extends Repository<'articles', FixtureTables> {
  static table = 'articles' as const;
}

const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url) },
  { name: 'blog', migrations: new URL('./__fixtures__/migrations/blog/', import.meta.url) },
];

describe.each(drivers)('Repository on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let users: UserRepository;
  let articles: ArticleRepository;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    users = new UserRepository(connections);
    articles = new ArticleRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<FixtureTables>().deleteFrom('articles').execute();
    await connections.get<FixtureTables>().deleteFrom('users').execute();
  });

  it('inserts and returns the stored row, finds it, counts it', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    expect(ada).toMatchObject({ name: 'Ada', is_admin: false, balance: '0.00', deleted_at: null });
    expect(await users.find(ada.id)).toEqual(ada);
    expect(await users.findOrFail(ada.id)).toEqual(ada);
    expect(await users.exists(ada.id)).toBe(true);
    expect(await users.exists(ada.id + 1)).toBe(false);
    expect(await users.count()).toBe(1);
    expect(await users.findByEmail('ada@example.com')).toEqual({ id: ada.id, name: 'Ada' });
  });

  it('recognizes a unique violation on this driver (for race-free "already taken" errors)', async () => {
    await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const error = await users.insert({ name: 'Ada 2', email: 'ada@example.com' }).then(() => undefined, (e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error('UNIQUE but not from the database'))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('tryInsert(): a duplicate err when a unique index holds the values — and the surrounding transaction survives it (Postgres aborts it otherwise)', async () => {
    await users.insert({ name: 'Ada', email: 'ada@example.com' });
    await users.transaction(async (inTransaction) => {
      const taken = await inTransaction.tryInsert({ name: 'Ada 2', email: 'ada@example.com' });
      expect(taken).toEqual({ ok: false, error: { kind: 'duplicate' } });
      const added = await inTransaction.tryInsert({ name: 'Alan', email: 'alan@example.com' });
      expect(added).toMatchObject({ ok: true, value: { name: 'Alan', email: 'alan@example.com' } });
      expectTypeOf(added).toEqualTypeOf<Result<Row, { kind: 'duplicate' }>>();
      expect(await inTransaction.count()).toBe(2); // still usable
    });
    expect(await users.count()).toBe(2);
  });

  it('tryUpdate(): a duplicate err when the new value is taken, a missing err without the row, the row otherwise — the transaction survives', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const alan = await users.insert({ name: 'Alan', email: 'alan@example.com' });
    await users.transaction(async (inTransaction) => {
      expect(await inTransaction.tryUpdate(ada.id, { email: 'alan@example.com' })).toEqual({ ok: false, error: { kind: 'duplicate' } });
      const changed = await inTransaction.tryUpdate(ada.id, { email: 'ada@new.example' });
      expect(changed).toMatchObject({ ok: true, value: { email: 'ada@new.example' } });
      expectTypeOf(changed).toEqualTypeOf<Result<Row, { kind: 'duplicate' } | { kind: 'missing' }>>();
    });
    expect(await users.tryUpdate(ada.id + 999, { name: 'Nobody' })).toEqual({ ok: false, error: { kind: 'missing' } });
    // A soft-deleted row is no row to update.
    await users.delete(alan.id);
    expect(await users.tryUpdate(alan.id, { name: 'Ghost' })).toEqual({ ok: false, error: { kind: 'missing' } });
  });

  it('an err of tryInsert() or tryUpdate() returned from a transaction around it rolls that transaction back', async () => {
    await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const result = await connections.transaction(async () => {
      await users.insert({ name: 'Alan', email: 'alan@example.com' });
      return users.tryInsert({ name: 'Ada 2', email: 'ada@example.com' });
    });
    expect(result).toEqual({ ok: false, error: { kind: 'duplicate' } });
    expect(await users.findByEmail('alan@example.com')).toBeUndefined();
    // Taken apart instead of returned, it leaves the transaction alone.
    await connections.transaction(async () => {
      await users.insert({ name: 'Alan', email: 'alan@example.com' });
      const taken = await users.tryUpdate((await users.findByEmail('alan@example.com'))!.id, { email: 'ada@example.com' });
      return taken.ok;
    });
    expect(await users.findByEmail('alan@example.com')).toMatchObject({ name: 'Alan' });
  });

  it('a plain insert-and-catch inside a Postgres transaction leaves it unusable', async () => {
    await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const after = await users
      .transaction(async (inTransaction) => {
        await inTransaction.insert({ name: 'Ada 2', email: 'ada@example.com' }).catch(() => undefined);
        return inTransaction.count();
      })
      .then((count) => `count ${count}`, (error: unknown) => (error as Error).message);
    expect(after).toBe(driver === 'pgsql' ? 'current transaction is aborted, commands ignored until end of transaction block' : 'count 1');
  });

  it('answers a missing row with a 404 that does not tell the client what was looked up', async () => {
    const error = await users.findOrFail(404).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(RecordNotFoundError);
    expect(error).toMatchObject({ status: 404, message: 'Not Found', table: 'users', key: 404 });
  });

  it('updates a row, sets updated_at when the migration has timestamps(), and returns undefined for no row', async () => {
    const old = '2020-01-01T00:00:00.000Z';
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com', created_at: old, updated_at: old });
    const updated = await users.update(ada.id, { name: 'Ada Lovelace' });
    expect(updated).toMatchObject({ name: 'Ada Lovelace', created_at: old });
    expect(updated!.updated_at > old).toBe(true);
    expect(await users.update(ada.id, { updated_at: old })).toMatchObject({ updated_at: old }); // set explicitly: kept
    expect(await users.update(ada.id + 1, { name: 'Nobody' })).toBeUndefined();
    const article = await articles.insert({ user_id: ada.id, title: 'Notes' });
    expect(await articles.update(article.id, { title: 'More notes' })).toEqual({ ...article, title: 'More notes' }); // no updated_at to set
  });

  it('deletes for real when the migration has no softDeletes()', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const article = await articles.insert({ user_id: ada.id, title: 'Notes' });
    expect(await articles.delete(article.id)).toBe(true);
    expect(await articles.delete(article.id)).toBe(false);
    expect(await connections.get<FixtureTables>().selectFrom('articles').selectAll().execute()).toEqual([]);
  });

  it('soft-deletes: hidden from reads and updates, visible withTrashed, restorable, force-deletable', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    expect(await users.delete(ada.id)).toBe(true);
    expect(await users.delete(ada.id)).toBe(false); // already deleted
    expect(await users.find(ada.id)).toBeUndefined();
    expect(await users.count()).toBe(0);
    expect(await users.update(ada.id, { name: 'Ghost' })).toBeUndefined();
    const trashed = await users.query().withTrashed().selectAll().where('id', '=', ada.id).executeTakeFirstOrThrow();
    expect(trashed.deleted_at).toMatch(/Z$/);

    expect(await users.restore(ada.id)).toBe(true);
    expect((await users.find(ada.id))?.deleted_at).toBeNull();
    expect(await users.forceDelete(ada.id)).toBe(true);
    expect(await users.query().withTrashed().selectAll().execute()).toEqual([]);
  });

  it('works across repositories in one transaction with using(trx)', async () => {
    await expect(
      connections.get<FixtureTables>().transaction().execute(async (trx) => {
        const ada = await users.using(trx).insert({ name: 'Ada', email: 'ada@example.com' });
        await articles.using(trx).insert({ user_id: ada.id, title: 'Notes' });
        expect(await users.using(trx).count()).toBe(1);
        throw new Error('roll it all back');
      }),
    ).rejects.toThrow('roll it all back');
    expect(await users.count()).toBe(0);
    expect(await articles.count()).toBe(0);
  });

  it('nests transactions as savepoints — a failed inner one leaves the outer one intact', async () => {
    await users.transaction(async (outer) => {
      await outer.insert({ name: 'Ada', email: 'ada@example.com' });
      await expect(
        outer.transaction(async (inner) => {
          await inner.insert({ name: 'Alan', email: 'alan@example.com' });
          throw new Error('inner failed');
        }),
      ).rejects.toThrow('inner failed');
      await outer.transaction((inner) => inner.insert({ name: 'Grace', email: 'grace@example.com' }));
    });
    const names = (await users.query().select('name').orderBy('id').execute()).map((u) => u.name);
    expect(names).toEqual(['Ada', 'Grace']);
  });
});

describe('Repository classes', () => {
  it('keep their private members in using(trx) — and refuse it with more dependencies than the connection', async () => {
    class Tagged extends Repository<'users', FixtureTables> {
      static table = 'users' as const;
      #tag = 'private';
      tag() {
        return this.#tag;
      }
    }
    const connections = { get: () => ({}) } as unknown as Connections;
    expect(new Tagged(connections).using({} as never).tag()).toBe('private');

    class Busy extends Repository<'users', FixtureTables> {
      static table = 'users' as const;
      constructor(connections: Connections, _clock: { now(): Date }) {
        super(connections);
      }
    }
    expect(() => new Busy(connections, { now: () => new Date() }).using({} as never)).toThrow(
      'Busy.using() builds the repository with the transaction as its only dependency, but its constructor takes 2.',
    );
  });

  it('need their table as a runtime value', () => {
    class Tableless extends Repository<'users', FixtureTables> {}
    expect(() => new Tableless({ get: () => ({}) } as unknown as Connections)).toThrow(
      "Tableless needs its table as a runtime value: static table = '…' as const;",
    );
  });
});

describe.each(drivers)('Repository as a route binder on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
  });
  afterAll(() => close());

  class Users extends Repository<'users', FixtureTables> {
    static table = 'users' as const;
  }
  class Articles extends Repository<'articles', FixtureTables> {
    static table = 'articles' as const;
  }
  class ArticlesBySlug extends Repository<'articles', FixtureTables> {
    static table = 'articles' as const;
    static routeKey = 'slug';
    static routeKeyPattern = /^[a-z0-9-]+$/;
  }
  const ctx = {} as never;

  it('finds by id, scoped by the parent, by another key — and never queries malformed values', async () => {
    const users = new Users(connections);
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const alan = await users.insert({ name: 'Alan', email: 'alan@example.com' });
    const articles = new Articles(connections);
    const post = await articles.insert({ user_id: ada.id, title: 'Notes', slug: 'notes' });

    expect(await users.resolveRouteBinding(String(ada.id), { ctx })).toMatchObject({ name: 'Ada' });
    expect(await articles.resolveRouteBinding(String(post.id), { ctx, scope: { param: 'user', parent: ada, column: 'user_id' } })).toMatchObject({ title: 'Notes' });
    // Alan's page, Ada's article: not found — the IDOR the scope prevents
    expect(await articles.resolveRouteBinding(String(post.id), { ctx, scope: { param: 'user', parent: alan, column: 'user_id' } })).toBeUndefined();
    expect(await new ArticlesBySlug(connections).resolveRouteBinding('notes', { ctx })).toMatchObject({ id: post.id });

    const queries: string[] = [];
    connections.onQuery((query) => queries.push(query.sql));
    expect(await users.resolveRouteBinding('abc', { ctx })).toBeUndefined();
    expect(await users.resolveRouteBinding('1e3', { ctx })).toBeUndefined();
    expect(await new ArticlesBySlug(connections).resolveRouteBinding("x' or 1=1", { ctx })).toBeUndefined();
    expect(queries).toEqual([]);

    await users.delete(alan.id); // soft-deleted rows do not bind either
    expect(await users.resolveRouteBinding(String(alan.id), { ctx })).toBeUndefined();
  });
});

describe.each(drivers)('Repository without markers on %s', (driver) => {
  interface LogTables {
    log_entries: { id: Generated<number>; message: string; deleted_at: string | null; updated_at: string | null };
  }
  class LogEntries extends Repository<'log_entries', LogTables> {
    static table = 'log_entries' as const;
  }
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    // Columns named like the markers' — but no migration said `softDeletes()` or `timestamps()`.
    await connections
      .get()
      .schema.createTable('log_entries')
      .addColumn('id', driver === 'sqlite' ? 'integer' : 'bigint', (c) => (driver === 'sqlite' ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity()))
      .addColumn('message', 'text', (c) => c.notNull())
      .addColumn('deleted_at', 'text')
      .addColumn('updated_at', 'text')
      .execute();
  });
  afterAll(() => close());

  it('deletes for real, reads every row and leaves updated_at alone — a column is no marker', async () => {
    const entries = new LogEntries(connections);
    const kept = await entries.insert({ message: 'kept', deleted_at: '2020-01-01' });
    const gone = await entries.insert({ message: 'gone' });
    expect(await entries.update(kept.id, { message: 'still kept' })).toMatchObject({ updated_at: null });
    expect(await entries.delete(gone.id)).toBe(true);
    expect(await entries.query().select('message').execute()).toEqual([{ message: 'still kept' }]);
    expect(await connections.get<LogTables>().selectFrom('log_entries').select('id').execute()).toHaveLength(1);
  });
});
