import { join } from 'node:path';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { DummyDriver, expressionBuilder, Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, type KyselyPlugin, type SelectQueryBuilder } from 'kysely';
import { jsonArrayFrom as pgArrayFrom } from 'kysely/helpers/postgres';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshDatabase, silent } from './__fixtures__/databases.ts';
import { testEncrypter } from './__fixtures__/encrypter.ts';
import './__fixtures__/relations.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { installChain, installOn } from './chain.ts';
import { Connections, cursorPaginate, Migrator, paginate, Repository, secret, sql, type ConnectionOptions, type Json, type QueryEvent } from './index.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'blog', migrations: fixtures('relations') },
  { name: 'keys', migrations: fixtures('relations-secrets') },
  { name: 'readers', migrations: fixtures('relations-readers') },
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
    await db
      .insertInto('post_user')
      .values([
        { post_id: ids.first, user_id: ids.ada },
        { post_id: ids.first, user_id: ids.gone },
        { post_id: ids.second, user_id: ids.alan },
      ])
      .execute();
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

  it('keeps the default columns when the callback selects a column only under another name — naming one as it is narrows', async () => {
    const [post] = await db
      .selectFrom('posts')
      .select('title')
      .with('tags', (q) => q.select('slug as label'))
      .with('tags', { as: 'named' }, (q) => q.select(['slug', 'slug as label']))
      .where('id', '=', ids.first)
      .execute();
    expect(post!.tags.map((tag) => Object.keys(tag).sort())).toEqual([
      ['id', 'label', 'slug'],
      ['id', 'label', 'slug'],
    ]);
    expect(post!.named.map((tag) => Object.keys(tag).sort())).toEqual([
      ['label', 'slug'],
      ['label', 'slug'],
    ]);
    expectTypeOf(post!.tags[0]!.id).toEqualTypeOf<number>();
    expectTypeOf(post!.named[0]!).not.toHaveProperty('id');
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

  it('normalizes nested values by their own relation — a nested relation of the same name never shadows the outer one', async () => {
    const [comment] = await db
      .selectFrom('comments')
      .select('body')
      .with('user')
      .with('post', (q) => q.select('title').with('comments', (c) => c.select('body').orderBy('id').with('user', (u) => u.select('name'))))
      .where('body', '=', 'two')
      .execute();
    expect(comment!.user).toEqual(expect.objectContaining({ name: 'Ada', is_admin: true, settings: { theme: 'dark' }, balance: '12.50', created_at: expect.stringMatching(ISO_UTC) }));
    expect(comment!.post.comments.map((c) => c.user)).toEqual([{ name: 'Alan' }, { name: 'Ada' }]);
    const [post] = await db
      .selectFrom('posts')
      .select('title')
      .with('author')
      .with('comments', (c) => c.select('body').orderBy('id').with('user', { as: 'author' }, (u) => u.select('name')))
      .where('id', '=', ids.first)
      .execute();
    expect(post!.author).toEqual(expect.objectContaining({ is_admin: true, settings: { theme: 'dark' }, created_at: expect.stringMatching(ISO_UTC) }));
    expect(post!.comments.map((c) => c.author)).toEqual([{ name: 'Alan' }, { name: 'Ada' }]);
  });

  it('keeps a raw `or` of a callback inside parentheses — no other row’s, no deleted relation rows', async () => {
    const posts = await db
      .selectFrom('posts')
      .select('id')
      .with('comments', (q) => q.select('body').where(sql<boolean>`body = 'deleted' or approved = ${true}`))
      .orderBy('id')
      .execute();
    expect(posts).toEqual([
      { id: ids.first, comments: [{ body: 'one' }] },
      { id: ids.second, comments: [] },
    ]);
    class Comments extends Repository<'comments', FixtureTables> {
      static table = 'comments' as const;
    }
    const comments = await new Comments(connections).query().select('body').where(sql<boolean>`body = 'deleted' or approved = ${true}`).execute();
    expect(comments).toEqual([{ body: 'one' }]);
  });

  it('relates withRelation() through the first of the query’s tables that has the local key', async () => {
    const [row] = await db
      .selectFrom('users')
      .innerJoin('posts', 'posts.author_id', 'users.id')
      .select('users.name')
      .withRelation('their_comments', { table: 'comments', foreignKey: 'user_id', localKey: 'author_id' }, (q) => q.select('body').orderBy('id'))
      .execute();
    expect(row).toEqual({ name: 'Ada', their_comments: [{ body: 'two' }] });
  });

  it('asks for the query it gave when a callback returns another one', () => {
    expect(() => db.selectFrom('posts').with('comments', () => db.selectFrom('users').select('name') as never)).toThrow(
      `The callback of with('comments') returns something else than the query it was given — return the query: (q) => q.select(…).`,
    );
  });

  it('never applies the relations of a sibling builder to a query without them — with or without a later plugin', async () => {
    const passThrough: KyselyPlugin = { transformQuery: ({ node }) => ({ ...node }), transformResult: async ({ result }) => result };
    for (const target of [db, db.withPlugin(passThrough)]) {
      const base = target.selectFrom('posts').where('id', '=', ids.first);
      const plain = base.select(['title', sql<string>`'plain text'`.as('author')]);
      expect(await plain.execute()).toEqual([{ title: 'First', author: 'plain text' }]);
      expect((await base.select('title').with('author').execute())[0]!.author).toEqual(expect.objectContaining({ is_admin: true }));
      // The same builder again, after its sibling: still its own (empty) shapes.
      expect(await plain.execute()).toEqual([{ title: 'First', author: 'plain text' }]);
      // Not converted as a relation: SQLite's connection parses JSON text of an expression (not of a text column) as it is.
      const [json] = await base.select(['title', sql<string>`'{"is_admin":1}'`.as('author')]).execute();
      expect(json!.author).toEqual(driver === 'sqlite' ? { is_admin: 1 } : '{"is_admin":1}');
    }
  });

  it('keeps normalizing nested values behind a plugin added later', async () => {
    const passThrough: KyselyPlugin = { transformQuery: ({ node }) => ({ ...node }), transformResult: async ({ result }) => result };
    const [post] = await db.withPlugin(passThrough).selectFrom('posts').select('title').with('author').where('id', '=', ids.first).execute();
    expect(post!.author).toEqual(expect.objectContaining({ is_admin: true, settings: { theme: 'dark' }, balance: '12.50', created_at: expect.stringMatching(ISO_UTC) }));
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
      const { result: [post], sql: sent } = await logged(() =>
        comments().with('comments', (q) => q.innerJoin('api_keys as k', 'k.user_id', 'comments.user_id').select('comments.body').selectAll('k').orderBy('comments.id')).execute(),
      );
      expect(post!.comments).toEqual([{ body: 'two', id: expect.any(Number), user_id: ids.ada, name: 'cli' }]);
      expect(Object.keys(post!.comments[0]!).sort()).toEqual(['body', 'id', 'name', 'user_id']);
      expect(sent[0]).not.toContain('token');
      // Below a relation's top level — a subquery of its callback — selectAll() is spelled out the same way.
      const [nested] = await comments()
        .with('comments', (q) =>
          q
            .innerJoin((eb) => eb.selectFrom('api_keys').selectAll().as('k'), (join) => join.onRef('k.user_id', '=', 'comments.user_id'))
            .select(['comments.body', 'k.name'])
            .orderBy('comments.id'),
        )
        .execute();
      expect(nested!.comments).toEqual([{ body: 'two', name: 'cli' }]);
    });

    const row = (label: string, table = 'api_keys') =>
      `${label} reads the whole row of ${table}, secret columns included — name the columns it needs, and read a secret one with secret(eb, …) in a query of its own. See docs/queries.md#relations-and-secret-columns.`;

    it('are refused in a whole row — of the relation’s table, a joined one, a name that is a table’s — before the database sees it', async () => {
      const users = () => db.selectFrom('users').select('name').where('id', '=', ids.ada);
      queries.length = 0;
      await expect(users().with('api_keys', (k) => k.select((eb) => eb.fn('to_jsonb', [eb.table('api_keys')]).as('row'))).execute()).rejects.toThrow(row(`with('api_keys')`));
      await expect(users().with('api_keys', (k) => k.select((eb) => eb.fn('row_to_json', [eb.table('api_keys')]).as('row'))).execute()).rejects.toThrow(row(`with('api_keys')`));
      await expect(
        db
          .selectFrom('posts')
          .select('title')
          .with('comments', (q) => q.innerJoin('api_keys', 'api_keys.user_id', 'comments.user_id').select((eb) => eb.fn('jsonb_agg', [eb.table('api_keys')]).as('keys')).groupBy('comments.id'))
          .execute(),
      ).rejects.toThrow(row(`with('comments')`));
      await expect(users().with('api_keys', (k) => k.select((eb) => eb.ref('api_keys' as never).as('row'))).execute()).rejects.toThrow(row(`with('api_keys')`));
      await expect(users().with('api_keys', (k) => k.select(sql.ref('api_keys').as('row'))).execute()).rejects.toThrow(row(`with('api_keys')`));
      await expect(users().with('api_keys', (k) => k.select(sql`to_jsonb(${sql.ref('api_keys')})`.as('row'))).execute()).rejects.toThrow(row(`with('api_keys')`));
      expect(queries).toEqual([]); // refused before it was sent
    });

    it('are refused from the outer query too — aliased, or named without its table', async () => {
      await expect(
        db
          .selectFrom('api_keys as k')
          .select('k.name')
          .with('user' as never, (u: any) => u.select(['name', sql.ref('k.token').as('pw')]))
          .execute(),
      ).rejects.toThrow(refused(`with('user')`));
      await expect(
        db
          .selectFrom('api_keys')
          .select('api_keys.name')
          .with('user', (u) => u.select(['name', sql<string>`${sql.ref('token')}`.as('pw')]))
          .execute(),
      ).rejects.toThrow(refused(`with('user')`));
    });

    it('are refused in a whole row on the first query of a process — before anything was loaded', async () => {
      const cold = new Connections({ connections: { default: options }, root: '/', logger: silent });
      try {
        await expect(cold.get<FixtureTables>().selectFrom('api_keys').select((eb) => eb.fn('to_jsonb', [eb.table('api_keys')]).as('row')).execute()).rejects.toThrow(row('This query'));
      } finally {
        await cold.destroy();
      }
    });

    it('are refused at the top level in a whole row — a named one stays readable on purpose', async () => {
      await expect(db.selectFrom('api_keys').select((eb) => eb.fn('to_jsonb', [eb.table('api_keys')]).as('row')).execute()).rejects.toThrow(row('This query'));
      await expect(
        db
          .selectFrom('users')
          .select((eb) => ['name', eb.selectFrom('api_keys').select((inner) => inner.fn('row_to_json', [inner.table('api_keys')]).as('k')).limit(1).as('key')])
          .execute(),
      ).rejects.toThrow(row('This query'));
      await expect(
        db.insertInto('api_keys').values({ user_id: ids.alan, name: 'x', token: 'y' }).returning((eb) => eb.fn('to_jsonb', [eb.table('api_keys')]).as('row')).execute(),
      ).rejects.toThrow(row('This query'));
      const [key] = await db.selectFrom('api_keys').select((eb) => ['name', secret(eb, 'token')]).execute();
      expect(key).toEqual({ name: 'cli', token: 'the-secret-token' });
    });

    const unasked = (what: string) =>
      `This query selects ${what}, a secret column, without secret() — read it with secret(eb, …) where it is needed, at every level of the query that passes it on. See docs/migrations.md#secret-columns.`;
    /** The statement as it would be sent — the plugins run when it compiles (the metadata is loaded by now). */
    const sent = (query: { compile(): { sql: string } }) => query.compile().sql;

    it('are refused at the top level by name too — only secret() reads one, at every level that passes it on', async () => {
      queries.length = 0;
      await expect(db.selectFrom('api_keys').select(['name', 'token' as never]).execute()).rejects.toThrow(unasked('api_keys.token'));
      // Asked for in a subquery, it carries the secret outward: the outer select must ask again.
      const derived = () => db.selectFrom((eb) => eb.selectFrom('api_keys').select((e) => ['name', secret(e, 'token')]).as('k'));
      await expect(derived().select(['k.name', 'k.token']).execute()).rejects.toThrow(unasked('k.token'));
      await expect(derived().select((eb) => eb.fn('to_jsonb', [eb.table('k')]).as('row')).execute()).rejects.toThrow(row('This query', 'k'));
      expect(queries).toEqual([]);
      expect(await derived().select((eb) => ['k.name', secret(eb as never, 'k.token' as never)]).execute()).toEqual([{ name: 'cli', token: 'the-secret-token' }]);
      // A common table expression the same way.
      const cte = () => db.with('k', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e, 'token')]));
      await expect(cte().selectFrom('k').select((eb) => eb.fn('to_jsonb', [eb.table('k')]).as('row')).execute()).rejects.toThrow(row('This query', 'k'));
      await expect(cte().selectFrom('k').selectAll().execute()).resolves.toEqual([{ user_id: ids.ada }]); // spelled out without it
    });

    it('are left out of a common table expression’s or a subquery’s selectAll(), at the top level too — its whole row is then safe', async () => {
      const cte = db.with('k', (q) => q.selectFrom('api_keys').selectAll()).selectFrom('k').select((eb) => eb.fn('to_jsonb', [eb.table('k')]).as('row'));
      expect(sent(cte)).not.toContain('token');
      const keys = db
        .selectFrom('users')
        .select((eb) => ['name', pgArrayFrom(eb.selectFrom('api_keys').selectAll().whereRef('api_keys.user_id', '=', 'users.id')).as('keys')])
        .where('id', '=', ids.ada);
      expect(sent(keys)).not.toContain('token');
      if (driver === 'pgsql') {
        expect(JSON.stringify(await cte.execute())).not.toContain('the-secret-token');
        expect(await keys.execute()).toEqual([{ name: 'Ada', keys: [{ id: expect.any(Number), user_id: ids.ada, name: 'cli' }] }]);
      }
    });

    it('are refused through an outer subquery or common table expression that asked for one — in a relation never', async () => {
      const posts = () =>
        db
          .selectFrom('posts')
          .innerJoin((eb) => eb.selectFrom('api_keys').select((e) => ['user_id', secret(e, 'token')]).as('k'), (join) => join.onRef('k.user_id', '=', 'posts.author_id'))
          .select('posts.title');
      await expect(posts().with('comments', (c) => c.select(['body', sql.ref('k.token').as('t')])).execute()).rejects.toThrow(refused(`with('comments')`, 'k.token'));
      await expect(posts().with('comments', (c) => c.select(['body', sql.ref('token').as('t')])).execute()).rejects.toThrow(refused(`with('comments')`, 'k.token'));
      await expect(posts().with('comments', (c) => c.select((eb) => ['body', secret(eb as never, 'k.token' as never)])).execute()).rejects.toThrow(
        refused(`with('comments')`, 'k.token'),
      );
      const cte = () => db.with('k', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e, 'token')])).selectFrom('posts').select('posts.title');
      await expect(
        cte().with('comments', (c) => c.innerJoin('k', 'k.user_id', 'comments.user_id').select(['body', (eb) => eb.fn('to_jsonb', [eb.table('k')]).as('key')])).execute(),
      ).rejects.toThrow(row(`with('comments')`, 'k'));
      await expect(cte().with('comments', (c) => c.select(['body', sql.ref('k.token').as('t')])).execute()).rejects.toThrow(refused(`with('comments')`, 'k.token'));
      // A common table expression of selectAll() has no secret column to pass on.
      const all = db.with('k', (q) => q.selectFrom('api_keys').selectAll()).selectFrom('posts').select('posts.title');
      const joined = all.with('comments', (c) => c.innerJoin('k', 'k.user_id', 'comments.user_id').select(['body', (eb) => eb.fn('to_jsonb', [eb.table('k')]).as('key')]));
      expect(sent(joined)).not.toContain('token');
      await expect(all.with('comments', (c) => c.innerJoin('k', 'k.user_id', 'comments.user_id').select(['body', sql.ref('k.token').as('t')])).execute()).rejects.toThrow();
    });

    it('are refused in a whole row named with sql.id()', async () => {
      await expect(
        db.selectFrom('users').select('name').with('api_keys', (k) => k.select(sql`to_jsonb(${sql.id('api_keys')})`.as('row'))).execute(),
      ).rejects.toThrow(row(`with('api_keys')`));
      await expect(db.selectFrom('api_keys').select(sql`to_jsonb(${sql.id('api_keys')})`.as('row')).execute()).rejects.toThrow(row('This query'));
    });

    it('are refused when an insert copies one — also on the first query of a process', async () => {
      const copy = (target: Kysely<FixtureTables>) => target.insertInto('tags').columns(['slug']).expression((eb) => eb.selectFrom('api_keys').select('token' as never));
      await expect(copy(db).execute()).rejects.toThrow(unasked('api_keys.token'));
      const cold = new Connections({ connections: { default: options }, root: '/', logger: silent });
      try {
        await expect(copy(cold.get<FixtureTables>()).execute()).rejects.toThrow(unasked('api_keys.token'));
      } finally {
        await cold.destroy();
      }
    });

    it('may be in a subquery that only filters a relation — refused all the same (filter on the key instead)', async () => {
      await expect(
        db
          .selectFrom('users')
          .select('name')
          .with('comments', (c) => c.where((eb) => eb.exists(eb.selectFrom('api_keys').select('token' as never).whereRef('api_keys.user_id', '=', 'comments.user_id'))))
          .execute(),
      ).rejects.toThrow(refused(`with('comments')`));
      const [ada] = await db
        .selectFrom('users')
        .select('name')
        .with('comments', (c) => c.select('body').where('user_id', 'in', (eb) => eb.selectFrom('api_keys').select('user_id').where('token' as never, '=', 'the-secret-token' as never)))
        .where('id', '=', ids.ada)
        .execute();
      expect(ada!.comments).toEqual([{ body: 'two' }]);
    });

    it('are carried through a recursive common table expression — every column, once one carries a secret', async () => {
      const k = (target: Kysely<FixtureTables>) =>
        target.withRecursive('k(user_id, name, token, depth)', (q) =>
          q
            .selectFrom('api_keys')
            .select((e) => ['user_id', 'name', secret(e, 'token'), sql<number>`0`.as('depth')])
            .unionAll((eb) => eb.selectFrom('k').select(['k.user_id', 'k.token as name', 'k.token', sql<number>`k.depth + 1`.as('depth')]).where('k.depth', '<', 1)),
        );
      await expect(k(db).selectFrom('k').select('name').execute()).rejects.toThrow(unasked('k.name'));
      await expect(
        k(db).selectFrom('posts').select('title').with('comments', (c) => c.innerJoin('k', 'k.user_id', 'comments.user_id').select(['body', 'k.name'])).execute(),
      ).rejects.toThrow(refused(`with('comments')`, 'k.name'));
    });

    it('are not lined up with a part of a union whose columns are unknown — a view’s selectAll()', async () => {
      const any = db as unknown as Kysely<any>;
      await sql`create view v_probe as select 'v' as name, 'w' as token2`.execute(db);
      const union = `This query combines a select that passes on a secret column with one whose columns are not known (a selectAll() of a table the migrations did not create, such as a view), so they cannot be lined up. Name the columns of both. See docs/migrations.md#secret-columns.`;
      try {
        const k = () => any.with('k', (q) => q.selectFrom('v_probe').selectAll().unionAll(q.selectFrom('api_keys').select((e) => ['name', secret(e as never, 'token' as never)])));
        await expect(k().selectFrom('k').selectAll().execute()).rejects.toThrow(union);
        await expect(
          k()
            .selectFrom('posts')
            .select('title')
            .with('comments', (c: any) => c.innerJoin('k', 'k.name', 'comments.body').select(['body', 'k.token2']))
            .execute(),
        ).rejects.toThrow(union);
        // Without a secret, a view's columns need not be known.
        expect(await any.selectFrom('v_probe').selectAll().execute()).toEqual([{ name: 'v', token2: 'w' }]);
        // A select of unknown width that carries a secret cannot be spelled out: its whole row is refused, readably.
        const wide = any.with('k', (q) => q.selectFrom('v_probe').innerJoin('api_keys', 'api_keys.name', 'v_probe.name').selectAll('v_probe').select((e) => [secret(e as never, 'token' as never)]));
        await expect(wide.selectFrom('k').selectAll().execute()).rejects.toThrow(row('This query', 'k'));
      } finally {
        await sql`drop view v_probe`.execute(db);
      }
    });

    it.runIf(driver === 'pgsql')('are left out of a merge’s returningAll(), and refused in its returning by name', async () => {
      const merge = () => db.mergeInto('api_keys').using('users', 'users.id', 'api_keys.user_id').whenMatched().thenUpdateSet({ name: 'cli' });
      const rows = await merge().returningAll('api_keys').execute();
      expect(rows).toEqual([{ id: expect.any(Number), user_id: ids.ada, name: 'cli' }]);
      await expect(merge().returning('api_keys.token' as never).execute()).rejects.toThrow(unasked('api_keys.token'));
      // A subquery in the `on` of its using clause is checked like one in a where.
      const on = db
        .mergeInto('api_keys')
        .using('users', (join) => join.onRef('users.id', '=', 'api_keys.user_id').on('api_keys.token' as never, 'in', (eb) => eb.selectFrom('api_keys as z').select('z.token' as never)))
        .whenMatched()
        .thenUpdateSet({ name: 'cli' });
      await expect(on.execute()).rejects.toThrow(unasked('api_keys.token'));
    });

    it('are refused in a selectAll() of nothing but secret columns — never an empty select', async () => {
      await expect(db.with('k', (q) => q.selectFrom('api_keys').select((e) => [secret(e, 'token')])).selectFrom('k').selectAll().execute()).rejects.toThrow(
        'This query selects all columns of k, and every one is a secret column — name the columns it needs, and read a secret one with secret(eb, …). See docs/migrations.md#secret-columns.',
      );
      await expect(db.selectFrom('api_keys').selectAll('users' as never).execute()).rejects.toThrow('This query selects all columns of "users", which is no table, subquery or alias of its own.');
    });

    it('get the same verdict on the first query of a process and later — secret() in a builder of the connection used as a subquery', async () => {
      const fresh = new Connections({ connections: { default: options }, root: '/', logger: silent });
      try {
        const own = fresh.get<FixtureTables>();
        const inner = () => own.selectFrom('api_keys').select((e) => ['user_id', secret(e, 'token')]);
        const derived = () => own.selectFrom(inner().as('k')).select((eb) => ['k.user_id', secret(eb as never, 'k.token' as never)]);
        const cte = () => own.with('k', inner()).selectFrom('k').select((eb) => ['k.user_id', secret(eb as never, 'k.token' as never)]);
        const union = () => own.selectFrom('api_keys').select((e) => ['user_id', secret(e, 'token')]).union(inner());
        const expected = [{ user_id: ids.ada, token: 'the-secret-token' }];
        for (const round of ['cold', 'warm']) {
          expect(await derived().execute(), round).toEqual(expected);
          expect(await cte().execute(), round).toEqual(expected);
          expect(await union().execute(), round).toEqual(expected);
        }
        await expect(own.selectFrom(inner().as('k')).select(['k.user_id', 'k.token']).execute()).rejects.toThrow(unasked('k.token'));
      } finally {
        await fresh.destroy();
      }
    });

    it('are followed through a common table expression that refers to a later one — the clause is checked as a whole, in any order', async () => {
      // `a` reads `b`, defined after it: SQLite allows that in any WITH, Postgres under WITH RECURSIVE. The check comes first on both.
      const forward = (target: Kysely<FixtureTables>, keyword = true) => {
        const a = ((q: Kysely<any>) => q.selectFrom('b').select((e) => ['b.user_id', secret(e as never, 'b.token' as never)])) as never;
        const b = ((q: Kysely<any>) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)])) as never;
        const any = target as unknown as Kysely<any>;
        return (keyword ? any.withRecursive('a(user_id, name)', a) : any.with('a(user_id, name)', a)).with('b', b) as unknown as Kysely<FixtureTables & { a: { user_id: number; name: string } }>;
      };
      await expect(forward(db).selectFrom('a').select('name').execute()).rejects.toThrow(unasked('a.name'));
      await expect(forward(db, false).selectFrom('a').select('name').execute()).rejects.toThrow(unasked('a.name'));
      await expect(
        forward(db)
          .selectFrom('posts')
          .select('title')
          .with('comments', (c: any) => c.innerJoin('a', 'a.user_id', 'comments.user_id').select(['body', 'a.name']))
          .execute(),
      ).rejects.toThrow(refused(`with('comments')`, 'a.name'));
      expect(await forward(db).selectFrom('a').select((e) => [secret(e, 'a.name' as never)]).execute()).toEqual([{ name: 'the-secret-token' }]);
      // Read in `a` without asking: refused where it happens.
      const plain = (db as unknown as Kysely<any>)
        .withRecursive('a(user_id, name)', ((q: Kysely<any>) => q.selectFrom('b').select(['b.user_id', 'b.token'])) as never)
        .with('b', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)]));
      await expect(plain.selectFrom('a').select('user_id').execute()).rejects.toThrow(unasked('b.token'));
    });

    it('are carried through a common table expression that refers to itself without the RECURSIVE keyword — SQLite runs it as recursive', async () => {
      const k = (target: Kysely<FixtureTables>) =>
        (target as unknown as Kysely<any>).with('k(user_id, name, token, depth)', ((q: Kysely<any>) =>
          q
            .selectFrom('api_keys')
            .select((e) => ['user_id', 'name', secret(e as never, 'token' as never), sql<number>`0`.as('depth')])
            .unionAll((eb) => eb.selectFrom('k').select(['k.user_id', 'k.token as name', 'k.token', sql<number>`k.depth + 1`.as('depth')]).where('k.depth', '<', 1))) as never,
        ) as unknown as Kysely<FixtureTables & { k: { user_id: number; name: string; token: string; depth: number } }>;
      await expect(k(db).selectFrom('k').select('name').execute()).rejects.toThrow(unasked('k.name'));
      await expect(
        k(db).selectFrom('posts').select('title').with('comments', (c) => c.innerJoin('k', 'k.user_id', 'comments.user_id').select(['body', 'k.name'])).execute(),
      ).rejects.toThrow(refused(`with('comments')`, 'k.name'));
    });

    it('refuse a common table expression named like a table or like one around it — a reference would mean one or the other, by database', async () => {
      const any = db as unknown as Kysely<any>;
      const shadows = (name: string, what: string) =>
        `This query names a common table expression "${name}", which is also ${what} — rename the expression: whether a reference means the one or the other differs between databases, so the check for secret columns cannot follow it. See docs/migrations.md#secret-columns.`;
      const table = shadows('api_keys', 'a table of the migrations');
      // Without RECURSIVE, Postgres resolves a reference to a later expression to the table of that name; SQLite to the expression.
      if (driver === 'pgsql') {
        const bare = any.withoutPlugins().with('a', (q) => q.selectFrom('api_keys').select('token')).with('api_keys', (q) => q.selectFrom('users').select('name as token'));
        expect(await bare.selectFrom('a').select('token').execute()).toEqual([{ token: 'the-secret-token' }]);
      }
      const later = (target: Kysely<any>) =>
        target.with('a', (q) => q.selectFrom('api_keys').select(['user_id', 'token'])).with('api_keys', (q) => q.selectFrom('users').select(['id as user_id', 'name as token']));
      await expect(later(any).selectFrom('a').select('token').execute()).rejects.toThrow(table);
      await expect(later(any).selectFrom('a').selectAll().execute()).rejects.toThrow(table);
      await expect(
        later(any).selectFrom('posts').select('title').with('comments', (c: any) => c.innerJoin('a', 'a.user_id', 'comments.user_id').select(['body', 'a.token'])).execute(),
      ).rejects.toThrow(table);
      // A later expression of a nested clause, named like an outer one that asked with secret().
      const outer = shadows('b', 'a common table expression around it');
      const nested = (target: Kysely<any>) =>
        target.with('b', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)])).selectFrom(
          target
            .with('a', (q) => q.selectFrom('b').select(['b.user_id', 'b.token']))
            .with('b', (q) => q.selectFrom('users').select(['id as user_id', 'name as token']))
            .selectFrom('a')
            .select(['a.user_id', 'a.token'])
            .as('x'),
        );
      await expect(nested(any).select('x.token').execute()).rejects.toThrow(outer);
      // A builder of the connection joined in a relation is compiled where the join is built: the refusal is thrown there.
      expect(() =>
        any
          .with('b', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)]))
          .selectFrom('posts')
          .select('title')
          .with('comments', (c: any) => c.innerJoin(nested(any).select(['x.user_id', 'x.token']).as('x'), 'x.user_id', 'comments.user_id').select(['body', 'x.token'])),
      ).toThrow(outer);
      // Without any secret involved too — and the same name twice in one clause.
      await expect(any.with('users', (q) => q.selectFrom('posts').select('id')).selectFrom('users').select('id').execute()).rejects.toThrow(shadows('users', 'a table of the migrations'));
      await expect(any.with('k', (q) => q.selectFrom('posts').select('id')).with('k', (q) => q.selectFrom('tags').select('id')).selectFrom('k').select('id').execute()).rejects.toThrow(
        shadows('k', 'a common table expression around it'),
      );
      await expect(any.with('k', (q) => q.selectFrom('posts').select('id')).selectFrom(any.with('k', (q) => q.selectFrom('tags').select('id')).selectFrom('k').select('id').as('x')).select('x.id').execute()).rejects.toThrow(
        shadows('k', 'a common table expression around it'),
      );
    });

    it('are found by a name in another case — SQLite reads TOKEN as token, API_KEYS as api_keys', async () => {
      const any = db as unknown as Kysely<any>;
      queries.length = 0;
      // Postgres would fail on these names; SQLite reads the secret column — refused on both.
      await expect(any.selectFrom('api_keys').select(['name', 'TOKEN']).execute()).rejects.toThrow(unasked('api_keys.TOKEN'));
      await expect(any.selectFrom('api_keys').select(sql.ref('api_keys.TOKEN').as('t')).execute()).rejects.toThrow(unasked('api_keys.TOKEN'));
      await expect(db.selectFrom('api_keys').select(sql.ref('TOKEN').as('t')).execute()).rejects.toThrow(unasked('api_keys.TOKEN'));
      await expect(any.selectFrom('API_KEYS').select('token').execute()).rejects.toThrow(unasked('API_KEYS.token'));
      await expect(any.selectFrom('api_keys as K').select('k.token').execute()).rejects.toThrow(unasked('api_keys.token'));
      const derived = any.selectFrom((eb) => eb.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)]).as('D'));
      await expect(derived.select('d.token').execute()).rejects.toThrow(unasked('D.token'));
      const cte = any.with('k', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)]));
      await expect(cte.selectFrom('k').select('K.token').execute()).rejects.toThrow(unasked('k.token'));
      await expect(cte.selectFrom('K').select('k.token').execute()).rejects.toThrow(unasked('K.token'));
      await expect(any.updateTable('api_keys').set({ name: 'cli' }).returning('TOKEN').execute()).rejects.toThrow(unasked('api_keys.TOKEN'));
      expect(queries).toEqual([]);
      // A selectAll() of the table in another case is spelled out without the secret column.
      const all = any.selectFrom('API_KEYS').selectAll();
      const returned = any.updateTable('API_KEYS').set({ name: 'cli' }).returningAll();
      expect(sent(all)).not.toContain('token');
      expect(sent(returned)).not.toContain('token');
      if (driver === 'sqlite') {
        expect(await all.execute()).toEqual([{ id: expect.any(Number), user_id: ids.ada, name: 'cli' }]);
        expect(await returned.execute()).toEqual([{ id: expect.any(Number), user_id: ids.ada, name: 'cli' }]);
      }
    });

    it('are found by a name in another case inside a relation too', async () => {
      const comments = (callback: (c: any) => any) => db.selectFrom('posts').select('title').with('comments', callback as never).where('id', '=', ids.first).execute();
      await expect(comments((c) => c.innerJoin('API_KEYS as k', 'k.user_id', 'comments.user_id').select(['body', 'k.token']))).rejects.toThrow(refused(`with('comments')`, 'API_KEYS.token'));
      await expect(comments((c) => c.innerJoin('api_keys as k', 'k.user_id', 'comments.user_id').select(['body', 'k.TOKEN']))).rejects.toThrow(refused(`with('comments')`, 'api_keys.TOKEN'));
      await expect(comments((c) => c.innerJoin('api_keys as k', 'k.user_id', 'comments.user_id').select(['body', sql.ref('k.TOKEN').as('t')]))).rejects.toThrow(
        refused(`with('comments')`, 'api_keys.TOKEN'),
      );
      await expect(comments((c) => c.innerJoin('api_keys as K', 'K.user_id', 'comments.user_id').select(['body', 'k.token']))).rejects.toThrow(refused(`with('comments')`));
      // A selectAll() of the joined table in another case leaves the secret column out.
      const [post] = await db
        .selectFrom('posts')
        .select('title')
        .with('comments', ((c: any) => c.innerJoin('API_KEYS as k', 'k.user_id', 'comments.user_id').select('comments.body').selectAll('k')) as never)
        .where('id', '=', ids.first)
        .execute()
        .catch(() => [{ comments: [] }]); // Postgres: no table "API_KEYS"
      expect(JSON.stringify(post)).not.toContain('the-secret-token');
    });

    it('refuse a common table expression named like a table or an outer one in another case — SQLite would read the one for the other', async () => {
      const any = db as unknown as Kysely<any>;
      const shadows = (name: string, what: string) =>
        `This query names a common table expression "${name}", which is also ${what} — rename the expression: whether a reference means the one or the other differs between databases, so the check for secret columns cannot follow it. See docs/migrations.md#secret-columns.`;
      const users = (target: Kysely<any>) => target.with('USERS(id, name)', ((q: Kysely<any>) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)])) as never);
      await expect(users(any).selectFrom('users').select('name').execute()).rejects.toThrow(shadows('USERS', 'a table of the migrations'));
      await expect(
        users(any)
          .selectFrom('posts')
          .select('title')
          .with('comments', (c: any) => c.innerJoin('users', 'users.id', 'comments.user_id').select(['body', 'users.name']))
          .execute(),
      ).rejects.toThrow(shadows('USERS', 'a table of the migrations'));
      // An inner `K` that asked for the token, read as `k`: SQLite reads the inner one.
      await expect(
        any.with('K', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)])).selectFrom('k').select(['k.user_id', 'k.token']).execute(),
      ).rejects.toThrow(unasked('k.token'));
      const inner = any.with('K', (q) => q.selectFrom('posts').select('id as user_id')).selectFrom('k').select('k.user_id');
      const outer = any.with('k', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)]));
      await expect(outer.selectFrom(inner.as('x')).select('x.user_id').execute()).rejects.toThrow(shadows('K', 'a common table expression around it'));
      const asked = any.with('b', (q) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)]));
      await expect(asked.selectFrom('b').select('B.token').execute()).rejects.toThrow(unasked('b.token'));
      await expect(
        asked
          .selectFrom('posts')
          .select('title')
          .with('comments', (c: any) => c.innerJoin('B', 'B.user_id', 'comments.user_id').select(['body', 'b.token']))
          .execute(),
      ).rejects.toThrow(refused(`with('comments')`, 'B.token'));
    });

    it('refuse two names in scope that differ only in case — Postgres tells them apart, SQLite does not', async () => {
      const any = db as unknown as Kysely<any>;
      const apart = (a: string, b: string) =>
        `This query names "${a}" and "${b}", which differ only in case — rename one: some databases tell them apart and some do not, so the check for secret columns cannot follow them. See docs/migrations.md#secret-columns.`;
      // On Postgres `k.token` below is the outer api_keys' token; on SQLite the inner tags' — the check cannot follow either way.
      const inner = (target: Kysely<any>) => target.selectFrom('tags as K').select((eb) => eb.ref('k.token').as('t')).limit(1);
      await expect(any.selectFrom('api_keys as k').select(['name', inner(any).as('t')]).execute()).rejects.toThrow(apart('k', 'K'));
      await expect(any.selectFrom(['tags as K', 'api_keys as k']).select('k.name').execute()).rejects.toThrow(apart('K', 'k'));
      // The same name in nested scopes means the inner one on every database.
      expect(await any.selectFrom('api_keys as k').select((eb) => ['k.name', eb.selectFrom('tags as k').select('k.slug').orderBy('k.id').limit(1).as('slug')]).execute()).toEqual([
        { name: 'cli', slug: 'kysely' },
      ]);
    });

    it('spell out a selectAll() as the last pass over a with clause sees it — the model and the SQL agree', async () => {
      // `a` reads all of `b`, defined after it: the first pass knows no secret in `b`, the last one does.
      const query = (db as unknown as Kysely<any>)
        .withRecursive('a', (q) => q.selectFrom('b').selectAll())
        .with('b(user_id, name)', ((q: Kysely<any>) => q.selectFrom('api_keys').select((e) => ['user_id', secret(e as never, 'token' as never)])) as never)
        .selectFrom('a')
        .selectAll();
      const compiled = sent(query);
      expect(compiled).toContain('"b"."user_id"');
      expect(compiled).not.toContain('"b".*');
      expect(await query.execute()).toEqual([{ user_id: ids.ada }]);
    });
  });

  describe('counting and filtering by relations', () => {
    it('counts a hasMany and a belongsToMany as numbers in the same query — soft-deleted rows left out, also behind a pivot', async () => {
      const { result: rows, sql } = await logged(() =>
        db.selectFrom('posts').select(['id', 'title']).withCount('comments').withCount('tags').withCount('users', { as: 'readers' }).orderBy('id').execute(),
      );
      expect(sql).toHaveLength(1);
      expect(sql[0]).not.toContain('__marmeon');
      expect(rows).toEqual([
        { id: ids.first, title: 'First', comments_count: 2, tags_count: 2, readers: 1 },
        { id: ids.second, title: 'Second', comments_count: 0, tags_count: 1, readers: 1 },
      ]);
      expectTypeOf(rows[0]!).toEqualTypeOf<{ id: number; title: string; comments_count: number; tags_count: number; readers: number }>();
    });

    it('counts what the callback narrows to — withTrashed() in it counts the soft-deleted rows, at that level only', async () => {
      const [first] = await db
        .selectFrom('posts')
        .select('id')
        .withCount('comments', (q) => q.where('approved', '=', true))
        .withCount('comments', { as: 'all_comments' }, (q) => q.withTrashed())
        .withCount('users', { as: 'readers' }, (q) => q.withTrashed())
        .withCount('users', { as: 'gone_readers' }, (q) => q.where('name', '=', 'Gone'))
        .where('id', '=', ids.first)
        .execute();
      expect(first).toEqual({ id: ids.first, comments_count: 1, all_comments: 3, readers: 2, gone_readers: 0 });
    });

    it('counts inside a relation, on a table related to itself, and on the first query of a process', async () => {
      const { result: [ada], sql } = await logged(() =>
        db
          .selectFrom('users')
          .select('name')
          .withCount('comments')
          .with('authored_posts', (posts) => posts.select(['title', 'rating', 'featured']).withCount('comments').withCount('tags'))
          .where('id', '=', ids.ada)
          .execute(),
      );
      expect(sql).toHaveLength(1);
      expect(ada).toEqual({ name: 'Ada', comments_count: 1, authored_posts: [{ title: 'First', rating: '4.50', featured: true, comments_count: 2, tags_count: 2 }] });
      expectTypeOf(ada!.authored_posts[0]!.comments_count).toEqualTypeOf<number>();
      const categories = await db.selectFrom('categories').select('name').withCount('categories', { as: 'children' }).orderBy('id').execute();
      expect(categories).toEqual([
        { name: 'root', children: 1 },
        { name: 'child', children: 1 },
        { name: 'grandchild', children: 0 },
      ]);
      const cold = new Connections({ connections: { default: options }, root: '/', logger: silent });
      try {
        const counted = await cold.get<FixtureTables>().selectFrom('posts').select('id').withCount('comments').whereHas('tags').orderBy('id').execute();
        expect(counted).toEqual([
          { id: ids.first, comments_count: 2 },
          { id: ids.second, comments_count: 0 },
        ]);
      } finally {
        await cold.destroy();
      }
    });

    it('filters with whereHas() and whereDoesntHave() — EXISTS, soft-deleted related rows do not count unless asked', async () => {
      const titles = async (query: SelectQueryBuilder<FixtureTables, 'posts', { title: string }>) => (await query.orderBy('posts.id').execute()).map((row) => row.title);
      const posts = () => db.selectFrom('posts').select('title');
      const { result: has, sql } = await logged(() => titles(posts().whereHas('comments')));
      expect(has).toEqual(['First']);
      expect(sql).toHaveLength(1);
      expect(sql[0]).toContain('exists (select 1 from "comments"');
      expect(await titles(posts().whereDoesntHave('comments'))).toEqual(['Second']);
      expect(await titles(posts().whereHas('comments', (q) => q.where('body', '=', 'deleted')))).toEqual([]);
      expect(await titles(posts().whereHas('comments', (q) => q.where('body', '=', 'deleted').withTrashed()))).toEqual(['First']);
      // The author of the second post is soft-deleted: it has none.
      expect(await titles(posts().whereHas('author'))).toEqual(['First']);
      expect(await titles(posts().whereDoesntHave('author'))).toEqual(['Second']);
      // Through a pivot — to a table with soft deletes.
      expect(await titles(posts().whereHas('tags', (q) => q.where('slug', '=', 'kysely')))).toEqual(['First']);
      expect(await titles(posts().whereHas('users', (q) => q.where('name', '=', 'Gone')))).toEqual([]);
      expect(await titles(posts().whereHas('users', (q) => q.where('name', '=', 'Gone').withTrashed()))).toEqual(['First']);
      expect(await titles(posts().whereDoesntHave('users', (q) => q.where('name', '=', 'Ada')))).toEqual(['Second']);
    });

    it('nests whereHas() in its callbacks and combines it with with() and withCount() — still one query', async () => {
      const { result: users, sql } = await logged(() =>
        db
          .selectFrom('users')
          .select('name')
          .whereHas('authored_posts', (posts) => posts.whereHas('tags', (tags) => tags.where('slug', '=', 'kysely')).whereDoesntHave('users', (readers) => readers.where('name', '=', 'Alan')))
          .with('comments', (comments) => comments.select('body').whereHas('post', (post) => post.where('featured', '=', true)))
          .withCount('authored_posts', (posts) => posts.whereHas('comments'))
          .execute(),
      );
      expect(sql).toHaveLength(1);
      expect(users).toEqual([{ name: 'Ada', comments: [{ body: 'two' }], authored_posts_count: 1 }]);
      // On a table related to itself: the categories with a child that has a child.
      const parents = await db
        .selectFrom('categories')
        .select('name')
        .whereHas('categories', (children) => children.whereHas('categories'))
        .execute();
      expect(parents).toEqual([{ name: 'root' }]);
      // On a repository's query(), which leaves its own soft-deleted rows out.
      const repository = new UserRepository(connections);
      expect(await repository.query().select('name').whereHas('authored_posts').execute()).toEqual([{ name: 'Ada' }]);
      // withTrashed() in the callback keeps that level's rows only: the repository's own deleted user stays out.
      expect(await repository.query().select('name').whereHas('posts', (posts) => posts.withTrashed()).orderBy('id').execute()).toEqual([{ name: 'Ada' }, { name: 'Alan' }]);
    });

    it('pages with paginate() — the count keeps whereHas() and leaves withCount() out', async () => {
      const { result: page, sql } = await logged(() =>
        paginate(db, db.selectFrom('posts').select('title').withCount('comments').whereHas('users').orderBy('id'), { page: 1, perPage: 1 }),
      );
      expect(page.data).toEqual([{ title: 'First', comments_count: 2 }]);
      expect(page.meta.total).toBe(2);
      expect(sql[0]).toContain('exists');
      expect(sql[0]).not.toContain('count(*) as integer');
    });

    it('refuses what would change a count or an exists in a callback — groupBy(), having(), limit(), offset()', async () => {
      const posts = () => db.selectFrom('posts').select('title');
      const counts = (parts: string) =>
        `withCount('comments') counts the related rows its callback's conditions match — ${parts} in the callback would change what it counts: leave it out and filter with where().`;
      await expect(posts().withCount('comments', (q) => q.groupBy('approved')).execute()).rejects.toThrow(counts('groupBy()'));
      await expect(posts().withCount('comments', (q) => q.limit(1)).execute()).rejects.toThrow(counts('limit()'));
      await expect(posts().withCount('comments', (q) => q.offset(1)).execute()).rejects.toThrow(counts('offset()'));
      await expect(posts().withCount('comments', (q) => q.having(sql<boolean>`count(*) > 1`)).execute()).rejects.toThrow(counts('having()'));
      await expect(posts().whereHas('comments', (q) => q.limit(1).offset(5)).execute()).rejects.toThrow(
        `whereHas('comments') asks whether there is a related row its callback's conditions match — limit() and offset() in the callback would change the answer: leave them out and filter with where().`,
      );
    });

    it('refuses a set operation in a count or an exists callback, and having() without groupBy() in an exists', async () => {
      const posts = () => db.selectFrom('posts').select('title');
      const other = db.selectFrom('comments').selectAll();
      await expect(posts().withCount('comments', (q) => q.union(other)).execute()).rejects.toThrow(
        `withCount('comments') counts the related rows its callback's conditions match — union() in the callback would change what it counts: leave it out and filter with where().`,
      );
      await expect(posts().whereHas('comments', (q) => q.unionAll(other).except(other)).execute()).rejects.toThrow(
        `whereHas('comments') asks whether there is a related row its callback's conditions match — unionAll() and except() in the callback would change the answer: leave them out and filter with where().`,
      );
      await expect(posts().whereDoesntHave('comments', (q) => q.intersect(other)).execute()).rejects.toThrow(`whereDoesntHave('comments') asks whether there is`);
      await expect(posts().whereHas('comments', (q) => q.having(sql<boolean>`count(*) > 1`)).execute()).rejects.toThrow(
        `whereHas('comments') asks whether there is a related row its callback's conditions match — having() without groupBy() makes every related row one group, which databases answer differently: add groupBy(), or filter with where().`,
      );
      // Grouped, having() asks about the groups — the same on every database.
      const grouped = await posts()
        .whereHas('comments', (q) => q.groupBy('post_id').having(sql<boolean>`count(*) > 1`))
        .orderBy('id')
        .execute();
      expect(grouped).toEqual([{ title: 'First' }]);
    });

    it('refuses a count or a relation under a name the query selects already', async () => {
      const taken = (label: string, name: string) => `${label} adds "${name}", which the query selects already — give it another name with { as }.`;
      await expect(db.selectFrom('posts').select('title').withCount('comments', { as: 'title' }).execute()).rejects.toThrow(taken(`withCount('comments')`, 'title'));
      await expect(db.selectFrom('posts').selectAll().withCount('tags', { as: 'rating' }).execute()).rejects.toThrow(taken(`withCount('tags')`, 'rating'));
      await expect(db.selectFrom('posts').select('id as author').with('author').execute()).rejects.toThrow(taken(`with('author')`, 'author'));
    });

    it('refuses withCount() on a relation of one row — whereHas() asks that', async () => {
      const posts = db.selectFrom('posts').select('title') as unknown as { withCount(name: string): { execute(): Promise<unknown> } };
      await expect(posts.withCount('author').execute()).rejects.toThrow(
        "withCount('author') counts the rows of a list — author is a belongsTo of posts, one row or none: ask whereHas('author') instead.",
      );
    });

    it('may filter on a secret column, never select one — a subquery of its callback that selects one is refused', async () => {
      const users = () => db.selectFrom('users').select('name');
      // A condition on a secret column is allowed — what it answers is still about the secret (see the docs for comparing one).
      expect(await users().whereHas('api_keys', (keys) => keys.where('token' as never, '=', 'the-secret-token' as never)).execute()).toEqual([{ name: 'Ada' }]);
      expect(await users().withCount('api_keys', (keys) => keys.where('token' as never, '=', 'wrong' as never)).where('id', '=', ids.ada).execute()).toEqual([
        { name: 'Ada', api_keys_count: 0 },
      ]);
      const { result, sql } = await logged(() => users().whereHas('api_keys', (keys) => keys.select('token' as never)).execute());
      expect(result).toEqual([{ name: 'Ada' }]);
      expect(sql[0]).not.toMatch(/select "?(api_keys"?\.)?"?token/);
      await expect(
        users()
          .whereHas('comments', (comments) => comments.where('body', 'in', (eb) => eb.selectFrom('api_keys').select('token' as never)))
          .execute(),
      ).rejects.toThrow(
        'This query selects api_keys.token, a secret column, without secret() — read it with secret(eb, …) where it is needed, at every level of the query that passes it on. See docs/migrations.md#secret-columns.',
      );
    });
  });

  it('fails with a message that says why on a connection without Marmeon’s plugins — and sends nothing', async () => {
    const message = `This query loads, counts or filters by relations, leaves out soft-deleted rows or touches a row's timestamps (with(), withCount(), whereHas(), withRelation(), withTrashed(), a repository's query(), update() or delete()), which only the app's connection resolves — it was not sent: it runs on the database connection "default" without Marmeon's plugins (infrastructure(), withoutPlugins()). Build it on connections.get() or Database. See docs/queries.md#relations.`;
    queries.length = 0;
    await expect(db.withoutPlugins().selectFrom('users').select('name').with('comments').execute()).rejects.toThrow(message);
    await expect(connections.infrastructure<FixtureTables>().selectFrom('users').select('name').with('comments').execute()).rejects.toThrow(message);
    await expect(connections.infrastructure<FixtureTables>().selectFrom('users').select('name').withTrashed().execute()).rejects.toThrow(message);
    await expect(connections.infrastructure<FixtureTables>().selectFrom('users').select('name').withCount('comments').execute()).rejects.toThrow(message);
    await expect(connections.infrastructure<FixtureTables>().selectFrom('users').select('name').whereHas('comments').execute()).rejects.toThrow(message);
    // A repository bound to such a connection: update() stamps updated_at, delete() may only mark a row deleted.
    const plain = new PostRepository(connections).using(db.withoutPlugins());
    await expect(plain.update(0, { title: 'never' })).rejects.toThrow(message);
    await expect(plain.delete(0)).rejects.toThrow(message);
    await expect(connections.infrastructure<FixtureTables>().selectFrom('api_keys').select((eb) => ['name', secret(eb, 'token')]).execute()).rejects.toThrow(
      `This query reads a column with secret(), which only the app's connection checks — it was not sent: it runs on the database connection "default" without Marmeon's plugins (infrastructure(), withoutPlugins()), which check no column. Name the column there as it is, or build the query on connections.get() or Database. See docs/migrations.md#secret-columns.`,
    );
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
    // Our own methods (another copy of the package on the same Kysely) are left in place.
    const prototype = Object.getPrototypeOf(db.selectFrom('t')) as Record<string, unknown>;
    const own = prototype['with'];
    installOn(prototype);
    expect(prototype['with']).toBe(own);
  });
});
