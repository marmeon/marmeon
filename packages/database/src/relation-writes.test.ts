import type { Application, ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import './__fixtures__/relations.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Migrator, RecordNotFoundError, Repository, secret, type Connections, type Kysely, type QueryEvent, type Selectable } from './index.ts';

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'blog', migrations: fixtures('relations') },
  { name: 'keys', migrations: fixtures('relations-secrets') },
  { name: 'readers', migrations: fixtures('relations-readers') },
  { name: 'archive', migrations: fixtures('relations-archived') },
];
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

// posts ↔ tags through post_tag; posts ↔ users (readers, with soft deletes) through post_user; posts → comments (soft deletes,
// timestamps), posts → post_stats (one); users → api_keys (a secret column).
class PostRepository extends Repository<'posts', FixtureTables> {
  static table = 'posts' as const;
}
class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}

describe.each(drivers)('writing through relations on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let db: Kysely<FixtureTables>;
  let posts: PostRepository;
  let users: UserRepository;
  const ids = { ada: 0, alan: 0, gone: 0, first: 0, second: 0, kysely: 0, sql: 0, orm: 0 };
  const queries: QueryEvent[] = [];
  const tagsOf = async (post: number) => (await db.selectFrom('post_tag').select('tag_id').where('post_id', '=', post).orderBy('tag_id').execute()).map((row) => row.tag_id);
  const readersOf = async (post: number) => (await db.selectFrom('post_user').select('user_id').where('post_id', '=', post).orderBy('user_id').execute()).map((row) => row.user_id);

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    db = connections.get<FixtureTables>();
    posts = new PostRepository(connections);
    users = new UserRepository(connections);
    ids.ada = (await users.insert({ name: 'Ada', email: 'ada@example.com' })).id;
    ids.alan = (await users.insert({ name: 'Alan', email: 'alan@example.com' })).id;
    ids.gone = (await users.insert({ name: 'Gone', email: 'gone@example.com', deleted_at: new Date() })).id;
    ids.first = (await posts.insert({ author_id: ids.ada, title: 'First' })).id;
    ids.second = (await posts.insert({ author_id: ids.ada, title: 'Second' })).id;
    for (const slug of ['kysely', 'sql', 'orm'] as const) ids[slug] = (await db.insertInto('tags').values({ slug }).returning('id').executeTakeFirstOrThrow()).id;
    connections.onQuery((query) => queries.push(query));
  });
  afterAll(() => close());
  beforeEach(async () => {
    await db.deleteFrom('post_tag').execute();
    await db.deleteFrom('post_user').execute();
    await db.deleteFrom('comments').execute();
    await db.deleteFrom('post_stats').execute();
    await db.deleteFrom('api_keys').execute();
  });

  describe('a belongsToMany', () => {
    it('sync() attaches what is missing, detaches what is extra, leaves the rest — and says which', async () => {
      expect(await posts.relation(ids.first, 'tags').sync([ids.kysely, ids.sql])).toEqual({ attached: [ids.kysely, ids.sql], detached: [] });
      await posts.relation(ids.second, 'tags').sync([ids.kysely]);
      const result = await posts.relation(ids.first, 'tags').sync([ids.sql, ids.orm, ids.orm]);
      expect(result).toEqual({ attached: [ids.orm], detached: [ids.kysely] });
      expectTypeOf(result).toEqualTypeOf<{ attached: number[]; detached: number[] }>();
      expect(await tagsOf(ids.first)).toEqual([ids.sql, ids.orm]);
      expect(await tagsOf(ids.second)).toEqual([ids.kysely]); // another post's links stay
      expect(await posts.relation(ids.first, 'tags').sync([])).toEqual({ attached: [], detached: [ids.sql, ids.orm] });
      expect(await tagsOf(ids.first)).toEqual([]);
    });

    it('sync() and attach() refuse a target that is soft-deleted or missing — and write nothing, in one transaction', async () => {
      await posts.relation(ids.first, 'users').sync([ids.ada]);
      await expect(posts.relation(ids.first, 'users').sync([ids.alan, ids.gone])).rejects.toThrow(
        `relation('users').sync() would link the posts row ${ids.first} to the users row ${ids.gone}, which is missing or soft-deleted — nothing was written. ` +
          "Check the ids first: the rule exists() leaves soft-deleted rows out. See docs/queries.md#writing-through-relations.",
      );
      // Neither the detach of Ada nor the attach of Alan happened.
      expect(await readersOf(ids.first)).toEqual([ids.ada]);
      await expect(posts.relation(ids.first, 'users').attach([ids.alan, 999_999, ids.gone])).rejects.toThrow(
        `relation('users').attach() would link the posts row ${ids.first} to the users rows 999999, ${ids.gone}, which are missing or soft-deleted — nothing was written.`,
      );
      expect(await readersOf(ids.first)).toEqual([ids.ada]);
      // A link to a row that was soft-deleted later stays until it is detached.
      await posts.relation(ids.first, 'users').attach(ids.alan);
      await db.updateTable('users').set({ deleted_at: new Date() }).where('id', '=', ids.alan).execute();
      try {
        expect(await posts.relation(ids.first, 'users').sync([ids.ada, ids.alan])).toEqual({ attached: [], detached: [] });
        expect(await posts.relation(ids.first, 'users').detach(ids.alan)).toBe(1);
      } finally {
        await db.updateTable('users').set({ deleted_at: null }).where('id', '=', ids.alan).execute();
      }
    });

    it('attach() links one id or several and skips those linked already; detach() unlinks some or all and counts them', async () => {
      expect(await posts.relation(ids.first, 'tags').attach(ids.kysely)).toEqual([ids.kysely]);
      const attached = await posts.relation(ids.first, 'tags').attach([ids.kysely, ids.sql, ids.orm]);
      expect(attached).toEqual([ids.sql, ids.orm]);
      expectTypeOf(attached).toEqualTypeOf<number[]>();
      expect(await tagsOf(ids.first)).toEqual([ids.kysely, ids.sql, ids.orm]);
      await posts.relation(ids.second, 'tags').attach(ids.kysely);

      expect(await posts.relation(ids.first, 'tags').detach([])).toBe(0); // an empty list is no list: nothing goes
      // Nor does undefined — a field a request did not send — mean "every one".
      await expect(posts.relation(ids.first, 'tags').detach(undefined as never)).rejects.toThrow(
        "relation('tags').detach() was given undefined — that is no list of ids. Call detach() without an argument to unlink every one.",
      );
      expect(await tagsOf(ids.first)).toEqual([ids.kysely, ids.sql, ids.orm]);
      expect(await posts.relation(ids.first, 'tags').detach(ids.sql)).toBe(1);
      expect(await posts.relation(ids.first, 'tags').detach([ids.sql, ids.orm])).toBe(1);
      expect(await posts.relation(ids.first, 'tags').detach()).toBe(1);
      expect(await tagsOf(ids.first)).toEqual([]);
      expect(await tagsOf(ids.second)).toEqual([ids.kysely]);
      // From the other side of the same pivot.
      expect(await users.relation(ids.ada, 'posts').attach([ids.first, ids.second])).toEqual([ids.first, ids.second]);
      expect(await readersOf(ids.second)).toEqual([ids.ada]);
    });
  });

  it('attach() twice at once links once — the row is locked on Postgres, and the pivot insert leaves an existing link alone', async () => {
    queries.length = 0;
    const both = await Promise.all([posts.relation(ids.first, 'tags').attach([ids.kysely]), posts.relation(ids.first, 'tags').attach([ids.kysely])]);
    expect(both.map((attached) => attached.length).sort()).toEqual([0, 1]);
    expect(await tagsOf(ids.first)).toEqual([ids.kysely]);
    const parentReads = queries.filter((query) => query.sql.startsWith('select "id" from "posts"'));
    expect(parentReads).toHaveLength(2);
    expect(parentReads.every((query) => query.sql.endsWith(' for update') === (driver === 'pgsql'))).toBe(true);
    expect(queries.some((query) => /on conflict do nothing/.test(query.sql))).toBe(true);
  });

  it('refuses to write the links of a pivot with soft deletes — sync, attach and detach', async () => {
    const labels = posts.relation(ids.first, 'labels' as never) as unknown as { sync(ids: number[]): Promise<unknown>; attach(id: number): Promise<unknown>; detach(): Promise<number> };
    const refused = "relation('labels') writes the links in label_post, which has soft deletes — write them with a query of your own.";
    await expect(labels.sync([1])).rejects.toThrow(refused);
    await expect(labels.attach(1)).rejects.toThrow(refused);
    await expect(labels.detach()).rejects.toThrow(refused);
  });

  describe('a hasMany and a hasOne', () => {
    it('create() and createMany() set the foreign key, the timestamps by the related table’s marks — and return the rows as stored', async () => {
      const comment = await posts.relation(ids.first, 'comments').create({ user_id: ids.alan, body: 'hello' });
      expect(comment).toMatchObject({ post_id: ids.first, user_id: ids.alan, body: 'hello', approved: false, deleted_at: null });
      expect(comment.created_at).toMatch(ISO_UTC);
      expect(comment.updated_at).toMatch(ISO_UTC);
      expectTypeOf(comment).toEqualTypeOf<Selectable<FixtureTables['comments']>>();

      const many = await posts.relation(ids.second, 'comments').createMany([
        { user_id: ids.ada, body: 'first of two', approved: true },
        { user_id: ids.alan, body: 'second of two' },
      ]);
      expect(many.map((row) => [row.post_id, row.body, row.approved])).toEqual([
        [ids.second, 'first of two', true],
        [ids.second, 'second of two', false],
      ]);
      queries.length = 0;
      expect(await posts.relation(ids.second, 'comments').createMany([])).toEqual([]);
      expect(queries).toEqual([]);

      const stats = await posts.relation(ids.second, 'post_stats').create({ views: 3 });
      expect(stats).toEqual({ post_id: ids.second, views: 3 });
      // A hasOne has one row: the unique key refuses a second.
      await expect(posts.relation(ids.second, 'post_stats').create({ views: 4 })).rejects.toThrow();
      expect(await db.selectFrom('post_stats').selectAll().execute()).toEqual([{ post_id: ids.second, views: 3 }]);
    });

    it('never returns a secret column of the related table — it is written all the same', async () => {
      const key = await users.relation(ids.ada, 'api_keys').create({ name: 'ci', token: 'another-secret-token' });
      expect(Object.keys(key).sort()).toEqual(['id', 'name', 'user_id']);
      expectTypeOf(key).toEqualTypeOf<{ id: number; user_id: number; name: string }>();
      const [many] = await users.relation(ids.ada, 'api_keys').createMany([{ name: 'deploy', token: 'deploy-secret-token' }]);
      expect(Object.keys(many!).sort()).toEqual(['id', 'name', 'user_id']);
      const stored = await db.selectFrom('api_keys').select((eb) => ['name', secret(eb, 'token')]).orderBy('id').execute();
      expect(stored).toEqual([
        { name: 'ci', token: 'another-secret-token' },
        { name: 'deploy', token: 'deploy-secret-token' },
      ]);
    });

    it('refuses the foreign key among the values — the relation sets it', async () => {
      await expect(posts.relation(ids.first, 'comments').create({ user_id: ids.ada, body: 'x', post_id: ids.second } as never)).rejects.toThrow(
        "relation('comments').create() sets comments.post_id itself — leave it out of the values.",
      );
      await expect(posts.relation(ids.first, 'comments').createMany([{ user_id: ids.ada, body: 'x', post_id: ids.second }] as never)).rejects.toThrow(
        "relation('comments').createMany() sets comments.post_id itself — leave it out of the values.",
      );
      expect(await db.selectFrom('comments').selectAll().execute()).toEqual([]);
    });
  });

  it('refuses a parent row that is missing or soft-deleted', async () => {
    await expect(users.relation(ids.gone, 'posts').attach(ids.first)).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(users.relation(ids.gone, 'comments').create({ post_id: ids.first, body: 'x' })).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(posts.relation(999_999, 'tags').detach()).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(await readersOf(ids.first)).toEqual([]);
  });

  it('refuses a relation it cannot write through — with what to do instead', async () => {
    const author = posts.relation(ids.first, 'author' as never) as unknown as { create(values: object): Promise<unknown> };
    await expect(author.create({ name: 'x' })).rejects.toThrow(
      "relation('author') writes through a hasMany, a hasOne or a belongsToMany — author is a belongsTo of posts: set author_id with update() instead.",
    );
    const comments = posts.relation(ids.first, 'comments') as unknown as { sync(ids: number[]): Promise<unknown> };
    await expect(comments.sync([1])).rejects.toThrow("relation('comments').sync() links the rows of a belongsToMany — comments is a hasMany of posts: use create().");
    const tags = posts.relation(ids.first, 'tags') as unknown as { create(values: object): Promise<unknown> };
    await expect(tags.create({ slug: 'new' })).rejects.toThrow("relation('tags').create() adds a row to a hasMany or a hasOne — tags is a belongsToMany of posts: use attach().");
    await expect((posts.relation(ids.first, 'nope' as never) as unknown as { detach(): Promise<number> }).detach()).rejects.toThrow(
      "relation('nope'): posts has no relation \"nope\" — it has author, comments, editor, label_post, labels, post_stats, post_tag, post_user, tags, users.",
    );
  });

  it('joins a transaction around it, which takes it back on a rollback — also through using(trx)', async () => {
    await expect(
      connections.transaction(async () => {
        await posts.relation(ids.first, 'tags').sync([ids.kysely, ids.sql]);
        await posts.relation(ids.first, 'comments').create({ user_id: ids.ada, body: 'gone with the rollback' });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await tagsOf(ids.first)).toEqual([]);
    expect(await db.selectFrom('comments').selectAll().execute()).toEqual([]);
    await db.transaction().execute((trx) => posts.using(trx).relation(ids.first, 'tags').attach(ids.orm));
    expect(await tagsOf(ids.first)).toEqual([ids.orm]);
  });
});
