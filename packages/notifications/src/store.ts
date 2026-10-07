import type { Clock } from '@marmeon/core';
import { cursorPaginate, sql, type Connections, type CursorEncrypter, type CursorPaginated } from '@marmeon/database';
import type { AnyRecipient } from './notification.ts';

/** The table `marmeon make:notifications-table` creates (E96: the app owns the migration; this package types it itself). */
export const NOTIFICATIONS_TABLE = 'notifications';

interface NotificationTable {
  id: string;
  recipient_type: string;
  recipient_id: string;
  type: string;
  data: unknown;
  read_at: string | Date | null;
  created_at: string | Date;
}
type Tables = { [NOTIFICATIONS_TABLE]: NotificationTable };

/** A notification as the inbox reads it: its id, its name (`static notification`), what `toDatabase()` returned, when it was read and came (ISO-8601, UTC). */
export interface StoredNotification {
  readonly id: string;
  readonly type: string;
  readonly data: unknown;
  readonly readAt: string | null;
  readonly createdAt: string;
}

/** A notification's id — a UUID. Anything else is no id of ours (and never reaches a Postgres `uuid` comparison). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNotificationId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

/**
 * The `notifications` table. Every read and every change of a recipient's notifications is bound to that recipient —
 * `where recipient_type = ? and recipient_id = ?` in the same statement (E92): an id of someone else's notification
 * finds nothing. The app's code uses the `Inbox`, which only offers that.
 *
 * Queries go through the app's connection (`NOTIFICATIONS_CONNECTION`, default `default`) and so join a
 * `connections.transaction()` around them (E107) — a delivery writes its row and queues its mail in one transaction.
 */
export class NotificationStore {
  readonly #connections: Connections;
  readonly #connection: string;
  readonly #clock: Clock;

  constructor(connections: Connections, connection: string, clock: Clock) {
    this.#connections = connections;
    this.#connection = connection;
    this.#clock = clock;
  }

  /** The connection's name — deliveries run in a transaction on it. */
  get connection(): string {
    return this.#connection;
  }

  async insert(row: { readonly id: string; readonly recipient: AnyRecipient; readonly type: string; readonly data: unknown }): Promise<void> {
    await this.#db()
      .insertInto(NOTIFICATIONS_TABLE)
      .values({
        id: row.id,
        recipient_type: row.recipient.type,
        recipient_id: String(row.recipient.id),
        type: row.type,
        data: JSON.stringify(row.data),
        read_at: null,
        created_at: new Date(this.#clock.now()),
      })
      .execute();
  }

  /** Whether a notification with this id was stored already — a delivery that ran before (at-least-once, E85). */
  async exists(id: string): Promise<boolean> {
    if (!isNotificationId(id)) return false;
    return (await this.#db().selectFrom(NOTIFICATIONS_TABLE).select('id').where('id', '=', id).executeTakeFirst()) !== undefined;
  }

  /** The recipient's notifications, newest first — only the unread ones with `unread: true`. */
  async list(recipient: AnyRecipient, { unread = false, limit = 50 }: { unread?: boolean; limit?: number } = {}): Promise<StoredNotification[]> {
    let query = this.#db()
      .selectFrom(NOTIFICATIONS_TABLE)
      .select(['id', 'type', 'data', 'read_at', 'created_at'])
      .where('recipient_type', '=', recipient.type)
      .where('recipient_id', '=', String(recipient.id));
    if (unread) query = query.where('read_at', 'is', null);
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(Math.max(1, Math.min(limit, 500))).execute();
    return rows.map((row) => ({ id: row.id, type: row.type, data: row.data, readAt: iso(row.read_at), createdAt: iso(row.created_at)! }));
  }

  /**
   * A page of the recipient's notifications, newest first — keyset by (`created_at`, `id`), the cursor encrypted (`encrypter`): for
   * "load more". A cursor that is not one of this list's answers 400.
   */
  async page(recipient: AnyRecipient, { cursor, perPage = 20, encrypter }: { cursor?: string | null | undefined; perPage?: number; encrypter: CursorEncrypter }): Promise<CursorPaginated<StoredNotification>> {
    const query = this.#db()
      .selectFrom(NOTIFICATIONS_TABLE)
      .select(['id', 'type', 'data', 'read_at', 'created_at'])
      .where('recipient_type', '=', recipient.type)
      .where('recipient_id', '=', String(recipient.id));
    // The recipient's own cursors only (`name`): one of another recipient's inbox does not decrypt here.
    const name = `notifications:${JSON.stringify([recipient.type, String(recipient.id)])}`;
    const page = await cursorPaginate(query, { column: 'created_at', key: 'id', cursor, perPage: Math.max(1, Math.min(perPage, 500)), direction: 'desc', encrypter, name });
    return { data: page.data.map((row) => ({ id: row.id, type: row.type, data: row.data, readAt: iso(row.read_at), createdAt: iso(row.created_at)! })), meta: page.meta };
  }

  /** Deletes one of the recipient's notifications. `false` when the recipient has none with this id — someone else's is no different from none. */
  async delete(recipient: AnyRecipient, id: string): Promise<boolean> {
    if (!isNotificationId(id)) return false;
    const result = await this.#db()
      .deleteFrom(NOTIFICATIONS_TABLE)
      .where('recipient_type', '=', recipient.type)
      .where('recipient_id', '=', String(recipient.id))
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Deletes all of the recipient's notifications — how many. */
  async deleteAll(recipient: AnyRecipient): Promise<number> {
    const result = await this.#db()
      .deleteFrom(NOTIFICATIONS_TABLE)
      .where('recipient_type', '=', recipient.type)
      .where('recipient_id', '=', String(recipient.id))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** How many of the recipient's notifications are unread. */
  async count(recipient: AnyRecipient): Promise<number> {
    const row = await this.#db()
      .selectFrom(NOTIFICATIONS_TABLE)
      .select((eb) => eb.fn.countAll<number | string>().as('count'))
      .where('recipient_type', '=', recipient.type)
      .where('recipient_id', '=', String(recipient.id))
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /**
   * Marks one of the recipient's notifications read (one that was read already keeps its time). `false` when the
   * recipient has no notification with this id — someone else's is no different from none.
   */
  async markRead(recipient: AnyRecipient, id: string): Promise<boolean> {
    if (!isNotificationId(id)) return false;
    const now = new Date(this.#clock.now());
    const result = await this.#db()
      .updateTable(NOTIFICATIONS_TABLE)
      .set({ read_at: sql<Date>`coalesce(read_at, ${now})` })
      .where('recipient_type', '=', recipient.type)
      .where('recipient_id', '=', String(recipient.id))
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Marks all of the recipient's unread notifications read — how many. */
  async markAllRead(recipient: AnyRecipient): Promise<number> {
    const result = await this.#db()
      .updateTable(NOTIFICATIONS_TABLE)
      .set({ read_at: new Date(this.#clock.now()) })
      .where('recipient_type', '=', recipient.type)
      .where('recipient_id', '=', String(recipient.id))
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * Deletes, in one statement, the notifications read before `readBefore` — and, with `unreadBefore`, the unread ones
   * that came before it (left alone by default: unread is unread). How many.
   */
  async prune({ readBefore, unreadBefore }: { readBefore: Date; unreadBefore?: Date | undefined }): Promise<number> {
    const result = await this.#db()
      .deleteFrom(NOTIFICATIONS_TABLE)
      .where((eb) =>
        eb.or([
          eb.and([eb('read_at', 'is not', null), eb('read_at', '<', readBefore)]),
          ...(unreadBefore ? [eb.and([eb('read_at', 'is', null), eb('created_at', '<', unreadBefore)])] : []),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #db() {
    return this.#connections.get<Tables>(this.#connection);
  }
}

function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
