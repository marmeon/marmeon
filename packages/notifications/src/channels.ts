import type { Resolver, Translator } from '@marmeon/core';
import type { AnyRecipient, NotificationClass, NotificationInstance, NotificationMail } from './notification.ts';
import { NotificationError, NotificationSetupError } from './registry.ts';
import type { NotificationStore } from './store.ts';
import { describeFields, NotificationDataError } from './validate.ts';
import { withCode } from '@marmeon/core/internal';

/**
 * One notification on its way to one recipient — what a channel gets. Built where the notification is delivered (a
 * worker, or the process that called `sendNow`), after the recipient was found again.
 */
export interface Delivery {
  /** The notification's id — a UUID, the same over every attempt of its job (the `notifications` row has it). */
  readonly id: string;
  /** Its name, `static notification`. */
  readonly type: string;
  readonly class: NotificationClass;
  /** The instance — built through the container for this delivery. */
  readonly notification: NotificationInstance;
  /** Who it is for, as it was sent: `{ type: 'user', id: 7 }`. */
  readonly recipient: AnyRecipient;
  /** The recipient's record, as its resolver found it now. */
  readonly record: unknown;
  /** Its data — the output of `static schema`. */
  readonly data: unknown;
  /** A translator in the recipient's language (its resolver's `locale()`, else `APP_LOCALE`). */
  readonly translator: Translator;
  /** Where queued work of the delivery goes (the notification's `static queue`): its mail, for one. */
  readonly queue: { readonly queue?: string; readonly connection?: string };
  /** The container of the delivery's scope (a job's, or the caller's). */
  readonly container: Resolver;
}

/**
 * A way to reach a recipient: a package or an app adds its name to `NotificationChannelMap` and registers it at boot.
 * A delivery's channels run inside one transaction: what a channel writes or queues commits with the `notifications`
 * row. A push channel sends a **generic** text — a notification's text shows on a lock screen and passes the push
 * service. See `docs/notifications.md#a-channel-of-your-own`.
 */
export interface NotificationChannel {
  deliver(delivery: Delivery): Promise<void>;
}

/** Builds a channel for a delivery, from that delivery's container. */
export type ChannelFactory = (container: Resolver) => NotificationChannel;

/** The app's channels by name — `mail` and `database` and whatever packages add. One per application. */
export class NotificationChannels {
  readonly #factories = new Map<string, ChannelFactory>();

  add(name: string, factory: ChannelFactory): this {
    if (this.#factories.has(name)) throw new NotificationSetupError(withCode('Q6', `Two notification channels are named "${name}" — a channel's name is what via() returns.`));
    this.#factories.set(name, factory);
    return this;
  }

  has(name: string): boolean {
    return this.#factories.has(name);
  }

  names(): string[] {
    return [...this.#factories.keys()];
  }

  make(name: string, container: Resolver): NotificationChannel {
    const factory = this.#factories.get(name);
    if (!factory) {
      const hint = name === 'mail' ? ' (the mail channel needs @marmeon/mail: pnpm add @marmeon/mail; marmeon discover)' : '';
      throw new NotificationError(`via() returned the channel "${name}", which this app does not have${hint}. Channels: ${this.names().join(', ') || 'none'}.`);
    }
    return factory(container);
  }
}

/** The `database` channel: a row in `notifications` — what `toDatabase()` returned, as `static database` describes it. */
export class DatabaseChannel implements NotificationChannel {
  readonly #store: NotificationStore;

  constructor(store: NotificationStore) {
    this.#store = store;
  }

  async deliver(delivery: Delivery): Promise<void> {
    const { class: Class, notification } = delivery;
    const toDatabase = (notification as { toDatabase?: (data: unknown, recipient: unknown) => unknown }).toDatabase;
    if (typeof toDatabase !== 'function') throw new NotificationError(`${Class.name} (${delivery.type}) goes through the database channel, but has no toDatabase(data, recipient) method.`);
    if (!Class.database) throw new NotificationError(`${Class.name} (${delivery.type}) goes through the database channel and needs static database — the schema of what toDatabase() returns.`);
    const value = await toDatabase.call(notification, delivery.data, delivery.record);
    const result = await Class.database['~standard'].validate(value);
    if (result.issues) throw new NotificationDataError(`${Class.name} (${delivery.type}): toDatabase() returned what static database rejects (fields: ${describeFields(result.issues)}).`, result.issues);
    // Only what the schema let through is stored (a field it does not know stays out).
    await this.#store.insert({ id: delivery.id, recipient: delivery.recipient, type: delivery.type, data: result.value });
  }
}

/** Queues a mail — `mailer.queue` of @marmeon/mail, so its transport (and its retries) are the mail job's. */
export type QueueMail = (mail: NotificationMail, options: { readonly queue?: string; readonly connection?: string }) => Promise<unknown>;

/**
 * The `mail` channel: `toMail(recipient, data, t)` composes the mail in the recipient's language, and it is **queued**
 * (`mailer.queue`: composed now, encrypted, sent by a worker) on the notification's queue. A mail server that is down
 * retries the mail alone — never the notification's other channels. With a database queue on the same connection the
 * queued mail is part of the delivery's transaction.
 */
export class MailChannel implements NotificationChannel {
  readonly #queue: QueueMail;

  constructor(queue: QueueMail) {
    this.#queue = queue;
  }

  async deliver(delivery: Delivery): Promise<void> {
    const { class: Class, notification } = delivery;
    const toMail = (notification as { toMail?: (recipient: unknown, data: unknown, t: Translator) => NotificationMail | Promise<NotificationMail> }).toMail;
    if (typeof toMail !== 'function') throw new NotificationError(`${Class.name} (${delivery.type}) goes through the mail channel, but has no toMail(recipient, data, t) method.`);
    const mail = await toMail.call(notification, delivery.record, delivery.data, delivery.translator);
    await this.#queue(mail, delivery.queue);
  }
}
