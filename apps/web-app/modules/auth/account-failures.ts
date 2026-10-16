import { createHash } from 'node:crypto';
import type { RateLimiter } from '@marmeon/cache';

/** Password sign-ins an account takes a day, until one succeeds; the next is refused whoever sends it. */
export const ACCOUNT_SIGN_INS = 100;
export const ACCOUNT_WINDOW_SECONDS = 86_400;

// The address is hashed: a cache key (and a cache dump) carries no personal datum. Known and unknown addresses get a key alike.
const digest = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** Counts the sign-ins against one account, however many clients they come from. */
export const accountKey = (email: string) => `login-account:${digest(email)}`;
/** Marks that the owner was told about the lockout of this window. */
export const accountNoticeKey = (email: string) => `login-account-notice:${digest(email)}`;

/** After a sign-in or a password reset: the owner is in again, so the count and the notice start over. */
export async function clearAccountFailures(limiter: RateLimiter, email: string): Promise<void> {
  await limiter.clear(accountKey(email));
  await limiter.clear(accountNoticeKey(email));
}
