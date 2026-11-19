import { describe, expect, it } from 'vitest';
import { NO_CONFIRM, OIDC } from '../oidc-marker.ts';
import { OAuthServiceProvider } from '../provider.ts';
import { OAuthProviders } from '../registry.ts';
import { activeEnv, definition, defineOAuthProvider, oauthApp, providerBringing } from '../test-helpers/app.ts';
import { expectA11, failure } from '../test-helpers/start.ts';

const NAMES = ['github', 'google', 'microsoft', 'gitlab', 'discord'];
const LABELS = { github: 'GitHub', google: 'Google', microsoft: 'Microsoft', gitlab: 'GitLab', discord: 'Discord' };

describe('the built-in providers', () => {
  it('registers the five providers through oauthProviders, inactive until their two variables are set', async () => {
    expect(Object.keys(OAuthServiceProvider.oauthProviders).toSorted()).toEqual(NAMES.toSorted());
    const none = (await oauthApp([])).application.container.make(OAuthProviders);
    expect(none.active()).toEqual([]);
    for (const name of NAMES) expect(none.get(name), name).toBeUndefined();

    for (const name of NAMES) {
      const prefix = `OAUTH_${name.toUpperCase()}_`;
      // One variable of the two is not enough.
      const half = (await oauthApp([], { APP_URL: 'https://app.example.com', [`${prefix}CLIENT_ID`]: 'client' })).application.container.make(OAuthProviders);
      expect(half.active(), name).toEqual([]);
      const active = (await oauthApp([], activeEnv(name))).application.container.make(OAuthProviders);
      expect(active.active().map((entry) => entry.name), name).toEqual([name]);
      expect(active.get(name)?.label).toBe(LABELS[name as keyof typeof LABELS]);
    }
    const all = (await oauthApp([], Object.assign({}, ...NAMES.map(activeEnv)))).application.container.make(OAuthProviders);
    expect(all.active().map((entry) => entry.name).toSorted()).toEqual(NAMES.toSorted());
  });

  it('reads the issuer of GitLab and the tenant of Microsoft, and only those', async () => {
    const providers = (await oauthApp([], { ...activeEnv('gitlab'), OAUTH_GITLAB_ISSUER: 'https://git.example.com', ...activeEnv('microsoft'), OAUTH_MICROSOFT_TENANT: 'organizations' })).application.container.make(OAuthProviders);
    expect(providers.get('gitlab')?.credentials.issuer).toBe('https://git.example.com');
    expect(providers.get('microsoft')?.credentials.options).toEqual({ TENANT: 'organizations' });
    // Every provider with both variables set: only GitLab reads an issuer, only Microsoft a TENANT.
    for (const name of NAMES) {
      const prefix = `OAUTH_${name.toUpperCase()}_`;
      const env = { ...activeEnv(name), [`${prefix}ISSUER`]: 'https://elsewhere.example.com', [`${prefix}TENANT`]: 'organizations' };
      const read = (await oauthApp([], env)).application.container.make(OAuthProviders).get(name)!.credentials;
      expect(read.issuer, name).toBe(name === 'gitlab' ? 'https://elsewhere.example.com' : undefined);
      expect(read.options, name).toEqual(name === 'microsoft' ? { TENANT: 'organizations' } : {});
    }
  });

  it('keeps the confirmation marks through the registry: only Microsoft of the five can confirm', async () => {
    const all = (await oauthApp([], Object.assign({}, ...NAMES.map(activeEnv)))).application.container.make(OAuthProviders);
    const marks = (name: string) => {
      const definition = all.get(name)!.definition as unknown as Record<symbol, unknown>;
      return { oidc: definition[OIDC] === true, noConfirmation: definition[NO_CONFIRM] === true };
    };
    expect(marks('google')).toEqual({ oidc: true, noConfirmation: true });
    expect(marks('gitlab')).toEqual({ oidc: true, noConfirmation: true });
    expect(marks('microsoft')).toEqual({ oidc: true, noConfirmation: false });
    for (const name of ['github', 'discord']) expect(marks(name), name).toEqual({ oidc: false, noConfirmation: false });
  });

  it('stops the start for the Microsoft provider under another name, whose tenant variable would not be read', async () => {
    const error = await failure(oauthApp([providerBringing('Partner', { partner: OAuthServiceProvider.oauthProviders.microsoft! })], activeEnv('partner')));
    expect(expectA11(error)).toContain('bring it under the name "microsoft" only');
  });

  it('keeps the names: an app that brings one of them stops the start', async () => {
    for (const name of NAMES) {
      const error = await failure(oauthApp([providerBringing('Mine', { [name]: defineOAuthProvider(definition()) })]));
      expect(expectA11(error), name).toContain(`"${name}" is brought by both`);
    }
  });
});
