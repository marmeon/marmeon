import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { SchemaRequirements } from '@marmeon/database';
import { SocialAccountsConfig } from './config.ts';
import { SOCIAL_ACCOUNT_COLUMNS, SOCIAL_ACCOUNTS_TABLE, SocialAccountStore } from './store.ts';

/**
 * Registers `SocialAccountStore` and reads `OAUTH_REGISTRATION` and `OAUTH_STORE_TOKENS`. Readiness waits for the `social_accounts` table
 * the app's migration creates. See docs/oauth.md#storing-tokens.
 */
export class SocialAccountsServiceProvider implements ServiceProvider {
  static config = [SocialAccountsConfig];

  register(container: Container): void {
    container.singleton(SocialAccountStore);
  }

  boot(app: Application): void {
    // Without a database nothing reads the table, and the requirement is registered on a container that has no readiness check to show it.
    app.container.make(SchemaRequirements).require({ connection: 'default', table: SOCIAL_ACCOUNTS_TABLE, columns: SOCIAL_ACCOUNT_COLUMNS, secrets: ['access_token', 'refresh_token'] });
  }
}
