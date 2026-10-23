import { ConsoleLogger, createApplication, HealthChecks, Logger, type Application, type Container, type ModuleDefinition, type Logger as LoggerType } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { Connections, DatabaseServiceProvider, Migrator, SchemaRequirements } from '@marmeon/database';
import { runMigration } from '@marmeon/database/internal';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { PASSKEY_COLUMNS, PASSKEYS_TABLE } from './passkeys/store.ts';
import { PasskeyServiceProvider } from './passkeys/provider.ts';
import { AuthServiceProvider, AccessTokenStore, combineFactors, DatabaseEmailChanges, EmailChangeStore, SignInStore, TwoFactorState, TwoFactorStore, UserProvider } from './index.ts';
import { factorSources, NoTwoFactorState } from './two-factor/state.ts';

const silent: LoggerType = Object.assign(new ConsoleLogger(), { debug() {}, info() {} });

/** The migrations the first stubs wrote (and the users table they point at), as apps have them. */
const LEGACY = new URL('./__fixtures__/legacy/', import.meta.url);
/** The migrations of the starter kit as `make:auth` writes them now. */
const KIT = new URL('../stubs/react/modules/auth/migrations/', import.meta.url);

describe('a database that lacks the auth tables', () => {
  const env = { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory' };
  const providers = [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider];
  const open = (more: Record<string, string> = {}, wire: (container: Container) => void = () => {}, extra: (typeof AuthServiceProvider | typeof PasskeyServiceProvider)[] = [], modules: ModuleDefinition[] = []) =>
    createApplication(
      { root: workspaceTempDir('marmeon-auth-tables-'), discover: false, providers: [...providers, ...extra], modules },
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
    expect(messages.join('\n')).toMatch(/a migration is missing: marmeon publish writes the ones of your packages, then marmeon migrate$/);
  });

  it("is green once the kit's migrations ran", async () => {
    await using application = await open(
      {},
      (container) => {
        signedIn(container);
        container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore)));
      },
      [],
      [{ name: 'kit', migrations: KIT }],
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

  it('makes /up/ready red while sign_ins has no columns for the remember-me token, and says which command copies them', async () => {
    await using application = await open({ AUTH_REMEMBER_DAYS: '0' }, signedIn, [], [{ name: 'legacy', migrations: LEGACY }]);
    await application.container.make(Migrator).migrate();
    const report = await application.container.make(HealthChecks).run(application.container);
    expect(report.ok).toBe(false);
    const messages = report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : [])).join('\n');
    expect(messages).toContain('sign_ins');
    expect(messages).toContain('remember_validator_hash');
    expect(messages).toContain('remember_fingerprint');
    expect(messages).toContain('marmeon publish');
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
    expect(messages).toContain('marmeon publish');
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
