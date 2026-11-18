import { Auth, AuthConfig, TwoFactorState, UserProvider } from '@marmeon/auth';
import { onPasswordReset, reauthenticator } from '@marmeon/auth/internal';
import { Clock, EventDispatcher, Logger, type Application, type Container, type ServiceProvider } from '@marmeon/core';
import { Connections, SchemaRequirements } from '@marmeon/database';
import { OAuthProviders } from '../registry.ts';
import { SocialAccountsConfig } from './config.ts';
import { SocialAccounts } from './social-accounts.ts';
import { SocialUserProvider } from './users.ts';
import { SOCIAL_ACCOUNT_COLUMNS, SOCIAL_ACCOUNTS_TABLE, SocialAccountStore } from './store.ts';

/**
 * Registers `SocialAccountStore` and `SocialAccounts` (per request), has the password reset of an account with an unconfirmed address
 * remove its links, and reads `OAUTH_REGISTRATION` and `OAUTH_STORE_TOKENS`. Readiness waits for the `social_accounts` table, whose
 * migration comes with `marmeon publish @marmeon/oauth` (declared by `OAuthServiceProvider`). See docs/oauth.md#storing-tokens.
 */
export class SocialAccountsServiceProvider implements ServiceProvider {
  static config = [SocialAccountsConfig];

  register(container: Container): void {
    container.singleton(SocialAccountStore);
    // The capability to open the confirmation window, claimed once for this container (A12 for a second claim) and held only here: it goes
    // to `SocialAccounts`, which issues a proof after the checks of `confirm()` and for nothing else.
    const reauthentication = reauthenticator(container, 'oauth');
    // A link is a first factor, like an API token: the reset of an account whose address is not confirmed (`email_verified_at` is `null` or missing) removes them, in the transaction
    // of the reset. Whoever registered the address first may have linked an account of their own, and it must not let them in again.
    onPasswordReset(container, 'oauth', async ({ userId, emailConfirmed }) => {
      if (emailConfirmed) return;
      const removed = await container.make(SocialAccountStore).removeAll(userId);
      // The user and the count, never an address: an operator can see that the reset took links, and whose.
      if (removed > 0) container.make(Logger).info('A password reset removed the linked provider accounts of a user whose address is not confirmed', { user: userId, accounts: removed });
    });
    container.scoped(
      SocialAccounts,
      (scope) =>
        new SocialAccounts(
          scope.make(Auth),
          scope.make(UserProvider),
          scope.make(TwoFactorState),
          scope.make(SocialAccountStore),
          scope.make(OAuthProviders),
          scope.make(SocialAccountsConfig),
          scope.make(AuthConfig),
          scope.make(Connections),
          scope.make(EventDispatcher),
          // Asked only when a user is looked up, made or checked: `undefined` is the app's missing binding (A10), a bound provider that cannot be built throws its own error.
          () => (container.has(SocialUserProvider) ? scope.make(SocialUserProvider) : undefined),
          scope.make(Clock),
          scope.make(Logger),
          reauthentication,
        ),
    );
  }

  boot(app: Application): void {
    // Without a database nothing reads the table, and the requirement is registered on a container that has no readiness check to show it.
    app.container.make(SchemaRequirements).require({ connection: 'default', table: SOCIAL_ACCOUNTS_TABLE, columns: SOCIAL_ACCOUNT_COLUMNS, secrets: ['access_token', 'refresh_token'] });
  }
}
