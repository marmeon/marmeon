import type { Application, ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Migrator, type Connections, type Json, type QueryEvent } from './index.ts';
import { sql, type Kysely } from 'kysely';

const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url) },
  { name: 'blog', migrations: new URL('./__fixtures__/migrations/blog/', import.meta.url) },
];
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describe.each(drivers)('relations on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let db: Kysely<FixtureTables>;
  const queries: QueryEvent[] = [];

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    db = connections.get<FixtureTables>();
    const ada = await db
      .insertInto('users')
      .values({ name: 'Ada', email: 'ada@example.com', is_admin: true, settings: JSON.stringify({ theme: 'dark' }), balance: '12.50' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.insertInto('users').values({ name: 'Alan', email: 'alan@example.com' }).execute();
    await db
      .insertInto('articles')
      .values([
        { user_id: ada.id, title: 'First', published_at: '2026-10-01T08:00:00.000Z' },
        { user_id: ada.id, title: 'Second' },
      ])
      .execute();
    connections.onQuery((query) => queries.push(query));
  });
  afterAll(() => close());

  // The fixture's tables have no generated relations: withRelation() names the keys.
  const withArticles = () =>
    db
      .selectFrom('users')
      .select(['id', 'name'])
      .withRelation('articles', { table: 'articles', foreignKey: 'user_id' }, (q) => q.select(['articles.id', 'articles.title', 'articles.published_at']).orderBy('articles.id'))
      .withRelation('latest', { table: 'articles', foreignKey: 'user_id', one: true }, (q) => q.select(['articles.title']).orderBy('articles.id', 'desc'))
      .orderBy('id');

  it('loads a list and one row in the same query as their parents', async () => {
    queries.length = 0; // column kinds were loaded on the connection when it was handed out — not as queries of their own
    const users = await withArticles().execute();
    expect(queries).toHaveLength(1); // no N+1 — there is no lazy loading to fall into

    expect(users).toEqual([
      {
        id: expect.any(Number),
        name: 'Ada',
        articles: [
          { id: expect.any(Number), title: 'First', published_at: '2026-10-01T08:00:00.000Z' },
          { id: expect.any(Number), title: 'Second', published_at: null },
        ],
        latest: { title: 'Second' },
      },
      { id: expect.any(Number), name: 'Alan', articles: [], latest: null },
    ]);
    expectTypeOf(users[0]!.articles).toEqualTypeOf<{ id: number; title: string; published_at: string | null }[]>();
    expectTypeOf(users[0]!.latest).toEqualTypeOf<{ title: string } | null>();
  });

  it('gives nested values the same types as top-level ones: booleans, JSON, decimals, timestamps', async () => {
    const [article] = await db
      .selectFrom('articles')
      .select('articles.title')
      .withRelation('author', { table: 'users', foreignKey: 'id', localKey: 'user_id', one: true }, (q) =>
        q.select(['users.name', 'users.is_admin', 'users.settings', 'users.balance', 'users.created_at']),
      )
      .orderBy('articles.id')
      .execute();
    expect(article).toEqual({
      title: 'First',
      author: { name: 'Ada', is_admin: true, settings: { theme: 'dark' }, balance: '12.50', created_at: expect.stringMatching(ISO_UTC) },
    });
    expectTypeOf(article!.author).toEqualTypeOf<{ name: string; is_admin: boolean; settings: Json; balance: string; created_at: string } | null>();
  });

  // Each case adds its own user and article and removes them, so the other tests see the fixture as seeded.
  async function withScratchArticle(values: { settings?: string; published_at?: string }, check: (article: { id: number; user_id: number }) => Promise<void>): Promise<void> {
    const email = `scratch-${crypto.randomUUID()}@example.com`;
    const user = await db.insertInto('users').values({ name: 'Scratch', email, ...(values.settings === undefined ? {} : { settings: values.settings }) }).returning('id').executeTakeFirstOrThrow();
    const article = await db.insertInto('articles').values({ user_id: user.id, title: email }).returning(['id', 'user_id']).executeTakeFirstOrThrow();
    try {
      if (values.published_at !== undefined) await sql`update articles set published_at = ${values.published_at}::timestamptz where id = ${article.id}`.execute(db);
      await check(article);
    } finally {
      await db.deleteFrom('articles').where('id', '=', article.id).execute();
      await db.deleteFrom('users').where('id', '=', user.id).execute();
    }
  }

  it.each([
    ['a JSON string scalar', 'abc'],
    ['a string that looks like an object', '{"role":"admin"}'],
    ['a string that looks like a number', '123'],
    ['a string that looks like a boolean', 'true'],
    ['an object', { theme: 'dark', nested: [1, 'two', null] }],
    ['an array', [1, 'two', { three: 3 }]],
    ['a number', 42],
    ['a boolean', false],
    ['a JSON null', null],
  ])('reads %s in a JSON column through a relation as it reads it directly', async (_label, stored) => {
    await withScratchArticle({ settings: JSON.stringify(stored) }, async (article) => {
      const direct = await db.selectFrom('users').select('settings').where('id', '=', article.user_id).executeTakeFirstOrThrow();
      const [viaRelation] = await db
        .selectFrom('articles')
        .select('articles.id')
        .withRelation('author', { table: 'users', foreignKey: 'id', localKey: 'user_id', one: true }, (q) => q.select(['users.settings']))
        .where('articles.id', '=', article.id)
        .execute();
      expect(direct.settings).toEqual(stored);
      expect(viaRelation!.author!.settings).toEqual(direct.settings);
      expect(typeof viaRelation!.author!.settings).toBe(typeof direct.settings);
    });
  });

  // SQLite stores timestamps as text; it has no special values.
  it.runIf(driver === 'pgsql').each(['infinity', '-infinity'])('reads a timestamp of %s through a relation as it reads it directly', async (value) => {
    await withScratchArticle({ published_at: value }, async (article) => {
      const direct = await db.selectFrom('articles').select('published_at').where('id', '=', article.id).executeTakeFirstOrThrow();
      const [viaRelation] = await db
        .selectFrom('users')
        .select('users.id')
        .withRelation('articles', { table: 'articles', foreignKey: 'user_id' }, (q) => q.select(['articles.published_at']))
        .where('users.id', '=', article.user_id)
        .execute();
      expect(direct.published_at).toBe(value);
      expect(viaRelation!.articles).toEqual([{ published_at: value }]);
    });
  });

  it.runIf(driver === 'pgsql')('reads a BC timestamp through a relation and directly without throwing', async () => {
    await withScratchArticle({ published_at: '0044-03-15 12:00:00+00 BC' }, async (article) => {
      const direct = await db.selectFrom('articles').select('published_at').where('id', '=', article.id).executeTakeFirstOrThrow();
      const [viaRelation] = await db
        .selectFrom('users')
        .select('users.id')
        .withRelation('articles', { table: 'articles', foreignKey: 'user_id' }, (q) => q.select(['articles.published_at']))
        .where('users.id', '=', article.user_id)
        .execute();
      expect(typeof direct.published_at).toBe('string');
      expect(viaRelation!.articles).toHaveLength(1);
    });
  });

  it('nests relations, with aliases and renamed columns', async () => {
    const [user] = await db
      .selectFrom('users')
      .select('users.name')
      .withRelation('articles', { table: 'articles', foreignKey: 'user_id' }, (q) =>
        q
          .select(['articles.id', 'articles.title as headline'])
          .withRelation('by', { table: 'users', foreignKey: 'id', localKey: 'user_id', one: true }, (u) => u.select(['users.id', 'users.is_admin as admin']))
          .orderBy('articles.id'),
      )
      .where('users.name', '=', 'Ada')
      .execute();
    expect(user!.articles).toEqual([
      { id: expect.any(Number), headline: 'First', by: { id: expect.any(Number), admin: true } },
      { id: expect.any(Number), headline: 'Second', by: { id: expect.any(Number), admin: true } },
    ]);
    expectTypeOf(user!.articles).toEqualTypeOf<{ id: number; headline: string; by: { id: number; admin: boolean } | null }[]>();
  });

  it('spells out selectAll() in a relation as the columns of its table — on every driver', async () => {
    const [user] = await db
      .selectFrom('users')
      .select('users.name')
      .withRelation('articles', { table: 'articles', foreignKey: 'user_id' }, (q) => q.selectAll().orderBy('articles.id'))
      .where('users.name', '=', 'Ada')
      .execute();
    expect(Object.keys(user!.articles[0]!).sort()).toEqual(['content', 'id', 'published_at', 'slug', 'title', 'user_id']);
  });
});

describe('the relations of a query', () => {
  it('are loaded through the query builder only — the package exports no functions that build them', async () => {
    expect(Object.keys(await import('./index.ts'))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^(hasMany|hasOne|belongsTo)$/)]));
  });
});
