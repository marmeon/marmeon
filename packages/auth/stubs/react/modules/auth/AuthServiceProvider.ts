import { PasskeyStore } from '@marmeon/auth/passkeys';
import { Auth, combineFactors, TwoFactorState, TwoFactorStore, UserProvider } from '@marmeon/auth';
import { Limit, RateLimiter } from '@marmeon/cache';
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

    // Reset links: a few requests per address (the broker also waits 60 s per e-mail). By IP only —
    // the e-mail is not validated yet when middleware runs (never on raw input).
    const limiter = app.container.make(RateLimiter);
    limiter.for('password-reset', (ctx) => Limit.perMinute(5).by(ctx.ip ?? 'unknown'));
    // Registrations: ten a minute per IP — scripted sign-ups (and the mails they queue) are slowed down.
    limiter.for('register', (ctx) => Limit.perMinute(10).by(ctx.ip ?? 'unknown'));
    // The options of a passkey sign-in: cheap, asked on every visit of the login page — a loose limit against load only.
    limiter.for('passkey-options', (ctx) => Limit.perMinute(30).by(ctx.ip ?? 'unknown'));
    // The options of the passkey step after a password: asked once per sign-in, so a tighter limit of its own.
    limiter.for('passkey-challenge-options', (ctx) => Limit.perMinute(10).by(ctx.ip ?? 'unknown'));
    // The options of a passkey step-up in a signed-in session: per user (the route is behind authenticate()), asked once per proof.
    limiter.for('passkey-step-up-options', (ctx) => Limit.perMinute(10).by(String(ctx.user?.id ?? ctx.ip)));
    // Resending the verification mail: per signed-in user (the route is behind authenticate()).
    limiter.for('verification', (ctx) => Limit.perMinute(3).by(String(ctx.user?.id ?? ctx.ip)));
    // Changing the address: every request sends a mail — to the new address or its owner (private registration). Per user.
    limiter.for('email-change', (ctx) => Limit.perMinute(6).by(String(ctx.user?.id ?? ctx.ip)));
  }
}
