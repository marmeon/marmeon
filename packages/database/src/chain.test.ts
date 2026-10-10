import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { DummyDriver, expressionBuilder, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, type SelectQueryBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import { testEncrypter } from './__fixtures__/encrypter.ts';
import './__fixtures__/relations.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { installChain, installOn } from './chain.ts';
import { Connections, cursorPaginate, hasMany, Migrator, paginate, Repository, secret, type ConnectionOptions, type Json, type QueryEvent } from './index.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'blog', migrations: fixtures('relations') },
  { name: 'keys', migrations: fixtures('relations-secrets') },
];
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

class PostRepository extends Repository<'posts', FixtureTables> {
  static table = 'posts' as const;
}
class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}

describe.each(drivers)('loading relations on %s', (driver) => {
  let options: ConnectionOptions;
  let drop: () => Promise<void>;
  let connections: Connections;
  let db: Kysely<FixtureTables>;
  const queries: QueryEvent[] = [];
  const ids = { ada: 0, alan: 0, gone: 0, first: 0, second: 0, kysely: 0, sql: 0, root: 0, child: 0 };

  beforeAll(async () => {
    // A file on SQLite: a second process (a cold `Connections`) opens the same database.
    ({ options, drop } =
      driver === 'sqlite'
        ? { options: { driver: 'sqlite', database: join(tempDir('marmeon-chain-'), 'app.sqlite') }, drop: async () => {} }
        : await freshDatabase(driver));
    connections = new Connections({ connections: { default: options }, root: '/', logger: silent });
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    db = connections.get<FixtureTables>();
    const user = (values: { name: string; email: string; is_admin?: boolean; settings?: string; balance?: string; deleted_at?: Date }) =>
      db.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow().then((row) => row.id);
    ids.ada = await user({ name: 'Ada', email: 'ada@example.com', is_admin: true, settings: JSON.stringify({ theme: 'dark' }), balance: '12.50' });
    ids.alan = await user({ name: 'Alan', email: 'alan@example.com' });
    ids.gone = await user({ name: 'Gone', email: 'gone@example.com', deleted_at: new Date() });
    const post = (values: { author_id: number; editor_id?: number; title: string; featured?: boolean; rating?: string }) =>
      db.insertInto('posts').values(values).returning('id').executeTakeFirstOrThrow().then((row) => row.id);
    ids.first = await post({ author_id: ids.ada, editor_id: ids.alan, title: 'First', featured: true, rating: '4.50' });
    ids.second = await post({ author_id: ids.gone, title: 'Second' });
    await db
      .insertInto('comments')
      .values([
        { post_id: ids.first, user_id: ids.alan, body: 'one', approved: true, deleted_at: null },
        { post_id: ids.first, user_id: ids.ada, body: 'two', approved: false, deleted_at: null },
        { post_id: ids.first, user_id: ids.alan, body: 'deleted', approved: true, deleted_at: new Date() },
      ])
      .execute();
    const tag = (slug: string) => db.insertInto('tags').values({ slug }).returning('id').executeTakeFirstOrThrow().then((row) => row.id);
    ids.kysely = await tag('kysely');
    ids.sql = await tag('sql');
    await db
      .insertInto('post_tag')
      .values([
        { post_id: ids.first, tag_id: ids.kysely },
        { post_id: ids.first, tag_id: ids.sql },
        { post_id: ids.second, tag_id: ids.sql },
      ])
      .execute();
    await db.insertInto('post_stats').values({ post_id: ids.first, views: 7 }).execute();
    await db.insertInto('api_keys').values({ user_id: ids.ada, name: 'cli', token: 'the-secret-token' }).execute();
    ids.root = (await db.insertInto('categories').values({ name: 'root' }).returning('id').executeTakeFirstOrThrow()).id;
    ids.child = (await db.insertInto('categories').values({ name: 'child', parent_id: ids.root }).returning('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('categories').values({ name: 'grandchild', parent_id: ids.child }).execute();
    connections.onQuery((query) => queries.push(query));
  });
  afterAll(async () => {
    await connections.destroy();
    await drop();
  });

  const logged = async <T>(run: () => Promise<T>): Promise<{ result: T; sql: string[] }> => {
    queries.length = 0;
    const result = await run();
    return { result, sql: queries.map((query) => query.sql) };
  };

  it('loads a belongsTo, a hasMany, a hasOne and a belongsToMany in one query — every column but the secret ones', async () => {
    const { result: rows, sql } = await logged(() =>
      db.selectFrom('posts').select(['id', 'title']).with('author').with('comments').with('post_stats').with('tags').orderBy('id').execute(),
    );
    expect(sql).toHaveLength(1); // no N+1: there is no lazy loading to fall into
    expect(sql[0]).not.toContain('__marmeon');
    const [first, second] = rows;
    expect(first).toEqual({
      id: ids.first,
      title: 'First',
      author: expect.objectContaining({ id: ids.ada, name: 'Ada', is_admin: true, settings: { theme: 'dark' }, balance: '12.50', deleted_at: null }),
      comments: [expect.objectContaining({ body: 'one', approved: true }), expect.objectContaining({ body: 'two', approved: false })],
      post_stats: { post_id: ids.first, views: 7 },
      tags: [
        { id: ids.kysely, slug: 'kysely' },
        { id: ids.sql, slug: 'sql' },
      ],
    });
    expect(Object.keys(first!.author!).sort()).toEqual(['balance', 'born_on', 'created_at', 'deleted_at', 'email', 'id', 'is_admin', 'name', 'settings', 'updated_at']);
    // Its author is soft-deleted: no row comes through, so a belongsTo to a table with soft deletes may be null.
    expect(second).toEqual({ id: ids.second, title: 'Second', author: null, comments: [], post_stats: null, tags: [{ id: ids.sql, slug: 'sql' }] });
    expectTypeOf(first!.author).toEqualTypeOf<{
      id: number;
      name: string;
      email: string;
      is_admin: boolean;
      settings: Json;
      balance: string;
      born_on: string | null;
      created_at: string;
      updated_at: string;
      deleted_at: string | null;
    } | null>();
    expectTypeOf(first!.post_stats).toEqualTypeOf<{ post_id: number; views: number } | null>();
    expectTypeOf(first!.tags).toEqualTypeOf<{ id: number; slug: string }[]>();
  });

  it('joins the pivot itself — a column the callback names without its table is the related table’s', async () => {
    const { result: [post], sql } = await logged(() => db.selectFrom('posts').select('id').with('tags', (q) => q.select(['id', 'slug']).orderBy('id', 'desc')).where('id', '=', ids.first).execute());
    expect(post!.tags).toEqual([
      { id: ids.sql, slug: 'sql' },
      { id: ids.kysely, slug: 'kysely' },
    ]);
    expect(sql[0]).toContain('order by "tags"."id" desc');
  });

  it('types a belongsTo as present when its foreign key is NOT NULL and its table has no soft deletes', async () => {
    const [comment] = await db.selectFrom('comments').select('body').with('post', (q) => q.select('title')).orderBy('id').execute();
    expect(comment).toEqual({ body: 'one', post: { title: 'First' } });
    expectTypeOf(comment!.post).toEqualTypeOf<{ title: string }>();
  });

  it('nests relations three levels deep through callbacks — still one query', async () => {
    const { result: [ada], sql } = await logged(() =>
      db
        .selectFrom('users')
        .select('name')
        .with('authored_posts', (posts) =>
          posts
            .select(['title', 'featured', 'rating'])
            .with('comments', (comments) => comments.select('body').orderBy('id').with('user', (user) => user.select(['name', 'is_admin', 'balance', 'settings', 'created_at']))),
        )
        .where('id', '=', ids.ada)
        .execute(),
    );
    expect(sql).toHaveLength(1);
    expect(ada).toEqual({
      name: 'Ada',
      authored_posts: [
        {
          title: 'First',
          featured: true,
          rating: '4.50',
          comments: [
            { body: 'one', user: { name: 'Alan', is_admin: false, balance: '0.00', settings: null, created_at: expect.stringMatching(ISO_UTC) } },
            { body: 'two', user: { name: 'Ada', is_admin: true, balance: '12.50', settings: { theme: 'dark' }, created_at: expect.stringMatching(ISO_UTC) } },
          ],
        },
      ],
    });
    expectTypeOf(ada!.authored_posts[0]!.comments[0]!.user).toEqualTypeOf<{ name: string; is_admin: boolean; balance: string; settings: Json; created_at: string } | null>();
  });

  it('renames a relation with { as }, and keeps the default columns when the callback selects none of its table', async () => {
    const [post] = await db
      .selectFrom('posts')
      .select('title')
      .with('comments', { as: 'replies' }, (q) => q.where('approved', '=', true).with('user', { as: 'by' }, (u) => u.select('name')))
      .with('tags', { as: 'labels' })
      .where('id', '=', ids.first)
      .execute();
    expect(post!.replies).toEqual([expect.objectContaining({ body: 'one', approved: true, by: { name: 'Alan' } })]);
    expect(post!.labels.map((label) => label.slug)).toEqual(['kysely', 'sql']);
    expect(post).not.toHaveProperty('comments');
    expectTypeOf(post!.replies[0]!.body).toEqualTypeOf<string>();
    expectTypeOf(post!.replies[0]!.by).toEqualTypeOf<{ name: string } | null>();
  });

  it('loads a relation no foreign key describes with withRelation() — a list, or one row', async () => {
    const [ada] = await db
      .selectFrom('users')
      .select('name')
      .withRelation('own_comments', { table: 'comments', foreignKey: 'user_id' }, (q) => q.select('body').orderBy('id'))
      .withRelation('latest_comment', { table: 'comments', foreignKey: 'user_id', one: true }, (q) => q.select(['body', 'approved']).orderBy('id', 'desc'))
      .withRelation('nothing', { table: 'comments', foreignKey: 'post_id', localKey: 'balance', one: true })
      .where('id', '=', ids.alan)
      .execute();
    expect(ada).toEqual({ name: 'Alan', own_comments: [{ body: 'one' }], latest_comment: { body: 'one', approved: true }, nothing: null });
    expectTypeOf(ada!.own_comments).toEqualTypeOf<{ body: string }[]>();
    expectTypeOf(ada!.latest_comment).toEqualTypeOf<{ body: string; approved: boolean } | null>();
  });

  it('relates a table to itself — the parent and the children of a category', async () => {
    const [child] = await db
      .selectFrom('categories')
      .select('name')
      .with('parent', (q) => q.select('name').with('parent', (p) => p.select('name')))
      .with('categories', (q) => q.select('name').with('categories'))
      .where('id', '=', ids.child)
      .execute();
    expect(child).toEqual({ name: 'child', parent: { name: 'root', parent: null }, categories: [{ name: 'grandchild', categories: [] }] });
  });

  it('leaves soft-deleted rows out of every relation — withTrashed() in the callback keeps them, at that level only', async () => {
    const bodies = async (trashed: boolean) => {
      const [post] = await db
        .selectFrom('posts')
        .select('id')
        .with('comments', (q) => (trashed ? q.withTrashed() : q).select('body').orderBy('id'))
        .where('id', '=', ids.first)
        .execute();
      return post!.comments.map((comment) => comment.body);
    };
    expect(await bodies(false)).toEqual(['one', 'two']);
    expect(await bodies(true)).toEqual(['one', 'two', 'deleted']);
    const [second] = await db
      .selectFrom('posts')
      .select('id')
      .with('author', (q) => q.withTrashed().select('name').with('comments', (c) => c.select('body')))
      .where('id', '=', ids.second)
      .execute();
    expect(second!.author).toEqual({ name: 'Gone', comments: [] });
  });

  it('withTrashed() at the top of a repository query keeps the soft-deleted rows, its relations still filtered', async () => {
    const users = new UserRepository(connections);
    expect((await users.query().select('name').orderBy('id').execute()).map((row) => row.name)).toEqual(['Ada', 'Alan']);
    const all = await users.query().withTrashed().select('name').with('comments', (q) => q.select('body')).orderBy('id').execute();
    expect(all).toEqual([
      { name: 'Ada', comments: [{ body: 'two' }] },
      { name: 'Alan', comments: [{ body: 'one' }] },
      { name: 'Gone', comments: [] },
    ]);
  });

  it('works on Repository.query(), in an ambient transaction, with using(trx), and as a stream', async () => {
    const posts = new PostRepository(connections);
    expect((await posts.query().select('title').with('post_stats').orderBy('id').executeTakeFirstOrThrow()).post_stats).toEqual({ post_id: ids.first, views: 7 });
    await connections.transaction(async () => {
      const post = await posts.query().select('id').with('author', (q) => q.select('name')).where('id', '=', ids.first).executeTakeFirstOrThrow();
      expect(post.author).toEqual({ name: 'Ada' });
    });
    await db.transaction().execute(async (trx) => {
      const post = await posts.using(trx).query().select('id').with('tags', (q) => q.select('slug').orderBy('slug')).where('id', '=', ids.first).executeTakeFirstOrThrow();
      expect(post.tags).toEqual([{ slug: 'kysely' }, { slug: 'sql' }]);
      const inside = await trx.selectFrom('posts').select('id').with('comments', (q) => q.select('body').orderBy('id')).where('id', '=', ids.first).executeTakeFirstOrThrow();
      expect(inside.comments).toEqual([{ body: 'one' }, { body: 'two' }]);
    });
    if (driver === 'sqlite') {
      const streamed: unknown[] = [];
      for await (const row of db.selectFrom('posts').select('title').with('tags', (q) => q.select('slug').orderBy('slug')).orderBy('id').stream()) streamed.push(row);
      expect(streamed).toEqual([
        { title: 'First', tags: [{ slug: 'kysely' }, { slug: 'sql' }] },
        { title: 'Second', tags: [{ slug: 'sql' }] },
      ]);
    }
  });

  it('pages with paginate() and cursorPaginate() — the count leaves the relations out', async () => {
    const query = db.selectFrom('posts').select(['id', 'title']).with('tags', (q) => q.select('slug').orderBy('slug'));
    const { result: page, sql } = await logged(() => paginate(db, query.orderBy('id'), { page: 1, perPage: 1 }));
    expect(page.data).toEqual([{ id: ids.first, title: 'First', tags: [{ slug: 'kysely' }, { slug: 'sql' }] }]);
    expect(page.meta.total).toBe(2);
    expect(sql[0]).not.toMatch(/json/);
    const cursor = await cursorPaginate(query, { column: 'id', encrypter: testEncrypter(), perPage: 1 });
    expect(cursor.data).toEqual([{ id: ids.first, title: 'First', tags: [{ slug: 'kysely' }, { slug: 'sql' }] }]);
  });

  it('resolves a relation of a joined table — on the table that has it', async () => {
    const rows = await db
      .selectFrom('posts')
      .innerJoin('users', 'users.id', 'posts.author_id')
      .select(['posts.title', 'users.name'])
      .with('tags', (q) => q.select('slug').orderBy('slug'))
      .with('api_keys', (q) => q.select('name'))
      .where('posts.id', '=', ids.first)
      .execute();
    expect(rows).toEqual([{ title: 'First', name: 'Ada', tags: [{ slug: 'kysely' }, { slug: 'sql' }], api_keys: [{ name: 'cli' }] }]);
    // Both tables have a relation "comments": the type does not offer it, and the connection refuses to guess.
    await expect(
      db
        .selectFrom('posts')
        .innerJoin('users', 'users.id', 'posts.author_id')
        .select('posts.id')
        .with('comments' as never)
        .execute(),
    ).rejects.toThrow(`with('comments'): posts and users both have a relation "comments" — load it in a query on one of them.`);
  });

  it('resolves on the first query of a process — one query in the log, the SQL that ran', async () => {
    const cold = new Connections({ connections: { default: options }, root: '/', logger: silent });
    const log: string[] = [];
    cold.onQuery((query) => log.push(query.sql));
    try {
      const query = cold.get<FixtureTables>().selectFrom('users').select('name').with('api_keys', (q) => q.select('name'));
      const rows = await query.where('id', '=', ids.ada).execute();
      expect(rows).toEqual([{ name: 'Ada', api_keys: [{ name: 'cli' }] }]);
      expect(log).toHaveLength(1);
      expect(log[0]).not.toContain('__marmeon');
      // Two queries of one builder at once, both left for the connection: each is resolved.
      const again = new Connections({ connections: { default: options }, root: '/', logger: silent });
      try {
        const twice = again.get<FixtureTables>().selectFrom('users').select('name').with('api_keys', (q) => q.select('name')).orderBy('id');
        const [all, ada] = await Promise.all([twice.execute(), twice.where('id', '=', ids.ada).execute()]);
        expect(all.map((row) => row.api_keys.length)).toEqual([1, 0, 0]);
        expect(ada).toEqual([{ name: 'Ada', api_keys: [{ name: 'cli' }] }]);
      } finally {
        await again.destroy();
      }
    } finally {
      await cold.destroy();
    }
  });

  describe('secret columns', () => {
    const refused = (label: string, column = 'api_keys.token') =>
      `${label} selects ${column}, a secret column — a relation never loads one. Read it where it is needed, in a query of its own with secret(eb, …). See docs/queries.md#relations-and-secret-columns.`;

    it('are never among a relation’s columns — nor in selectAll() of its callback', async () => {
      const [ada] = await db.selectFrom('users').select('name').with('api_keys').with('api_keys', { as: 'all' }, (q) => q.selectAll()).where('id', '=', ids.ada).execute();
      expect(ada!.api_keys).toEqual([{ id: expect.any(Number), user_id: ids.ada, name: 'cli' }]);
      expect(ada!.all).toEqual(ada!.api_keys);
      expect(JSON.stringify(ada)).not.toContain('the-secret-token');
    });

    it('are refused when a callback selects one — by name, through secret(), under an alias, at any depth', async () => {
      const users = () => db.selectFrom('users').select('name').where('id', '=', ids.ada);
      await expect(users().with('api_keys', (q) => q.select(['name', 'token' as never])).execute()).rejects.toThrow(refused(`with('api_keys')`));
      await expect(users().with('api_keys', (q) => q.select((eb) => ['name', secret(eb, 'token')])).execute()).rejects.toThrow(refused(`with('api_keys')`));
      await expect(users().with('api_keys', (q) => q.select((eb) => eb.ref('api_keys.token' as never).as('key'))).execute()).rejects.toThrow(refused(`with('api_keys')`));
      await expect(users().with('api_keys', (q) => q.select((eb) => eb.fn('upper', ['token' as never]).as('shout'))).execute()).rejects.toThrow(refused(`with('api_keys')`));
      await expect(
        db.selectFrom('comments').select('body').with('user', (q) => q.select('name').with('api_keys', (k) => k.select('token' as never))).execute(),
      ).rejects.toThrow(refused(`with('api_keys')`));
      await expect(
        users().withRelation('keys', { table: 'api_keys', foreignKey: 'user_id' }, (q) => q.select((eb) => secret(eb, 'token'))).execute(),
      ).rejects.toThrow(refused(`withRelation('keys')`));
    });

    it('are refused from every table of a relation’s query — a joined one, an aliased one, a subquery', async () => {
      const comments = () => db.selectFrom('posts').select('title').where('id', '=', ids.first);
      await expect(
        comments().with('comments', (q) => q.innerJoin('api_keys', 'api_keys.user_id', 'comments.user_id').select(['comments.body', 'api_keys.token' as never])).execute(),
      ).rejects.toThrow(refused(`with('comments')`));
      await expect(
        comments().with('comments', (q) => q.innerJoin('api_keys as k', 'k.user_id', 'comments.user_id').select(['comments.body', 'k.token' as never])).execute(),
      ).rejects.toThrow(refused(`with('comments')`));
      await expect(
        comments()
          .with('comments', (q) => q.select((eb) => ['body', eb.selectFrom('api_keys').select('token' as never).whereRef('api_keys.user_id', '=', 'comments.user_id').limit(1).as('key')]))
          .execute(),
      ).rejects.toThrow(refused(`with('comments')`));
      // A joined table's selectAll() is spelled out without its secret columns.
      const [post] = await comments()
        .with('comments', (q) => q.innerJoin('api_keys as k', 'k.user_id', 'comments.user_id').select('comments.body').select((eb) => eb.ref('k.name').as('key')).orderBy('comments.id'))
        .execute();
      expect(post!.comments).toEqual([{ body: 'two', key: 'cli' }]);
    });

    it('are refused in a relation of the free helpers too', async () => {
      await expect(
        db
          .selectFrom('users')
          .select((eb) => ['name', hasMany(eb, 'api_keys', 'user_id', 'users.id', (q) => q.select(['api_keys.name', 'api_keys.token' as never])).as('keys')])
          .execute(),
      ).rejects.toThrow(refused(`hasMany('api_keys')`));
    });
  });

  it('fails with a message that says why on a connection without Marmeon’s plugins — and sends nothing', async () => {
    const message = `This query loads relations or leaves out soft-deleted rows (with(), withRelation(), withTrashed(), a repository's query()), which only the app's connection resolves — it was not sent: it runs on the database connection "default" without Marmeon's plugins (infrastructure(), withoutPlugins()). Build it on connections.get() or Database. See docs/queries.md#relations.`;
    queries.length = 0;
    await expect(db.withoutPlugins().selectFrom('users').select('name').with('comments').execute()).rejects.toThrow(message);
    await expect(connections.infrastructure<FixtureTables>().selectFrom('users').select('name').with('comments').execute()).rejects.toThrow(message);
    await expect(connections.infrastructure<FixtureTables>().selectFrom('users').select('name').withTrashed().execute()).rejects.toThrow(message);
    expect(queries).toEqual([]);
  });
});

// The chain lives on the prototype Kysely's select builders share: when a Kysely update splits it up or brings a method of the
// same name, this fails here — not in an app.
describe("the relation methods on Kysely's select builders", () => {
  const db = new Kysely<any>({
    dialect: { createAdapter: () => new SqliteAdapter(), createDriver: () => new DummyDriver(), createIntrospector: (k) => new SqliteIntrospector(k), createQueryCompiler: () => new SqliteQueryCompiler() },
  });
  const builders: Record<string, () => SelectQueryBuilder<any, any, any>> = {
    'db.selectFrom': () => db.selectFrom('t'),
    'db.selectFrom(subquery)': () => db.selectFrom(db.selectFrom('t').selectAll().as('s')),
    'db.selectNoFrom': () => db.selectNoFrom((eb) => eb.lit(1).as('one')) as never,
    'db.with(cte).selectFrom': () => db.with('c', (q) => q.selectFrom('t').selectAll()).selectFrom('c'),
    'expressionBuilder().selectFrom': () => expressionBuilder<any, any>().selectFrom('t'),
    'after where/orderBy/$if/innerJoin': () => db.selectFrom('t').where('a', '=', 1).orderBy('a').$if(true, (q) => q.limit(1)).innerJoin('u', 'u.id', 't.id'),
    withoutPlugins: () => db.withoutPlugins().selectFrom('t'),
    'a subquery in a select callback': () => {
      let inner: SelectQueryBuilder<any, any, any> | undefined;
      db.selectFrom('t').select((eb) => (inner = eb.selectFrom('u').select('id')).as('x'));
      return inner!;
    },
  };

  it.each(Object.keys(builders))('%s has with(), withRelation() and withTrashed()', (name) => {
    const builder = builders[name]!() as unknown as Record<string, unknown>;
    for (const method of ['with', 'withRelation', 'withTrashed']) expect(typeof builder[method], method).toBe('function');
  });

  it('are on the prototype once — not enumerable, and installing again is a no-op', () => {
    installChain();
    const prototype = Object.getPrototypeOf(db.selectFrom('t')) as object;
    expect(Object.getOwnPropertyDescriptor(prototype, 'with')?.enumerable).toBe(false);
    expect(Object.keys(prototype)).not.toContain('with');
  });

  it('are not put over a method of the same name — the builder of a Kysely that has one', () => {
    const builder = { orderBy() {}, withTrashed() {} };
    expect(() => installOn(builder)).toThrow(`Kysely's select builder has a "withTrashed" method of its own — @marmeon/database cannot add its relation method of that name.`);
    expect(Object.keys(builder)).toEqual(['orderBy', 'withTrashed']); // nothing added
    const prototype = Object.getPrototypeOf(db.selectFrom('t')) as object;
    expect(() => installOn(prototype)).toThrow(`Kysely's select builder has a "with" method of its own`);
  });
});
