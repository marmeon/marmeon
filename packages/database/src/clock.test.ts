import { TestClock } from '@marmeon/core/testing';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { UserFactory } from './__fixtures__/factories.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Factories, Migrator, Repository, type Connections } from './index.ts';

class PostRepository extends Repository<'posts', FixtureTables> {
  static table = 'posts' as const;
}

class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}

const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url) },
  { name: 'blog', migrations: new URL('./__fixtures__/migrations/relations/', import.meta.url) },
  { name: 'flags', migrations: new URL('./__fixtures__/migrations/relations-stamped/', import.meta.url) },
];

const START = Date.parse('2031-03-04T05:06:07.089Z');
const DAY = 86_400_000;
/** What a stamp is in milliseconds, whatever text the driver reads it back as. */
const at = (value: unknown) => new Date(value as string).getTime();

describe.each(drivers)('stamping with the app clock on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let users: UserRepository;
  let clock: TestClock;

  beforeAll(async () => {
    clock = new TestClock();
    ({ connections, close } = await freshConnections(driver, { now: () => clock.now() }));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    users = new UserRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    clock.freeze(START);
    await connections.get<FixtureTables>().deleteFrom('users').execute();
  });

  it('insert and tryInsert stamp created_at and updated_at with the clock, milliseconds kept', async () => {
    const first = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    expect(at(first.created_at)).toBe(START);
    expect(at(first.updated_at)).toBe(START);
    clock.travel({ days: 7 });
    const second = await users.tryInsert({ name: 'Grace', email: 'grace@example.com' });
    expect(second.ok && at(second.value.created_at)).toBe(START + 7 * DAY);
    expect(second.ok && at(second.value.updated_at)).toBe(START + 7 * DAY);
    expect(at((await users.findBy('email', 'grace@example.com'))?.created_at)).toBe(START + 7 * DAY);
  });

  it('update and tryUpdate set updated_at to the clock and keep created_at', async () => {
    const row = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    clock.travel({ days: 7 });
    const updated = await users.update(row.id, { name: 'Ada L.' });
    expect(at(updated?.created_at)).toBe(START);
    expect(at(updated?.updated_at)).toBe(START + 7 * DAY);
    clock.travel({ days: 1 });
    const tried = await users.tryUpdate(row.id, { name: 'Ada Lovelace' });
    expect(tried.ok && at(tried.value.updated_at)).toBe(START + 8 * DAY);
    expect(tried.ok && at(tried.value.created_at)).toBe(START);
  });

  it('insertMany and tryInsertMany stamp every row with one time, across chunks', async () => {
    // Four columns a row with the stamps: 20 000 rows are more than two statements on either driver's SQLite limit.
    const rows = Array.from({ length: 20_000 }, (_, index) => ({ name: `Person ${index}`, email: `person-${index}@example.com` }));
    expect(await users.insertMany(rows)).toBe(20_000);
    const found = await connections.get<FixtureTables>().selectFrom('users').select(['created_at', 'updated_at']).execute();
    expect(found).toHaveLength(20_000);
    expect(new Set(found.map((row) => at(row.created_at)))).toEqual(new Set([START]));
    expect(new Set(found.map((row) => at(row.updated_at)))).toEqual(new Set([START]));

    clock.travel({ days: 2 });
    expect(await users.tryInsertMany([{ name: 'Late', email: 'late@example.com' }])).toEqual({ ok: true, value: 1 });
    const late = await users.findBy('email', 'late@example.com');
    expect([at(late?.created_at), at(late?.updated_at)]).toEqual([START + 2 * DAY, START + 2 * DAY]);
  }, 60_000);

  it('stamps inside a transaction and through using(trx) the same way', async () => {
    await connections.transaction(async (trx) => {
      clock.travel({ days: 3 });
      const row = await users.using(trx).insert({ name: 'Ada', email: 'ada@example.com' });
      expect(at(row.created_at)).toBe(START + 3 * DAY);
      clock.travel({ days: 1 });
      expect(at((await users.update(row.id, { name: 'Ada L.' }))?.updated_at)).toBe(START + 4 * DAY);
      await users.insertMany([{ name: 'Grace', email: 'grace@example.com' }]);
    });
    expect(at((await users.findBy('email', 'grace@example.com'))?.created_at)).toBe(START + 4 * DAY);
  });

  it('keeps a value the caller names: created_at, updated_at, or both', async () => {
    const named = new Date('2020-01-02T03:04:05.006Z');
    const row = await users.insert({ name: 'Ada', email: 'ada@example.com', created_at: named });
    expect(at(row.created_at)).toBe(named.getTime());
    expect(at(row.updated_at)).toBe(START);
    const both = await users.insert({ name: 'Grace', email: 'grace@example.com', created_at: named, updated_at: named });
    expect([at(both.created_at), at(both.updated_at)]).toEqual([named.getTime(), named.getTime()]);
    await users.insertMany([{ name: 'Linus', email: 'linus@example.com', created_at: named }]);
    expect(at((await users.findBy('email', 'linus@example.com'))?.created_at)).toBe(named.getTime());
    const updated = await users.update(row.id, { name: 'Ada L.', updated_at: named });
    expect(at(updated?.updated_at)).toBe(named.getTime());
  });

  it('a row of insertMany that names a stamp the first row does not is refused like any other column', async () => {
    await expect(users.insertMany([{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'b@example.com', created_at: new Date() }])).rejects.toThrow(/first row/);
  });

  it('relation().create() and createMany() stamp the related rows with the clock', async () => {
    const author = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const post = await connections.get<any>().insertInto('posts').values({ title: 'Hello', author_id: author.id }).returningAll().executeTakeFirstOrThrow();
    const posts = new PostRepository(connections);
    clock.travel({ days: 4 });
    const one = (await posts.relation(post.id, 'comments').create({ user_id: author.id, body: 'One' } as never)) as { created_at: string; updated_at: string };
    expect([at(one.created_at), at(one.updated_at)]).toEqual([START + 4 * DAY, START + 4 * DAY]);
    const many = (await posts.relation(post.id, 'comments').createMany([{ user_id: author.id, body: 'Two' }, { user_id: author.id, body: 'Three' }] as never)) as { created_at: string }[];
    expect(many.map((row) => at(row.created_at))).toEqual([START + 4 * DAY, START + 4 * DAY]);
  });

  it('attach() and sync() stamp the links of a pivot with timestamps with the clock', async () => {
    const author = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const post = await connections.get<any>().insertInto('posts').values({ title: 'Hello', author_id: author.id }).returningAll().executeTakeFirstOrThrow();
    const flags = await connections.get<any>().insertInto('flags').values([{ label: 'a' }, { label: 'b' }, { label: 'c' }]).returning('id').execute();
    const [a, b, c] = flags.map((flag: { id: number }) => flag.id);
    const writer = new PostRepository(connections).relation(post.id, 'flags' as never) as unknown as { attach(ids: number[]): Promise<number[]>; sync(ids: number[]): Promise<unknown> };
    clock.travel({ days: 6 });
    await writer.attach([a!]);
    clock.travel({ days: 1 });
    await writer.sync([a!, b!, c!]);
    const links = await connections.get<any>().selectFrom('flag_post').select(['flag_id', 'created_at', 'updated_at']).execute();
    const byFlag = new Map(links.map((link: { flag_id: number; created_at: string; updated_at: string }) => [link.flag_id, link]));
    expect([at(byFlag.get(a!)?.created_at), at(byFlag.get(a!)?.updated_at)]).toEqual([START + 6 * DAY, START + 6 * DAY]);
    expect([b!, c!].map((id) => at(byFlag.get(id)?.created_at))).toEqual([START + 7 * DAY, START + 7 * DAY]);
  });

  it('a soft delete sets deleted_at to the clock', async () => {
    const row = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    clock.travel({ days: 9 });
    expect(await users.delete(row.id)).toBe(true);
    const gone = await connections.get<FixtureTables>().selectFrom('users').select('deleted_at').where('id', '=', row.id).executeTakeFirstOrThrow();
    expect(at(gone.deleted_at)).toBe(START + 9 * DAY);
  });

  it('a factory stamps its rows with the clock, and keeps what an override names', async () => {
    const factories = new Factories(connections);
    clock.travel({ days: 5 });
    const made = await factories.for(UserFactory).create();
    expect([at(made.created_at), at(made.updated_at)]).toEqual([START + 5 * DAY, START + 5 * DAY]);
    const named = new Date('2020-01-02T03:04:05.006Z');
    expect(at((await factories.for(UserFactory).create({ created_at: named })).created_at)).toBe(named.getTime());
  });
});

describe.each(drivers)('stamping without an app clock on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
  });
  afterAll(() => close());

  it('uses the wall clock', async () => {
    const users = new UserRepository(connections);
    const before = Date.now();
    const row = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const after = Date.now();
    expect(at(row.created_at)).toBeGreaterThanOrEqual(before);
    expect(at(row.created_at)).toBeLessThanOrEqual(after);
    expect(at(row.updated_at)).toBe(at(row.created_at));
  });
});
