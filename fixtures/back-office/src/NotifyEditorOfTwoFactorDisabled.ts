import type { EventPayload } from '@marmeon/core';
import type { OfficeGuard } from './guard.ts';
import { OfficeNotices } from './OfficeNotices.ts';

/** Turning the authenticator app off tells the editor, and says whether a passkey still protects the account. The operator's removal and a reset are told apart. Queued: the app lists it. */
export class NotifyEditorOfTwoFactorDisabled {
  /** Stable: queued jobs carry this name, never the class name. */
  static readonly listener = 'office.notify-two-factor-disabled';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };
  static readonly inject = [OfficeNotices] as const;

  readonly #notices: OfficeNotices;

  constructor(notices: OfficeNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof OfficeGuard.events.TwoFactorDisabled>): Promise<void> {
    await this.#notices.sendTwoFactorDisabled(payload);
  }
}
