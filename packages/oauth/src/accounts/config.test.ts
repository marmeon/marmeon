import { resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { SocialAccountsConfig } from './config.ts';

const resolved = async (env: Record<string, string>) => (await resolveConfig([SocialAccountsConfig], env)).get(SocialAccountsConfig);

describe('SocialAccountsConfig', () => {
  it('registers by default and stores no tokens', async () => {
    expect(await resolved({})).toEqual({ registration: true, storeTokens: false });
  });

  it('reads both variables as booleans', async () => {
    expect(await resolved({ OAUTH_REGISTRATION: 'false', OAUTH_STORE_TOKENS: 'true' })).toEqual({ registration: false, storeTokens: true });
    expect(await resolved({ OAUTH_REGISTRATION: '0', OAUTH_STORE_TOKENS: '1' })).toEqual({ registration: false, storeTokens: true });
    expect(await resolved({ OAUTH_REGISTRATION: 'true', OAUTH_STORE_TOKENS: 'false' })).toEqual({ registration: true, storeTokens: false });
  });

  it('refuses a value that is no boolean', async () => {
    await expect(resolved({ OAUTH_STORE_TOKENS: 'maybe' })).rejects.toThrow();
    await expect(resolved({ OAUTH_REGISTRATION: 'maybe' })).rejects.toThrow();
  });
});
