import { Auth, AuthConfig, TwoFactorState, UserProvider } from '@marmeon/auth';
import { Clock, Container, Logger, ContainerError, SystemClock, createApplication, errorCodeOf, token, EventDispatcher, HealthChecks, type Application, type ModuleDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, SchemaRequirements } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { OAuthProviders } from '../registry.ts';
import { OAuthSetupError } from '../config.ts';
import { marked } from '../test-helpers/social-accounts.ts';
import { SocialAccounts } from './social-accounts.ts';
import { SocialUserProvider } from './users.ts';
import { SocialAccountsServiceProvider } from './provider.ts';
import { SocialAccountsConfig } from './config.ts';
import { SOCIAL_ACCOUNT_COLUMNS, SocialAccountStore } from './store.ts';

const USERS = new URL('../__fixtures__/migrations/', import.meta.url);
const STUB = new URL('../../stubs/migrations/', import.meta.url);
const MISSING_COLUMN = new URL('../__fixtures__/missing-column/', import.meta.url);
const UNMARKED_SECRET = new URL('../__fixtures__/unmarked-secret/', import.meta.url);

const env = { DB_DRIVER: 'sqlite', DB_DATABASE: ':memory:', NODE_ENV: 'test', APP_KEY: generateKey(), LOG_LEVEL: 'silent' };
const open = (modules: ModuleDefinition[], providers: readonly unknown[] = [DatabaseServiceProvider, EncryptionServiceProvider, SocialAccountsServiceProvider], more: Record<string, string> = {}) =>
  createApplication({ root: workspaceTempDir('marmeon-oauth-accounts-'), discover: false, providers: providers as never, modules }, { env: { ...env, ...more } });
const problems = async (application: Application) => {
  await application.container.make(Migrator).migrate();
  const report = await application.container.make(HealthChecks).run(application.container);
  return report.checks.flatMap((check) => (check.error instanceof Error ? [check.error.message] : []));
};

describe('SocialAccountsServiceProvider', () => {
  it('resolves the store, with the configuration of the app', async () => {
    await using application = await open([], undefined, { OAUTH_STORE_TOKENS: 'true' });
    const store = application.container.make(SocialAccountStore);
    expect(store).toBeInstanceOf(SocialAccountStore);
    expect(application.container.make(SocialAccountStore)).toBe(store);
  });

  it('requires exactly the table, its columns and its secret token columns', async () => {
    await using application = await open([]);
    expect(application.container.make(SchemaRequirements).all()).toEqual([
      { connection: 'default', table: 'social_accounts', columns: SOCIAL_ACCOUNT_COLUMNS, secrets: ['access_token', 'refresh_token'] },
    ]);
  });

  it('boots in an app without a database', async () => {
    await using application = await open([], [EncryptionServiceProvider, SocialAccountsServiceProvider]);
    expect(application.container.has(Connections)).toBe(false);
  });

  it('is green once the stub migration ran', async () => {
    await using application = await open([{ name: 'users', migrations: USERS }, { name: 'oauth', migrations: STUB }]);
    expect(await problems(application)).toEqual([]);
  });

  it('makes readiness red while the table is missing', async () => {
    await using application = await open([]);
    expect((await problems(application)).join('\n')).toContain('social_accounts is missing');
  });

  it('makes readiness red for a table that lacks a column', async () => {
    await using application = await open([{ name: 'users', migrations: USERS }, { name: 'oauth', migrations: MISSING_COLUMN }]);
    expect((await problems(application)).join('\n')).toContain('social_accounts lacks scopes');
  });

  it('makes readiness red for token columns that are not marked secret', async () => {
    await using application = await open([{ name: 'users', migrations: USERS }, { name: 'oauth', migrations: UNMARKED_SECRET }]);
    expect((await problems(application)).join('\n')).toMatch(/social_accounts.*access_token/);
  });

  it('builds SocialAccounts per request from what the app binds', () => {
    const container = new Container();
    const instances = new Map<unknown, unknown>([
      [Auth, { check: async () => false }],
      [UserProvider, {}],
      [TwoFactorState, {}],
      [SocialAccountStore, { find: async () => undefined }],
      [OAuthProviders, new OAuthProviders([])],
      [SocialAccountsConfig, { registration: true, storeTokens: false }],
      [AuthConfig, { privateRegistration: true }],
      [Connections, {}],
      [EventDispatcher, {}],
      [Clock, new SystemClock()],
      [Logger, {}],
    ]);
    new SocialAccountsServiceProvider().register(container);
    for (const [key, value] of instances) container.bind(key as never, () => value);
    const scope = container.createScope();
    const accounts = scope.make(SocialAccounts);
    expect(accounts).toBeInstanceOf(SocialAccounts);
    expect(scope.make(SocialAccounts)).toBe(accounts);
    expect(container.createScope().make(SocialAccounts)).not.toBe(accounts);
    // Nothing binds SocialUserProvider here, and building SocialAccounts did not ask for it.
    expect(() => scope.make(SocialUserProvider)).toThrow(ContainerError);
  });

  it('answers A10 for a SocialUserProvider nobody bound, and the bound provider\'s own error when it cannot be built (K1)', async () => {
    const container = new Container();
    const instances = new Map<unknown, unknown>([
      [Auth, { check: async () => false }],
      [UserProvider, {}],
      [TwoFactorState, {}],
      [SocialAccountStore, { find: async () => undefined }],
      [OAuthProviders, new OAuthProviders([])],
      [SocialAccountsConfig, { registration: true, storeTokens: false }],
      [AuthConfig, { privateRegistration: true }],
      [Connections, {}],
      [EventDispatcher, {}],
      [Clock, new SystemClock()],
      [Logger, {}],
    ]);
    new SocialAccountsServiceProvider().register(container);
    for (const [key, value] of instances) container.bind(key as never, () => value);
    const profile = () => marked('sign-in');
    const unbound = await container.createScope().make(SocialAccounts).signIn(profile()).catch((error: unknown) => error);
    expect(unbound).toBeInstanceOf(OAuthSetupError);
    expect(errorCodeOf(unbound)).toBe('A10');

    // Bound to a provider that needs something nobody bound: the container's own error, not A10.
    const missing = token<{ ready: true }>('MissingDependency');
    container.bind(SocialUserProvider, (resolver) => ({ dependency: resolver.make(missing) }) as never);
    const broken = await container.createScope().make(SocialAccounts).signIn(profile()).catch((error: unknown) => error);
    expect(broken).toBeInstanceOf(ContainerError);
    expect(errorCodeOf(broken)).toBe('K1');
  });

  it('claims the re-authentication "oauth" once per container: a second provider on it stops with A12', () => {
    const container = new Container();
    new SocialAccountsServiceProvider().register(container);
    expect(() => new SocialAccountsServiceProvider().register(container)).toThrow(/re-authentication "oauth" is claimed already/);
  });
});
