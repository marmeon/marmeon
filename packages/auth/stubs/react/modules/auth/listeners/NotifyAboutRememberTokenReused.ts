import type { RememberTokenReused } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { SignInNotices } from '../sign-in-notices.ts';

/**
 * A "keep me signed in" cookie came back after it had been replaced: it was copied, and every session of the account is ended. The
 * owner is told when, from where and which browser — the request may have been the owner's own or the holder of the copy. A queued
 * listener.
 */
export class NotifyAboutRememberTokenReused {
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: SignInNotices;

  constructor(notices: SignInNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof RememberTokenReused>): Promise<void> {
    await this.#notices.send(payload.userId, { kind: 'remember_reused', at: payload.at, ip: payload.ip, userAgent: payload.userAgent, sessionsEnded: payload.sessionsEnded });
  }
}
