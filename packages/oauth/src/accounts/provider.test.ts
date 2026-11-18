import { createApplication, HealthChecks, type Application, type ModuleDefinition } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator, SchemaRequirements } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { SocialAccountsServiceProvider } from './provider.ts';
import { SOCIAL_ACCOUNT_COLUMNS, SocialAccountStore } from './store.ts';

const USERS = new URL('../__fixtures__/migrations/', import.meta.url);
const STUB = new URL('../../stubs/react/modules/oauth/migrations/', import.meta.url);
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
});
