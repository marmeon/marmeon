import type { Application, ModuleDefinition } from '@bespokecore/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { cursorPaginate, hasMany, Migrator, paginate, paginationFrom, type Connections, type QueryEvent } from './index.ts';

const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url) },
  { name: 'blog', migrations: new URL('./__fixtures__/migrations/blog/', import.meta.url) },
];

describe.each(drivers)('pagination on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let db: Kysely<FixtureTables>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    db = connections.get<FixtureTables>();
    for (let i = 1; i <= 12; i++) {
      const user = await db.insertInto('users').values({ name: `User ${String(i).padStart(2, '0')}`, email: `u${i}@example.com` }).returning('id').executeTakeFirstOrThrow();
      if (i <= 2) await db.insertInto('articles').values([{ user_id: user.id, title: 'a' }, { user_id: user.id, title: 'b' }]).execute();
    }
  });
  afterAll(() => close());

  const people = () =>
    db
      .selectFrom('users')
      .select((eb) => ['users.name', hasMany(eb, 'articles', 'user_id', 'users.id', (q) => q.select(['articles.title'])).as('articles')])
      .orderBy('users.name');

  it('returns a page and where it stands — counting without ordering or relations', async () => {
    const queries: QueryEvent[] = [];
    const stop = connections.onQuery((query) => queries.push(query));
    const page = await paginate(db, people(), { page: 2, perPage: 5 });
    stop();
    expect(page.data.map((person) => person.name)).toEqual(['User 06', 'User 07', 'User 08', 'User 09', 'User 10']);
    expect(page.meta).toEqual({ page: 2, perPage: 5, total: 12, lastPage: 3, from: 6, to: 10 });
    expectTypeOf(page.data[0]!).toEqualTypeOf<{ name: string; articles: { title: string }[] }>();
    const count = queries.find((query) => /count\(\*\)/.test(query.sql))!.sql;
    expect(count).not.toMatch(/order by|json/i);
  });

  it('keeps the filter in the count, and answers past the last page with no rows', async () => {
    const filtered = await paginate(db, people().where('users.name', 'like', 'User 1%'), { perPage: 2 });
    expect(filtered.meta).toEqual({ page: 1, perPage: 2, total: 3, lastPage: 2, from: 1, to: 2 });
    expect((await paginate(db, people(), { page: 9, perPage: 5 })).meta).toEqual({ page: 9, perPage: 5, total: 12, lastPage: 3, from: null, to: null });
    expect((await paginate(db, people().where('users.name', '=', 'nobody'))).meta).toMatchObject({ total: 0, lastPage: 1, from: null });
    await expect(paginate(db, people(), { page: 0 })).rejects.toThrow('page must be a whole number ≥ 1');
  });

  it('pages by cursor through large tables — stable while rows are added', async () => {
    const ids = db.selectFrom('users').select(['id', 'name']);
    const first = await cursorPaginate(ids, { column: 'id', perPage: 5 });
    expect(first.data.map((u) => u.name)).toEqual(['User 01', 'User 02', 'User 03', 'User 04', 'User 05']);
    await db.insertInto('users').values({ name: 'User 00 (late)', email: 'late@example.com' }).execute(); // appended at the end
    const second = await cursorPaginate(ids, { column: 'id', perPage: 5, cursor: first.meta.nextCursor });
    expect(second.data.map((u) => u.name)).toEqual(['User 06', 'User 07', 'User 08', 'User 09', 'User 10']);
    const third = await cursorPaginate(ids, { column: 'id', perPage: 5, cursor: second.meta.nextCursor });
    expect(third.data.map((u) => u.name)).toEqual(['User 11', 'User 12', 'User 00 (late)']);
    expect(third.meta.nextCursor).toBeNull();
    const backwards = await cursorPaginate(ids, { column: 'id', perPage: 2, direction: 'desc' });
    expect(backwards.data.map((u) => u.name)).toEqual(['User 00 (late)', 'User 12']);
    expect((await cursorPaginate(ids, { column: 'id', perPage: 2, cursor: 'not-a-cursor' })).data.map((u) => u.name)).toEqual(['User 01', 'User 02']);
  });
});

describe('paginationFrom', () => {
  it('takes page and size from the query string — safe against anything', () => {
    const from = (query: string) => paginationFrom(new URLSearchParams(query), { perPage: 10, maxPerPage: 50 });
    expect(from('page=3&per_page=20')).toEqual({ page: 3, perPage: 20 });
    expect(from('')).toEqual({ page: 1, perPage: 10 });
    for (const bad of ['page=-1', 'page=0', 'page=abc', 'page=1.5', 'page=1e999', 'page=99999999999999999999']) expect(from(bad).page).toBe(1);
    expect(from('per_page=100000').perPage).toBe(50);
    expect(from('per_page=0').perPage).toBe(10);
  });
});
