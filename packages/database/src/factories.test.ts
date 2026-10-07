import { Application, Container, type ModuleDefinition } from '@marmeon/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import { ArticleFactory, UserFactory } from './__fixtures__/factories.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Connections, Factories, Migrator, Repository, Seeding, type SeedContext } from './index.ts';

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
    expect(() => seeding.seeders({ module: 'shop' })).toThrow('There is no module "shop".');
    expect(() => seeding.seeders({ seeder: 'Nope' })).toThrow('There is no seeder "Nope".');
  });
});
