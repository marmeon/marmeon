import type { PasskeyRegistered } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { PasskeyNotices } from '../passkey-notices.ts';

/** A new passkey tells the owner — it signs in without the password, so if it was not them, they know their account was entered. A queued listener. */
export class NotifyAboutPasskeyRegistered {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = 'auth.notify-about-passkey-registered';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: PasskeyNotices;

  constructor(notices: PasskeyNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof PasskeyRegistered>): Promise<void> {
    await this.#notices.send(payload.userId, { kind: 'added', name: payload.name });
  }
}
