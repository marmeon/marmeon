import type { Authenticated } from '@bespokecore/auth';
import { Controller, type HttpContext } from '@bespokecore/http';
import { Translator } from '@bespokecore/i18n';
import { notificationsChannel } from '@bespokecore/live';
import { Inbox, notificationData, type StoredNotification } from '@bespokecore/notifications';
import { NewSignInNotification } from '#modules/auth';

/** One notification as the list shows it — its text made here, in the reader's language. */
export interface NotificationItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** When it came (ISO-8601, UTC). */
  readonly at: string;
  readonly read: boolean;
}

/** The signed-in user's notifications, newest first — read and unread. */
export class ShowNotificationsController extends Controller {
  readonly #inbox: Inbox;
  readonly #translator: Translator;

  constructor(inbox: Inbox, translator: Translator) {
    super();
    this.#inbox = inbox;
    this.#translator = translator;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const notifications = await this.#inbox.latest({ type: 'user', id: ctx.user.id }, { limit: 50 });
    // Live (W6.10): a new notification — or one read in another tab — reloads the list (the bell is the layout's, shared).
    return this.view('notifications/Index', { notifications: notifications.map((row) => this.#present(row)) }).live(notificationsChannel({ type: 'user', id: ctx.user.id }), {
      only: ['notifications'],
    });
  }

  #present(row: StoredNotification): NotificationItem {
    const t = this.#translator;
    const base = { id: row.id, at: row.createdAt, read: row.readAt !== null };
    const signIn = notificationData(row, NewSignInNotification);
    if (signIn) {
      return { ...base, title: t.get('notifications.new_sign_in.title'), body: t.get('notifications.new_sign_in.body', { ip: signIn.ip ?? '—', browser: signIn.browser ?? '—' }) };
    }
    // A kind this app no longer shows (or a row a deploy changed): still listed, to be marked read.
    return { ...base, title: t.get('notifications.unknown'), body: '' };
  }
}
