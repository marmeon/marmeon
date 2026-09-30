import type { Application, ModuleDefinition } from '@bespokecore/core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { belongsTo, hasMany, hasOne, Migrator, type Connections, type Json, type QueryEvent } from './index.ts';
import type { Kysely } from 'kysely';

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

  const withArticles = () =>
    db
      .selectFrom('users')
      .select((eb) => [
        'id',
        'name',
        hasMany(eb, 'articles', 'user_id', 'users.id', (q) => q.select(['articles.id', 'articles.title', 'articles.published_at']).orderBy('articles.id')).as(
          'articles',
        ),
        hasOne(eb, 'articles', 'user_id', 'users.id', (q) => q.select(['articles.title']).orderBy('articles.id', 'desc').limit(1)).as('latest'),
      ])
      .orderBy('id');

  it('loads a hasMany and a hasOne in the same query as their parents', async () => {
    await withArticles().execute(); // the first relation query on a connection also looks up its column types, once
    queries.length = 0;
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
      .select((eb) => [
        'articles.title',
        belongsTo(eb, 'users', 'id', 'articles.user_id', (q) =>
          q.select(['users.name', 'users.is_admin', 'users.settings', 'users.balance', 'users.created_at']),
        ).as('author'),
      ])
      .orderBy('articles.id')
      .execute();
    expect(article).toEqual({
      title: 'First',
      author: { name: 'Ada', is_admin: true, settings: { theme: 'dark' }, balance: '12.50', created_at: expect.stringMatching(ISO_UTC) },
    });
    expectTypeOf(article!.author).toEqualTypeOf<{ name: string; is_admin: boolean; settings: Json; balance: string; created_at: string } | null>();
  });

  it('nests relations, with aliases and renamed columns', async () => {
    const [user] = await db
      .selectFrom('users')
      .select((eb) => [
        'users.name',
        hasMany(eb, 'articles', 'user_id', 'users.id', (q) =>
          q
            .select((inner) => [
              'articles.title as headline',
              belongsTo(inner, 'users', 'id', 'articles.user_id', (u) => u.select(['users.is_admin as admin'])).as('by'),
            ])
            .orderBy('articles.id'),
        ).as('articles'),
      ])
      .where('users.name', '=', 'Ada')
      .execute();
    expect(user!.articles).toEqual([
      { headline: 'First', by: { admin: true } },
      { headline: 'Second', by: { admin: true } },
    ]);
  });

  it('asks for explicit columns instead of selectAll() — on every driver', async () => {
    await expect(
      db
        .selectFrom('users')
        .select((eb) => hasMany(eb, 'articles', 'user_id', 'users.id', (q) => q.selectAll('articles')).as('articles'))
        .execute(),
    ).rejects.toThrow('Relations need explicit columns: q.select([…]) instead of selectAll()');
  });
});
