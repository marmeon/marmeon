import type { Application, ModuleDefinition } from '@marmeon/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Migrator, Repository, renderTypes, secret, sql, type Connections, type Generated, type Secret, type Selectable, type Timestamp } from './index.ts';

/** What `db:types` generates for the accounts fixture (checked below), next to the other fixture tables. */
interface AccountTables extends FixtureTables {
  accounts: {
    id: Generated<number>;
    email: string;
    password: Secret<string>;
    totp_secret: Secret<string | null>;
    recovery_code: Secret<string | null>;
    created_at: Generated<Timestamp>;
    updated_at: Generated<Timestamp>;
  };
}

class AccountRepository extends Repository<'accounts', AccountTables> {
  static table = 'accounts' as const;

  /** The one place that reads the hash. */
  findForLogin(email: string) {
    return this.query().select((eb) => ['id', secret(eb, 'password')]).where('email', '=', email).executeTakeFirst();
  }
}

const fixtures = (name: string) => new URL(`./__fixtures__/migrations/${name}/`, import.meta.url);
const modules: ModuleDefinition[] = [
  { name: 'auth', migrations: fixtures('auth') },
  { name: 'accounts', migrations: fixtures('accounts') },
];
const migrator = (connections: Connections) => new Migrator({ modules, root: '/' } as unknown as Application, connections);
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';

describe.each(drivers)('secret columns on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let db: Kysely<AccountTables>;
  let accounts: AccountRepository;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await migrator(connections).migrate();
    db = connections.get<AccountTables>();
    accounts = new AccountRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await db.deleteFrom('accounts').execute();
    await db.deleteFrom('users').execute();
  });

  const insertAda = () => accounts.insert({ email: 'ada@example.com', password: HASH, totp_secret: 'JBSWY3DP' });

  it('records which columns are secret — through creates, alters, renames and rollbacks', async () => {
    const secrets = async () => Object.fromEntries([...(await migrator(connections).secrets())].map(([t, c]) => [t, [...c].sort()]));
    expect(await secrets()).toEqual({ accounts: ['password', 'recovery_code', 'totp_secret'] });
    await migrator(connections).rollback({ steps: 1 });
    expect(await secrets()).toEqual({ accounts: ['api_secret', 'password'] });
    await migrator(connections).migrate();
    expect(await secrets()).toEqual({ accounts: ['password', 'recovery_code', 'totp_secret'] });
  });

  it('generates Secret<…> for them — the type above is what db:types writes', async () => {
    const tables = await db.introspection.getTables();
    const { source } = renderTypes({
      driver,
      tables: tables.filter((t) => t.name === 'accounts'),
      owners: new Map([['accounts', 'accounts']]),
      secrets: await migrator(connections).secrets(),
      modules: ['accounts'],
      exposes: new Map(),
    });
    expect(source).toContain('password: Secret<string>;');
    expect(source).toContain('totp_secret: Secret<string | null>;');
    expect(source).toContain('recovery_code: Secret<string | null>;');
    expect(source).toContain("import type { Generated, Secret, Timestamp } from '@marmeon/database';");
  });

  it('leaves them out of every select-all and returning-all result', async () => {
    const inserted = await insertAda();
    expect(Object.keys(inserted).sort()).toEqual(['created_at', 'email', 'id', 'updated_at']); // insert … returning *
    const ada = (await accounts.update(inserted.id, { password: `${HASH}x` }))!; // update … returning *
    expect(Object.keys(ada).sort()).toEqual(['created_at', 'email', 'id', 'updated_at']);
    expect(await accounts.find(ada.id)).toEqual(ada);
    expect(await accounts.resolveRouteBinding(String(ada.id), { ctx: {} as never })).toEqual(ada);
    expect(await db.selectFrom('accounts').selectAll().execute()).toEqual([ada]);
    expect(await db.deleteFrom('accounts').returningAll().execute()).toHaveLength(1);
  });

  it('… also through joins, subqueries and CTEs that select *', async () => {
    await insertAda();
    await db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).execute();
    const joined = await db.selectFrom('users').innerJoin('accounts', 'accounts.email', 'users.email').selectAll('accounts').select('users.name').executeTakeFirstOrThrow();
    expect(joined).not.toHaveProperty('password');
    expect(joined).toMatchObject({ email: 'ada@example.com', name: 'Ada' });

    const derived = await db.selectFrom(db.selectFrom('accounts').selectAll().as('a')).selectAll().executeTakeFirstOrThrow();
    expect(derived).not.toHaveProperty('password');
    const cte = await db.with('a', (q) => q.selectFrom('accounts').selectAll()).selectFrom('a').selectAll().executeTakeFirstOrThrow();
    expect(cte).not.toHaveProperty('password');
    expect(cte).not.toHaveProperty('totp_secret');
    const union = await db.selectFrom('accounts').selectAll().union(db.selectFrom('accounts').selectAll()).execute();
    expect(union).toHaveLength(1);
    expect(union[0]).not.toHaveProperty('password');
    const aliased = await db.selectFrom('accounts as a').selectAll('a').executeTakeFirstOrThrow();
    expect(aliased).not.toHaveProperty('password');
    expect(aliased).not.toHaveProperty('totp_secret');
  });


  it('… also for a join that selects every column of both tables, and for returning * of an update and a delete', async () => {
    await insertAda();
    await db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).execute();
    const both = await db.selectFrom('users').innerJoin('accounts', 'accounts.email', 'users.email').selectAll('users').selectAll('accounts').executeTakeFirstOrThrow();
    expect(both).not.toHaveProperty('password');
    expect(both).not.toHaveProperty('totp_secret');
    const inserted = await db.insertInto('accounts').values({ email: 'grace@example.com', password: HASH }).returningAll().execute();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).not.toHaveProperty('password');
    const updated = await db.updateTable('accounts').set({ password: `${HASH}y` }).returningAll().execute();
    expect(updated).toHaveLength(2);
    expect(updated[0]).not.toHaveProperty('password');
    const deleted = await db.deleteFrom('accounts').returningAll().execute();
    expect(deleted[0]).not.toHaveProperty('password');
    expect(deleted[0]).not.toHaveProperty('totp_secret');
  });

  it('the same builder run with and without a secret() sibling never leaks the column to the run without it', async () => {
    await insertAda();
    const plain = db.selectFrom('accounts').selectAll();
    const withSecret = plain.select((eb) => secret(eb, 'password'));
    expect(await withSecret.executeTakeFirstOrThrow()).toMatchObject({ password: HASH });
    expect(await plain.executeTakeFirstOrThrow()).not.toHaveProperty('password');
    expect(await withSecret.executeTakeFirstOrThrow()).toMatchObject({ password: HASH });
    expect(await plain.executeTakeFirstOrThrow()).not.toHaveProperty('password');
  });

  it('reads one only with secret() — explicit wins over select-all in the same query', async () => {
    const ada = await insertAda();
    expect(await accounts.findForLogin('ada@example.com')).toEqual({ id: ada.id, password: HASH });
    // Explicit wins over select-all in the same query.
    const both = await db.selectFrom('accounts').selectAll().select((eb) => secret(eb, 'accounts.totp_secret')).executeTakeFirstOrThrow();
    expect(both).toMatchObject({ totp_secret: 'JBSWY3DP' });
    expect(both).not.toHaveProperty('password');
  });

  it('without the connection plugin, select-all would hand out the hash', async () => {
    await insertAda();
    const raw = await db.withoutPlugins().selectFrom('accounts').selectAll().executeTakeFirstOrThrow();
    expect(raw).toMatchObject({ password: HASH });
  });

  describe('values written', () => {
    const refusal = 'a secret column';

    it('are read like a selection: a secret column is not copied into a readable one', async () => {
      await insertAda();
      await expect(db.updateTable('accounts').set((eb) => ({ email: eb.ref('password') })).execute()).rejects.toThrow(refusal);
      await expect(db.updateTable('accounts').set((eb) => ({ email: eb.ref('PASSWORD' as never) })).execute()).rejects.toThrow(refusal);
      await expect(db.updateTable('accounts').set({ email: sql.ref('password') } as never).execute()).rejects.toThrow(refusal);
      await expect(db.insertInto('accounts').values((eb) => ({ email: eb.ref('accounts.password'), password: HASH })).execute()).rejects.toThrow(refusal);
      expect((await db.selectFrom('accounts').select('email').execute()).map((row) => row.email)).toEqual(['ada@example.com']);
    });

    it('are read in an upsert too, where excluded is the row that was to be inserted', async () => {
      await insertAda();
      const upsert = (value: string) =>
        db
          .insertInto('accounts')
          .columns(['email', 'password'])
          .expression(db.selectFrom('accounts').select((e) => ['email', secret(e, 'password')]).where(sql<boolean>`true`))
          .onConflict((conflict) => conflict.column('email').doUpdateSet((eb) => ({ email: eb.ref(value as never) })))
          .returning('email');
      await expect(upsert('excluded.password').execute()).rejects.toThrow(refusal);
      await expect(upsert('EXCLUDED.password').execute()).rejects.toThrow(refusal);
      await expect(upsert('accounts.password').execute()).rejects.toThrow(refusal);
      expect((await db.selectFrom('accounts').select('email').execute()).map((row) => row.email)).toEqual(['ada@example.com']);
    });

    it('may pass from a secret column to a secret column', async () => {
      await insertAda();
      await db
        .insertInto('accounts')
        .values({ email: 'ada@example.com', password: 'other' })
        .onConflict((conflict) => conflict.column('email').doUpdateSet((eb) => ({ password: eb.ref('excluded.password') })))
        .execute();
      await db.updateTable('accounts').set((eb) => ({ totp_secret: eb.ref('password') })).execute();
      const copy = await db.insertInto('accounts').columns(['email', 'password']).expression(db.selectFrom('accounts').select((e) => [sql<string>`'grace@example.com'`.as('email'), secret(e, 'password')])).returning('id').execute();
      expect(copy).toHaveLength(1);
      const read = await db.selectFrom('accounts').select((eb) => ['email', secret(eb, 'password'), secret(eb, 'totp_secret')]).orderBy('id').execute();
      expect(read).toEqual([
        { email: 'ada@example.com', password: 'other', totp_secret: 'other' },
        { email: 'grace@example.com', password: 'other', totp_secret: null },
      ]);
    });

    it('are read in a statement inside a common table expression', () => {
      const compile = (query: { compile(): unknown }) => () => query.compile();
      expect(compile(db.with('x', (q) => q.updateTable('accounts').set((eb) => ({ email: eb.ref('password') })).returning('id')).selectFrom('users').select('id'))).toThrow(refusal);
      const from = db.selectFrom('accounts').select((e) => ['email', secret(e, 'password')]);
      expect(compile(db.with('x', (q) => q.insertInto('accounts').columns(['email', 'created_at']).expression(from).returning('id')).selectFrom('users').select('id'))).toThrow(refusal);
      expect(compile(db.with('x', (q) => q.insertInto('accounts').columns(['email', 'password']).expression(from).returning('id')).selectFrom('users').select('id'))).not.toThrow();
    });

    it('are read in a merge', () => {
      const merge = db.mergeInto('accounts').using('users', 'users.email', 'accounts.email');
      expect(() => merge.whenMatched().thenUpdateSet((eb) => ({ email: eb.ref('accounts.password') })).compile()).toThrow(refusal);
      expect(() => merge.whenMatched().thenUpdateSet((eb) => ({ password: eb.ref('accounts.password') })).compile()).not.toThrow();
      expect(() => merge.whenNotMatched().thenInsertValues((eb) => ({ email: eb.ref('accounts.password'), password: HASH })).compile()).toThrow(refusal);
    });
  });

  it('follows migrations on a live connection — a renamed secret stays secret', async () => {
    await migrator(connections).rollback({ steps: 1 });
    await db.insertInto('accounts').values({ email: 'ada@example.com', password: HASH, api_secret: 'JBSWY3DP' } as never).execute();
    expect(Object.keys(await db.selectFrom('accounts').selectAll().executeTakeFirstOrThrow()).sort()).toEqual(['created_at', 'email', 'id', 'updated_at']);
    await migrator(connections).migrate(); // renames api_secret → totp_secret: stale metadata would let it through
    const row = await db.selectFrom('accounts').selectAll().executeTakeFirstOrThrow();
    expect(row).not.toHaveProperty('totp_secret');
    expect(row).not.toHaveProperty('recovery_code');
  });
});

describe.each(drivers)('schema metadata inside transactions on %s', (driver) => {
  it('is loaded on the connection a transaction holds — a first relation query inside one does not hang', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).execute();
      // A lookup through the pool would wait for the connection the transaction holds (SQLite: forever).
      const run = db.transaction().execute((trx) =>
        trx
          .selectFrom('users')
          .select('id')
          .withRelation('accounts', { table: 'accounts', foreignKey: 'email', localKey: 'email' }, (q) => q.select(['accounts.id']))
          .execute(),
      );
      const outcome = await Promise.race([run.then(() => 'done'), new Promise((resolve) => setTimeout(() => resolve('hung'), 2000))]);
      expect(outcome).toBe('done');
    } finally {
      await close();
    }
  });
});

// --- Type guarantees (never called: `declare const` values are undefined at runtime) ---------

declare const accountsDb: Kysely<AccountTables>;
declare const repository: AccountRepository;

export async function secretTypes() {
  // The row type has no secret column — not as `never`, not at all.
  type Account = Selectable<AccountTables['accounts']>;
  expectTypeOf<keyof Account>().toEqualTypeOf<'id' | 'email' | 'created_at' | 'updated_at'>();
  const found = (await repository.find(1))!;
  // @ts-expect-error — a repository's rows do not carry the hash
  found.password;

  // Writing it is ordinary: NOT NULL secrets are required on insert.
  // @ts-expect-error — `password` is missing
  await accountsDb.insertInto('accounts').values({ email: 'ada@example.com' }).execute();
  await accountsDb.insertInto('accounts').values({ email: 'ada@example.com', password: 'hash' }).execute();
  await accountsDb.updateTable('accounts').set({ password: 'new hash' }).execute();

  // Reading it takes `secret()`, typed by the column…
  const login = await repository.findForLogin('ada@example.com');
  expectTypeOf(login).toEqualTypeOf<{ id: number; password: string } | undefined>();
  // …and only for secret columns of tables in scope.
  // @ts-expect-error — `email` is not secret: select it as usual
  accountsDb.selectFrom('accounts').select((eb) => secret(eb, 'email'));
  // @ts-expect-error — `accounts` is not in this query
  accountsDb.selectFrom('users').select((eb) => secret(eb, 'accounts.password'));

  // Kysely's `selectAll()` type keeps the key as `never` (the runtime drops it).
  const all = await accountsDb.selectFrom('accounts').selectAll().executeTakeFirstOrThrow();
  expectTypeOf(all.password).toEqualTypeOf<never>();
}
