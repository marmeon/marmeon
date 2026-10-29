import type { Application, ModuleDefinition, Result } from '@marmeon/core';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { isUniqueViolation, Migrator, Repository, type Connections, type DuplicateError } from './index.ts';

class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}

const modules: ModuleDefinition[] = [{ name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url) }];

// Two columns per row: 70 000 rows are 140 000 parameters, more than one statement takes on either driver.
const people = (count: number, prefix = 'person') => Array.from({ length: count }, (_, index) => ({ name: `Person ${index}`, email: `${prefix}-${index}@example.com` }));

describe.each(drivers)('Repository.tryInsertMany() on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let users: UserRepository;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    users = new UserRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<FixtureTables>().deleteFrom('users').execute();
  });

  it('inserts rows across several chunks and counts them; defaults and timestamps apply', async () => {
    const result = await users.tryInsertMany(people(70_000));
    expect(result).toEqual({ ok: true, value: 70_000 });
    expectTypeOf(result).toEqualTypeOf<Result<number, DuplicateError>>();
    expect(await users.count()).toBe(70_000);
    expect(await users.findBy('email', 'person-69999@example.com')).toMatchObject({ name: 'Person 69999', is_admin: false, balance: '0.00', deleted_at: null, created_at: expect.anything(), updated_at: expect.anything() });
    expect((await users.findBy('email', 'person-0@example.com'))?.created_at).not.toBeNull();
  }, 60_000);

  it('inserts exactly as many rows as one statement takes, and one more', async () => {
    const perStatement = Math.floor((driver === 'pgsql' ? 65_535 : 32_766) / 2);
    expect(await users.tryInsertMany(people(perStatement))).toEqual({ ok: true, value: perStatement });
    expect(await users.tryInsertMany(people(perStatement + 1, 'second'))).toEqual({ ok: true, value: perStatement + 1 });
    expect(await users.count()).toBe(2 * perStatement + 1);
  }, 60_000);

  it('does nothing for no rows', async () => {
    expect(await users.tryInsertMany([])).toEqual({ ok: true, value: 0 });
    expect(await users.count()).toBe(0);
  });

  it('a duplicate in a later chunk is a duplicate err with its columns, and no chunk stays', async () => {
    await users.insert({ name: 'Taken', email: 'taken@example.com' });
    const rows = people(70_000);
    rows[40_000] = { name: 'Late', email: 'taken@example.com' }; // in the third of five chunks on SQLite
    expect(await users.tryInsertMany(rows)).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
    expect(await users.count()).toBe(1);
  }, 60_000);

  it('two rows of different chunks holding the same value are a duplicate too', async () => {
    const rows = people(70_000);
    rows[69_999] = { name: 'Again', email: rows[0]!.email };
    expect(await users.tryInsertMany(rows)).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
    expect(await users.count()).toBe(0);
  }, 60_000);

  it('inside a transaction it joins it: the err leaves the transaction usable and the earlier work in place, the rows roll back with it', async () => {
    await users.insert({ name: 'Taken', email: 'taken@example.com' });
    await connections.transaction(async () => {
      await users.insert({ name: 'Before', email: 'before@example.com' });
      const rows = people(40_000);
      rows[39_999] = { name: 'Late', email: 'taken@example.com' };
      expect(await users.tryInsertMany(rows)).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
      expect(await users.count()).toBe(2); // the chunks before the failing one are gone, the transaction is not
      expect(await users.tryInsertMany(people(3, 'fresh'))).toEqual({ ok: true, value: 3 });
    });
    expect(await users.count()).toBe(5);
    // Returned from the transaction's callback, the err rolls everything back.
    const result = await connections.transaction(async () => {
      await users.tryInsertMany(people(3, 'other'));
      return users.tryInsertMany([{ name: 'Again', email: 'taken@example.com' }]);
    });
    expect(result.ok).toBe(false);
    expect(await users.count()).toBe(5);
  }, 60_000);

  it('an error that is not a duplicate throws and rolls every chunk back', async () => {
    const rows: { name: string | null; email: string }[] = people(40_000);
    rows[39_999] = { name: null, email: 'nameless@example.com' }; // name is NOT NULL
    await expect(users.tryInsertMany(rows as never)).rejects.toThrow();
    expect(await users.count()).toBe(0);
  }, 60_000);

  it('rows with different columns are a TypeError before any statement', async () => {
    await expect(users.tryInsertMany([{ name: 'Ada', email: 'ada@example.com' }, { name: 'Alan', email: 'alan@example.com', is_admin: true }])).rejects.toThrow(TypeError);
    await expect(users.tryInsertMany([{ name: 'Ada', email: 'ada@example.com' }, { name: 'Alan' } as never])).rejects.toThrow(/tryInsertMany\(\) writes.*row 1 has name/);
    await expect(users.tryInsertMany([{} as never])).rejects.toThrow(TypeError);
    expect(await users.count()).toBe(0);
  });

  it('a key with the value undefined counts as absent', async () => {
    const result = await users.tryInsertMany([{ name: 'Ada', email: 'ada@example.com' }, { name: 'Alan', email: 'alan@example.com', born_on: undefined }]);
    expect(result).toEqual({ ok: true, value: 2 });
  });

  it('rows are exact, like insert()', () => {
    // Type guarantees only: the function is never called.
    void (() => {
      // @ts-expect-error not a column of users
      void users.tryInsertMany([{ name: 'Ada', email: 'ada@example.com', nickname: 'A' }]);
      // @ts-expect-error email is required
      void users.tryInsertMany([{ name: 'Ada' }]);
    });
  });
});

describe.each(drivers)('Repository.insertMany() on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let users: UserRepository;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    users = new UserRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<FixtureTables>().deleteFrom('users').execute();
  });

  it('inserts rows across several chunks and returns their number', async () => {
    const count = await users.insertMany(people(70_000));
    expect(count).toBe(70_000);
    expectTypeOf(count).toEqualTypeOf<number>();
    expect(await users.count()).toBe(70_000);
  }, 60_000);

  it('does nothing for no rows', async () => {
    expect(await users.insertMany([])).toBe(0);
    expect(await users.count()).toBe(0);
  });

  it('throws on a duplicate in a later chunk, like insert(), and leaves no chunk behind', async () => {
    await users.insert({ name: 'Taken', email: 'taken@example.com' });
    const rows = people(70_000);
    rows[40_000] = { name: 'Late', email: 'taken@example.com' };
    const error = await users.insertMany(rows).then(() => undefined, (e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(await users.count()).toBe(1);
  }, 60_000);

  it('rows with different columns are a TypeError', async () => {
    await expect(users.insertMany([{ name: 'Ada', email: 'ada@example.com' }, { name: 'Alan' } as never])).rejects.toThrow(/insertMany\(\) writes.*row 1 has name/);
  });

  it('a duplicate thrown inside a transaction and caught keeps the earlier work and the transaction usable', async () => {
    await users.insert({ name: 'Taken', email: 'taken@example.com' });
    await connections.transaction(async () => {
      await users.insert({ name: 'Before', email: 'before@example.com' });
      const rows = people(40_000);
      rows[39_999] = { name: 'Late', email: 'taken@example.com' };
      const error = await users.transaction((inner) => inner.insertMany(rows)).then(() => undefined, (e: unknown) => e);
      expect(isUniqueViolation(error)).toBe(true);
      expect(await users.count()).toBe(2);
      expect(await users.insertMany(people(3, 'fresh'))).toBe(3);
    });
    expect(await users.count()).toBe(5);
  }, 60_000);

  it('another error inside an open transaction throws out of it and rolls the whole transaction back', async () => {
    const rows: { name: string | null; email: string }[] = people(40_000);
    rows[39_999] = { name: null, email: 'nameless@example.com' };
    await expect(
      connections.transaction(async () => {
        await users.insert({ name: 'Before', email: 'before@example.com' });
        await users.insertMany(rows as never);
      }),
    ).rejects.toThrow();
    expect(await users.count()).toBe(0);
  }, 60_000);
});
