import type { Application, ModuleDefinition } from '@bespokecore/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Migrator, RecordNotFoundError, Repository, type Connections } from './index.ts';

class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
  static timestamps = true;
  static softDeletes = true;

  findByEmail(email: string) {
    return this.query().select(['id', 'name']).where('email', '=', email).executeTakeFirst();
  }
}

class ArticleRepository extends Repository<'articles', FixtureTables> {
  static table = 'articles' as const;
}

const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url) },
  { name: 'blog', migrations: new URL('./__fixtures__/migrations/blog/', import.meta.url) },
];

describe.each(drivers)('Repository on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let users: UserRepository;
  let articles: ArticleRepository;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
    users = new UserRepository(connections);
    articles = new ArticleRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await connections.get<FixtureTables>().deleteFrom('articles').execute();
    await connections.get<FixtureTables>().deleteFrom('users').execute();
  });

  it('inserts and returns the stored row, finds it, counts it', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    expect(ada).toMatchObject({ name: 'Ada', is_admin: false, balance: '0.00', deleted_at: null });
    expect(await users.find(ada.id)).toEqual(ada);
    expect(await users.findOrFail(ada.id)).toEqual(ada);
    expect(await users.exists(ada.id)).toBe(true);
    expect(await users.exists(ada.id + 1)).toBe(false);
    expect(await users.count()).toBe(1);
    expect(await users.findByEmail('ada@example.com')).toEqual({ id: ada.id, name: 'Ada' });
  });

  it('answers a missing row with a 404 that does not tell the client what was looked up', async () => {
    const error = await users.findOrFail(404).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(RecordNotFoundError);
    expect(error).toMatchObject({ status: 404, message: 'Not Found', table: 'users', key: 404 });
  });

  it('updates a row, sets updated_at with timestamps, and returns undefined for no row', async () => {
    const old = '2020-01-01T00:00:00.000Z';
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com', created_at: old, updated_at: old });
    const updated = await users.update(ada.id, { name: 'Ada Lovelace' });
    expect(updated).toMatchObject({ name: 'Ada Lovelace', created_at: old });
    expect(updated!.updated_at > old).toBe(true);
    expect(await users.update(ada.id + 1, { name: 'Nobody' })).toBeUndefined();
    expect(await articles.update(1, { title: 'x' })).toBeUndefined(); // no timestamps, no row
  });

  it('soft-deletes: hidden from reads and updates, visible withTrashed, restorable, force-deletable', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    expect(await users.delete(ada.id)).toBe(true);
    expect(await users.delete(ada.id)).toBe(false); // already deleted
    expect(await users.find(ada.id)).toBeUndefined();
    expect(await users.count()).toBe(0);
    expect(await users.update(ada.id, { name: 'Ghost' })).toBeUndefined();
    const trashed = await users.withTrashed().selectAll().where('id', '=', ada.id).executeTakeFirstOrThrow();
    expect(trashed.deleted_at).toMatch(/Z$/);

    expect(await users.restore(ada.id)).toBe(true);
    expect((await users.find(ada.id))?.deleted_at).toBeNull();
    expect(await users.forceDelete(ada.id)).toBe(true);
    expect(await users.withTrashed().selectAll().execute()).toEqual([]);
  });

  it('works across repositories in one transaction with using(trx)', async () => {
    await expect(
      connections.get<FixtureTables>().transaction().execute(async (trx) => {
        const ada = await users.using(trx).insert({ name: 'Ada', email: 'ada@example.com' });
        await articles.using(trx).insert({ user_id: ada.id, title: 'Notes' });
        expect(await users.using(trx).count()).toBe(1);
        throw new Error('roll it all back');
      }),
    ).rejects.toThrow('roll it all back');
    expect(await users.count()).toBe(0);
    expect(await articles.count()).toBe(0);
  });

  it('nests transactions as savepoints — a failed inner one leaves the outer one intact', async () => {
    await users.transaction(async (outer) => {
      await outer.insert({ name: 'Ada', email: 'ada@example.com' });
      await expect(
        outer.transaction(async (inner) => {
          await inner.insert({ name: 'Alan', email: 'alan@example.com' });
          throw new Error('inner failed');
        }),
      ).rejects.toThrow('inner failed');
      await outer.transaction((inner) => inner.insert({ name: 'Grace', email: 'grace@example.com' }));
    });
    const names = (await users.query().select('name').orderBy('id').execute()).map((u) => u.name);
    expect(names).toEqual(['Ada', 'Grace']);
  });
});

describe('Repository classes', () => {
  it('keep their private members in using(trx) — and refuse it with more dependencies than the connection', async () => {
    class Tagged extends Repository<'users', FixtureTables> {
      static table = 'users' as const;
      #tag = 'private';
      tag() {
        return this.#tag;
      }
    }
    const connections = { get: () => ({}) } as unknown as Connections;
    expect(new Tagged(connections).using({} as never).tag()).toBe('private');

    class Busy extends Repository<'users', FixtureTables> {
      static table = 'users' as const;
      constructor(connections: Connections, _clock: { now(): Date }) {
        super(connections);
      }
    }
    expect(() => new Busy(connections, { now: () => new Date() }).using({} as never)).toThrow(
      'Busy.using() builds the repository with the transaction as its only dependency, but its constructor takes 2.',
    );
  });

  it('need their table as a runtime value', () => {
    class Tableless extends Repository<'users', FixtureTables> {}
    expect(() => new Tableless({ get: () => ({}) } as unknown as Connections)).toThrow(
      "Tableless needs its table as a runtime value: static table = '…' as const;",
    );
  });
});
