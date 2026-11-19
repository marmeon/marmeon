import type { ServiceProviderClass } from '@marmeon/core';
import { FetchServiceProvider } from '@marmeon/fetch';
import { createTestApp, type TestApp, type TestAppOptions } from '@marmeon/testing';
import { oauthCredentials } from '../credentials.ts';
import { defineOAuthProvider, type OAuthProviderDefinition, type OAuthProviderFactory } from '../definition.ts';
import { OAuthServiceProvider } from '../provider.ts';

/** A provider class that brings the OAuth providers `brought` and lists their credentials, the way a package does. */
export function providerBringing(name: string, brought: Readonly<Record<string, OAuthProviderFactory>>, credentials = Object.keys(brought)): ServiceProviderClass {
  return {
    [name]: class {
      static config = credentials.map((entry) => oauthCredentials(entry));
      static oauthProviders = brought;
    },
  }[name]!;
}

/** The smallest valid definition; `overrides` replaces parts of it. */
export function definition(overrides: Partial<OAuthProviderDefinition> = {}): OAuthProviderDefinition {
  return {
    label: 'Example',
    endpoints: { authorizeUrl: 'https://id.example.com/authorize', tokenUrl: 'https://id.example.com/token' },
    scopes: ['profile'],
    profile: async () => ({}),
    mapUser: () => ({ id: '1', email: null, emailVerified: false, name: null, nickname: null, avatar: null }),
    ...overrides,
  };
}

/** The environment that makes the provider `name` active: its client id and secret, and the `APP_URL` an active provider needs. */
export function activeEnv(name: string): Record<string, string> {
  const prefix = `OAUTH_${name.replaceAll('-', '_').toUpperCase()}_`;
  return { APP_URL: 'https://app.example.com', [`${prefix}CLIENT_ID`]: 'client', [`${prefix}CLIENT_SECRET`]: 'secret' };
}

/**
 * An app with the OAuth provider, the fake `HttpClient` and the `providers` given; `env` adds variables (a test app is `NODE_ENV=test`
 * unless `env` says another).
 */
export function oauthApp(providers: readonly ServiceProviderClass[], env: Readonly<Record<string, string | undefined>> = {}, options: TestAppOptions = {}): Promise<TestApp> {
  return createTestApp(
    { root: import.meta.dirname, discover: false, providers: [FetchServiceProvider, OAuthServiceProvider, ...providers] },
    { ...options, env: { LOG_LEVEL: 'silent', ...env } },
  );
}

export { defineOAuthProvider };
