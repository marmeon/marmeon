import { AssertionError } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterCommit, Application, inTransaction, type Container } from '@marmeon/core';
import { channels } from '@marmeon/core/diagnostics';
import { trace } from '@marmeon/core/internal';
import type { AnyRecipient, NotificationClass, NotificationData, RecipientRef, Recipients } from './notification.ts';
import { checkSend, NotificationDeliverer, sendMessage, type DeliveryOutcome, type Notifications, type SendOptions } from './notifications.ts';
import { NotificationRegistry, RecipientRegistry } from './registry.ts';
import { validate } from './validate.ts';

/** A notification the fake recorded — for one recipient. */
export interface SentNotification<N extends NotificationClass = NotificationClass> {
  readonly notification: N;
  readonly recipient: AnyRecipient;
  /** The data, as the notification's channels would get it (the output of `static schema`). */
  readonly data: NotificationData<N>;
  /** The notification's id. */
  readonly id: string;
  /** Sent with `sendNow` (delivered at once), not `send` (queued). */
  readonly now: boolean;
  readonly options: SendOptions;
  /** Sent inside a transaction (recorded with its commit). */
  readonly inTransaction: boolean;
}

/** Which notifications an assertion means: a part of the data (`{ ip: '1.2.3.4' }`), or a test of it. */
export type NotificationMatch<N extends NotificationClass> = Partial<NotificationData<N>> | ((data: NotificationData<N>, sent: SentNotification<N>) => boolean);

/**
 * Records notifications instead of delivering them — `@marmeon/testing` puts it in place of `Notifications`
 * (`app.notifications`). Every send is still checked as for real (a bad send fails the test), and inside a transaction
 * it is recorded with the commit — never after a rollback. See `docs/fakes.md#notifications`.
 */
export class NotificationFake implements Notifications {
  readonly #container: Container;
  readonly #sent: SentNotification[] = [];
  readonly #delivered = new Set<string>();

  /** @internal Built by the container. */
  constructor(container: Container) {
    this.#container = container;
  }

  send(recipient: Recipients, notification: unknown, data: unknown, options: SendOptions = {}): Promise<any> {
    return this.#record(recipient, notification as NotificationClass, data, false, options);
  }

  sendNow(recipient: Recipients, notification: unknown, data: unknown): Promise<any> {
    return this.#record(recipient, notification as NotificationClass, data, true, {});
  }

  // --- Inspection and assertions -------------------------------------------

  /** The recorded notifications of a class — for one recipient, matching, if given — oldest first. */
  sent<N extends NotificationClass>(notification: N, recipient?: RecipientRef, match?: NotificationMatch<N>): SentNotification<N>[] {
    return this.#sent.filter(
      (entry): entry is SentNotification<N> => entry.notification === notification && (recipient === undefined || same(entry.recipient, recipient)) && matches(entry as SentNotification<N>, match),
    );
  }

  /** At least one `notification` to `recipient` (matching the data part, if given). */
  assertSent<N extends NotificationClass>(recipient: RecipientRef, notification: N, match?: NotificationMatch<N>): this {
    if (this.sent(notification, recipient, match).length === 0) {
      throw new AssertionError({ message: `Expected ${notification.name} to be sent to ${label(recipient)}${match ? ' matching the given data' : ''}. Sent: ${this.#summary()}.` });
    }
    return this;
  }

  assertSentTimes<N extends NotificationClass>(recipient: RecipientRef, notification: N, times: number): this {
    const actual = this.sent(notification, recipient).length;
    if (actual !== times) throw new AssertionError({ message: `Expected ${times} × ${notification.name} to ${label(recipient)}, sent ${actual}.`, actual, expected: times });
    return this;
  }

  assertNotSent<N extends NotificationClass>(recipient: RecipientRef, notification: N, match?: NotificationMatch<N>): this {
    if (this.sent(notification, recipient, match).length > 0) {
      throw new AssertionError({ message: `Expected no ${notification.name} to ${label(recipient)}${match ? ' matching the given data' : ''}. Sent: ${this.#summary()}.` });
    }
    return this;
  }

  assertNothingSent(): this {
    if (this.#sent.length > 0) throw new AssertionError({ message: `Expected no notification, sent: ${this.#summary()}.` });
    return this;
  }

  /**
   * Delivers the recorded notifications for real, each once, oldest first — through the app's channels (rows in
   * `notifications`, mails queued), each in a scope of its own, as a worker would. Resolves with each one's outcome.
   */
  async deliver(): Promise<{ readonly id: string; readonly outcome: DeliveryOutcome }[]> {
    const deliverer = this.#container.make(NotificationDeliverer);
    const outcomes: { id: string; outcome: DeliveryOutcome }[] = [];
    for (const entry of this.#sent) {
      if (this.#delivered.has(entry.id)) continue;
      this.#delivered.add(entry.id);
      const scope = this.#container.createScope();
      outcomes.push({ id: entry.id, outcome: await deliverer.deliver(scope, { id: entry.id, notification: entry.notification, recipient: entry.recipient, data: entry.data }) });
    }
    return outcomes;
  }

  async #record(recipient: Recipients, notification: NotificationClass, data: unknown, now: boolean, options: SendOptions): Promise<any> {
    const list = (Array.isArray(recipient) ? recipient : [recipient]) as readonly AnyRecipient[];
    const json = await checkSend(this.#container.make(NotificationRegistry), this.#container.make(RecipientRegistry), notification, list, data);
    const value = await validate(notification.schema, json, `${notification.name} (${notification.notification})`);
    const transaction = inTransaction();
    const entries = list.map((one) => ({ notification, recipient: { type: one.type, id: one.id }, data: value as never, id: randomUUID(), now, options, inTransaction: transaction }));
    // Like the real thing: a notification sent in a transaction exists with its commit, and not after a rollback.
    afterCommit(() => {
      this.#sent.push(...entries);
    });
    // Reported on `notification.send` like the real sender's — the devtools record them in tests too.
    const sends = channels.tracing('notification.send');
    if (sends.hasSubscribers && this.#container.has(Application)) {
      const app = this.#container.make(Application);
      for (const entry of entries) await trace(sends, sendMessage(app, { id: entry.id, notification, recipient: entry.recipient, data: json }, !now), async () => undefined);
    }
    const ids = entries.map((entry) => entry.id);
    return Array.isArray(recipient) ? ids : ids[0];
  }

  #summary(): string {
    return this.#sent.map((entry) => `${entry.notification.name} to ${label(entry.recipient)}`).join('; ') || 'nothing';
  }
}

function same(a: AnyRecipient, b: AnyRecipient): boolean {
  return a.type === b.type && String(a.id) === String(b.id);
}

function label(recipient: AnyRecipient): string {
  return `${recipient.type} ${recipient.id}`;
}

function matches<N extends NotificationClass>(entry: SentNotification<N>, match: NotificationMatch<N> | undefined): boolean {
  if (match === undefined) return true;
  if (typeof match === 'function') return match(entry.data, entry);
  const data = entry.data as Record<string, unknown>;
  return Object.entries(match).every(([key, value]) => isDeepStrictEqual(data?.[key], value));
}
