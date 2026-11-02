import { Application, Container, type ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { ApiKeyFactory, ArticleFactory, define, SluggedArticleFactory, UserFactory } from './__fixtures__/factories.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Connections, Factories, Migrator, PendingFactory, Repository, secret, type SeedContext } from './index.ts';
import { Seeding } from './seeders.ts';

class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}

/** A seeder with an injected repository — built by the container like any class. */
class DemoUsersSeeder {
  readonly #users: UserRepository;
  constructor(users: UserRepository) {
    this.#users = users;
  }
  async handle({ factory }: SeedContext) {
    await this.#users.insert({ name: 'Ada Lovelace', email: 'ada@example.com' });
    await factory(UserFactory).count(2).create();
  }
}
class ArticlesSeeder {
  async handle({ factory }: SeedContext) {
    await factory(ArticleFactory).create({ title: 'Seeded' });
  }
}

const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url), seeders: [DemoUsersSeeder] },
  { name: 'blog', migrations: new URL('./__fixtures__/migrations/blog/', import.meta.url), seeders: [ArticlesSeeder] },
  { name: 'keys', migrations: new URL('./__fixtures__/migrations/relations-secrets/', import.meta.url) },
];

describe.each(drivers)('factories and seeders on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let factories: Factories;
  const db = () => connections.get<FixtureTables>();

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await new Migrator({ modules, root: '/' } as unknown as Application, connections).migrate();
  });
  afterAll(() => close());
  beforeEach(async () => {
    factories = new Factories(connections);
    await db().deleteFrom('api_keys').execute();
    await db().deleteFrom('articles').execute();
    await db().deleteFrom('users').execute();
  });

  it('creates one row or many, counting a sequence per app', async () => {
    const one = await factories.for(UserFactory).create();
    expect(one).toMatchObject({ id: expect.any(Number), name: 'User 1', email: 'user1@example.com', is_admin: false });
    const many = await factories.for(UserFactory).count(2).create();
    expect(many.map((user) => user.email)).toEqual(['user2@example.com', 'user3@example.com']);
    expect(await factories.for(UserFactory).count(0).create()).toEqual([]);
    expect(await new Factories(connections).for(UserFactory).make()).toMatchObject({ email: 'user1@example.com' }); // a new app starts at 1
  });

  it('applies states and overrides, in that order', async () => {
    const admin = await factories.for(UserFactory).state('admin').state('rich').create({ name: 'Ada' });
    expect(admin).toMatchObject({ name: 'Ada', is_admin: true, balance: '1000.00' });
    const custom = await factories.for(UserFactory).state({ is_admin: true }).create();
    expect(custom.is_admin).toBe(true);
    expect(() => factories.for(UserFactory).state('banned' as never)).toThrow('Factory for "users" has no state "banned". Known: admin, rich.');
  });

  it('makes attributes without inserting', async () => {
    expect(factories.for(UserFactory).count(2).make({ name: 'Same' })).toEqual([
      { name: 'Same', email: 'user1@example.com' },
      { name: 'Same', email: 'user2@example.com' },
    ]);
    expect(await db().selectFrom('users').selectAll().execute()).toEqual([]);
  });

  it('makes a related factory\'s column as the factory itself, not an id — and its type says so', () => {
    const made = factories.for(ArticleFactory).make();
    expect(made.user_id).toBeInstanceOf(PendingFactory);
    expectTypeOf(made.user_id).toEqualTypeOf<number | PendingFactory<any, any, false>>();
    expectTypeOf(factories.for(ArticleFactory).count(2).make()[0]!.title).toEqualTypeOf<string | PendingFactory<any, any, false>>();
    // What the overrides set is what it is.
    const overridden = factories.for(ArticleFactory).make({ user_id: 7, title: 'Mine' });
    expect(overridden).toEqual({ user_id: 7, title: 'Mine' });
    expectTypeOf(overridden.user_id).toEqualTypeOf<number>();
    expectTypeOf(overridden.title).toEqualTypeOf<string>();
    // @ts-expect-error — a column the table does not have
    factories.for(ArticleFactory).make({ title: 'Mine', titel: 'typo' });
  });

  it('creates the related row for a factory used as a column value', async () => {
    const article = await factories.for(ArticleFactory).create();
    const author = await db().selectFrom('users').selectAll().where('id', '=', article.user_id).executeTakeFirstOrThrow();
    expect(author.email).toBe('user1@example.com');
    const ada = await factories.for(UserFactory).create({ name: 'Ada' });
    expect((await factories.for(ArticleFactory).create({ user_id: ada.id })).user_id).toBe(ada.id); // an override wins
  });

  it('creates inside a transaction with using(trx) — related rows included', async () => {
    await expect(
      db().transaction().execute(async (trx) => {
        await factories.for(ArticleFactory).using(trx).count(2).create();
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await db().selectFrom('users').selectAll().execute()).toEqual([]);
  });

  it('runs the modules’ seeders in module order — or one module, or one class', async () => {
    const container = new Container();
    container.instance(Connections, connections);
    const app = { modules } as unknown as Application;
    const seeding = new Seeding(app, container, connections, factories);
    const ran: string[] = [];
    await seeding.run({}, (run) => ran.push(`${run.module}/${run.seeder}`));
    expect(ran).toEqual(['auth/DemoUsersSeeder', 'blog/ArticlesSeeder']);
    expect((await db().selectFrom('users').select('name').orderBy('id').execute()).map((u) => u.name)).toEqual(['Ada Lovelace', 'User 1', 'User 2', 'User 3']);
    expect(seeding.seeders({ module: 'blog' }).map((s) => s.seeder.name)).toEqual(['ArticlesSeeder']);
    expect(seeding.seeders({ seeder: 'DemoUsersSeeder' }).map((s) => s.module)).toEqual(['auth']);
    expect(() => seeding.seeders({ module: 'shop' })).toThrow('[marmeon:D13] There is no module "shop".');
    expect(() => seeding.seeders({ seeder: 'Nope' })).toThrow('[marmeon:D13] There is no seeder "Nope".');
  });

  describe('derived columns', () => {
    it('derives a column from the row, and from a related row the definition created', async () => {
      const article = await factories.for(SluggedArticleFactory).create({ title: 'Hello World' });
      expect(article.slug).toBe('hello-world');
      const author = await db().selectFrom('users').selectAll().where('id', '=', article.user_id).executeTakeFirstOrThrow();
      expect(author.name).toBe('Author of Hello World'); // a derived column may return a factory
    });

    it('lets an override or a state replace the function, which then does not run', async () => {
      let ran = 0;
      const Counted = define('articles', ({ factory }) => ({
        user_id: factory(UserFactory),
        title: 'Counted',
        slug: () => `slug-${++ran}`,
      }));
      expect((await factories.for(Counted).create()).slug).toBe('slug-1');
      expect((await factories.for(Counted).create({ slug: 'mine', title: 'Other' })).slug).toBe('mine');
      expect((await factories.for(Counted).state({ slug: 'stated', title: 'Third' }).create()).slug).toBe('stated');
      expect(ran).toBe(1);
    });

    it('takes a related factory from a state, and a derived column from a state', async () => {
      const Linked = define('articles', ({ factory }) => ({ user_id: factory(UserFactory), title: 'Linked' }), {
        states: { shouting: { slug: (row) => String(row.title).toUpperCase() } },
      });
      expect((await factories.for(Linked).state('shouting').create()).slug).toBe('LINKED');
      const ada = factories.for(UserFactory).state({ name: 'Ada' });
      const article = await factories.for(Linked).state({ user_id: ada }).create();
      expect((await db().selectFrom('users').select('name').where('id', '=', article.user_id).executeTakeFirstOrThrow()).name).toBe('Ada');
    });

    it('gives every row of count() its own derived related row, and the call\'s override none', async () => {
      const rows = await factories.for(SluggedArticleFactory).count(3).create();
      expect(new Set(rows.map((row) => row.user_id)).size).toBe(3);
      expect(await db().selectFrom('users').select('id').execute()).toHaveLength(3);
      const ada = await factories.for(UserFactory).create({ name: 'Ada' });
      await factories.for(SluggedArticleFactory).create({ user_id: ada.id });
      expect(await db().selectFrom('users').select('id').execute()).toHaveLength(4); // the function for user_id did not run
    });

    it('lets a derived column read the ones before it', async () => {
      const Chain = define('articles', ({ factory }) => ({
        user_id: factory(UserFactory),
        title: (row) => `Title ${row.user_id === undefined ? '?' : typeof row.user_id}`,
        slug: (row) => String(row.title),
        content: (row) => `${String(row.slug)}!`,
      }));
      expect(await factories.for(Chain).create()).toMatchObject({ title: 'Title number', slug: 'Title number', content: 'Title number!' });
    });

    it('makes the derived column with the related column holding its factory', () => {
      const made = factories.for(SluggedArticleFactory).make({ title: 'Made' });
      expect(made.slug).toBe('made');
      expect(made.user_id).toBeInstanceOf(PendingFactory);
    });

    it('refuses a cycle, a read of a column derived later, and a function returning a function — before any insert', async () => {
      const Cycle = define('articles', ({ factory }) => ({
        user_id: factory(UserFactory),
        title: (row) => String(row.slug),
        slug: (row) => String(row.title),
      }));
      await expect(factories.for(Cycle).create()).rejects.toThrow('Factory for "articles": the derived column "title" reads "slug", which is derived too and not yet worked out.');
      expect(() => factories.for(Cycle).make()).toThrow('reads "slug"');
      const Itself = define('articles', ({ factory }) => ({ user_id: factory(UserFactory), title: (row) => String(row.title) }));
      await expect(factories.for(Itself).create()).rejects.toThrow('the derived column "title" reads "title"');
      const Nested = define('articles', ({ factory }) => ({ user_id: factory(UserFactory), title: 'T', slug: () => (() => 'x') as never }));
      await expect(factories.for(Nested).create()).rejects.toThrow(new TypeError('Factory for "articles": the derived column "slug" returned a function; return a value or a factory.'));
      const Async = define('articles', ({ factory }) => ({ user_id: factory(UserFactory), title: 'T', slug: (async () => 'x') as never }));
      await expect(factories.for(Async).create()).rejects.toThrow('returned a promise; a derived column is synchronous.');
      expect(() => factories.for(Async).make()).toThrow('returned a promise');
      expect(await db().selectFrom('articles').select('id').execute()).toEqual([]); // no article; the users of the plain user_id columns exist
      expect((await db().selectFrom('users').select('id').execute()).length).toBeGreaterThan(0);
    });

    it('throws when a derived column reads a secret column anyway', async () => {
      const Leaky = define('api_keys', ({ factory }) => ({ user_id: factory(UserFactory), token: 'secret-token', name: (row) => String((row as never as { token: string }).token) }));
      await expect(factories.for(Leaky).create()).rejects.toThrow('the derived column "name" reads the secret column "token"');
      expect(await db().selectFrom('api_keys').select('id').execute()).toEqual([]);
    });

    it('refuses a derived column on a connection that does not know the schema', async () => {
      const Leaky = define('api_keys', ({ factory }) => ({ user_id: factory(UserFactory), token: 'secret-token', name: (row) => String((row as never as { token: string }).token) }));
      await expect(factories.for(Leaky).using(connections.infrastructure() as never).create()).rejects.toThrow('Factory for "api_keys": derived columns need a connection that knows the schema');
      expect(await db().selectFrom('api_keys').select('id').execute()).toEqual([]);
    });

    it('lets a factory set a secret column, and a derived value never receives it', async () => {
      const key = await factories.for(ApiKeyFactory).create();
      expect(key).not.toHaveProperty('token');
      expect(key.name).toBe(`key of user ${key.user_id}`);
      const stored = await db().selectFrom('api_keys').select((eb) => [secret(eb, 'token')]).where('id', '=', key.id).executeTakeFirstOrThrow();
      expect(stored.token).toBe('token-1');
    });
  });
});
