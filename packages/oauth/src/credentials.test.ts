import { resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { oauthCredentials, type OAuthCredentials } from './credentials.ts';

const read = async (config: ReturnType<typeof oauthCredentials>, env: Record<string, string | undefined>): Promise<OAuthCredentials> =>
  (await resolveConfig([config], env)).get(config) as OAuthCredentials;

describe('oauthCredentials', () => {
  it('derives OAUTH_<NAME>_* from the provider name, a dash becoming an underscore', async () => {
    const credentials = await read(oauthCredentials('my-idp'), {
      OAUTH_MY_IDP_CLIENT_ID: 'id',
      OAUTH_MY_IDP_CLIENT_SECRET: 'secret',
      OAUTH_MY_IDP_REDIRECT_URL: 'https://app.example.com/back',
      OAUTH_MY_IDP_SCOPES: 'a,b',
    });
    expect(credentials).toMatchObject({ clientId: 'id', clientSecret: 'secret', redirectUrl: 'https://app.example.com/back', scopes: ['a', 'b'], issuer: undefined, options: {} });
    expect(oauthCredentials('my-idp').name).toBe('oauth:my-idp');
  });

  it('declares ISSUER only when asked and option keys as OAUTH_<NAME>_<KEY>', async () => {
    const env = { OAUTH_IDP_ISSUER: 'https://id.example.com', OAUTH_IDP_TENANT: 'acme', OAUTH_IDP_REGION: 'eu' };
    expect((await read(oauthCredentials('idp'), env)).issuer).toBeUndefined();
    expect((await read(oauthCredentials('idp', { issuer: 'required' }), env)).issuer).toBe('https://id.example.com');
    expect((await read(oauthCredentials('idp', { issuer: 'optional' }), {})).issuer).toBeUndefined();
    expect((await read(oauthCredentials('idp', { options: ['TENANT', 'REGION'] }), env)).options).toEqual({ TENANT: 'acme', REGION: 'eu' });
    expect((await read(oauthCredentials('idp'), env)).options).toEqual({});
  });

  it('refuses a name with capitals, underscores or over 32 characters', () => {
    for (const name of ['Gitea', 'my_idp', '1idp', '', 'idp ', 'a'.repeat(33)]) expect(() => oauthCredentials(name), name).toThrow(TypeError);
    expect(() => oauthCredentials('a'.repeat(32))).not.toThrow();
  });

  it('refuses an option key that shadows CLIENT_ID', () => {
    for (const key of ['CLIENT_ID', 'CLIENT_SECRET', 'REDIRECT_URL', 'SCOPES', 'ISSUER']) {
      expect(() => oauthCredentials('idp', { options: [key] }), key).toThrow(/every provider has/);
    }
    expect(() => oauthCredentials('idp', { options: ['tenant'] })).toThrow(TypeError);
    expect(() => oauthCredentials('idp', { options: ['TENANT', 'TENANT'] })).toThrow(/twice/);
  });

  it('reads an unset or empty variable as undefined, never failing', async () => {
    const credentials = await read(oauthCredentials('idp', { issuer: 'required', options: ['TENANT'] }), { OAUTH_IDP_CLIENT_ID: '', OAUTH_IDP_SCOPES: '' });
    expect(credentials).toEqual({ clientId: undefined, clientSecret: undefined, redirectUrl: undefined, scopes: undefined, issuer: undefined, options: { TENANT: undefined } });
  });

  it('splits SCOPES at commas and trims them', async () => {
    expect((await read(oauthCredentials('idp'), { OAUTH_IDP_SCOPES: ' openid , email,, profile ' })).scopes).toEqual(['openid', 'email', 'profile']);
    expect((await read(oauthCredentials('idp'), { OAUTH_IDP_SCOPES: ' , ' })).scopes).toBeUndefined();
  });

  it('refuses an issuer that is neither required nor optional, and an option that is none', () => {
    expect(() => oauthCredentials('idp', { issuer: 'requird' as never })).toThrow(/issuer is 'required' or 'optional'/);
    expect(() => oauthCredentials('idp', { issuer: true as never })).toThrow(TypeError);
    expect(() => oauthCredentials('idp', { isuer: 'required' } as never)).toThrow(/"isuer" is not an option/);
    expect(() => oauthCredentials('idp', { options: 'TENANT' as never })).toThrow(/options is a list/);
    expect(() => oauthCredentials('idp', null as never)).toThrow(TypeError);
  });
});
