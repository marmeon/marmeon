import { Inbox } from '@marmeon/notifications';
import type { AccountDeleted } from '#modules/auth';

/** A deleted account's notifications go with it — in the deletion's transaction (the table is the app's own data). */
export class ClearInbox {
  readonly #inbox: Inbox;

  constructor(inbox: Inbox) {
    this.#inbox = inbox;
  }

  async handle(event: AccountDeleted): Promise<void> {
    await this.#inbox.deleteAll({ type: 'user', id: event.user.id });
  }
}
