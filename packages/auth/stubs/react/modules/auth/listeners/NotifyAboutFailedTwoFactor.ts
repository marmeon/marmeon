import type { TwoFactorChallengeFailed } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import type { EventPayload } from '@marmeon/core';
import { TwoFactorNotices } from '../two-factor-notices.ts';

/**
 * A wrong second factor after the right password means somebody knows the password: the owner is told. At most one mail an hour
 * for each account (counted atomically), so nobody can fill an inbox by guessing codes. A wrong code from a session that is already
 * signed in (`during: 'step-up'`) sends nothing. A queued listener.
 */
export class NotifyAboutFailedTwoFactor {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = 'auth.notify-about-failed-two-factor';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: TwoFactorNotices;
  readonly #limiter: RateLimiter;

  constructor(notices: TwoFactorNotices, limiter: RateLimiter) {
    this.#notices = notices;
    this.#limiter = limiter;
  }

  async handle(payload: EventPayload<typeof TwoFactorChallengeFailed>): Promise<void> {
    if (payload.during !== 'sign-in') return;
    const key = `two-factor-failed-mail:${payload.userId}`;
    if (!(await this.#limiter.attempt(key, { maxAttempts: 1, decay: 3600 }))) return;
    try {
      await this.#notices.send(payload.userId, { kind: 'failed', at: payload.at, ip: payload.ip });
    } catch (error) {
      // The queue retries this listener: the hour must not already be spent by a mail that was never queued.
      await this.#limiter.clear(key);
      throw error;
    }
  }
}
