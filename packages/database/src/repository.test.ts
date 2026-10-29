import type { Application, ModuleDefinition, Result } from '@marmeon/core';
import { sql, type Generated } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { RouteBindingContext } from '@marmeon/router';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { isUniqueViolation, Migrator, type DuplicateError, RecordNotFoundError, Repository, type Connections, type RowOf } from './index.ts';

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
      expect(taken).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
      const added = await inTransaction.tryInsert({ name: 'Alan', email: 'alan@example.com' });
      expect(added).toMatchObject({ ok: true, value: { name: 'Alan', email: 'alan@example.com' } });
      expectTypeOf(added).toEqualTypeOf<Result<Row, DuplicateError>>();
      expect(await inTransaction.count()).toBe(2); // still usable
    });
    expect(await users.count()).toBe(2);
  });

  it('tryInsert(): the duplicate err names the columns of the index it hit — one per index, a composite one together, an expression one by its words', async () => {
    const db = connections.get();
    await sql`create unique index users_name_born_on_unique on users (name, born_on)`.execute(db);
    try {
      await users.insert({ name: 'Ada', email: 'ada@example.com', born_on: '1815-12-10' });
      const byEmail = await users.tryInsert({ name: 'Other', email: 'ada@example.com' });
      expect(byEmail).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
      const byPair = await users.tryInsert({ name: 'Ada', email: 'ada2@example.com', born_on: '1815-12-10' });
      expect(byPair.ok === false && [...byPair.error.columns].sort()).toEqual(['born_on', 'name']);
      await sql`create unique index users_lower_email_unique on users (lower(email))`.execute(db);
      // Only the expression index holds these values: the other case slips past the plain index of `email`.
      const byExpression = await users.tryInsert({ name: 'Third', email: 'ADA@example.com' });
      expect(byExpression.ok === false && byExpression.error.columns).toEqual(['email']);
    } finally {
      await sql`drop index users_name_born_on_unique`.execute(db);
      await sql`drop index if exists users_lower_email_unique`.execute(db);
    }
  });

  it('tryUpdate(): a duplicate err when the new value is taken, a missing err without the row, the row otherwise — the transaction survives', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const alan = await users.insert({ name: 'Alan', email: 'alan@example.com' });
    await users.transaction(async (inTransaction) => {
      expect(await inTransaction.tryUpdate(ada.id, { email: 'alan@example.com' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
      const changed = await inTransaction.tryUpdate(ada.id, { email: 'ada@new.example' });
      expect(changed).toMatchObject({ ok: true, value: { email: 'ada@new.example' } });
      expectTypeOf(changed).toEqualTypeOf<Result<Row, DuplicateError | { kind: 'missing' }>>();
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
    expect(result).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
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

  it('restores only a row that is soft-deleted', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    expect(await users.restore(ada.id)).toBe(false); // alive: nothing to bring back
    await users.delete(ada.id);
    expect(await users.restore(ada.id)).toBe(true);
    expect(await users.restore(ada.id)).toBe(false);
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
    // The mark that lets a route scope a binding by this repository (`Route.bind(…, { scopedBy })`), subclasses included.
    expect(Articles.routeBindingScoped).toBe(true);

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
    // Another tool owns the table, so its primary key is read from the catalog.
    ({ connections, close } = await freshConnections(driver, { managed: false }));
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

describe.each(drivers)('Repository on a table whose primary key is not id, on %s', (driver) => {
  interface PageTables {
    pages: { slug: string; title: string };
  }
  class Pages extends Repository<'pages', PageTables> {
    static table = 'pages' as const;
  }
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    const slugs: ModuleDefinition[] = [{ name: 'pages', migrations: new URL('./__fixtures__/migrations/slug-keys/', import.meta.url) }];
    await new Migrator({ modules: slugs, root: '/' } as unknown as Application, connections).migrate();
  });
  afterAll(() => close());

  it('finds, updates and deletes by the key the migration declared', async () => {
    const pages = new Pages(connections);
    await pages.insert({ slug: 'welcome', title: 'Welcome' });
    expect(await pages.find('welcome')).toMatchObject({ title: 'Welcome' });
    expect(await pages.find('missing')).toBeUndefined();
    expect(await pages.exists('welcome')).toBe(true);
    expect(await pages.update('welcome', { title: 'Hello' })).toMatchObject({ title: 'Hello' });
    expect((await pages.findOrFail('welcome')).title).toBe('Hello');
    await expect(pages.findOrFail('missing')).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(await pages.delete('welcome')).toBe(true);
    expect(await pages.count()).toBe(0);
  });

  it('batches by the key and binds it as a route parameter of at most 255 characters', async () => {
    const pages = new Pages(connections);
    for (const slug of ['a', 'b', 'c']) await pages.insert({ slug, title: slug });
    const batches: string[][] = [];
    for await (const batch of pages.chunk(2)) batches.push(batch.map((page) => page.slug));
    expect(batches).toEqual([['a', 'b'], ['c']]);

    expect(await pages.findByRouteKey('b')).toMatchObject({ title: 'b' });
    const queries: string[] = [];
    connections.onQuery((query) => queries.push(query.sql));
    expect(await pages.findByRouteKey('x'.repeat(256))).toBeUndefined();
    expect(await pages.findByRouteKey('')).toBeUndefined();
    expect(queries).toEqual([]);
  });

  it('gives findByRouteKey no request: a repository that reads binding.ctx gets a TypeError naming it', async () => {
    class ByUser extends Pages {
      override async resolveRouteBinding(value: string, binding: RouteBindingContext) {
        void (binding.ctx as { user?: unknown }).user;
        return super.resolveRouteBinding(value, binding);
      }
    }
    await expect(new ByUser(connections).findByRouteKey('a')).rejects.toThrow('ByUser.findByRouteKey() has no request');
  });
});

describe.each(drivers)('Repository on a table without a single-column primary key on %s', (driver) => {
  interface PivotTables {
    role_user: { role_id: number; user_id: number };
    audit_lines: { line: string };
  }
  class RoleUser extends Repository<'role_user', PivotTables> {
    static table = 'role_user' as const;
  }
  class AuditLines extends Repository<'audit_lines', PivotTables> {
    static table = 'audit_lines' as const;
  }
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    // A composite key cannot be declared with the blueprint: another tool made these tables, and the catalog tells.
    ({ connections, close } = await freshConnections(driver, { managed: false }));
    const db = connections.get();
    await db.schema
      .createTable('role_user')
      .addColumn('role_id', 'integer', (c) => c.notNull())
      .addColumn('user_id', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('role_user_pkey', ['role_id', 'user_id'])
      .execute();
    await db.schema.createTable('audit_lines').addColumn('line', 'text', (c) => c.notNull()).execute();
  });
  afterAll(() => close());

  it('refuses every method that takes a key with a TypeError — it never falls back to id', async () => {
    const roleUser = new RoleUser(connections) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const message = 'role_user has no single-column primary key — use query().';
    await expect(roleUser.find!(1)).rejects.toThrow(new TypeError(message));
    await expect(roleUser.exists!(1)).rejects.toThrow(message);
    await expect(roleUser.update!(1, { role_id: 2 })).rejects.toThrow(message);
    await expect(roleUser.delete!(1)).rejects.toThrow(message);
    await expect(roleUser.findByRouteKey!('1')).rejects.toThrow(message);
    await expect(new RoleUser(connections).chunk(10).next()).rejects.toThrow(message);
    await expect(new AuditLines(connections).findByRouteKey('1')).rejects.toThrow('audit_lines has no single-column primary key — use query().');
  });

  it('still reads and writes through query() and insert()', async () => {
    const roleUser = new RoleUser(connections);
    await roleUser.insert({ role_id: 1, user_id: 2 });
    expect(await roleUser.query().selectAll().execute()).toEqual([{ role_id: 1, user_id: 2 }]);
    expect(await roleUser.count()).toBe(1);
  });

  it('binds a table without a key by the column routeKey names', async () => {
    class ByLine extends Repository<'audit_lines', PivotTables> {
      static table = 'audit_lines' as const;
      static routeKey = 'line';
    }
    await new AuditLines(connections).insert({ line: 'one' });
    expect(await new ByLine(connections).findByRouteKey('one')).toEqual({ line: 'one' });
  });
});

describe.each(drivers)('Scoped route bindings under a parent keyed by a slug on %s', (driver) => {
  interface ProjectTables {
    projects: { slug: string; name: string };
    tasks: { id: Generated<number>; project_id: string; title: string };
  }
  class Tasks extends Repository<'tasks', ProjectTables> {
    static table = 'tasks' as const;
  }
  let connections: Connections;
  let close: () => Promise<void>;
  const ctx = {} as never;
  beforeAll(async () => {
    // A foreign key to a text column cannot be declared with the blueprint: the catalog tells.
    ({ connections, close } = await freshConnections(driver, { managed: false }));
    const db = connections.get();
    await db.schema.createTable('projects').addColumn('slug', 'varchar(100)', (c) => c.primaryKey()).addColumn('name', 'text', (c) => c.notNull()).execute();
    await db.schema
      .createTable('tasks')
      .addColumn('id', driver === 'sqlite' ? 'integer' : 'bigint', (c) => (driver === 'sqlite' ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity()))
      .addColumn('project_id', 'varchar(100)', (c) => c.notNull().references('projects.slug'))
      .addColumn('title', 'text', (c) => c.notNull())
      .execute();
  });
  afterAll(() => close());

  it('compares with the column the foreign key references, so a task under the wrong parent is not found', async () => {
    const db = connections.get<ProjectTables>();
    await db.insertInto('projects').values([{ slug: 'alpha', name: 'Alpha' }, { slug: 'beta', name: 'Beta' }]).execute();
    const tasks = new Tasks(connections);
    const task = await tasks.insert({ project_id: 'alpha', title: 'Write' });
    const scope = (slug: string, column = 'project_id') => ({ param: 'project', parent: { slug, name: slug }, column });
    expect(await tasks.resolveRouteBinding(String(task.id), { ctx, scope: scope('alpha') })).toMatchObject({ title: 'Write' });
    expect(await tasks.resolveRouteBinding(String(task.id), { ctx, scope: scope('beta') })).toBeUndefined();
    // A parent without the referenced column is no parent.
    expect(await tasks.resolveRouteBinding(String(task.id), { ctx, scope: { param: 'project', parent: { id: 1 }, column: 'project_id' } })).toBeUndefined();
  });

  it('refuses a scope column that is no foreign key instead of comparing with an id', async () => {
    const tasks = new Tasks(connections);
    await expect(tasks.resolveRouteBinding('1', { ctx, scope: { param: 'project', parent: { id: 1 }, column: 'title' } })).rejects.toThrow(
      'tasks.title is not a foreign key',
    );
  });
});

describe.each(drivers)('Repository lookups that need what the schema says, on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    await connections.get().schema.createTable('raw_notes').addColumn('id', 'integer', (c) => c.primaryKey()).execute();
  });
  afterAll(() => close());

  it('says that a table raw SQL made has an unknown primary key', async () => {
    class RawNotes extends Repository<'raw_notes', { raw_notes: { id: number } }> {
      static table = 'raw_notes' as const;
    }
    await expect((new RawNotes(connections) as unknown as { find(id: number): Promise<unknown> }).find(1)).rejects.toThrow(
      'raw_notes is not a table the migrations created with schema.create(), so its primary key is unknown — create it with schema.create() or use query() (docs/migrations.md#raw-sql).',
    );
  });

  it('refuses a route key of a kind that matches no text unless a routeKeyPattern says what it looks like', async () => {
    class ByCreated extends Repository<'users', FixtureTables> {
      static table = 'users' as const;
      static routeKey = 'created_at';
    }
    class ByCreatedChecked extends ByCreated {
      static routeKeyPattern = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
    }
    await expect(new ByCreated(connections).findByRouteKey('yesterday')).rejects.toThrow('users.created_at');
    await expect(new ByCreated(connections).findByRouteKey('yesterday')).rejects.toThrow('routeKeyPattern');
    expect(await new ByCreatedChecked(connections).findByRouteKey('yesterday')).toBeUndefined();
  });
});
