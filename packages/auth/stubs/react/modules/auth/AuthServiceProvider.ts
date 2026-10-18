import { PasskeyStore } from '@marmeon/auth/passkeys';
import { Auth, combineFactors, TwoFactorState, TwoFactorStore, UserProvider } from '@marmeon/auth';
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { LocalePreference } from '@marmeon/i18n';
import { MiddlewarePriority, Router } from '@marmeon/router';
import { ShareAuthProps } from './middleware/ShareAuthProps.ts';
import { UserRepository } from './UserRepository.ts';

export class AuthServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(UserRepository);
    // Authentication finds users through the repository.
    container.bind(UserProvider, (c) => c.make(UserRepository));
    // Accounts may set up a second factor: the authenticator app and passkeys (their tables are in this module's migrations). Removing this
    // binding switches two-factor authentication off for every account.
    container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore), c.make(PasskeyStore)));
    // The signed-in user's language — after the session's choice, before the browser's (SetLocale of @marmeon/i18n).
    container.scoped(LocalePreference, (c) => ({ preferredLocale: async () => (await c.make(Auth).user())?.locale }));
  }

  boot(app: Application): void {
    // Every page of the `web` group gets `auth` and `flash` (with the framework's shared props).
    app.container.make(Router).middleware.append('web', ShareAuthProps, MiddlewarePriority.shareProps);

    // The limits of this module's routes (`throttle('auth.login')` …) are defined by @marmeon/auth. To change one, define the limiter of
    // that name here with `app.container.make(RateLimiter).for('auth.login', …)`: yours replaces the default (docs/authentication.md#the-limits-of-the-auth-routes).
  }
}
