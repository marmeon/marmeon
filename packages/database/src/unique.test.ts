import type { Application, ModuleDefinition } from '@marmeon/core';
import { ValidationError, type ValidationContext } from '@marmeon/router';
import { rules as r } from '@marmeon/validation';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { failOnDuplicate, Migrator, Repository, uniqueViolationColumns, type Connections } from './index.ts';

class UserRepository extends Repository<'users', FixtureTables> {
  static table = 'users' as const;
}

const modules: ModuleDefinition[] = [{ name: 'auth', migrations: new URL('./__fixtures__/migrations/auth/', import.meta.url) }];

/** What the router hands a schema in a request (`libraryOptions.marmeon`): its resolve, its ctx, whether it is live. */
const inRequest = (users: UserRepository, ctx: object = {}, live = false) => ({
  libraryOptions: { marmeon: { resolve: () => users, ctx, live } as unknown as ValidationContext },
});

describe.each(drivers)('the unique index is the truth — on %s', (driver) => {
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

  it('failOnDuplicate: a conflict on the field\'s unique index is a 422 at the field — with the unique rule\'s message', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const alan = await users.insert({ name: 'Alan', email: 'alan@example.com' });
    const error = await failOnDuplicate('email', () => users.update(alan.id, { email: 'ada@example.com' }), { email: 'ada@example.com' }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).status).toBe(422);
    expect((error as ValidationError).errors).toEqual({ email: ['The email has already been taken.'] });
    expect((error as ValidationError).input).toEqual({ email: 'ada@example.com' });
    // A form field of another name than the column.
    const renamed = await failOnDuplicate({ email: 'address' }, () => users.insert({ name: 'Ada 2', email: 'ada@example.com' })).catch((failure: unknown) => failure);
    expect((renamed as ValidationError).errors).toEqual({ address: ['The address has already been taken.'] });
    expect(await failOnDuplicate('email', () => users.update(ada.id, { name: 'Ada L.' }))).toMatchObject({ name: 'Ada L.' });
  });

  it('a conflict on another index stays what it is (a bug, not the input): rethrown', async () => {
    await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const error = await failOnDuplicate('name', () => users.insert({ name: 'Ada', email: 'ada@example.com' })).catch((failure: unknown) => failure);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(uniqueViolationColumns(error)).toContain('email');
  });

  it('in a transaction, the 422 rolls it back', async () => {
    await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const error = await connections
      .transaction(async () => {
        await users.insert({ name: 'Grace', email: 'grace@example.com' });
        await failOnDuplicate('email', () => users.insert({ name: 'Ada 2', email: 'ada@example.com' }));
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ValidationError);
    expect(await users.count()).toBe(1);
  });

  it('r.unique against the table: the friendly message first — soft-deleted rows count, the row being edited does not', async () => {
    const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const gone = await users.insert({ name: 'Gone', email: 'gone@example.com' });
    await users.delete(gone.id);
    const form = r.object({ email: r.email().unique(UserRepository, 'email', { ignore: (ctx: { user: { id: number } }) => ctx.user.id }) });
    const validate = (email: string, user = 0) => form['~standard'].validate({ email }, inRequest(users, { user: { id: user } }));
    expect(await validate('new@example.com')).toEqual({ value: { email: 'new@example.com' } });
    expect((await validate('ada@example.com')).issues?.map((issue) => issue.message)).toEqual(['The email has already been taken.']);
    expect((await validate('gone@example.com')).issues?.map((issue) => issue.message)).toEqual(['The email has already been taken.']);
    expect(await validate('ada@example.com', ada.id)).toEqual({ value: { email: 'ada@example.com' } });
  });

  it('r.exists: a row that is there (soft-deleted rows are not)', async () => {
    await users.insert({ name: 'Ada', email: 'ada@example.com' });
    const gone = await users.insert({ name: 'Gone', email: 'gone@example.com' });
    await users.delete(gone.id);
    const form = r.object({ email: r.email().exists(UserRepository, 'email') });
    expect(await form['~standard'].validate({ email: 'ada@example.com' }, inRequest(users))).toEqual({ value: { email: 'ada@example.com' } });
    expect((await form['~standard'].validate({ email: 'gone@example.com' }, inRequest(users))).issues?.map((issue) => issue.message)).toEqual(['The selected email is invalid.']);
  });
});
