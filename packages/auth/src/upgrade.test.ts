import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConsoleLogger, createApplication, HealthChecks, Logger, SystemClock, type Application, type Container, type ModuleDefinition, type Logger as LoggerType } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider, MakeUpgradeMigrationsCommand, Migrator, sql, type ConnectionOptions, type Migration } from '@marmeon/database';
import { runMigration, SchemaRequirements } from '@marmeon/database/internal';
import { AesGcmEncrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import type { CommandInput } from 'marmeon';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { PASSKEY_COLUMNS, PASSKEYS_TABLE } from './passkeys/store.ts';
import { PasskeyServiceProvider } from './passkeys/provider.ts';
import { PGSQL_URL } from './__fixtures__/databases.ts';
import { AuthServiceProvider, AccessTokenStore, combineFactors, DatabaseEmailChanges, DatabaseSignIns, EmailChangeStore, SignInStore, TwoFactorState, TwoFactorStore, UserProvider } from './index.ts';
import { factorSources, NoTwoFactorState } from './two-factor/state.ts';
import { REMEMBER_TOKENS_DROP_MIGRATION, SESSION_KEYS_MIGRATION, SIGN_INS_REMEMBER_MIGRATION, TOKENS_REISSUE_MIGRATION } from './upgrades.ts';

const silent: LoggerType = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

/** The migrations the first stubs wrote (and the users table they point at), as apps have them. */
const LEGACY = new URL('./__fixtures__/legacy/', import.meta.url);
/** The migration `make:upgrade-migrations` writes, as the package ships it. */
const UPGRADE = new URL('./__fixtures__/upgrade/', import.meta.url);
/** The migrations of the starter kit as `make:auth` writes them now. */
const KIT = new URL('../stubs/react/modules/auth/migrations/', import.meta.url);

const TABLES = ['remember_tokens', 'password_reset_tokens', 'personal_access_tokens', 'two_factor_authentications', 'two_factor_recovery_codes', 'passkeys', 'sign_ins'] as const;
/** The tables of an app that took every upgrade: `remember_tokens` is gone. */
const TABLES_UPGRADED = TABLES.filter((table) => table !== 'remember_tokens');
/** The columns marked `.secret()`. */
const SECRETS: Record<string, readonly string[]> = {
  remember_tokens: ['previous_validator_hash', 'validator_hash'],
  password_reset_tokens: ['token_hash'],
  personal_access_tokens: ['token_hash'],
  two_factor_authentications: ['secret'],
  two_factor_recovery_codes: ['code_hash'],
};
/** The secret columns of `sign_ins` after the upgrade: the selector is made again, as a secret, and the validators are new. */
const REMEMBER_SECRETS = ['sign_ins.remember_previous_validator_hash', 'sign_ins.remember_selector', 'sign_ins.remember_validator_hash'];

const load = async (file: URL) => ((await import(file.href)) as { default: Migration }).default;
const filesOf = (directory: URL) => readdirSync(directory).filter((file) => file.endsWith('.ts')).sort();
const loadAll = async (directory: URL) => Promise.all(filesOf(directory).map((file) => load(new URL(file, directory))));

/** Everything a table is known by: columns, and the names of indexes and constraints, by their full names. */
async function describeTable(connections: Connections, name: string) {
  const db = connections.get<any>();
  const introspected = await db.introspection.getTables();
  // Sorted: an upgrade that makes a column again (as a secret) puts it last, and a table is the same whatever the order.
  const columns = introspected.find((table: { name: string }) => table.name === name)!.columns.map((column: { name: string; dataType: string; isNullable: boolean }) => `${column.name}:${column.dataType}:${column.isNullable}`).sort();
  const names = async (query: ReturnType<typeof sql<{ name: string }>>) => (await query.execute(db)).rows.map((row) => row.name).sort();
  if (connections.options().driver === 'sqlite') {
    return { columns, indexes: await names(sql<{ name: string }>`select name from sqlite_master where type = 'index' and tbl_name = ${name} and name not like 'sqlite_autoindex%'`) };
  }
  const table = sql`t.relname = ${name} and t.relnamespace = (select oid from pg_namespace where nspname = current_schema())`;
  return {
    columns,
    indexes: await names(sql<{ name: string }>`select i.relname as name from pg_index x join pg_class t on t.oid = x.indrelid join pg_class i on i.oid = x.indexrelid where ${table}`),
    constraints: await names(sql<{ name: string }>`select c.conname as name from pg_constraint c join pg_class t on t.oid = c.conrelid where ${table}`),
    sequences: await names(sql<{ name: string }>`select s.relname as name from pg_class s join pg_depend d on d.objid = s.oid and d.deptype in ('a', 'i') join pg_class t on t.oid = d.refobjid where s.relkind = 'S' and ${table}`),
  };
}

const kinds: readonly ('sqlite' | 'pgsql')[] = ['sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : [])];

const connect = (options: ConnectionOptions, managed: boolean) => new Connections({ connections: { default: { ...options, managed } }, root: '/', logger: silent });

/** An empty database: a file of its own, or a new Postgres database. */
async function open(kind: 'sqlite' | 'pgsql', managed = false) {
  if (kind === 'sqlite') {
    const connections = connect({ driver: 'sqlite', database: join(tempDir('marmeon-auth-upgrade-'), 'app.sqlite') }, managed);
    return { connections, drop: async () => connections.destroy() };
  }
  const name = `marmeon_auth_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = connect({ driver: 'pgsql', url: PGSQL_URL! }, false);
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  const connections = connect({ driver: 'pgsql', url: url.href, poolMax: 2 }, managed);
  return {
    connections,
    drop: async () => {
      await connections.destroy();
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
      await admin.destroy();
    },
  };
}

const KEY = generateKey();
const encrypter = new AesGcmEncrypter(Buffer.from(KEY.replace('base64:', ''), 'base64'));
/** What `TwoFactor` binds a secret to: the account, not the table. */
const TOTP_CONTEXT = 'marmeon-auth:two-factor:1';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** One account with a row in each of the old tables. */
async function seed(connections: Connections): Promise<void> {
  const db = connections.get<any>();
  const secretOfTheAuthenticator = await encrypter.encrypt('JBSWY3DPEHPK3PXP', TOTP_CONTEXT);
  await sql`insert into users (name, email, password, created_at, updated_at) values ('Ada', 'ada@example.com', '$argon2id$stored', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db);
  await sql`insert into remember_tokens (user_id, selector, validator_hash, expires_at, account_fingerprint, created_at, updated_at)
    values (1, 'selector', 'validator-hash', '2027-01-01 00:00:00', 'fingerprint', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db);
  await sql`insert into password_reset_tokens (email, token_hash, created_at) values ('ada@example.com', 'reset-hash', '2026-01-01 00:00:00')`.execute(db);
  await sql`insert into personal_access_tokens (user_id, name, token_hash, abilities, created_at, updated_at)
    values (1, 'cli', 'access-hash', ${JSON.stringify(['*'])}, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db);
  await sql`insert into two_factor_authentications (user_id, secret, confirmed_at, last_used_step, created_at, updated_at)
    values (1, ${secretOfTheAuthenticator}, '2026-01-01 00:00:00', 100, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db);
  await sql`insert into two_factor_recovery_codes (user_id, code_hash, created_at, updated_at) values (1, ${sha256('recovery-code')}, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db);
  await sql`insert into passkeys (user_id, user_handle, credential_id, public_key, algorithm, sign_count, transports, aaguid, backup_eligible, backed_up, name, created_at, updated_at)
    values (1, 'handle', 'credential', 'public-key', -7, 5, ${JSON.stringify(['internal'])}, 'aaguid', ${sql.lit(false)}, ${sql.lit(false)}, 'Laptop', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db);
  await sql`insert into sign_ins (id, user_id, user_agent, signed_in_at, last_seen_at, created_at, updated_at)
    values ('abcdefghijklmnopqrstuv', 1, 'Browser', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db);
}

describe.each(kinds)('the reissue of the API tokens on %s', (kind) => {
  it('leaves a database made with the first stubs identical to one made with the current ones: the API tokens, the sign-ins and remember_tokens go', async () => {
    const fresh = await open(kind);
    const old = await open(kind);
    try {
      // `fresh` was made by the kit as it is now; `old` by the first stubs, with an account that has every row.
      for (const migration of await loadAll(KIT)) await runMigration(fresh.connections, migration);
      for (const migration of await loadAll(LEGACY)) await runMigration(old.connections, migration);
      await seed(old.connections);
      const before = Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, await describeTable(old.connections, table)])));

      const reissue = await load(new URL(`${UPGRADE.href}2026_02_01_000002_reissue_personal_access_tokens.ts`));
      const remember = await load(new URL(`${UPGRADE.href}2026_02_01_000003_add_remember_columns_to_sign_ins.ts`));
      const dropped = await load(new URL(`${UPGRADE.href}2026_02_01_000004_drop_remember_tokens_table.ts`));
      await runMigration(old.connections, reissue);
      await runMigration(old.connections, remember);
      await runMigration(old.connections, dropped);
      const db = old.connections.get<any>();
      const tableNames = async (connections: Connections) => (await connections.get<any>().introspection.getTables()).map((table: { name: string }) => table.name);
      expect(await tableNames(old.connections), 'the remember-me tokens live on the sign-ins now').not.toContain('remember_tokens');
      expect(await tableNames(fresh.connections)).not.toContain('remember_tokens');
      for (const table of TABLES_UPGRADED) {
        expect(await describeTable(old.connections, table), table).toEqual(await describeTable(fresh.connections, table));
        if (table !== 'personal_access_tokens' && table !== 'sign_ins') expect(await describeTable(old.connections, table), `${table} is untouched`).toEqual(before[table]);
        const { rows } = await sql<{ n: number | string }>`select count(*) as n from ${sql.table(table)}`.execute(old.connections.get());
        // The API tokens of the first release and the sign-ins (their remember-me selectors are made again) are what the upgrade deletes.
        expect(Number(rows[0]!.n), `rows of ${table}`).toBe(table === 'personal_access_tokens' || table === 'sign_ins' ? 0 : 1);
      }
      expect((await sql<{ token_hash: string }>`select token_hash from password_reset_tokens`.execute(db)).rows).toEqual([{ token_hash: 'reset-hash' }]);
      expect((await sql<{ token_hash: string }>`select token_hash from personal_access_tokens`.execute(db)).rows).toEqual([]);
      expect((await sql<{ name: string }>`select name from passkeys`.execute(db)).rows).toEqual([{ name: 'Laptop' }]);
      // The table of the app stays the app's.
      expect((await sql<{ email: string }>`select email from users`.execute(db)).rows).toEqual([{ email: 'ada@example.com' }]);

      // The table of the tokens comes back empty in the other direction, as the first stubs made it.
      await runMigration(old.connections, dropped, { direction: 'down' });
      expect(await describeTable(old.connections, 'remember_tokens'), 'down restores the table').toEqual(before.remember_tokens);
      await runMigration(old.connections, remember, { direction: 'down' });
      expect(await describeTable(old.connections, 'sign_ins'), 'down restores the sign-ins').toEqual(before.sign_ins);
      await runMigration(old.connections, reissue, { direction: 'down' });
      expect(await describeTable(old.connections, 'personal_access_tokens'), 'down restores the table').toEqual(before.personal_access_tokens);
    } finally {
      await fresh.drop();
      await old.drop();
    }
  });

  it('ends every sign-in and leaves no remember-me token that could sign anybody in: a cookie of the old table finds nothing', async () => {
    const old = await open(kind);
    try {
      for (const migration of await loadAll(LEGACY)) await runMigration(old.connections, migration);
      await seed(old.connections);
      const db = old.connections.get<any>();
      // The sign-in of the seeded account says it is kept signed in, as the first release recorded it.
      await sql`update sign_ins set remember_selector = 'selector', remember_until = '2027-01-01 00:00:00'`.execute(db);
      for (const file of ['2026_02_01_000003_add_remember_columns_to_sign_ins.ts', '2026_02_01_000004_drop_remember_tokens_table.ts']) await runMigration(old.connections, await load(new URL(file, UPGRADE)));
      expect((await sql`select * from sign_ins`.execute(db)).rows, 'no sign-in survives, none is listed as kept signed in').toEqual([]);
      const signIns = new DatabaseSignIns(old.connections, new SystemClock());
      expect(await signIns.consume(`${'selector'.padEnd(22, 'x')}.${'v'.repeat(43)}`), 'a cookie of the old table finds nothing').toMatchObject({ ok: false, error: { kind: 'invalid' } });
      const id = await signIns.create({ userId: 1, userAgent: 'Browser' });
      const cookie = await signIns.issueToken(1, id, { until: new Date(Date.now() + 86_400_000), fingerprint: 'fp' });
      expect(await signIns.consume(cookie), 'and a sign-in made now works').toMatchObject({ ok: true, value: { userId: 1, signIn: id } });
      await expect(sql`insert into sign_ins (id, user_id, remember_selector, signed_in_at, last_seen_at, created_at, updated_at) values ('second-sign-in-id-xxxxxx', 1, ${cookie.split('.')[0]}, '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db), 'the selector stays unique').rejects.toThrow();
    } finally {
      await old.drop();
    }
  });

  it("makes a hash one token's alone, and gives it back in the other direction", async () => {
    const old = await open(kind);
    try {
      for (const migration of await loadAll(LEGACY)) await runMigration(old.connections, migration);
      await seed(old.connections);
      const reissue = await load(TOKENS_REISSUE_MIGRATION);
      await runMigration(old.connections, reissue);
      const db = old.connections.get<any>();
      const count = async (table: string) => Number((await sql<{ n: number | string }>`select count(*) as n from ${sql.table(table)}`.execute(db)).rows[0]!.n);
      const insert = sql`insert into personal_access_tokens (user_id, name, token_hash, abilities, created_at, updated_at) values (1, 'cli', 'same-hash', ${JSON.stringify(['*'])}, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`;
      await insert.execute(db);
      await expect(insert.execute(db)).rejects.toThrow();
      await runMigration(old.connections, reissue, { direction: 'down' });
      await insert.execute(db);
      expect(await count('personal_access_tokens')).toBe(2);
    } finally {
      await old.drop();
    }
  });
});

describe.each(kinds)('the random session keys of accounts that have none, on %s', (kind) => {
  it('gives every NULL key its own random value, with the database\'s generator, and leaves a key that is there alone', async () => {
    const database = await open(kind);
    try {
      for (const migration of await loadAll(KIT)) await runMigration(database.connections, migration);
      const db = database.connections.get<any>();
      for (const n of [1, 2, 3]) {
        await sql`insert into users (name, email, password, created_at, updated_at) values (${`User ${n}`}, ${`user${n}@example.com`}, 'hash', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(db);
      }
      await sql`update users set session_key = ${'k'.repeat(43)} where id = 3`.execute(db);
      await runMigration(database.connections, await load(SESSION_KEYS_MIGRATION));
      const keys = (await sql<{ id: number; session_key: string }>`select id, session_key from users order by id`.execute(db)).rows;
      expect(keys[2]!.session_key, 'a key that was there').toBe('k'.repeat(43));
      const filled = keys.slice(0, 2).map((row) => row.session_key);
      for (const key of filled) expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set(filled).size, 'one for each row').toBe(2);
    } finally {
      await database.drop();
    }
  });
});


describe.each(kinds)('the secret columns across the reissue, on %s', (kind) => {
  const modules = (...directories: URL[]) => directories.map((migrations, index) => ({ name: `part${index}`, migrations }));
  const migrator = (connections: Connections, ...directories: URL[]) => new Migrator({ modules: modules(...directories), root: '/' } as unknown as Application, connections);
  /** The secret columns the connections hide: what the migrations that ran say. */
  const marked = async (connections: Connections) => [...connections.metadata().secrets].flatMap(([table, columns]) => [...columns].map((column) => `${table}.${column}`)).sort();
  const expected = ['users.password', 'users.pending_email_token', 'users.session_key', ...Object.entries(SECRETS).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`))].sort();
  const expectedUpgraded = [...expected.filter((column) => !column.startsWith('remember_tokens.')), ...REMEMBER_SECRETS].sort();
  /** Every row of the table as `selectAll()` gives it: the columns it names. */
  const columnsOf = async (connections: Connections, table: string) => Object.keys(await connections.get<any>().selectFrom(table).selectAll().executeTakeFirstOrThrow()).sort();

  it('stay marked in both directions: selectAll() and relations never return them, before, after and after going back', async () => {
    const { connections, drop } = await open(kind, true);
    try {
      await migrator(connections, LEGACY).migrate();
      await seed(connections);
      expect(await marked(connections)).toEqual(expected);
      const withoutSecrets = async (upgraded = false) => {
        for (const [table, columns] of Object.entries(SECRETS).filter(([table]) => !upgraded || table !== 'remember_tokens')) {
          const keys = await columnsOf(connections, table);
          for (const column of columns) expect(keys, `${table}.${column}`).not.toContain(column);
          expect(keys.length, table).toBeGreaterThan(1);
        }
        // A relation of the account loads none of them either.
        const query: any = connections.get<any>().selectFrom('users').select('email');
        const relations = upgraded ? query.with('personal_access_tokens').with('two_factor_recovery_codes') : query.with('personal_access_tokens').with('remember_tokens').with('two_factor_recovery_codes');
        const [ada] = (await relations.execute()) as Record<string, any>[];
        const hidden = [['personal_access_tokens', 'token_hash'], ...(upgraded ? [] : [['remember_tokens', 'validator_hash'], ['remember_tokens', 'previous_validator_hash']]), ['two_factor_recovery_codes', 'code_hash']] as const;
        for (const [table, column] of hidden) {
          expect(ada![table], table).toHaveLength(1);
          expect(ada![table][0], `${table}.${column}`).not.toHaveProperty(column);
        }
      };
      await withoutSecrets();

      await migrator(connections, LEGACY, UPGRADE).migrate();
      expect(await marked(connections)).toEqual(expectedUpgraded);
      // The sign-ins were deleted by the upgrade; one made since stands in their place.
      await sql`insert into sign_ins (id, user_id, user_agent, signed_in_at, last_seen_at, created_at, updated_at)
        values ('abcdefghijklmnopqrstuv', 1, 'Browser', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(connections.get());
      for (const column of ['remember_selector', 'remember_validator_hash', 'remember_previous_validator_hash']) {
        expect(await columnsOf(connections, 'sign_ins'), `${column} never comes back from selectAll()`).not.toContain(column);
      }
      // The token of the first release is gone; one issued since stands in its place.
      await sql`insert into personal_access_tokens (user_id, name, token_hash, abilities, created_at, updated_at)
        values (1, 'cli', 'new-hash', ${JSON.stringify(['*'])}, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(connections.get());
      await withoutSecrets(true);

      await migrator(connections, LEGACY, UPGRADE).rollback({ steps: 2 });
      expect(await marked(connections)).toEqual(expected);
      // The table comes back empty: a token of the first release is not brought back.
      await sql`insert into remember_tokens (user_id, selector, validator_hash, expires_at, account_fingerprint, created_at, updated_at)
        values (1, 'selector', 'validator-hash', '2027-01-01 00:00:00', 'fingerprint', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`.execute(connections.get());
      await withoutSecrets();
    } finally {
      await drop();
    }
  });

  it("keeps the authenticator's secret and a recovery code working: the secret is bound to the account, not to the table", async () => {
    const { connections, drop } = await open(kind, true);
    try {
      await migrator(connections, LEGACY).migrate();
      await seed(connections);
      await migrator(connections, LEGACY, UPGRADE).migrate();
      const store = new TwoFactorStore(connections, new SystemClock());
      const found = await store.find(1);
      expect(found).toMatchObject({ confirmed: true, lastUsedStep: 100 });
      expect(await encrypter.decrypt(found!.encryptedSecret, TOTP_CONTEXT)).toBe('JBSWY3DPEHPK3PXP');
      expect(await store.factors(1)).toEqual(['totp']);
      expect(await store.consumeRecoveryCode(1, sha256('recovery-code'))).toBe(0);
      expect(await store.consumeRecoveryCode(1, sha256('recovery-code')), 'a code works once').toBeUndefined();
    } finally {
      await drop();
    }
  });
});

describe('a database that lacks the auth tables', () => {
  const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory' };
  const providers = [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider];
  const open = (more: Record<string, string> = {}, wire: (container: Container) => void = () => {}, extra: (typeof AuthServiceProvider | typeof PasskeyServiceProvider)[] = [], modules: ModuleDefinition[] = []) =>
    createApplication(
      { root: '/tmp', discover: false, providers: [...providers, ...extra], modules },
      {
        env: { ...env, ...more },
        override: (container) => {
          container.instance(Logger, silent);
          wire(container);
        },
      },
    );
  const signedIn = (container: Container) => container.instance(UserProvider, {} as UserProvider);
  const required = async (application: Application) => application.container.make(SchemaRequirements).all().map((requirement) => requirement.table).sort();

  it('makes /up/ready red until the migrations ran, and says what to run for each table the app uses', async () => {
    await using application = await open({}, (container) => {
      signedIn(container);
      container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore)));
    });
    await application.container.make(Migrator).migrate();
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
    expect(messages.join('\n')).not.toContain('remember_tokens');
    for (const table of ['password_reset_tokens', 'personal_access_tokens', 'sign_ins', 'two_factor_authentications', 'two_factor_recovery_codes']) {
      expect(messages.join('\n'), table).toContain(`${table} is missing`);
    }
    expect(messages.join('\n')).toMatch(/run marmeon make:upgrade-migrations, then marmeon migrate$/);
  });

  it('is green once the migrations of the first stubs and the reissue ran', async () => {
    await using application = await open(
      {},
      (container) => {
        signedIn(container);
        container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore)));
      },
      [],
      [{ name: 'legacy', migrations: LEGACY }, { name: 'upgrade', migrations: UPGRADE }],
    );
    await application.container.make(Migrator).migrate();
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []))).toEqual([]);
  });

  it('waits for no table of an app that set up no authentication', async () => {
    await using application = await open();
    expect(await required(application)).toEqual([]);
  });

  it('waits for the tables of the default stores once authentication is set up, and for the second factor only when it is bound', async () => {
    await using plain = await open({}, signedIn);
    expect(await required(plain)).toEqual(['password_reset_tokens', 'personal_access_tokens', 'sign_ins']);

    await using full = await open({}, (container) => {
      signedIn(container);
      container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore), c.make(NoTwoFactorState)));
    });
    expect(await required(full)).toEqual([
      'password_reset_tokens',
      'personal_access_tokens',
      'sign_ins',
      'two_factor_authentications',
      'two_factor_recovery_codes',
    ]);
  });

  it('waits for email_changes only once the database store of the changes of address is bound, and is red while the table is missing', async () => {
    await using plain = await open({}, signedIn);
    expect(await required(plain), 'opt-in: the package binds no store').not.toContain('email_changes');
    await using application = await open({}, (container) => {
      signedIn(container);
      container.singleton(EmailChangeStore, DatabaseEmailChanges);
    });
    expect(await required(application)).toContain('email_changes');
    expect(application.container.make(SchemaRequirements).all().find((requirement) => requirement.table === 'email_changes')?.secrets, 'the token hash is a secret column').toEqual(['session_key', 'token_hash']);
    await application.container.make(Migrator).migrate();
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n')).toContain('email_changes is missing');
  });

  it('leaves out the table of a store the app replaced, and keeps the sign-ins table although remember-me is off', async () => {
    class OwnSignIns {}
    await using own = await open({ AUTH_REMEMBER_DAYS: '0' }, signedIn);
    expect(await required(own), 'a sign-in is a row whether or not it is remembered').toEqual(['password_reset_tokens', 'personal_access_tokens', 'sign_ins']);
    await using replaced = await open({}, (container) => {
      signedIn(container);
      container.singleton(SignInStore, OwnSignIns as never);
    });
    expect(await required(replaced)).toEqual(['password_reset_tokens', 'personal_access_tokens']);
  });

  it('boots with a store of its own that depends on something scoped, and waits for no table of it', async () => {
    class ScopedTokens {}
    await using application = await open({}, (container) => {
      signedIn(container);
      container.scoped(AccessTokenStore, ScopedTokens as never);
      container.scoped(SignInStore, ScopedTokens as never);
    });
    expect(await required(application)).toEqual(['password_reset_tokens']);
  });

  it('makes /up/ready red while a column that holds a secret lacks its mark, as in a table made by an older migration', async () => {
    await using application = await open({ AUTH_REMEMBER_DAYS: '0' }, signedIn);
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await runMigration(connections, {
      up: (schema) => {
        schema.create('password_reset_tokens', (table) => {
          table.string('email').primary();
          table.string('token_hash', 64);
          table.timestamp('created_at');
        });
        schema.create('personal_access_tokens', (table) => {
          table.id();
          table.integer('user_id').nullable();
          table.string('name').nullable();
          table.string('token_hash', 64).nullable();
          table.text('abilities').nullable();
          table.timestamp('last_used_at').nullable();
          table.timestamp('expires_at').nullable();
          table.timestamp('created_at').nullable();
          table.timestamp('updated_at').nullable();
        });
      },
    });
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    expect(messages).toContain('password_reset_tokens has token_hash without the secret() mark');
    expect(messages).toContain('personal_access_tokens has token_hash without the secret() mark');
  });

  it('makes /up/ready red while sign_ins has no columns for the remember-me token, and says which command writes them', async () => {
    await using application = await open({ AUTH_REMEMBER_DAYS: '0' }, signedIn, [], [{ name: 'legacy', migrations: LEGACY }]);
    await application.container.make(Migrator).migrate();
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    expect(messages).toContain('sign_ins');
    expect(messages).toContain('remember_validator_hash');
    expect(messages).toContain('remember_fingerprint');
    expect(messages).toContain('make:upgrade-migrations');
  });

  it('makes /up/ready red while the selector and the validators of sign_ins lack their secret() mark, as in a table of the first stubs', async () => {
    await using application = await open({ AUTH_REMEMBER_DAYS: '0' }, signedIn);
    await application.container.make(Migrator).migrate();
    await runMigration(application.container.make(Connections), {
      up: (schema) => {
        schema.create('sign_ins', (table) => {
          table.string('id', 22).primary();
          table.integer('user_id');
          table.string('user_agent', 255).nullable();
          table.string('remember_selector', 32).nullable().unique();
          table.timestamp('remember_until').nullable();
          table.string('remember_validator_hash', 64).nullable();
          table.string('remember_previous_validator_hash', 64).nullable();
          table.timestamp('remember_rotated_at').nullable();
          table.timestamp('remember_created_at').nullable();
          table.string('remember_fingerprint', 64).nullable();
          table.timestamp('signed_in_at');
          table.timestamp('last_seen_at');
          table.timestamps();
        });
      },
    });
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    expect(messages).toContain('sign_ins has remember_selector, remember_validator_hash, remember_previous_validator_hash without the secret() mark');
  });

  it('makes /up/ready red while only the selector of sign_ins lacks its secret() mark: a table that took the columns of the remember-me token before the selector became a secret', async () => {
    await using application = await open({}, signedIn);
    await application.container.make(Migrator).migrate();
    await runMigration(application.container.make(Connections), {
      up: (schema) => {
        schema.create('sign_ins', (table) => {
          table.string('id', 22).primary();
          table.integer('user_id');
          table.string('user_agent', 255).nullable();
          table.string('remember_selector', 32).nullable().unique();
          table.timestamp('remember_until').nullable();
          table.string('remember_validator_hash', 64).nullable().secret();
          table.string('remember_previous_validator_hash', 64).nullable().secret();
          table.timestamp('remember_rotated_at').nullable();
          table.timestamp('remember_created_at').nullable();
          table.string('remember_fingerprint', 64).nullable();
          table.timestamp('signed_in_at');
          table.timestamp('last_seen_at');
          table.timestamps();
        });
      },
    });
    const report = await application.container.make(HealthChecks).run(application.container);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    expect(messages).toContain('sign_ins has remember_selector without the secret() mark');
    expect(messages).toContain('make:upgrade-migrations');
  });

  it('waits for the passkeys table when the passkeys are switched on', async () => {
    await using application = await open({ APP_URL: 'http://localhost:3000' }, () => {}, [PasskeyServiceProvider]);
    expect(await required(application)).toEqual([PASSKEYS_TABLE]);
    expect(PASSKEY_COLUMNS).toContain('suspended_at');
  });
});

describe('the sources of a second factor', () => {
  it('are found through every combination, down to the stores', () => {
    const a = new NoTwoFactorState();
    const b = new NoTwoFactorState();
    const c = new NoTwoFactorState();
    expect(factorSources(a)).toEqual([a]);
    expect(factorSources(combineFactors(a, combineFactors(b, c)))).toEqual([a, b, c]);
  });
});

describe('the revision the auth tables list', () => {
  it('lists the auth set up to revision 4 and the sign-ins set at revision 2, for apps that created these tables with the first stubs', () => {
    const upgrades = AuthServiceProvider.migrationUpgrades;
    expect(upgrades.map(({ set, revision, name, createdBy }) => ({ set, revision, name, createdBy }))).toEqual([
      { set: 'auth', revision: 2, name: 'reissue_personal_access_tokens', createdBy: ['create_personal_access_tokens_table'] },
      { set: 'auth', revision: 3, name: 'fill_empty_session_keys', createdBy: ['create_personal_access_tokens_table', 'create_users_table'] },
      { set: 'auth', revision: 4, name: 'drop_remember_tokens_table', createdBy: ['create_remember_tokens_table'] },
      { set: 'sign-ins', revision: 2, name: 'add_remember_columns_to_sign_ins', createdBy: ['create_sign_ins_table'] },
    ]);
    expect(upgrades[0]!.contents).toBe(readFileSync(TOKENS_REISSUE_MIGRATION, 'utf8'));
    expect(upgrades[0]!.contents).toMatch(/^\/\/ @marmeon-stub auth 2\n/);
    expect(upgrades[1]!.contents).toBe(readFileSync(SESSION_KEYS_MIGRATION, 'utf8'));
    expect(upgrades[1]!.contents).toMatch(/^\/\/ @marmeon-stub auth 3\n/);
    expect(upgrades[2]!.contents).toBe(readFileSync(REMEMBER_TOKENS_DROP_MIGRATION, 'utf8'));
    expect(upgrades[2]!.contents).toMatch(/^\/\/ @marmeon-stub auth 4\n/);
    expect(upgrades[3]!.contents).toBe(readFileSync(SIGN_INS_REMEMBER_MIGRATION, 'utf8'));
    expect(upgrades[3]!.contents).toMatch(/^\/\/ @marmeon-stub sign-ins 2\n/);
  });

  it('is what the first stubs and the stubs now say: no mark (revision 1) before, revision 4 after, and the plain names in both', () => {
    for (const file of filesOf(LEGACY).filter((name) => !name.includes('users'))) {
      expect(readFileSync(new URL(file, LEGACY), 'utf8'), file).not.toMatch(/^\/\/ @marmeon-stub/);
    }
    for (const file of filesOf(KIT).filter((name) => !name.includes('users'))) {
      const contents = readFileSync(new URL(file, KIT), 'utf8');
      expect(contents, file).toMatch(file.includes('sign_ins') ? /^\/\/ @marmeon-stub sign-ins 2\n/ : /^\/\/ @marmeon-stub auth 4\n/);
      expect(contents, file).not.toContain('marmeon_');
    }
    const signIns = readFileSync(new URL('../stubs/migrations/create_sign_ins_table.ts', import.meta.url), 'utf8');
    expect(signIns).toMatch(/^\/\/ @marmeon-stub sign-ins 2\n/);
    expect(signIns).toContain("'remember_validator_hash', 64).nullable().secret()");
    expect(signIns, 'the selector finds a row by a secret of the cookie').toContain("'remember_selector', 32).nullable().secret().unique()");
    expect(filesOf(KIT).filter((name) => name.includes('remember_tokens')), 'new apps have no table of remember-me tokens').toEqual([]);
    expect(signIns).toContain("schema.create('sign_ins'");
  });
});

describe('marmeon make:upgrade-migrations for the auth tables', () => {
  const MODULE = "import { defineModule } from '@marmeon/core';\n\nexport default defineModule({ name: 'auth', migrations: new URL('./migrations/', import.meta.url) });\n";
  /** An app whose `auth` module holds the given migrations. */
  function appWith(directory: URL): { root: string; files: () => string[] } {
    const root = tempDir('marmeon-auth-upgrade-app-');
    const migrations = join(root, 'modules/auth/migrations');
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(root, 'modules/auth/index.ts'), MODULE);
    for (const file of filesOf(directory)) copyFileSync(new URL(file, directory), join(migrations, file));
    return { root, files: () => readdirSync(migrations).sort() };
  }
  const run = (root: string, options: Record<string, unknown> = {}) => {
    const push = () => {};
    const output = { success: push, warn: push, error: push, line: push };
    return new MakeUpgradeMigrationsCommand({ providers: [AuthServiceProvider] } as unknown as Application).handle({ root, args: [], options, output } as unknown as CommandInput);
  };

  it('writes the reissue, the session keys, the end of remember_tokens and the remember-me columns, and nothing else, for an app made with the first stubs', () => {
    const { root, files } = appWith(LEGACY);
    const before = files();
    expect(run(root, { check: true }), '--check before').toBe(1);
    expect(run(root)).toBe(0);
    const written = files().filter((file) => !before.includes(file));
    expect(written).toHaveLength(4);
    const contents = (pattern: RegExp) => readFileSync(join(root, 'modules/auth/migrations', written.find((file) => pattern.test(file))!), 'utf8');
    expect(contents(/reissue/)).toBe(readFileSync(TOKENS_REISSUE_MIGRATION, 'utf8'));
    expect(contents(/fill_empty_session_keys/)).toBe(readFileSync(SESSION_KEYS_MIGRATION, 'utf8'));
    expect(contents(/drop_remember_tokens/)).toBe(readFileSync(REMEMBER_TOKENS_DROP_MIGRATION, 'utf8'));
    expect(contents(/add_remember_columns/)).toBe(readFileSync(SIGN_INS_REMEMBER_MIGRATION, 'utf8'));
    expect(run(root, { check: true }), '--check after').toBe(0);
  });

  it('writes nothing for an app made with the stubs now', () => {
    const { root, files } = appWith(KIT);
    const before = files();
    expect(run(root, { check: true })).toBe(0);
    expect(run(root)).toBe(0);
    expect(files()).toEqual(before);
  });
});

describe('the migrations in the apps', () => {
  const repo = new URL('../../../', import.meta.url);
  const migrationsOf = (directory: string) => readdirSync(new URL(directory, repo)).filter((file) => /(remember|password_reset|personal_access|two_factor|passkeys|sign_ins|auth_tables)/.test(file));

  it("the web app's tables come from the first stubs and the upgrades, the blank app's and the starter's have none", () => {
    const web = 'apps/web-app/modules/auth/migrations/';
    const files = migrationsOf(web);
    const reissue = files.filter((file) => /reissue/.test(file));
    const remember = files.filter((file) => /add_remember_columns/.test(file));
    const dropped = files.filter((file) => /drop_remember_tokens_table/.test(file));
    expect(reissue).toEqual([expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_reissue_personal_access_tokens\.ts$/)]);
    expect(remember).toEqual([expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_add_remember_columns_to_sign_ins\.ts$/)]);
    expect(dropped).toEqual([expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_drop_remember_tokens_table\.ts$/)]);
    expect(readFileSync(new URL(web + reissue[0], repo), 'utf8')).toBe(readFileSync(TOKENS_REISSUE_MIGRATION, 'utf8'));
    expect(readFileSync(new URL(web + remember[0], repo), 'utf8')).toBe(readFileSync(SIGN_INS_REMEMBER_MIGRATION, 'utf8'));
    expect(readFileSync(new URL(web + dropped[0], repo), 'utf8')).toBe(readFileSync(REMEMBER_TOKENS_DROP_MIGRATION, 'utf8'));
    // The upgrades come after every migration that creates or changes the tables they touch.
    expect([...files].sort().slice(-3)).toEqual([reissue[0], remember[0], dropped[0]]);
    for (const file of files) expect(readFileSync(new URL(web + file, repo), 'utf8'), file).not.toContain('marmeon_');
    for (const directory of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(migrationsOf(directory), directory).toEqual([]);
  });
});
