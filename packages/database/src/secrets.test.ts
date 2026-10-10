import type { Application, ModuleDefinition } from '@marmeon/core';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { hasMany, Migrator, Repository, renderTypes, secret, type Connections, type Generated, type Secret, type Selectable, type Timestamp } from './index.ts';

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
  static timestamps = true;

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
  });

  it('reads one only when asked for by name', async () => {
    const ada = await insertAda();
    expect(await accounts.findForLogin('ada@example.com')).toEqual({ id: ada.id, password: HASH });
    // Explicit wins over select-all in the same query.
    const both = await db.selectFrom('accounts').selectAll().select((eb) => secret(eb, 'accounts.totp_secret')).executeTakeFirstOrThrow();
    expect(both).toMatchObject({ totp_secret: 'JBSWY3DP' });
    expect(both).not.toHaveProperty('password');
  });

  it('counter-check: without the connection plugin, select-all would hand out the hash', async () => {
    await insertAda();
    const raw = await db.withoutPlugins().selectFrom('accounts').selectAll().executeTakeFirstOrThrow();
    expect(raw).toMatchObject({ password: HASH });
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
  it('is loaded on the connection a transaction holds — a first relation query inside one no longer hangs (W3 bug)', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).execute();
      // Before: the plugin looked up column kinds through the pool — which the transaction holds (SQLite: forever).
      const run = db.transaction().execute((trx) =>
        trx
          .selectFrom('users')
          .select((eb) => ['id', hasMany(eb, 'accounts', 'email', 'users.email', (q) => q.select(['accounts.id'])).as('accounts')])
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

  // Finding: Kysely's `selectAll()` type keeps the key as `never` (the runtime drops it).
  const all = await accountsDb.selectFrom('accounts').selectAll().executeTakeFirstOrThrow();
  expectTypeOf(all.password).toEqualTypeOf<never>();
}
