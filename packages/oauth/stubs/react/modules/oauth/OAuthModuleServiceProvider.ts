import { hash } from 'node:crypto';
import { clientKey, Limit, RateLimiter, type LimiterCallback } from '@marmeon/cache';
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { SessionConfig, sessionCookieName } from '@marmeon/session';
import { SocialUserProvider } from '@marmeon/oauth/accounts';
import { LINK_STARTS_PER_DAY } from './limits.ts';
import { SocialUsers } from './SocialUsers.ts';

/** Every request from one client counts together: an IPv6 address counts as its /64, the block one connection gets. */
const perClient = (attempts: number): LimiterCallback => (ctx) => Limit.perMinute(attempts).by(clientKey(ctx.ip));

/** Every request of one signed-in user counts together, per minute and, with `daily`, per day; without a user, the requests of one client. */
const perUser = (attempts: number, daily?: number): LimiterCallback => (ctx) => {
  const id = (ctx.user as { id?: unknown } | undefined)?.id;
  const key = typeof id === 'string' || typeof id === 'number' ? `user:${id}` : clientKey(ctx.ip);
  return daily === undefined ? Limit.perMinute(attempts).by(key) : [Limit.perMinute(attempts).by(key), Limit.perDay(daily).by(key)];
};

export class OAuthModuleServiceProvider implements ServiceProvider {
  register(container: Container): void {
    // How the package finds and makes the users that sign in at a provider.
    container.bind(SocialUserProvider, SocialUsers);
  }

  boot(app: Application): void {
    // The limits of this module's routes. Define a limiter of the same name in your own provider to replace one: yours wins, whichever runs first.
    const limiter = app.container.make(RateLimiter);
    // Every start opens a flow in the session and may ask the provider for its endpoints.
    if (!limiter.limiter('oauth.redirect')) limiter.for('oauth.redirect', perClient(10));
    // Every callback trades a code with the provider and asks it who the person is. A callback counts against the browser's own session
    // when it carries one: strangers on the same address (a shared network) must not be able to use up the limit of a visitor who is
    // in the middle of signing in. A request without a session cookie shares the bucket of its client (a cookie the app did not seal reads
    // as no cookie, so a made-up one lands there too).
    if (!limiter.limiter('oauth.callback')) {
      const cookie = sessionCookieName(app.container.make(SessionConfig));
      limiter.for('oauth.callback', (ctx) => {
        const session = ctx.cookies.get(cookie);
        const client = clientKey(ctx.ip);
        // A hash, never the session id itself: the id is a secret and does not belong in the cache's keys.
        if (typeof session !== 'string' || session === '') return Limit.perMinute(20).by(client);
        return Limit.perMinute(20).by(`session:${hash('sha256', session, 'base64url')}`);
      });
    }
    // Linking, and confirming with a provider, start flows like the sign-in does, but only for signed-in people (`authenticate()` runs before the
    // limit). They count per user, so one account cannot use up the limit of another on a shared address. Every link mails its owner; the
    // daily cap on starts bounds the mails of links made on the panel, and the listener's own cap (`limits.ts`, four times the daily starts) lies above anything decoys can reach there: a callback completes up to ten minutes
    // after its start, so the starts of three daily windows can land inside one day of mails.
    if (!limiter.limiter('oauth.link')) limiter.for('oauth.link', perUser(10, LINK_STARTS_PER_DAY));
    if (!limiter.limiter('oauth.confirm')) limiter.for('oauth.confirm', perUser(10));
  }
}
