import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { OAuthConfig } from './config.ts';
import type { OAuthProviderFactory } from './definition.ts';
import { buildProviders, OAuthProviders } from './registry.ts';

declare module '@marmeon/core' {
  interface ServiceProviderClass {
    /**
     * OAuth providers this provider brings, by name. The provider also lists `oauthCredentials(name)` in its `static config`.
     * See docs/oauth.md#your-own-provider.
     */
    readonly oauthProviders?: Readonly<Record<string, OAuthProviderFactory>>;
  }
}

/**
 * Registers `OAuthProviders`, built at the start from the providers that bring a name through `static oauthProviders`: a bad
 * name, a name twice, missing `oauthCredentials`, a definition that is wrong or an active provider without an `HttpClient`
 * stops the start. Found by `marmeon discover`. See docs/oauth.md#your-own-provider.
 */
export class OAuthServiceProvider implements ServiceProvider {
  static config = [OAuthConfig];
  static oauthProviders: Readonly<Record<string, OAuthProviderFactory>> = {};

  register(container: Container): void {
    container.singleton(OAuthProviders, () => buildProviders(container));
  }

  boot(app: Application): void {
    app.container.make(OAuthProviders);
  }
}
