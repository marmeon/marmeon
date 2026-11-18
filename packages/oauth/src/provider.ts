import { Clock, EnvironmentConfig, Logger, type Application, type Container, type ServiceProvider } from '@marmeon/core';
import type { ProviderMigrations } from '@marmeon/database';
import { HttpClient } from '@marmeon/fetch';
import { Session, SessionConfig } from '@marmeon/session';
import type { CommandClass } from 'marmeon';
import { OAuthConfig } from './config.ts';
import { oauthCredentials } from './credentials.ts';
import type { OAuthProviderFactory } from './definition.ts';
import { MakeOAuthCommand } from './make-oauth.ts';
import { MakeSocialAccountsTableCommand } from './make-social-accounts-table.ts';
import { OAuth } from './oauth.ts';
import { discord } from './providers/discord.ts';
import { github } from './providers/github.ts';
import { gitlab } from './providers/gitlab.ts';
import { google } from './providers/google.ts';
import { microsoft } from './providers/microsoft.ts';
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
 * Registers `OAuthProviders`, built at the start from the providers that bring a name through `static oauthProviders` (a bad
 * name, a name twice, missing `oauthCredentials`, a definition that is wrong or an active provider without an `HttpClient`
 * stops the start), and `OAuth` for each request. Found by `marmeon discover`. The built-in providers (GitHub, Google, Microsoft,
 * GitLab and Discord) come through the same record, so their names are taken. Brings the commands `make:oauth`, which writes the sign-in module into the app, and `make:social-accounts-table`, which writes the migration of the `social_accounts` table (`marmeon publish` copies it too). See docs/oauth.md#the-built-in-providers and docs/oauth.md#the-generated-module.
 */
export class OAuthServiceProvider implements ServiceProvider {
  static config = [
    OAuthConfig,
    oauthCredentials('github'),
    oauthCredentials('google'),
    oauthCredentials('microsoft', { options: ['TENANT'] }),
    oauthCredentials('gitlab', { issuer: 'optional' }),
    oauthCredentials('discord'),
  ];
  static commands: readonly CommandClass[] = [MakeOAuthCommand, MakeSocialAccountsTableCommand];
  // The migration of `social_accounts`, which `marmeon make:social-accounts-table` and `marmeon publish @marmeon/oauth` copy into the app's `system` module. It is declared here and not on
  // `SocialAccountsServiceProvider`: publish reads only the providers a package exports at its main entry, and the table serves `@marmeon/oauth/accounts`.
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'system' } satisfies ProviderMigrations;
  static oauthProviders: Readonly<Record<string, OAuthProviderFactory>> = { github, google, microsoft, gitlab, discord };

  register(container: Container): void {
    container.singleton(OAuthProviders, () => buildProviders(container));
    // The session package is optional until a flow starts, so a missing binding is `undefined` here and any other failure passes through.
    // Per request: it writes into the session of the browser that asks.
    container.scoped(OAuth, (c) => {
      const node = c.make(EnvironmentConfig).node;
      return new OAuth(c.make(OAuthProviders), () => (container.has(Session) ? c.make(Session) : undefined), () => (container.has(SessionConfig) ? c.make(SessionConfig) : undefined), () => c.make(HttpClient), c.make(OAuthConfig), c.make(Clock), c.make(Logger), node === 'development' || node === 'test');
    });
  }

  boot(app: Application): void {
    app.container.make(OAuthProviders);
  }
}
