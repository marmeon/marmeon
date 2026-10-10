import type { Application, ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import './__fixtures__/relations.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Migrator, RecordNotFoundError, Repository, type Connections, type Json, type Kysely, type QueryEvent } from './index.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'blog', migrations: fixtures('relations') },
  { name: 'keys', migrations: fixtures('relations-secrets') },
  { name: 'readers', migrations: fixtures('relations-readers') },
];

// `users` and `comments` have soft deletes; `api_keys.token` is a secret column.
class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}
class PostRepository extends Repository<'posts', FixtureTables> {
  static table = 'posts' as const;
}
class ApiKeyRepository extends Repository<'api_keys', FixtureTables> {
  static table = 'api_keys' as const;
}

describe.each(drivers)('finders of a repository on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let db: Kysely<FixtureTables>;
  let users: UserRepository;
  let posts: PostRepository;
  let keys: ApiKeyRepository;
  const ids = { ada: 0, alan: 0, gone: 0, first: 0, second: 0 };
  const queries: QueryEvent[] = [];
  const logged = async <T>(run: () => Promise<T>): Promise<{ result: T; sql: string[] }> => {
    queries.length = 0;
    const result = await run();
    return { result, sql: queries.map((query) => query.sql) };
  };

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    db = connections.get<FixtureTables>();
    users = new UserRepository(connections);
    posts = new PostRepository(connections);
    keys = new ApiKeyRepository(connections);
    ids.ada = (await users.insert({ name: 'Ada', email: 'ada@example.com', is_admin: true, balance: '12.50' })).id;
    ids.alan = (await users.insert({ name: 'Alan', email: 'alan@example.com' })).id;
    ids.gone = (await users.insert({ name: 'Gone', email: 'gone@example.com', deleted_at: new Date() })).id;
    ids.first = (await posts.insert({ author_id: ids.ada, editor_id: ids.alan, title: 'First', featured: true, rating: '4.50' })).id;
    ids.second = (await posts.insert({ author_id: ids.gone, title: 'Second' })).id;
    await db
      .insertInto('comments')
      .values([
        { post_id: ids.first, user_id: ids.alan, body: 'one', approved: true, deleted_at: null },
        { post_id: ids.first, user_id: ids.ada, body: 'deleted', approved: false, deleted_at: new Date() },
      ])
      .execute();
    const tag = (await db.insertInto('tags').values({ slug: 'sql' }).returning('id').executeTakeFirstOrThrow()).id;
    await db.insertInto('post_tag').values({ post_id: ids.first, tag_id: tag }).execute();
    await keys.insert({ user_id: ids.ada, name: 'cli', token: 'the-secret-token' });
    connections.onQuery((query) => queries.push(query));
  });
  afterAll(() => close());

  it('findBy() finds a row by a column in one query — never a soft-deleted one, never its secret columns', async () => {
    const { result: alan, sql } = await logged(() => users.findBy('email', 'alan@example.com'));
    expect(alan).toMatchObject({ id: ids.alan, name: 'Alan', is_admin: false, balance: '0.00' });
    expect(sql).toHaveLength(1);
    expectTypeOf(alan).toEqualTypeOf<{
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
    } | undefined>();
    expect(await users.findBy('email', 'gone@example.com')).toBeUndefined();
    const key = await keys.findBy('name', 'cli');
    expect(Object.keys(key!).sort()).toEqual(['id', 'name', 'user_id']);
    // null is compared with `is null`: the second post has no editor.
    expect(await posts.findBy('editor_id', null)).toMatchObject({ id: ids.second });
  });

  it('firstWhere() matches every value it is given — soft-deleted rows left out', async () => {
    expect(await posts.firstWhere({ author_id: ids.ada, featured: true })).toMatchObject({ id: ids.first, title: 'First', rating: '4.50', featured: true });
    expect(await posts.firstWhere({ author_id: ids.ada, featured: false })).toBeUndefined();
    expect(await posts.firstWhere({ editor_id: null, title: 'Second' })).toMatchObject({ id: ids.second });
    expect(await users.firstWhere({ name: 'Gone' })).toBeUndefined();
  });

  it('refuses a finder without a value — never a condition that matches any row', async () => {
    await expect(users.firstWhere({})).rejects.toThrow('firstWhere() needs at least one column to match — it was given none.');
    await expect(users.firstWhere({ email: undefined as never })).rejects.toThrow(
      'firstWhere() was given no value for email (undefined) — a condition without a value would match any row. Pass null to find a NULL.',
    );
    await expect(users.findBy('email', undefined as never)).rejects.toThrow(
      'findBy() was given no value for email (undefined) — a condition without a value would match any row. Pass null to find a NULL.',
    );
  });

  it('pluck() reads one column of every row — not of the soft-deleted ones; a secret column is refused', async () => {
    const { result: names, sql } = await logged(() => users.pluck('name'));
    expect([...names].sort()).toEqual(['Ada', 'Alan']);
    expect(sql).toHaveLength(1);
    expectTypeOf(names).toEqualTypeOf<string[]>();
    expect(await posts.pluck('rating')).toEqual(expect.arrayContaining(['4.50', '0.00']));
    expect(await users.pluck('is_admin')).toEqual(expect.arrayContaining([true, false]));
    await expect(keys.pluck('token' as never)).rejects.toThrow('This query selects api_keys.token, a secret column, without secret()');
  });

  it('findOrFail(id, { with }) loads relations in the same query — soft-deleted related rows left out — and answers 404', async () => {
    const { result: post, sql } = await logged(() => posts.findOrFail(ids.first, { with: ['author', 'comments', 'tags'] }));
    expect(sql).toHaveLength(1);
    expect(post).toMatchObject({ id: ids.first, title: 'First', author: { id: ids.ada, name: 'Ada', is_admin: true, balance: '12.50' }, tags: [{ slug: 'sql' }] });
    expect(post.comments.map((comment) => comment.body)).toEqual(['one']);
    expectTypeOf(post.title).toEqualTypeOf<string>();
    expectTypeOf(post.author).toEqualTypeOf<{
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
    expectTypeOf(post.tags).toEqualTypeOf<{ id: number; slug: string }[]>();
    // The author is soft-deleted: none comes through.
    expect((await posts.findOrFail(ids.second, { with: ['author'] })).author).toBeNull();
    const user = await users.findOrFail(ids.ada, { with: ['api_keys'] });
    expect(user.api_keys).toEqual([{ id: expect.any(Number), user_id: ids.ada, name: 'cli' }]);
    await expect(users.findOrFail(ids.gone, { with: ['comments'] })).rejects.toBeInstanceOf(RecordNotFoundError);
    // Without relations, the row as it is.
    expectTypeOf(await posts.findOrFail(ids.first)).toEqualTypeOf<NonNullable<Awaited<ReturnType<PostRepository['find']>>>>();
  });

  describe('chunk()', () => {
    const seed = async (count: number) => {
      const made: number[] = [];
      for (let index = 0; index < count; index++) made.push((await users.insert({ name: `Reader ${index}`, email: `reader${index}@example.com` })).id);
      return made;
    };

    it('reads the rows in batches by key — one query each, soft-deleted rows left out', async () => {
      const made = await seed(5);
      try {
        const batches: number[][] = [];
        const { sql } = await logged(async () => {
          for await (const rows of users.chunk(3)) batches.push(rows.map((row) => row.id));
        });
        expect(batches.flat()).toEqual([ids.ada, ids.alan, ...made]);
        expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
        expect(sql).toHaveLength(3);
        expect(batches.flat()).not.toContain(ids.gone);
      } finally {
        await db.deleteFrom('users').where('id', 'in', made).execute();
      }
    });

    it('narrows with its callback — conditions, relations — and types the batches by it', async () => {
      const batches: { id: number; title: string; comments_count: number; author: { name: string } | null }[][] = [];
      const { sql } = await logged(async () => {
        for await (const rows of posts.chunk(1, (query) => query.where('featured', '=', true).withCount('comments').with('author', (author) => author.select('name')))) {
          expectTypeOf(rows[0]!.comments_count).toEqualTypeOf<number>();
          expectTypeOf(rows[0]!.author).toEqualTypeOf<{ name: string } | null>();
          batches.push(rows);
        }
      });
      expect(batches).toEqual([[expect.objectContaining({ id: ids.first, title: 'First', comments_count: 1, author: { name: 'Ada' } })]]);
      // One query per batch: the first batch was full, so a second one asked for more.
      expect(sql).toHaveLength(2);
      expect(sql[0]).not.toContain('offset');
    });

    it('stays stable while rows are added and removed during the iteration — none twice, none skipped', async () => {
      const made = await seed(6);
      const late: number[] = [];
      try {
        const seen: number[] = [];
        for await (const rows of users.chunk(2, (query) => query.where('name', 'like', 'Reader%'))) {
          seen.push(...rows.map((row) => row.id));
          if (seen.length === 2) {
            // The rows just read go, a new one comes: an offset would now skip the next two rows.
            await db.deleteFrom('users').where('id', 'in', seen).execute();
            late.push((await users.insert({ name: 'Reader late', email: 'late@example.com' })).id);
          }
        }
        expect(seen).toEqual([...made, ...late]);
        expect(new Set(seen).size).toBe(seen.length);
      } finally {
        await db.deleteFrom('users').where('id', 'in', [...made, ...late]).execute();
      }
    });

    it('refuses a size that is not a whole number ≥ 1, and a callback that leaves the key out', async () => {
      await expect(users.chunk(0).next()).rejects.toThrow('chunk() takes a size that is a whole number ≥ 1, got 0.');
      await expect(users.chunk(2.5).next()).rejects.toThrow('chunk() takes a size that is a whole number ≥ 1, got 2.5.');
      await expect(users.chunk(1, (query) => query.clearSelect().select('name') as never).next()).rejects.toThrow(
        'chunk() reads the rows by their key "id", but the query does not select it — keep it in the selection.',
      );
    });
  });
});
