import type { DatabaseData, NotificationStatics, RecipientRef } from './notification.ts';
import type { CursorEncrypter, CursorPaginated } from '@bespokecore/database';
import type { NotificationStore, StoredNotification } from './store.ts';

/**
 * A recipient's notifications of the `database` channel — **always bound to the recipient** (E92): every method takes
 * whose notifications it reads or changes, and an id of somebody else's notification finds nothing.
 *
 * ```ts
 * const me = { type: 'user', id: ctx.user.id } as const;
 * const unread = await this.#inbox.count(me);
 * if (!(await this.#inbox.markRead(me, ctx.params.notification))) abort(404);   // someone else's id: 404, nothing changed
 * ```
 *
 * The recipient comes from who is signed in — never from the request's input.
 */
export class Inbox {
  readonly #store: NotificationStore;

  constructor(store: NotificationStore) {
    this.#store = store;
  }

  /** The recipient's unread notifications, newest first (at most `limit`, default 20). */
  unread(recipient: RecipientRef, { limit = 20 }: { limit?: number } = {}): Promise<StoredNotification[]> {
    return this.#store.list(recipient, { unread: true, limit });
  }

  /** The recipient's notifications, read or not, newest first (at most `limit`, default 50). */
  latest(recipient: RecipientRef, { limit = 50 }: { limit?: number } = {}): Promise<StoredNotification[]> {
    return this.#store.list(recipient, { limit });
  }

  /**
   * A page of the recipient's notifications, newest first, for "load more": the next `perPage` (default 20) after `cursor`
   * (`meta.nextCursor` of the page before). The cursor is encrypted with the app key — inject `Encrypter` and pass it; one that is
   * not this list's answers 400.
   */
  page(recipient: RecipientRef, options: { cursor?: string | null | undefined; perPage?: number; encrypter: CursorEncrypter }): Promise<CursorPaginated<StoredNotification>> {
    return this.#store.page(recipient, options);
  }

  /** How many of the recipient's notifications are unread — the bell's number. */
  count(recipient: RecipientRef): Promise<number> {
    return this.#store.count(recipient);
  }

  /**
   * Marks one of the recipient's notifications read. `false` when the recipient has none with this id (unknown, or
   * somebody else's — answer 404 for both); `true` also when it was read already.
   */
  markRead(recipient: RecipientRef, id: string): Promise<boolean> {
    return this.#store.markRead(recipient, id);
  }

  /**
   * Deletes one of the recipient's notifications. `false` when the recipient has none with this id (unknown, or somebody
   * else's — answer 404 for both).
   */
  delete(recipient: RecipientRef, id: string): Promise<boolean> {
    return this.#store.delete(recipient, id);
  }

  /** Marks all of the recipient's notifications read — how many were unread. */
  markAllRead(recipient: RecipientRef): Promise<number> {
    return this.#store.markAllRead(recipient);
  }
}

/**
 * What a stored notification of class `N` holds — checked against `static database` (a row written before a deploy
 * changed it reads as `undefined`, not as something it is not):
 *
 * ```ts
 * const signIn = notificationData(row, NewSignInNotification);   // DatabaseData<typeof NewSignInNotification> | undefined
 * ```
 */
export function notificationData<N extends NotificationStatics & { readonly database: NonNullable<NotificationStatics['database']> }>(
  row: StoredNotification,
  notification: N,
): DatabaseData<N> | undefined {
  if (row.type !== notification.notification) return undefined;
  const result = notification.database['~standard'].validate(row.data);
  if (result instanceof Promise) throw new TypeError(`static database of ${notification.notification} validates asynchronously — notificationData() needs a synchronous schema.`);
  return result.issues ? undefined : (result.value as DatabaseData<N>);
}
