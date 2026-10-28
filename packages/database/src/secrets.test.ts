import type { Application, ModuleDefinition } from '@marmeon/core';
import { CamelCasePlugin, ColumnNode, RawNode, ColumnUpdateNode, CommonTableExpressionNameNode, CommonTableExpressionNode, WithNode, type UpdateQueryNode, ExplainNode, OperationNodeTransformer, TableNode, type InsertQueryNode, type Kysely, type KyselyPlugin, type SelectQueryNode } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { drivers, freshConnections, unfresh } from './__fixtures__/databases.ts';
import type { FixtureTables } from './__fixtures__/tables.ts';
import { Migrator, Repository, secret, secretEquals, sql, type Connections, type Generated, type Secret, type RowOf, type Timestamp } from './index.ts';
import { projectMigrations } from './schema/projection.ts';
import { renderTypes } from './types-gen/render.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

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
  findForSignIn(email: string) {
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

  it('knows which columns are secret from the migrations — through creates, alters, renames and rollbacks', async () => {
    const secrets = async () => {
      const m = migrator(connections);
      const ran = new Set((await m.status()).filter((file) => file.batch !== undefined).map((file) => file.name));
      const { tables } = await projectMigrations(m.files(), { only: ran });
      return Object.fromEntries([...tables.values()].flatMap((table) => {
        const secret = table.columns.filter((column) => column.secret).map((column) => column.name).sort();
        return secret.length > 0 ? [[table.name, secret]] : [];
      }));
    };
    expect(await secrets()).toEqual({ accounts: ['password', 'recovery_code', 'totp_secret'] });
    await migrator(connections).rollback({ steps: 1 });
    expect(await secrets()).toEqual({ accounts: ['api_secret', 'password'] });
    await migrator(connections).migrate();
    expect(await secrets()).toEqual({ accounts: ['password', 'recovery_code', 'totp_secret'] });
  });

  it('generates Secret<…> for them — the type above is what db:types writes', async () => {
    const { source } = renderTypes({
      driver,
      projection: await new Migrator({ modules: [modules[1]!], root: workspaceTempDir('marmeon-secrets-') } as unknown as Application, connections).projection(),
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
    expect(await accounts.findForSignIn('ada@example.com')).toEqual({ id: ada.id, password: HASH });
    // Explicit wins over select-all in the same query.
    const both = await db.selectFrom('accounts').selectAll().select((eb) => secret(eb, 'accounts.totp_secret')).executeTakeFirstOrThrow();
    expect(both).toMatchObject({ totp_secret: 'JBSWY3DP' });
    expect(both).not.toHaveProperty('password');
  });

  describe('secretEquals()', () => {
    // A hex SHA-256, what a token's hash column holds.
    const TOKEN_HASH = 'b5bb9d8014a0f9b1d61e21e796d78dccdf1352f23cd32812f4850b878ae4944c';

    it('finds the row by the hash, in a select, an update and a delete, and returns no hash', async () => {
      const ada = await accounts.insert({ email: 'ada@example.com', password: HASH, recovery_code: TOKEN_HASH });
      await accounts.insert({ email: 'grace@example.com', password: HASH, recovery_code: `${TOKEN_HASH.slice(0, -1)}0` });
      const found = await db.selectFrom('accounts').selectAll().where((eb) => secretEquals(eb, 'recovery_code', TOKEN_HASH)).execute();
      expect(found).toEqual([ada]);
      expect(found[0]).not.toHaveProperty('recovery_code');
      expect(await db.selectFrom('accounts').select('id').where((eb) => secretEquals(eb, 'accounts.recovery_code', TOKEN_HASH.toUpperCase())).execute()).toEqual([]);
      expect(await db.selectFrom('accounts').select('id').where((eb) => secretEquals(eb, 'recovery_code', 'f'.repeat(64))).execute()).toEqual([]);

      const updated = await db.updateTable('accounts').set({ email: 'ada@example.org' }).where((eb) => secretEquals(eb, 'recovery_code', TOKEN_HASH)).executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(1n);
      const deleted = await db.deleteFrom('accounts').where((eb) => secretEquals(eb, 'recovery_code', TOKEN_HASH)).executeTakeFirst();
      expect(deleted.numDeletedRows).toBe(1n);
      expect(await db.selectFrom('accounts').select('email').execute()).toEqual([{ email: 'grace@example.com' }]);
    });

    it('refuses a value that is no hash — a short secret can be guessed — without naming it', () => {
      const compare = (value: unknown) => db.selectFrom('accounts').select('id').where((eb) => secretEquals(eb, 'recovery_code', value as string));
      for (const short of ['123456', 'x'.repeat(31), '', null, 12345678901234567890123456789012345n, undefined]) {
        expect(() => compare(short)).toThrow(TypeError);
      }
      expect(() => compare('x'.repeat(32))).not.toThrow();
      let message = '';
      try {
        compare('s3cr3t-pin');
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('secretEquals()');
      expect(message).not.toContain('s3cr3t-pin');
    });

    it('sends the hash as a parameter, never in the SQL text', () => {
      const compiled = db.selectFrom('accounts').select('id').where((eb) => secretEquals(eb, 'recovery_code', TOKEN_HASH)).compile();
      expect(compiled.sql).not.toContain(TOKEN_HASH);
      expect(compiled.parameters).toContain(TOKEN_HASH);
    });
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
      await expect(db.updateTable('accounts').set((eb) => ({ email: eb.ref('password') })).execute()).rejects.toThrow(/^\[marmeon:D9\] /);
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

describe.each(drivers)('statements the guard reads through on %s', (driver) => {
  it('strips a select inside raw SQL, on the first query after a migration as on every later one', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await new AccountRepository(connections).insert({ email: 'ada@example.com', password: HASH, totp_secret: 'JBSWY3DP' });
      const read = () => sql<Record<string, unknown>>`select * from ${db.selectFrom('accounts').selectAll().as('a')}`.execute(db);
      // The metadata is not fresh: the query is compiled before the schema is known again, as the first query of a process is.
      unfresh(connections);
      for (const attempt of [read, read]) {
        const [row] = (await attempt()).rows;
        expect(row).toMatchObject({ email: 'ada@example.com' });
        expect(row).not.toHaveProperty('password');
      }
    } finally {
      await close();
    }
  });

  it('refuses a function named like a placeholder but with more behind it, on cold metadata', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await expect(
        db
          .selectFrom('accounts as __marmeon_unresolved_t' as never)
          .select((eb: any) => eb.fn('__marmeon_unresolved_t.email || (select password from accounts limit 1) || lower', [eb.val('')]).as('leak'))
          .execute(),
      ).rejects.toThrow('which is no identifier');
    } finally {
      await close();
    }
  });

  it('refuses a function whose name is no identifier — it would send a subquery past the check', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await new AccountRepository(connections).insert({ email: 'ada@example.com', password: HASH });
      for (let warm = 0; warm < 2; warm++) {
        await expect(
          db.selectFrom('accounts').select((eb) => eb.fn('(select password from accounts limit 1) || lower', [eb.val('')]).as('leak')).execute(),
        ).rejects.toThrow('which is no identifier');
        await expect(db.selectFrom('accounts').select('id').where((eb) => eb.fn('x) or (select 1', [])).execute()).rejects.toThrow('which is no identifier');
      }
      await expect(db.selectFrom('accounts').select((eb) => eb.fn.agg('(select password from accounts limit 1) || max', ['email']).as('leak')).execute()).rejects.toThrow('which is no identifier');
      await expect(db.selectFrom('accounts').select((eb) => eb.fn.count('id').as('n')).executeTakeFirstOrThrow()).resolves.toMatchObject({ n: 1 });
      await expect(db.selectFrom('accounts').select((eb) => eb.fn('lower', ['email']).as('e')).executeTakeFirstOrThrow()).resolves.toMatchObject({ e: 'ada@example.com' });
    } finally {
      await close();
    }
  });
});

describe.each(drivers)('a plugin added to a single query on %s', (driver) => {
  /** Renames a column in whatever the query reads — runs after the connection's own plugins. */
  const rename = (from: string, to: string): KyselyPlugin => ({
    transformQuery: ({ node }) => new (class extends OperationNodeTransformer {
      protected override transformColumn(column: ColumnNode): ColumnNode {
        return column.column.name === from ? ColumnNode.create(to) : column;
      }
    })().transformNode(node),
    transformResult: async ({ result }) => result,
  });
  const retarget = (table: string): KyselyPlugin => ({
    transformQuery: ({ node }) => ({ ...(node as InsertQueryNode), into: TableNode.create(table) }),
    transformResult: async ({ result }) => result,
  });

  // Cold: a schema change leaves the metadata stale, so the query is compiled before the schema is known again.
  const temperatures = ['warm', 'cold'] as const;

  it.each(temperatures)('does not hand out a secret column it renamed to — %s', async (temperature) => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await new AccountRepository(connections).insert({ email: 'ada@example.com', password: HASH });
      if (temperature === 'cold') unfresh(connections);
      await expect(db.selectFrom('accounts').select('email').withPlugin(rename('email', 'password')).execute()).rejects.toThrow('password');
      await expect(db.selectFrom('accounts').select('email').withPlugin(rename('email', 'password')).execute()).rejects.toThrow('password');
      await expect(db.withPlugin(rename('email', 'password')).selectFrom('accounts').select('email').execute()).rejects.toThrow('password');
      // The same query without the secret stays as it was.
      await expect(db.selectFrom('accounts').select('email').withPlugin(rename('id', 'email')).execute()).resolves.toEqual([{ email: 'ada@example.com' }]);
    } finally {
      await close();
    }
  });

  it.each(temperatures)('does not write another table than the one it was built for — %s', async (temperature) => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      if (temperature === 'cold') unfresh(connections);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).withPlugin(retarget('accounts')).execute(),
        ).rejects.toThrow('changed the tables it writes');
      }
      expect(await db.selectFrom('accounts').select('id').execute()).toEqual([]);
      // A plugin that keeps the table works, and so does a rename of the table's own spelling.
      await db.insertInto('users').values({ name: 'Ada', email: 'ada@example.com' }).withPlugin(new CamelCasePlugin()).execute();
      expect(await db.selectFrom('users').select('name').execute()).toEqual([{ name: 'Ada' }]);
    } finally {
      await close();
    }
  });

  it.each(temperatures)('still checks a query a benign plugin rewrote — %s', async (temperature) => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await new AccountRepository(connections).insert({ email: 'ada@example.com', password: HASH });
      if (temperature === 'cold') unfresh(connections);
      const camel = new CamelCasePlugin();
      await expect(db.selectFrom('accounts').selectAll().withPlugin(camel).execute()).resolves.toMatchObject([{ email: 'ada@example.com' }]);
      await expect(db.selectFrom('accounts').select('email').withPlugin(camel).execute()).resolves.toEqual([{ email: 'ada@example.com' }]);
      const [row] = await db.selectFrom('accounts').selectAll().withPlugin(camel).execute();
      expect(row).not.toHaveProperty('password');
    } finally {
      await close();
    }
  });

  it('does not take a node another query passed on cold metadata for its own', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await new AccountRepository(connections).insert({ email: 'ada@example.com', password: HASH });
      const fresh = unfresh(connections);
      // Compiled while the metadata is not fresh: nothing checked it.
      const leak = db.selectFrom('accounts').select('password' as never).compile().query;
      const write = db.insertInto('accounts').values({ email: 'x@example.com', password: 'x' }).compile().query;
      fresh();
      await db.selectFrom('users').select('id').execute(); // fresh again
      const replay = (node: unknown): KyselyPlugin => ({ transformQuery: () => node as never, transformResult: async ({ result }) => result });
      await expect(db.selectFrom('accounts').select('email').withPlugin(replay(leak)).execute()).rejects.toThrow('password');
      await expect(db.insertInto('users').values({ name: 'Ada', email: 'a@example.com' }).withPlugin(replay(write)).execute()).rejects.toThrow('changed the tables it writes');
      expect(await db.selectFrom('accounts').select('id').execute()).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('sees a write a plugin hides in a common table expression, and a table of another schema', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await new AccountRepository(connections).insert({ email: 'ada@example.com', password: HASH });
      const gone = db.deleteFrom('accounts').returning('id').toOperationNode();
      const cte: KyselyPlugin = {
        transformQuery: ({ node }) => ({ ...(node as SelectQueryNode), with: WithNode.create(CommonTableExpressionNode.create(CommonTableExpressionNameNode.create('gone'), gone as never)) }),
        transformResult: async ({ result }) => result,
      };
      const schemed: KyselyPlugin = {
        transformQuery: ({ node }) => ({ ...(node as InsertQueryNode), into: TableNode.createWithSchema('other', 'users') }),
        transformResult: async ({ result }) => result,
      };
      await expect(db.selectFrom('users').select('id').withPlugin(cte).execute()).rejects.toThrow('changed the tables it writes');
      await expect(db.insertInto('users').values({ name: 'Ada', email: 'a@example.com' }).withPlugin(schemed).execute()).rejects.toThrow('changed the tables it writes');
      expect(await db.selectFrom('accounts').select('id').execute()).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('cannot be changed in place after the check', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      await new AccountRepository(connections).insert({ email: 'ada@example.com', password: HASH });
      const inPlace: KyselyPlugin = {
        transformQuery: ({ node }) => {
          const update = node as UpdateQueryNode;
          (update.updates as ColumnUpdateNode[])[0] = ColumnUpdateNode.create(ColumnNode.create('email'), RawNode.create(['(select password from accounts)'], []));
          return node;
        },
        transformResult: async ({ result }) => result,
      };
      await db.insertInto('users').values({ name: 'a', email: 'a@example.com' }).execute();
      // Kysely leaves the array of the first set() open; the plugin gets the node as it was checked.
      await expect(db.updateTable('users').set({ name: 'b' }).withPlugin(inPlace).execute()).rejects.toThrow(TypeError);
      expect(await db.selectFrom('users').select('email').execute()).toEqual([{ email: 'a@example.com' }]);
    } finally {
      await close();
    }
  });

  it('refuses an explain format that is not a plain identifier', async () => {
    const { connections, close } = await freshConnections(driver);
    try {
      await migrator(connections).migrate();
      const db = connections.get<AccountTables>();
      const explained = (format: string): KyselyPlugin => ({
        transformQuery: ({ node }) => ({ ...(node as SelectQueryNode), explain: ExplainNode.create(format as 'json') }),
        transformResult: async ({ result }) => result,
      });
      await expect(db.selectFrom('users').select('id').withPlugin(explained('json) select 1 --')).execute()).rejects.toThrow('no plain identifier');
    } finally {
      await close();
    }
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
  type Account = RowOf<AccountTables['accounts']>;
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
  const login = await repository.findForSignIn('ada@example.com');
  expectTypeOf(login).toEqualTypeOf<{ id: number; password: string } | undefined>();
  // …and only for secret columns of tables in scope.
  // @ts-expect-error — `email` is not secret: select it as usual
  accountsDb.selectFrom('accounts').select((eb) => secret(eb, 'email'));
  // @ts-expect-error — `accounts` is not in this query
  accountsDb.selectFrom('users').select((eb) => secret(eb, 'accounts.password'));

  // Comparing one takes `secretEquals()`: the operand of `where()` has no value to compare.
  // @ts-expect-error — a secret column cannot be an operand of where()
  accountsDb.selectFrom('accounts').select('id').where('password', '=', 'hash');
  const hashed = accountsDb.selectFrom('accounts').select('id').where((eb) => secretEquals(eb, 'password', 'hash'));
  expectTypeOf(await hashed.executeTakeFirst()).toEqualTypeOf<{ id: number } | undefined>();
  accountsDb.deleteFrom('accounts').where((eb) => secretEquals(eb, 'accounts.password', 'hash'));
  // @ts-expect-error — `email` is not secret: compare it with where()
  accountsDb.selectFrom('accounts').select('id').where((eb) => secretEquals(eb, 'email', 'ada@example.com'));
  // @ts-expect-error — the value is the column's type
  accountsDb.selectFrom('accounts').select('id').where((eb) => secretEquals(eb, 'password', 42));

  // Kysely's `selectAll()` type keeps the key as `never` (the runtime drops it).
  const all = await accountsDb.selectFrom('accounts').selectAll().executeTakeFirstOrThrow();
  expectTypeOf(all.password).toEqualTypeOf<never>();
}
