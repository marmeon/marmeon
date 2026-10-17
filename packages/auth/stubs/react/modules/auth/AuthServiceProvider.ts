import { PasskeyStore } from '@marmeon/auth/passkeys';
import { Auth, combineFactors, DatabaseSignIns, SignInStore, TwoFactorState, TwoFactorStore, UserProvider } from '@marmeon/auth';
import { clientKey, Limit, RateLimiter } from '@marmeon/cache';
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
    // Every sign-in is a row of the `marmeon_sign_ins` table (this module's migrations): the security page lists the browsers an account is signed in on,
    // and ends one by one. Removing this binding turns the list off — sessions and remember-me cookies then work as before.
    container.singleton(SignInStore, DatabaseSignIns);
    // The signed-in user's language — after the session's choice, before the browser's (SetLocale of @marmeon/i18n).
    container.scoped(LocalePreference, (c) => ({ preferredLocale: async () => (await c.make(Auth).user())?.locale }));
  }

  boot(app: Application): void {
    // Every page of the `web` group gets `auth` and `flash` (with the framework's shared props).
    app.container.make(Router).middleware.append('web', ShareAuthProps, MiddlewarePriority.shareProps);

    // Every limit that counts a client keys on clientKey(ctx.ip): an IPv6 address counts as its /64, the block one connection gets —
    // rotating through the addresses of it opens no new budget.
    // Reset links: a few requests per client (the broker also waits 60 s per e-mail). By client only — the e-mail is not
    // validated yet when middleware runs, and a limit never keys on raw input.
    const limiter = app.container.make(RateLimiter);
    limiter.for('password-reset', (ctx) => Limit.perMinute(5).by(clientKey(ctx.ip)));
    // Sign-ins: all password guesses of one client, whatever e-mail they name — the per-e-mail limit of LoginController
    // does not stop a client that tries one password each on many addresses. The /login route applies it.
    limiter.for('login-client', (ctx) => Limit.perMinute(30).by(clientKey(ctx.ip)));
    // Registrations: ten a minute per client — scripted sign-ups (and the mails they queue) are slowed down.
    limiter.for('register', (ctx) => Limit.perMinute(10).by(clientKey(ctx.ip)));
    // The options of a passkey sign-in: cheap, asked on every visit of the login page — a loose limit against load only.
    limiter.for('passkey-options', (ctx) => Limit.perMinute(30).by(clientKey(ctx.ip)));
    // The options of the passkey step after a password: asked once per sign-in, so a tighter limit of its own.
    limiter.for('passkey-challenge-options', (ctx) => Limit.perMinute(10).by(clientKey(ctx.ip)));
    // The options of a passkey confirmation of sudo mode: per user (the route is behind authenticate()), asked once per confirmation.
    limiter.for('passkey-confirm-options', (ctx) => Limit.perMinute(10).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
    // The options of a passkey step-up in a signed-in session: per user (the route is behind authenticate()), asked once per proof.
    limiter.for('passkey-step-up-options', (ctx) => Limit.perMinute(10).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
    // Resending the verification mail: per signed-in user (the route is behind authenticate()).
    limiter.for('verification', (ctx) => Limit.perMinute(3).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
    // Changing the address: every request sends a mail — to the new address or its owner (private registration). Per user.
    limiter.for('email-change', (ctx) => Limit.perMinute(6).by(String(ctx.user?.id ?? clientKey(ctx.ip))));
  }
}
