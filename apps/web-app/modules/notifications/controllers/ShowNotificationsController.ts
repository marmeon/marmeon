import type { Authenticated } from '@marmeon/auth';
import { Encrypter } from '@marmeon/encryption';
import { Controller, defineRequest, merge, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { notificationsChannel } from '@marmeon/live';
import { Inbox, notificationData, type StoredNotification } from '@marmeon/notifications';
import { rules as r } from '@marmeon/validation';
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

/** The list's query: where "load more" goes on — an encrypted cursor (a made-up or changed one is a 400). */
export const ShowNotificationsRequest = defineRequest({
  query: r.query({ cursor: r.string().optional() }),
});

/** How many notifications a page of the list shows. */
export const NOTIFICATIONS_PER_PAGE = 10;

/** The signed-in user's notifications, newest first — read and unread, ten at a time ("load more" appends the next ten). */
export class ShowNotificationsController extends Controller {
  static request = ShowNotificationsRequest;

  readonly #inbox: Inbox;
  readonly #translator: Translator;
  readonly #encrypter: Encrypter;

  constructor(inbox: Inbox, translator: Translator, encrypter: Encrypter) {
    super();
    this.#inbox = inbox;
    this.#translator = translator;
    this.#encrypter = encrypter;
  }

  handle(ctx: ContextOf<typeof ShowNotificationsRequest> & Authenticated) {
    const me = { type: 'user', id: ctx.user.id } as const;
    // A partial reload with `?cursor=…` appends (`merge()` of a paginator: its `data`, matched on the id); a revalidation — the
    // reload after an action, a live hint — replaces the list (E183): a notification deleted meanwhile is gone.
    const notifications = merge(async () => {
      const page = await this.#inbox.page(me, { cursor: ctx.query.cursor, perPage: NOTIFICATIONS_PER_PAGE, encrypter: this.#encrypter });
      return { data: page.data.map((row) => this.#present(row)), meta: page.meta };
    }).matchOn('data.id');
    // Live (W6.10): a new notification — or one read or deleted in another tab — reloads the list (the bell is the layout's, shared).
    return this.view('notifications/Index', { notifications }).live(notificationsChannel(me), { only: ['notifications'] });
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
