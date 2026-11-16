import type { EventPayload } from '@marmeon/core';
import type { OfficeGuard } from './guard.ts';
import { OfficeNotices } from './OfficeNotices.ts';

/** A new passkey tells the editor: it signs in without the password. Queued: the app lists it. */
export class NotifyEditorOfPasskeyAdded {
  /** Stable: queued jobs carry this name, never the class name. */
  static readonly listener = 'office.notify-passkey-added';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };
  static readonly inject = [OfficeNotices] as const;

  readonly #notices: OfficeNotices;

  constructor(notices: OfficeNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof OfficeGuard.events.PasskeyRegistered>): Promise<void> {
    await this.#notices.send(payload, { kind: 'passkeyAdded' });
  }
}
