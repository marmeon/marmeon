import type { PasskeySignInFailed } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import type { EventPayload } from '@marmeon/core';
import { PasskeyNotices } from '../passkey-notices.ts';

/**
 * A passkey of the account was presented for a sign-in and failed: the owner is told. At most one mail an hour for each account
 * (counted atomically), so nobody can fill an inbox by sending wrong answers. A queued listener.
 */
export class NotifyAboutFailedPasskeySignIn {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = 'auth.notify-about-failed-passkey-sign-in';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: PasskeyNotices;
  readonly #limiter: RateLimiter;

  constructor(notices: PasskeyNotices, limiter: RateLimiter) {
    this.#notices = notices;
    this.#limiter = limiter;
  }

  async handle(payload: EventPayload<typeof PasskeySignInFailed>): Promise<void> {
    const key = `passkey-failed-mail:${payload.userId}`;
    if (!(await this.#limiter.attempt(key, { maxAttempts: 1, decay: 3600 }))) return;
    try {
      await this.#notices.send(payload.userId, { kind: 'sign_in_failed', ip: payload.ip });
    } catch (error) {
      // The queue retries this listener: the hour must not already be spent by a mail that was never queued.
      await this.#limiter.clear(key);
      throw error;
    }
  }
}
