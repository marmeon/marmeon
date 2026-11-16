import type { EventPayload } from '@marmeon/core';
import type { OfficeGuard } from './guard.ts';
import { OfficeNotices } from './OfficeNotices.ts';

/** Turning a second factor on tells the editor. Queued: the app lists it. */
export class NotifyEditorOfTwoFactorEnabled {
  /** Stable: queued jobs carry this name, never the class name. */
  static readonly listener = 'office.notify-two-factor-enabled';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };
  static readonly inject = [OfficeNotices] as const;

  readonly #notices: OfficeNotices;

  constructor(notices: OfficeNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof OfficeGuard.events.TwoFactorEnabled>): Promise<void> {
    await this.#notices.send(payload, { kind: 'twoFactorEnabled' });
  }
}
