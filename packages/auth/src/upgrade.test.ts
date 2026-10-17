import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ConsoleLogger, createApplication, HealthChecks, Logger, SystemClock, type Application, type Container, type ModuleDefinition, type Logger as LoggerType } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, Schema, sql, type ConnectionOptions, type Migration } from '@marmeon/database';
import { SchemaRequirements } from '@marmeon/database/internal';
import { AesGcmEncrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { PASSKEY_COLUMNS, PASSKEYS_TABLE } from './passkeys/store.ts';
import { PasskeyServiceProvider } from './passkeys/provider.ts';
import { PGSQL_URL } from './__fixtures__/databases.ts';
import { AuthServiceProvider, AccessTokenStore, combineFactors, DatabaseSignIns, RememberTokenStore, SignInStore, TwoFactorState, TwoFactorStore, UserProvider } from './index.ts';
import { factorSources, NoTwoFactorState } from './two-factor/state.ts';
import { AUTH_RENAME_MIGRATION, SIGN_INS_RENAME_MIGRATION } from './upgrades.ts';

const silent: LoggerType = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

/** The migrations the first stubs wrote (and the users table they point at), as apps have them. */
const LEGACY = new URL('./__fixtures__/legacy/', import.meta.url);
/** The two migrations `make:upgrade-migrations` writes, as the package ships them. */
const UPGRADE = new URL('./__fixtures__/upgrade/', import.meta.url);
/** A migration that renames a table with a secret column in raw SQL. */
const BY_HAND = new URL('./__fixtures__/by-hand/', import.meta.url);
/** The migrations of the starter kit as `make:auth` writes them now. */
const KIT = new URL('../stubs/react/modules/auth/migrations/', import.meta.url);

const TABLES = ['remember_tokens', 'password_reset_tokens', 'personal_access_tokens', 'two_factor_authentications', 'two_factor_recovery_codes', 'passkeys', 'sign_ins'] as const;
/** The columns marked `.secret()`, by the table's old name. */
const SECRETS: Record<string, readonly string[]> = {
  remember_tokens: ['previous_validator_hash', 'validator_hash'],
  password_reset_tokens: ['token_hash'],
  personal_access_tokens: ['token_hash'],
  two_factor_authentications: ['secret'],
  two_factor_recovery_codes: ['code_hash'],
};

const load = async (file: URL) => ((await import(file.href)) as { default: Migration }).default;
const filesOf = (directory: URL) => readdirSync(directory).filter((file) => file.endsWith('.ts')).sort();
const loadAll = async (directory: URL) => Promise.all(filesOf(directory).map((file) => load(new URL(file, directory))));

/** Everything a table is known by: columns, and the names of indexes and constraints, by their full names. */
async function describeTable(connections: Connections, name: string) {
  const db = connections.get<any>();
  const introspected = await db.introspection.getTables();
  const columns = introspected.find((table: { name: string }) => table.name === name)!.columns.map((column: { name: string; dataType: string; isNullable: boolean }) => `${column.name}:${column.dataType}:${column.isNullable}`);
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
    return { connections, schema: new Schema(connections.get(), 'sqlite'), drop: async () => connections.destroy() };
  }
  const name = `marmeon_auth_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = connect({ driver: 'pgsql', url: PGSQL_URL! }, false);
  await sql`create database ${sql.id(name)}`.execute(admin.get());
  const url = new URL(PGSQL_URL!);
  url.pathname = `/${name}`;
  const connections = connect({ driver: 'pgsql', url: url.href, poolMax: 2 }, managed);
  return {
    connections,
    schema: new Schema(connections.get(), 'pgsql'),
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

describe.each(kinds)('the upgrade of the auth tables on %s', (kind) => {
  it('leaves a database made with the first revision identical to one made with the current one, and the rows stay', async () => {
    const fresh = await open(kind);
    const old = await open(kind);
    try {
      // `fresh` was made by the kit as it is now; `old` by the first revision, with an account that has every row.
      for (const migration of await loadAll(KIT)) await migration.up(fresh.schema);
      for (const migration of await loadAll(LEGACY)) await migration.up(old.schema);
      await seed(old.connections);
      const before = Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, await describeTable(old.connections, table)])));

      const upgrades = [await load(new URL(`${UPGRADE.href}2026_02_01_000000_rename_auth_tables_to_marmeon.ts`)), await load(new URL(`${UPGRADE.href}2026_02_01_000001_rename_sign_ins_table_to_marmeon.ts`))];
      for (const upgrade of upgrades) await upgrade.up(old.schema);
      for (const table of TABLES) {
        expect(await describeTable(old.connections, `marmeon_${table}`), table).toEqual(await describeTable(fresh.connections, `marmeon_${table}`));
        const { rows } = await sql<{ n: number | string }>`select count(*) as n from ${sql.table(`marmeon_${table}`)}`.execute(old.connections.get());
        expect(Number(rows[0]!.n), `rows of marmeon_${table}`).toBe(1);
      }
      const db = old.connections.get<any>();
      expect((await sql<{ validator_hash: string }>`select validator_hash from marmeon_remember_tokens`.execute(db)).rows).toEqual([{ validator_hash: 'validator-hash' }]);
      expect((await sql<{ token_hash: string }>`select token_hash from marmeon_password_reset_tokens`.execute(db)).rows).toEqual([{ token_hash: 'reset-hash' }]);
      expect((await sql<{ token_hash: string }>`select token_hash from marmeon_personal_access_tokens`.execute(db)).rows).toEqual([{ token_hash: 'access-hash' }]);
      expect((await sql<{ name: string }>`select name from marmeon_passkeys`.execute(db)).rows).toEqual([{ name: 'Laptop' }]);
      // The table of the app stays the app's.
      expect((await sql<{ email: string }>`select email from users`.execute(db)).rows).toEqual([{ email: 'ada@example.com' }]);

      for (const upgrade of upgrades.toReversed()) await upgrade.down!(old.schema);
      for (const table of TABLES) expect(await describeTable(old.connections, table), `down restores ${table}`).toEqual(before[table]);
    } finally {
      await fresh.drop();
      await old.drop();
    }
  });

  it('skips a table the app does not have, in both directions', async () => {
    const old = await open(kind);
    try {
      const without = filesOf(LEGACY).filter((file) => !file.endsWith('_create_passkeys_table.ts'));
      for (const file of without) await (await load(new URL(file, LEGACY))).up(old.schema);
      const upgrade = await load(AUTH_RENAME_MIGRATION);
      await upgrade.up(old.schema);
      expect(await old.schema.hasTable('marmeon_remember_tokens')).toBe(true);
      expect(await old.schema.hasTable('marmeon_passkeys')).toBe(false);
      expect(await old.schema.hasTable('passkeys')).toBe(false);
      await upgrade.down!(old.schema);
      expect(await old.schema.hasTable('remember_tokens')).toBe(true);
    } finally {
      await old.drop();
    }
  });
});

describe.each(kinds)('the secret columns across the rename, on %s', (kind) => {
  const modules = (...directories: URL[]) => directories.map((migrations, index) => ({ name: `part${index}`, migrations }));
  const migrator = (connections: Connections, ...directories: URL[]) => new Migrator({ modules: modules(...directories), root: '/' } as unknown as Application, connections).onOneConnection();
  const marked = async (connections: Connections) => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`select table_name, column_name from marmeon_secret_columns`.execute(connections.get());
    return rows.map((row) => `${row.table_name}.${row.column_name}`).sort();
  };
  const expected = (name: (table: string) => string) => ['users.password', 'users.pending_email_token', 'users.session_key', ...Object.entries(SECRETS).flatMap(([table, columns]) => columns.map((column) => `${name(table)}.${column}`))].sort();
  /** Every row of the table as `selectAll()` gives it: the columns it names. */
  const columnsOf = async (connections: Connections, table: string) => Object.keys(await connections.get<any>().selectFrom(table).selectAll().executeTakeFirstOrThrow()).sort();

  it('stay marked in both directions: selectAll() and relations never return them, before, after and after going back', async () => {
    const { connections, drop } = await open(kind, true);
    try {
      await migrator(connections, LEGACY).migrate();
      await seed(connections);
      expect(await marked(connections)).toEqual(expected((table) => table));
      const withoutSecrets = async (name: (table: string) => string) => {
        for (const [table, columns] of Object.entries(SECRETS)) {
          const keys = await columnsOf(connections, name(table));
          for (const column of columns) expect(keys, `${name(table)}.${column}`).not.toContain(column);
          expect(keys.length, name(table)).toBeGreaterThan(1);
        }
        // A relation of the account loads none of them either.
        const query: any = connections.get<any>().selectFrom('users').select('email');
        const [ada] = (await query.with(name('personal_access_tokens')).with(name('remember_tokens')).with(name('two_factor_recovery_codes')).execute()) as Record<string, any>[];
        for (const [table, column] of [['personal_access_tokens', 'token_hash'], ['remember_tokens', 'validator_hash'], ['remember_tokens', 'previous_validator_hash'], ['two_factor_recovery_codes', 'code_hash']] as const) {
          expect(ada![name(table)], name(table)).toHaveLength(1);
          expect(ada![name(table)][0],`${name(table)}.${column}`).not.toHaveProperty(column);
        }
      };
      await withoutSecrets((table) => table);

      await migrator(connections, LEGACY, UPGRADE).migrate();
      const renamed = (table: string) => `marmeon_${table}`;
      expect(await marked(connections)).toEqual(expected(renamed));
      await withoutSecrets(renamed);

      await migrator(connections, LEGACY, UPGRADE).rollback({ steps: 2 });
      expect(await marked(connections)).toEqual(expected((table) => table));
      await withoutSecrets((table) => table);
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

  it('is checked by the bookkeeping: a rename in raw SQL rolls back with D4, and an entry that points at nothing refuses every query with D1', async () => {
    const { connections, drop } = await open(kind, true);
    try {
      await migrator(connections, LEGACY, UPGRADE).migrate();
      await expect(migrator(connections, LEGACY, UPGRADE, BY_HAND).migrate()).rejects.toThrow(/\[marmeon:D4\].*secret column marmeon_two_factor_authentications\.secret.*schema\.rename\(\)/s);
      expect(await marked(connections)).toEqual(expected((table) => `marmeon_${table}`));
      expect(await connections.get<any>().selectFrom('marmeon_two_factor_authentications').selectAll().execute()).toEqual([]);

      // The same rename by a tool outside the migrator: the next query of the connection finds the entry loose.
      await sql`alter table marmeon_two_factor_authentications rename to moved_two_factor`.execute(connections.get());
      connections.metadata().invalidate();
      await expect(connections.get<any>().selectFrom('users').selectAll().execute()).rejects.toThrow(/\[marmeon:D1\].*points at nothing: .*secret column marmeon_two_factor_authentications\.secret/s);
    } finally {
      await drop();
    }
  });
});

describe('a database that still has the old tables', () => {
  const env = { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent' };
  const providers = [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider];
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

  it('makes /up/ready red, and says what to run for each table the app uses', async () => {
    await using application = await open({}, (container) => {
      signedIn(container);
      container.singleton(SignInStore, DatabaseSignIns);
      container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore)));
    });
    // A first migrate writes the empty bookkeeping; the tables then are the old release's.
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    const schema = new Schema(connections.get(), connections.options().driver);
    for (const migration of await loadAll(LEGACY)) await migration.up(schema);
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
    for (const table of ['remember_tokens', 'password_reset_tokens', 'personal_access_tokens', 'sign_ins', 'two_factor_authentications', 'two_factor_recovery_codes']) {
      expect(messages.join('\n'), table).toContain(`marmeon_${table} is missing`);
    }
    expect(messages.join('\n')).toMatch(/run marmeon make:upgrade-migrations, then marmeon migrate$/);
  });

  it('is green once the tables are renamed', async () => {
    // Made by the migrations of the first revision and the renames, so the bookkeeping marks the secret columns.
    await using application = await open(
      {},
      (container) => {
        signedIn(container);
        container.singleton(SignInStore, DatabaseSignIns);
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

  it('waits for the tables of the default stores once authentication is set up, and for the second factor and the sign-ins only when they are bound', async () => {
    await using plain = await open({}, signedIn);
    expect(await required(plain)).toEqual(['marmeon_password_reset_tokens', 'marmeon_personal_access_tokens', 'marmeon_remember_tokens']);

    await using full = await open({}, (container) => {
      signedIn(container);
      container.singleton(SignInStore, DatabaseSignIns);
      container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore), c.make(NoTwoFactorState)));
    });
    expect(await required(full)).toEqual([
      'marmeon_password_reset_tokens',
      'marmeon_personal_access_tokens',
      'marmeon_remember_tokens',
      'marmeon_sign_ins',
      'marmeon_two_factor_authentications',
      'marmeon_two_factor_recovery_codes',
    ]);
  });

  it('leaves out the table of a store the app replaced, and of remember-me when it is off', async () => {
    class OwnRememberTokens {}
    await using own = await open({ AUTH_REMEMBER_DAYS: '0' }, signedIn);
    expect(await required(own)).toEqual(['marmeon_password_reset_tokens', 'marmeon_personal_access_tokens']);
    await using replaced = await open({}, (container) => {
      signedIn(container);
      container.singleton(RememberTokenStore, OwnRememberTokens as never);
    });
    expect(await required(replaced)).toEqual(['marmeon_password_reset_tokens', 'marmeon_personal_access_tokens']);
  });

  it('boots with a store of its own that depends on something scoped, and waits for no table of it', async () => {
    class ScopedTokens {}
    await using application = await open({}, (container) => {
      signedIn(container);
      container.scoped(AccessTokenStore, ScopedTokens as never);
      container.scoped(SignInStore, ScopedTokens as never);
    });
    expect(await required(application)).toEqual(['marmeon_password_reset_tokens', 'marmeon_remember_tokens']);
  });

  it('makes /up/ready red while a column that holds a secret lacks its mark, as in a table made by hand', async () => {
    await using application = await open({ AUTH_REMEMBER_DAYS: '0' }, signedIn);
    await application.container.make(Migrator).migrate();
    const connections = application.container.make(Connections);
    await sql`create table marmeon_password_reset_tokens (email varchar(255) primary key, token_hash varchar(64) not null, created_at timestamp not null)`.execute(connections.get());
    await sql`create table marmeon_personal_access_tokens (id integer primary key, user_id integer, name varchar(255), token_hash varchar(64), abilities text, last_used_at timestamp, expires_at timestamp, created_at timestamp, updated_at timestamp)`.execute(connections.get());
    connections.metadata().invalidate();
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    expect(messages).toContain('marmeon_password_reset_tokens has token_hash without the secret() mark');
    expect(messages).toContain('marmeon_personal_access_tokens has token_hash without the secret() mark');
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

describe('the revisions the auth tables list', () => {
  it('are revision 2 of the auth set and of the sign-ins set, for apps that created the tables with the first stubs', () => {
    const upgrades = AuthServiceProvider.migrationUpgrades;
    expect(upgrades.map(({ set, revision, name }) => ({ set, revision, name }))).toEqual([
      { set: 'auth', revision: 2, name: 'rename_auth_tables_to_marmeon' },
      { set: 'sign-ins', revision: 2, name: 'rename_sign_ins_table_to_marmeon' },
    ]);
    expect(upgrades[0]!.createdBy).toEqual(expect.arrayContaining(['create_remember_tokens_table', 'create_two_factor_tables', 'create_two_factor_authentications_table', 'create_passkeys_table']));
    expect(upgrades[1]!.createdBy).toEqual(['create_sign_ins_table']);
    expect(upgrades[0]!.contents).toBe(readFileSync(AUTH_RENAME_MIGRATION, 'utf8'));
    expect(upgrades[1]!.contents).toBe(readFileSync(SIGN_INS_RENAME_MIGRATION, 'utf8'));
    expect(upgrades[0]!.contents).toMatch(/^\/\/ @marmeon-stub auth 2\n/);
    expect(upgrades[1]!.contents).toMatch(/^\/\/ @marmeon-stub sign-ins 2\n/);
  });

  it('are what the first stubs and the stubs now say: revision 1 before, revision 2 after, and the new names only after', () => {
    for (const file of filesOf(LEGACY).filter((name) => !name.includes('users'))) {
      const contents = readFileSync(new URL(file, LEGACY), 'utf8');
      expect(contents, file).toMatch(/^\/\/ @marmeon-stub (auth|sign-ins) 1\n/);
      expect(contents, file).not.toContain('marmeon_');
    }
    for (const file of filesOf(KIT).filter((name) => !name.includes('users'))) {
      const contents = readFileSync(new URL(file, KIT), 'utf8');
      expect(contents, file).toMatch(file.includes('sign_ins') ? /^\/\/ @marmeon-stub sign-ins 2\n/ : /^\/\/ @marmeon-stub auth 2\n/);
      expect(contents.match(/schema\.(create|drop)\('[a-z_]+'/g)!.every((call) => call.includes("'marmeon_")), file).toBe(true);
    }
    const signIns = readFileSync(new URL('../stubs/migrations/create_sign_ins_table.ts', import.meta.url), 'utf8');
    expect(signIns).toMatch(/^\/\/ @marmeon-stub sign-ins 2\n/);
    expect(signIns).toContain("schema.create('marmeon_sign_ins'");
  });
});

describe('the migrations in the apps', () => {
  const repo = new URL('../../../', import.meta.url);
  const migrationsOf = (directory: string) => readdirSync(new URL(directory, repo)).filter((file) => /(remember|password_reset|personal_access|two_factor|passkeys|sign_ins|auth_tables)/.test(file));

  it("the web app's tables come from the first stubs and the renames, the blank app's and the starter's have none", () => {
    const web = 'apps/web-app/modules/auth/migrations/';
    const files = migrationsOf(web);
    const renames = files.filter((file) => /rename/.test(file));
    expect(renames).toEqual([expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_rename_auth_tables_to_marmeon\.ts$/), expect.stringMatching(/^\d{4}_\d{2}_\d{2}_\d{6}_rename_sign_ins_table_to_marmeon\.ts$/)]);
    expect(readFileSync(new URL(web + renames[0], repo), 'utf8')).toBe(readFileSync(AUTH_RENAME_MIGRATION, 'utf8'));
    expect(readFileSync(new URL(web + renames[1], repo), 'utf8')).toBe(readFileSync(SIGN_INS_RENAME_MIGRATION, 'utf8'));
    // The renames come after every migration that creates or changes the old tables.
    const sorted = [...files].sort();
    expect(sorted.slice(-2)).toEqual(renames);
    for (const file of files.filter((name) => !/rename/.test(name))) expect(readFileSync(new URL(web + file, repo), 'utf8'), file).not.toContain('marmeon_');
    for (const directory of ['apps/blank-app/modules/system/migrations/', 'packages/create-marmeon/template/base/modules/system/migrations/']) expect(migrationsOf(directory), directory).toEqual([]);
  });
});
