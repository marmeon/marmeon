import type { Application, ModuleDefinition } from '@marmeon/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import * as v from 'valibot';
import { testEncrypter } from './__fixtures__/encrypter.ts';
import { cursorPaginate, hasMany, InvalidCursorError, Migrator, pageQuery, paginate, paginationFrom, type Connections, type CursorEncrypter, type QueryEvent } from './index.ts';

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

  const encrypter = testEncrypter();

  it('pages by cursor through large tables — stable while rows are added', async () => {
    const ids = db.selectFrom('users').select(['id', 'name']);
    const first = await cursorPaginate(ids, { column: 'id', perPage: 5, encrypter });
    expect(first.data.map((u) => u.name)).toEqual(['User 01', 'User 02', 'User 03', 'User 04', 'User 05']);
    await db.insertInto('users').values({ name: 'User 00 (late)', email: 'late@example.com' }).execute(); // appended at the end
    const second = await cursorPaginate(ids, { column: 'id', perPage: 5, cursor: first.meta.nextCursor, encrypter });
    expect(second.data.map((u) => u.name)).toEqual(['User 06', 'User 07', 'User 08', 'User 09', 'User 10']);
    const third = await cursorPaginate(ids, { column: 'id', perPage: 5, cursor: second.meta.nextCursor, encrypter });
    expect(third.data.map((u) => u.name)).toEqual(['User 11', 'User 12', 'User 00 (late)']);
    expect(third.meta.nextCursor).toBeNull();
    const backwards = await cursorPaginate(ids, { column: 'id', perPage: 2, direction: 'desc', encrypter });
    expect(backwards.data.map((u) => u.name)).toEqual(['User 00 (late)', 'User 12']);
  });

  it('orders by its own columns only — an orderBy of the query does not come first', async () => {
    const page = await cursorPaginate(db.selectFrom('users').select(['id', 'name']).orderBy('email', 'desc'), { column: 'id', perPage: 3, encrypter });
    expect(page.data.map((u) => u.name), 'the query’s order came first').toEqual(['User 01', 'User 02', 'User 03']);
    const next = await cursorPaginate(db.selectFrom('users').select(['id', 'name']).orderBy('email', 'desc'), { column: 'id', perPage: 3, cursor: page.meta.nextCursor, encrypter });
    expect(next.data.map((u) => u.name)).toEqual(['User 04', 'User 05', 'User 06']);
  });

  it('pages by a column that is not unique: the key (id) breaks the tie by itself — no row twice, none skipped', async () => {
    // Three people of the same name, across a page boundary (page 2 ends with the first of the four "User 05").
    for (const email of ['twin1@example.com', 'twin2@example.com', 'twin3@example.com']) await db.insertInto('users').values({ name: 'User 05', email }).execute();
    const byName = db.selectFrom('users').select(['id', 'name', 'email']).where('email', 'not like', 'late%');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: { email: string }[]; meta: { nextCursor: string | null } } = await cursorPaginate(byName, { column: 'name', perPage: 3, cursor, encrypter });
      seen.push(...page.data.map((u) => u.email));
      cursor = page.meta.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(15);
    expect(new Set(seen).size).toBe(15);
    expect(seen.slice(4, 8)).toEqual(['u5@example.com', 'twin1@example.com', 'twin2@example.com', 'twin3@example.com']);
  });

  it('pages by a nullable column: NULLs last in both directions, and a NULL is a cursor like any other (never page 1 again)', async () => {
    // Birthdays for some; the others have none — two pages of NULLs.
    const born = ['1990-05-01', '1985-01-01', null, '1990-05-01', null, '2001-12-24', null, null, '1970-07-07', null, null, null];
    for (const [index, day] of born.entries()) await db.updateTable('users').set({ born_on: day }).where('email', '=', `u${index + 1}@example.com`).execute();
    const byBirthday = db.selectFrom('users').select(['id', 'email', 'born_on']).where('email', 'like', 'u%@example.com');
    for (const direction of ['asc', 'desc'] as const) {
      const seen: { email: string; born_on: string | null }[] = [];
      const cursors: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: { email: string; born_on: string | null }[]; meta: { nextCursor: string | null } } = await cursorPaginate(byBirthday, {
          column: 'born_on',
          perPage: 2,
          cursor,
          direction,
          encrypter,
        });
        seen.push(...page.data);
        cursor = page.meta.nextCursor;
        if (cursor) cursors.push(cursor);
        expect(cursors.length, 'paging never ends: a NULL cursor starts over').toBeLessThan(10);
      } while (cursor);
      expect(seen.map((row) => row.email).sort()).toEqual(born.map((_, index) => `u${index + 1}@example.com`).sort());
      const days = seen.map((row) => (row.born_on === null ? null : String(row.born_on).slice(0, 10)));
      const dated = born.filter((day) => day !== null).sort();
      expect(days).toEqual([...(direction === 'asc' ? dated : dated.reverse()), null, null, null, null, null, null, null]);
    }
  });

  it('encrypts the cursor: no value of the last row can be read from it', async () => {
    const byEmail = db.selectFrom('users').select(['id', 'email']).where('email', 'like', 'u%@example.com');
    const { meta } = await cursorPaginate(byEmail, { column: 'email', perPage: 1, encrypter });
    // The base64url text of the cursor (what the format before Wave 9 was) holds no value of the row it ends at.
    const readable = Buffer.from(meta.nextCursor!, 'base64url').toString('latin1');
    expect(readable, 'the cursor shows the last row').not.toContain('"u10@example.com"');
    expect(readable).not.toContain('@example.com');
  });

  it('a cursor that was changed, made up, of the old format, of another list or another key is a 400 — never page 1 again', async () => {
    const byEmail = db.selectFrom('users').select(['id', 'email']).where('email', 'like', 'u%@example.com');
    const cursor = (await cursorPaginate(byEmail, { column: 'email', perPage: 1, encrypter })).meta.nextCursor!;
    const rejected = async (value: string, options: { direction?: 'asc' | 'desc'; encrypter?: CursorEncrypter } = {}) => {
      const failure = await cursorPaginate(byEmail, { column: 'email', perPage: 1, cursor: value, encrypter, ...options }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, `cursor ${value.slice(0, 12)}… was taken`).toBeInstanceOf(InvalidCursorError);
      expect((failure as InvalidCursorError).status).toBe(400);
    };
    await rejected(`${cursor.slice(0, -2)}${cursor.at(-2) === 'A' ? 'B' : 'A'}${cursor.at(-1)}`);
    await rejected('not-a-cursor');
    await rejected(Buffer.from(JSON.stringify(['u10@example.com', 10])).toString('base64url'));
    await rejected(cursor, { direction: 'desc' });
    await rejected(cursor, { encrypter: testEncrypter() });
    // A cursor of the right list goes on.
    expect((await cursorPaginate(byEmail, { column: 'email', perPage: 1, cursor, encrypter })).data).toHaveLength(1);
  });

  it('needs the key selected — it orders by it last', async () => {
    await expect(cursorPaginate(db.selectFrom('users').select(['name']), { column: 'name', perPage: 1, encrypter })).rejects.toThrow('does not select it');
  });

  it('pages by ctx.query: what pageQuery() parses', async () => {
    const { parseQuery } = await import('@marmeon/router');
    const schema = v.object({ ...pageQuery({ perPage: [5, 10] }), q: v.optional(v.string(), '') });
    const parsed = await parseQuery(schema, new URLSearchParams('page=2&per_page=5&q=x'));
    expect(parsed.value).toEqual({ page: 2, per_page: 5, q: 'x' });
    const page = await paginate(db, people(), parsed.value as v.InferOutput<typeof schema>);
    expect(page.meta).toMatchObject({ page: 2, perPage: 5 });
    // Invalid values fall back to their defaults (the first size); the defaults stay out of the canonical query.
    const fallback = await parseQuery(schema, new URLSearchParams('page=-1&per_page=100000'));
    expect(fallback.value).toEqual({ page: 1, per_page: 5, q: '' });
    expect(fallback.canonical).toEqual({});
    expect((await paginate(db, people(), fallback.value as v.InferOutput<typeof schema>)).meta).toMatchObject({ page: 1, perPage: 5 });
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

  it('reads a parsed query (ctx.query) as well — the page it names, not page 1', () => {
    expect(paginationFrom({ page: 3, per_page: 20, q: 'ada' }, { perPage: 10 })).toEqual({ page: 3, perPage: 20 });
    expect(paginationFrom({ page: 0 }, { perPage: 10 })).toEqual({ page: 1, perPage: 10 });
  });
});
