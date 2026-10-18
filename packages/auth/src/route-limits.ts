import { clientKey, Limit, type LimiterCallback, type RateLimiter } from '@marmeon/cache';

/** Every request from one client counts together: an IPv6 address counts as its /64, the block one connection gets. */
const perClient = (attempts: number): LimiterCallback => (ctx) => Limit.perMinute(attempts).by(clientKey(ctx.ip));
/**
 * Per signed-in user (the route is behind `authenticate()`); the client's key is the fallback for a route that is not. The cast: an app that
 * has not declared its user type (`AuthTypes`) has no `id` to read here.
 */
const userKey = (ctx: Parameters<LimiterCallback>[0]) => String((ctx.user as { id?: unknown } | undefined)?.id ?? clientKey(ctx.ip));
const perUser = (attempts: number): LimiterCallback => (ctx) => Limit.perMinute(attempts).by(userKey(ctx));

// A limit never keys on raw input: the e-mail of a form is not validated yet when middleware runs.
const LIMITS = {
  // All password guesses of one client, whatever e-mail they name — the limit per client and e-mail inside `Auth.attempt()` does not
  // stop a client that tries one password on many addresses. It counts separately from that one.
  'auth.login': perClient(30),
  // Scripted sign-ups, and the mails they queue.
  'auth.register': perClient(10),
  // A few requests per client; the broker also waits 60 s per e-mail.
  'auth.password-reset-link': perClient(5),
  // Every request looks a token up and hashes a new password.
  'auth.password-reset': perClient(10),
  // A code is checked per account inside `TwoFactor`; this stops the load before it gets there (session lock, hashing).
  'auth.two-factor-challenge': perClient(10),
  // The options are cheap and asked on every visit of the login page: a loose limit against load only.
  'auth.passkey-sign-in-options': perClient(30),
  // The answer is verified cryptographically before any account throttle counts.
  'auth.passkey-sign-in': perClient(10),
  // The options of the passkey step after a password: asked once per sign-in.
  'auth.passkey-challenge-options': perClient(10),
  'auth.passkey-challenge': perClient(10),
  // The options of a passkey confirmation or step-up in a signed-in session: asked once per proof.
  'auth.passkey-confirm-options': perUser(10),
  'auth.passkey-step-up-options': perUser(10),
  // Resending the verification mail: every request sends one to the same address, so a day's limit comes with the minute's.
  'auth.verification': (ctx) => [Limit.perMinute(3).by(userKey(ctx)), Limit.perDay(10).by(userKey(ctx))],
  // Every request sends a mail — to the new address or its owner (private registration).
  'auth.email-change': perUser(6),
} as const satisfies Record<string, LimiterCallback>;

/**
 * Defines the rate limits of the auth routes (`throttle('auth.login')` …) unless a limiter of that name exists. An app that defines one of
 * the names itself replaces the default, whether it does so before or after this runs. See `docs/authentication.md#the-limits-of-the-auth-routes`.
 */
export function defineAuthRouteLimits(limiter: RateLimiter): void {
  for (const [name, callback] of Object.entries(LIMITS)) {
    if (!limiter.limiter(name)) limiter.for(name, callback);
  }
}
