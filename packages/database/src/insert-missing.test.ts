import { TestClock } from '@marmeon/core/testing';
import type { Application, ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { compareKeys } from './repository.ts';
import { isUniqueViolation, Migrator, Repository, type Connections } from './index.ts';

class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}
class KeyRepository extends Repository<'api_keys', FixtureTables> {
  static table = 'api_keys' as const;
}

const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url) },
  { name: 'keys', migrations: new URL('./__fixtures__/migrations/relations-secrets/', import.meta.url) },
];

// Two columns per row: 70 000 rows are 140 000 parameters, more than one statement takes on either driver.
const people = (count: number, prefix = 'person') => Array.from({ length: count }, (_, index) => ({ name: `Person ${index}`, email: `${prefix}-${index}@example.com` }));
const START = Date.parse('2031-03-04T05:06:07.089Z');

describe.each(drivers)('Repository.insertMissing() on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let users: UserRepository;
  let keys: KeyRepository;
  let clock: TestClock;

  beforeAll(async () => {
    clock = new TestClock();
    ({ connections, close } = await freshConnections(driver, { now: () => clock.now() }));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    users = new UserRepository(connections);
    keys = new KeyRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    clock.freeze(START);
    await connections.get<FixtureTables>().deleteFrom('api_keys').execute();
    await connections.get<FixtureTables>().deleteFrom('users').execute();
  });

  it('writes the same rows once: 3, then 0', async () => {
    const rows = people(3);
    const first = await users.insertMissing(rows, { on: ['email'] });
    expect(first).toBe(3);
    expectTypeOf(first).toEqualTypeOf<number>();
    expect(await users.insertMissing(rows, { on: ['email'] })).toBe(0);
    expect(await users.count()).toBe(3);
  });

  it('writes only the new rows of a mixed list, and leaves the existing ones as they are', async () => {
    await users.insert({ name: 'Original', email: 'person-1@example.com' });
    expect(await users.insertMissing(people(3), { on: ['email'] })).toBe(2);
    expect((await users.findBy('email', 'person-1@example.com'))?.name).toBe('Original');
    expect(await users.count()).toBe(3);
  });

  it('does nothing for no rows', async () => {
    expect(await users.insertMissing([], { on: ['email'] })).toBe(0);
    expect(await users.insertMissing([], { on: ['email'], returning: ['id'] })).toEqual([]);
  });

  it('counts across chunks', async () => {
    await users.insertMany(people(10));
    expect(await users.insertMissing(people(70_000), { on: ['email'] })).toBe(69_990);
    expect(await users.count()).toBe(70_000);
  }, 60_000);

  it('returns the inserted rows only, with returning', async () => {
    await users.insert({ name: 'Original', email: 'person-1@example.com' });
    const inserted = await users.insertMissing(people(3), { on: ['email'], returning: ['email', 'name'] });
    expectTypeOf(inserted).toEqualTypeOf<{ email: string; name: string }[]>();
    expect(inserted.map((row) => row.email).sort()).toEqual(['person-0@example.com', 'person-2@example.com']);
    expect(Object.keys(inserted[0]!).sort()).toEqual(['email', 'name']);
  });

  it.runIf(driver === 'pgsql')('a call that waits on another one writes nothing of what that one wrote', async () => {
    const rows = people(200);
    let opened!: () => void;
    let release!: () => void;
    const hasWritten = new Promise<void>((resolve) => (opened = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    // A holds its rows uncommitted; B starts outside A's transaction, on another connection.
    const a = connections.transaction(async () => {
      try {
        expect(await users.insertMissing(rows, { on: ['email'] })).toBe(200);
      } finally {
        opened();
      }
      await gate;
    });
    try {
      await hasWritten;
      const b = users.insertMissing([...rows].reverse(), { on: ['email'] });
      const early = await Promise.race([b, new Promise<'waiting'>((resolve) => setTimeout(resolve, 200, 'waiting'))]);
      expect(early).toBe('waiting');
      release();
      await a;
      expect(await b).toBe(0);
    } finally {
      release();
      await a.catch(() => undefined);
    }
    expect(await users.count()).toBe(200);
  });

  it('writes rows with the same keys in another order without a difference', async () => {
    const rows = people(50);
    const [a, b] = await Promise.all([users.insertMissing(rows, { on: ['email'] }), users.insertMissing([...rows].reverse(), { on: ['email'] })]);
    expect(a + b).toBe(50);
    expect(await users.count()).toBe(50);
  });

  it('a secret column, an unknown one or a missing value in on is a TypeError before any statement', async () => {
    const owner = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const rows = [{ user_id: owner.id, name: 'cli', token: 'hash-1' }];
    await expect(keys.insertMissing(rows, { on: ['token'] as never })).rejects.toThrow(/secret column/);
    await expect(keys.insertMissing(rows, { on: ['nope'] as never })).rejects.toThrow(/not a column/);
    expect(await keys.count()).toBe(0);
    await expect(users.insertMissing([{ name: 'Ada', email: null as never }], { on: ['email'] })).rejects.toThrow(/row 0 has no value for it \(null\)/);
    await expect(users.insertMissing([{ name: 'Ada', email: 'a@example.com' }, { name: 'Bo', email: undefined as never }], { on: ['email'] })).rejects.toThrow(TypeError);
    expect(await users.count()).toBe(1);
  });

  it('a conflict on another unique index throws and writes nothing', async () => {
    await users.insert({ name: 'Taken', email: 'taken@example.com' });
    const before = await users.count();
    // `on` is the primary key, so only the email can collide.
    const rows = [
      { id: 9001, name: 'New', email: 'new@example.com' },
      { id: 9002, name: 'Clash', email: 'taken@example.com' },
    ];
    const error = await users.insertMissing(rows, { on: ['id'] }).then(() => undefined, (e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(await users.count()).toBe(before);
  });

  it('a clash in a later chunk rolls the earlier chunks back', async () => {
    await users.insert({ name: 'Taken', email: 'taken@example.com' });
    const rows = people(70_000).map((row, index) => ({ ...row, id: 10_000 + index }));
    rows[69_999] = { id: 99_999_999, name: 'Clash', email: 'taken@example.com' };
    const error = await users.insertMissing(rows, { on: ['id'] }).then(() => undefined, (e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(await users.count()).toBe(1);
  }, 60_000);

  it('columns no unique index backs are a TypeError naming them, inside a transaction too', async () => {
    await expect(users.insertMissing(people(2), { on: ['name'] })).rejects.toThrow(TypeError);
    await expect(users.insertMissing(people(2), { on: ['name'] })).rejects.toThrow(/no unique index on users \(name\).*unique\(\['name'\]\)/);
    await connections.transaction(async () => {
      await expect(users.insertMissing(people(2), { on: ['name'] })).rejects.toThrow(TypeError);
      expect(await users.insertMissing(people(2), { on: ['email'] })).toBe(2); // the transaction is still usable
    });
    expect(await users.count()).toBe(2);
  });

  it('an empty or absent on is a TypeError before any statement', async () => {
    await expect(users.insertMissing(people(1), { on: [] } as never)).rejects.toThrow(TypeError);
    await expect(users.insertMissing(people(1), {} as never)).rejects.toThrow(/needs \{ on/);
    await expect(users.insertMissing(people(1), undefined as never)).rejects.toThrow(TypeError);
    expect(await users.count()).toBe(0);
  });

  it('stamps created_at and updated_at with the app clock', async () => {
    await users.insertMissing(people(2), { on: ['email'] });
    const row = await users.findBy('email', 'person-0@example.com');
    expect(new Date(row!.created_at as unknown as string).getTime()).toBe(START);
    expect(new Date(row!.updated_at as unknown as string).getTime()).toBe(START);
  });

  it('a soft-deleted row counts as present', async () => {
    const row = await users.insert({ name: 'Gone', email: 'gone@example.com' });
    await connections.get<FixtureTables>().updateTable('users').set({ deleted_at: new Date(START).toISOString() } as never).where('id', '=', row.id).execute();
    expect(await users.insertMissing([{ name: 'Back', email: 'gone@example.com' }], { on: ['email'] })).toBe(0);
  });

  it('refuses a secret column in returning, at run time before a statement', async () => {
    const owner = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const rows = [{ id: 1, user_id: owner.id, name: 'cli', token: 'hash-1' }];
    await expect(keys.insertMissing(rows, { on: ['id'], returning: ['token'] as never })).rejects.toThrow(TypeError);
    await expect(keys.insertMissing(rows, { on: ['id'], returning: ['token'] as never })).rejects.toThrow(/secret column/);
    expect(await keys.count()).toBe(0);
    const inserted = await keys.insertMissing(rows, { on: ['id'], returning: ['id', 'name'] });
    expect(inserted).toEqual([{ id: expect.anything(), name: 'cli' }]);
  });

  it('a returning without columns is a TypeError', async () => {
    await expect(users.insertMissing(people(1), { on: ['email'], returning: [] as never })).rejects.toThrow(TypeError);
  });

  it('on and returning are checked by the types', () => {
    void (() => {
      // @ts-expect-error on is required
      void users.insertMissing(people(1));
      // @ts-expect-error on is not empty
      void users.insertMissing(people(1), { on: [] });
      // @ts-expect-error on names columns of the table
      void users.insertMissing(people(1), { on: ['mail'] });
      // @ts-expect-error a secret column is not one to match on
      void keys.insertMissing([], { on: ['token'] });
      // @ts-expect-error a secret column is not returned
      void keys.insertMissing([], { on: ['id'], returning: ['token'] });
    });
  });
});

describe.each(drivers)('Repository.insertMany() and tryInsertMany() with returning on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let users: UserRepository;
  let keys: KeyRepository;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    users = new UserRepository(connections);
    keys = new KeyRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<FixtureTables>().deleteFrom('api_keys').execute();
    await connections.get<FixtureTables>().deleteFrom('users').execute();
  });

  it('returns the named columns of every row, over a chunk boundary', async () => {
    const rows = await users.insertMany(people(70_000), { returning: ['id', 'email'] });
    expectTypeOf(rows).toEqualTypeOf<{ id: number; email: string }[]>();
    expect(rows).toHaveLength(70_000);
    expect(Object.keys(rows[0]!).sort()).toEqual(['email', 'id']);
    expect(new Set(rows.map((row) => row.email)).size).toBe(70_000);
    expect(new Set(rows.map((row) => row.id)).size).toBe(70_000);
  }, 60_000);

  it('stays a number without the option', async () => {
    expectTypeOf(await users.insertMany(people(2))).toEqualTypeOf<number>();
    expect(await users.insertMany([], { returning: ['id'] })).toEqual([]);
  });

  it('tryInsertMany returns ok(rows), or the duplicate err with none written', async () => {
    const result = await users.tryInsertMany(people(3), { returning: ['email'] });
    expect(result.ok && result.value.map((row) => row.email).sort()).toEqual(['person-0@example.com', 'person-1@example.com', 'person-2@example.com']);
    expect(await users.tryInsertMany(people(4), { returning: ['email'] })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
    expect(await users.count()).toBe(3);
  });

  it('refuses a secret column or an unknown one, at compile time and when it runs', async () => {
    const owner = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const rows = [{ user_id: owner.id, name: 'cli', token: 'hash-1' }];
    // @ts-expect-error token is secret
    await expect(keys.insertMany(rows, { returning: ['token'] })).rejects.toThrow(/secret column/);
    await expect(keys.insertMany(rows, { returning: ['token'] as never })).rejects.toThrow(TypeError);
    await expect(keys.tryInsertMany(rows, { returning: ['token'] as never })).rejects.toThrow(TypeError);
    await expect(keys.insertMany(rows, { returning: ['nope'] as never })).rejects.toThrow(/not a column/);
    await expect(keys.insertMany(rows, { returning: [] as never })).rejects.toThrow(TypeError);
    expect(await keys.count()).toBe(0);
  });
});

describe('the order insertMissing() writes in', () => {
  it('is the same for numbers, numeric strings and bigints', () => {
    const keys = [[10], [9], [100], [2]];
    const as = (convert: (value: number) => unknown) => keys.map(([value]) => [convert(value!)]).sort(compareKeys).map(([value]) => Number(value));
    expect(as((value) => value)).toEqual(as(String));
    expect(as((value) => value)).toEqual(as(BigInt));
    expect(compareKeys([new Date(0)], [new Date(1000)])).toBe(-1);
    expect(compareKeys([new Uint8Array([1, 2])], [new Uint8Array([1, 3])])).toBe(-1);
    expect(compareKeys(['a', 1], ['a', 1])).toBe(0);
  });
});
