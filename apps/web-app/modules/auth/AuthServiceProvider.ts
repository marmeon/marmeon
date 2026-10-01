import { Auth, UserProvider } from '@bespokecore/auth';
import { Limit, RateLimiter } from '@bespokecore/cache';
import type { Application, Container, ServiceProvider } from '@bespokecore/core';
import { LocalePreference } from '@bespokecore/i18n';
import { UserRepository } from './UserRepository.ts';

export class AuthServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(UserRepository);
    // Authentication finds users through the repository (E24).
    container.bind(UserProvider, (c) => c.make(UserRepository));
    // The signed-in user's language — after the session's choice, before the browser's (SetLocale of @bespokecore/i18n).
    container.scoped(LocalePreference, (c) => ({ preferredLocale: async () => (await c.make(Auth).user())?.locale }));
  }

  boot(app: Application): void {
    // Reset links: a few requests per address (the broker also waits 60 s per e-mail). By IP only —
    // the e-mail is not validated yet when middleware runs (W2 rule: never raw input).
    const limiter = app.container.make(RateLimiter);
    limiter.for('password-reset', (ctx) => Limit.perMinute(5).by(ctx.ip ?? 'unknown'));
    // Resending the verification mail: per signed-in user (the route is behind authenticate()).
    limiter.for('verification', (ctx) => Limit.perMinute(3).by(String((ctx as { user?: { id: number } }).user?.id ?? ctx.ip)));
  }
}
