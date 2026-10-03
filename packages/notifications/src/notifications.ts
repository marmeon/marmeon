import { randomUUID } from 'node:crypto';
import { token, type Application, type Duration, type Resolver, type StandardSchemaV1, type Translator } from '@bespokecore/core';
import { channels, messageBase, trace, type NotificationSendMessage } from '@bespokecore/core/diagnostics';
import type { Connections } from '@bespokecore/database';
import type { NotificationChannels } from './channels.ts';
import type { AnyRecipient, CheckNotification, NotificationClass, Recipients, RecipientTypeOf, SendResult } from './notification.ts';
import { NotificationError, type NotificationRegistry, type RecipientRegistry } from './registry.ts';
import type { NotificationStore } from './store.ts';
import { toJson, validate } from './validate.ts';

/** When a notification is delivered (`send` only). */
export interface SendOptions {
  /** Deliver no earlier than this — seconds, or a duration (`{ minutes: 5 }`). Default: the notification's `static queue.delay`. */
  readonly delay?: number | Duration;
}

type SchemaInput<S> = S extends StandardSchemaV1 ? NonNullable<S['~standard']['types']>['input'] : never;
/** What a notification class is sent with — the input of its `static schema` (never, for a class without one). */
export type SendData<N> = N extends { readonly schema: infer S extends StandardSchemaV1 } ? SchemaInput<S> : never;

/**
 * Sends notifications (E92) — `constructor(notifications: Notifications)`:
 *
 * ```ts
 * await this.#notifications.send({ type: 'user', id: user.id }, NewSignInNotification, { at, ip, agent });   // queued
 * await this.#notifications.sendNow({ type: 'user', id: user.id }, NewSignInNotification, { at, ip, agent }); // here and now
 * ```
 *
 * The recipient is data — its kind and id (`interface NotificationRecipients`) —, looked up again where the
 * notification is delivered; `via(recipient, data)` decides the channels then.
 */
export interface Notifications {
  /**
   * Checks the data against the notification's schema **now** and queues the delivery (`bespoke.notification`, encrypted)
   * — one job per recipient, on the notification's `static queue`. A worker finds the recipient, asks `via()` and
   * delivers through each channel. Inside `connections.transaction()` it is queued only if the transaction commits
   * (E107). Resolves with the notification's id (one per recipient for a list). Needs @bespokecore/queue.
   */
  send<const R extends Recipients, N extends abstract new (...args: any[]) => object>(
    recipient: R,
    notification: N & CheckNotification<N, RecipientTypeOf<R>>,
    data: SendData<N>,
    options?: SendOptions,
  ): Promise<SendResult<R>>;
  /**
   * Delivers now, in this process — no notification job (e.g. in a job or a queued listener that runs in a worker
   * already). The `notifications` row is written before it resolves; a mail is composed now and queued like every mail
   * (`mailer.queue`). Inside `connections.transaction()` the delivery is part of it.
   */
  sendNow<const R extends Recipients, N extends abstract new (...args: any[]) => object>(
    recipient: R,
    notification: N & CheckNotification<N, RecipientTypeOf<R>>,
    data: SendData<N>,
  ): Promise<SendResult<R>>;
}
export const Notifications = token<Notifications>('Notifications');

/** A delivery could not happen and never will by trying again — `via()` named a channel the app does not have, … */
export class NotificationChannelError extends NotificationError {
  override name = 'NotificationChannelError';
}

/** What happened to a delivery: done, the recipient is gone, or it was done before (the `notifications` row exists). */
export type DeliveryOutcome = 'delivered' | 'gone' | 'delivered-before';

/** One notification for one recipient, ready to deliver. */
export interface PendingDelivery {
  readonly id: string;
  readonly notification: NotificationClass;
  readonly recipient: AnyRecipient;
  /** The data — the output of the notification's `static schema`. */
  readonly data: unknown;
}

export interface DelivererDependencies {
  readonly recipients: RecipientRegistry;
  readonly channels: NotificationChannels;
  readonly store: NotificationStore;
  readonly connections: Connections;
  /** A translator in `locale` (the recipient's), else `APP_LOCALE`. */
  readonly translator: (locale: string | null | undefined, container: Resolver) => Translator;
  /** The app its deliveries are reported for on the `notification.send` channel (E118). */
  readonly app?: Application;
}

const sends = channels.tracing('notification.send');

/** A `notification.send` message — built only while something listens. */
function sendMessage(app: Application, pending: PendingDelivery, queued: boolean): NotificationSendMessage {
  return {
    ...messageBase(app),
    notification: pending.notification.notification,
    id: pending.id,
    recipient: { type: pending.recipient.type, id: pending.recipient.id },
    queued,
  };
}

/**
 * Delivers one notification to one recipient — for a worker (`bespoke.notification`) and for `sendNow`:
 *
 * 1. the recipient's record, by its kind's resolver (gone: nothing is delivered);
 * 2. `via(record, data)` — the channels, each known to the app;
 * 3. the recipient's language (`locale()` of the resolver) — mails are composed in it;
 * 4. in **one transaction** of the notifications' connection: the `database` channel first, then the others in the
 *    order `via()` gave them. A row with the notification's id already there means an earlier attempt committed
 *    (at-least-once, E85): nothing is delivered twice.
 */
export class NotificationDeliverer {
  readonly #deps: DelivererDependencies;

  constructor(deps: DelivererDependencies) {
    this.#deps = deps;
  }

  /** Traced on `notification.send` while something listens (E118): the channels `via()` chose, and the outcome. */
  deliver(container: Resolver, pending: PendingDelivery): Promise<DeliveryOutcome> {
    const { app } = this.#deps;
    if (!app || !sends.hasSubscribers) return this.#deliver(container, pending);
    const message = sendMessage(app, pending, false);
    return trace(sends, message, () => this.#deliver(container, pending, message), (ended, outcome) => {
      ended.outcome = outcome;
    });
  }

  async #deliver(container: Resolver, pending: PendingDelivery, message?: NotificationSendMessage): Promise<DeliveryOutcome> {
    const { recipients, channels: registry, store, connections } = this.#deps;
    const { notification: Class, recipient, data, id } = pending;
    const Resolver = recipients.get(recipient.type);
    if (!Resolver) throw new NotificationError(`No resolver finds "${recipient.type}" recipients — list one in a module: recipients: { ${recipient.type}: … }.`);
    const resolver = container.make(Resolver);
    const record = await resolver.find(recipient.id as never);
    if (record === undefined || record === null) return 'gone';

    const notification = container.make(Class);
    const via = await notification.via(record, data);
    if (!Array.isArray(via) || via.some((channel) => typeof channel !== 'string')) {
      throw new NotificationChannelError(`${Class.name} (${Class.notification}): via() must return a list of channel names, like ['database', 'mail'].`);
    }
    const names = [...new Set(via as readonly string[])];
    if (message) message.channels = names;
    const unknown = names.filter((name) => !registry.has(name));
    if (unknown.length > 0) {
      const hint = unknown.includes('mail') ? ' (the mail channel needs @bespokecore/mail)' : '';
      throw new NotificationChannelError(`${Class.name} (${Class.notification}): via() returned ${unknown.map((name) => `"${name}"`).join(', ')}, which this app does not have${hint}. Channels: ${registry.names().join(', ')}.`);
    }
    if (names.length === 0) return 'delivered';
    // The database channel first: its row is how a later attempt knows this one went through.
    const ordered = names.includes('database') ? ['database', ...names.filter((name) => name !== 'database')] : names;
    const channels = ordered.map((name) => registry.make(name, container));
    const translator = this.#deps.translator(resolver.locale?.(record as never), container);
    const { queue, connection } = Class.queue ?? {};
    const delivery = {
      id,
      type: Class.notification,
      class: Class,
      notification,
      recipient: { type: recipient.type, id: recipient.id },
      record,
      data,
      translator,
      queue: { ...(queue === undefined ? {} : { queue }), ...(connection === undefined ? {} : { connection }) },
      container,
    };

    return connections.transaction(
      async () => {
        if (ordered[0] === 'database' && (await store.exists(id))) return 'delivered-before';
        for (const channel of channels) await channel.deliver(delivery);
        return 'delivered';
      },
      { connection: store.connection },
    );
  }
}

/** The data checked against the notification's schema — its output, ready for the channels (and as JSON for the queue). */
export async function checkSend(registry: NotificationRegistry, recipients: RecipientRegistry, notification: NotificationClass, list: readonly AnyRecipient[], data: unknown): Promise<unknown> {
  if (!registry.has(notification)) {
    throw new NotificationError(
      `${notification.name} is not a registered notification — list it in its module: notifications: [${notification.name}] (a worker finds a notification by its name there).`,
    );
  }
  for (const recipient of list) {
    if (typeof recipient?.type !== 'string' || !(typeof recipient.id === 'string' || typeof recipient.id === 'number')) {
      throw new NotificationError(`${notification.name}: a recipient is { type, id } — the kind of recipient and its id, e.g. { type: 'user', id: user.id }.`);
    }
    if (!recipients.get(recipient.type)) {
      throw new NotificationError(`${notification.name} is sent to a "${recipient.type}" recipient, but no module finds those — list a resolver: recipients: { ${recipient.type}: … }. Known: ${recipients.types().join(', ') || 'none'}.`);
    }
  }
  const value = await validate(notification.schema, data, `${notification.name} (${notification.notification}) cannot be sent: its static schema rejects the data`);
  return toJson(value, `The data of ${notification.name}`);
}

/** The default `Notifications`: queues a job per recipient (`send`) or delivers in the calling scope (`sendNow`). */
export class NotificationSender implements Notifications {
  readonly #container: Resolver;
  readonly #registry: NotificationRegistry;
  readonly #recipients: RecipientRegistry;
  readonly #deliverer: () => NotificationDeliverer;
  readonly #dispatch: QueueNotification;
  readonly #app: Application | undefined;

  /** `app`: queued notifications are reported on its `notification.send` channel (E118). */
  constructor(container: Resolver, registry: NotificationRegistry, recipients: RecipientRegistry, deliverer: () => NotificationDeliverer, dispatch: QueueNotification, app?: Application) {
    this.#container = container;
    this.#registry = registry;
    this.#recipients = recipients;
    this.#deliverer = deliverer;
    this.#dispatch = dispatch;
    this.#app = app;
  }

  async send(recipient: Recipients, notification: unknown, data: unknown, options: SendOptions = {}): Promise<any> {
    const Class = notification as NotificationClass;
    const list = toList(recipient);
    const json = await checkSend(this.#registry, this.#recipients, Class, list, data);
    const ids: string[] = [];
    for (const one of list) {
      const pending: PendingDelivery = { id: randomUUID(), notification: Class, recipient: { type: one.type, id: one.id }, data: json };
      if (this.#app && sends.hasSubscribers) await trace(sends, sendMessage(this.#app, pending, true), () => this.#dispatch(pending, options));
      else await this.#dispatch(pending, options);
      ids.push(pending.id);
    }
    return Array.isArray(recipient) ? ids : ids[0];
  }

  async sendNow(recipient: Recipients, notification: unknown, data: unknown): Promise<any> {
    const Class = notification as NotificationClass;
    const list = toList(recipient);
    const json = await checkSend(this.#registry, this.#recipients, Class, list, data);
    // Delivered from the data as the queue would carry it (JSON, checked again) — the same input as in a worker.
    const value = await validate(Class.schema, json, `${Class.name} (${Class.notification})`);
    const ids: string[] = [];
    for (const one of list) {
      const id = randomUUID();
      await this.#deliverer().deliver(this.#container, { id, notification: Class, recipient: { type: one.type, id: one.id }, data: value });
      ids.push(id);
    }
    return Array.isArray(recipient) ? ids : ids[0];
  }
}

/** Queues one notification's delivery — the `bespoke.notification` job (the provider wires it to @bespokecore/queue). */
export type QueueNotification = (pending: PendingDelivery, options: SendOptions) => Promise<void>;

function toList(recipient: Recipients): readonly AnyRecipient[] {
  return (Array.isArray(recipient) ? recipient : [recipient]) as readonly AnyRecipient[];
}
