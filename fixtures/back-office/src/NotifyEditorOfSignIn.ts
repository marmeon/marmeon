import type { EventPayload } from '@marmeon/core';
import type { OfficeGuard } from './guard.ts';
import { OfficeNotices } from './OfficeNotices.ts';

/** A sign-in of an editor tells the editor, whichever way it happened: if it was not them, they know their account was entered. Queued: the app lists it. */
export class NotifyEditorOfSignIn {
  /** Stable: queued jobs carry this name, never the class name. */
  static readonly listener = 'office.notify-signed-in';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };
  static readonly inject = [OfficeNotices] as const;

  readonly #notices: OfficeNotices;

  constructor(notices: OfficeNotices) {
    this.#notices = notices;
  }

  async handle(payload: EventPayload<typeof OfficeGuard.events.SignedIn>): Promise<void> {
    await this.#notices.send(payload, { kind: 'signedIn', at: payload.at });
  }
}
