import type { RecoveryCodeUsed } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { TwoFactorNotices } from '../two-factor-notices.ts';

/** A recovery code that signed in (or stepped up) tells the owner how many are left. A queued listener. */
export class NotifyAboutRecoveryCodeUsed {
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #notices: TwoFactorNotices;

  constructor(notices: TwoFactorNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof RecoveryCodeUsed>): Promise<void> {
    await this.#notices.send(payload.userId, { kind: 'recovery_used', remaining: payload.remaining });
  }
}
