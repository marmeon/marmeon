import { EnvironmentConfig, type Container, type ServiceProvider } from '@marmeon/core';
import { OAuthSetupError, oauthCredentials, oidc, type OAuthProviderFactory } from '@marmeon/oauth';
import { LocalOidc } from './LocalOidc.ts';
import { LocalOidcCodes } from './LocalOidcCodes.ts';

const local = oidc({ label: 'Local', allowAddresses: ['127.0.0.0/8', '::1/128'] });

/**
 * The provider `local`: an OpenID Connect provider that runs inside this app, for trying the social sign-in without an account anywhere.
 * It exists in development and test only. The factory runs when the provider is active (`OAUTH_LOCAL_*` set), and then refuses to start the app
 * unless `NODE_ENV` is exactly `development` or `test` — the same condition under which its routes answer at all.
 */
const localProvider: OAuthProviderFactory = (context) => {
  const node = context.container.make(EnvironmentConfig).node;
  if (node !== 'development' && node !== 'test') {
    throw new OAuthSetupError('The OAuth provider "local" is active, but it is for development and test only: unset OAUTH_LOCAL_CLIENT_ID and OAUTH_LOCAL_CLIENT_SECRET, or start with NODE_ENV=development.');
  }
  return local(context);
};

export class LocalOidcServiceProvider implements ServiceProvider {
  static config = [oauthCredentials('local', { issuer: 'required' })];
  static oauthProviders = { local: localProvider };

  register(container: Container): void {
    // One map of codes, so the token endpoint finds what the authorization page issued.
    container.singleton(LocalOidcCodes);
    container.singleton(LocalOidc);
  }
}
