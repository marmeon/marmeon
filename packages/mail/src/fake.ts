import { AssertionError } from 'node:assert';
import type { Application } from '@marmeon/core';
import type { Address, Mailable, MailMessage } from './message.ts';
import { compose, type Mailer, type QueueMailOptions, type SentMail } from './mailer.ts';
import { traceMail } from './trace.ts';

type MailableClass<M extends Mailable> = abstract new (...args: any[]) => M;

/**
 * Records mail instead of sending it — `@marmeon/testing` puts it in place of the `Mailer` (`app.mail`). Every mail is
 * still composed, so a broken template fails the test. Mails sent now and queued ones are kept apart: `assertSent` sees
 * the first, `assertQueued` the second; a queued mail is not put on the queue.
 * See `docs/fakes.md#mail`.
 */
export class MailFake implements Mailer {
  readonly #from: Address;
  readonly #sent: { mailable: Mailable; message: MailMessage }[] = [];
  readonly #queued: { mailable: Mailable; message: MailMessage; options: QueueMailOptions }[] = [];

  readonly #app: Application | undefined;
  readonly #failures: Error[] = [];
  #ids = 0;

  /**
   * @internal createTestApp() makes it. `app`: its mails are reported on the `mail.send` channel like real ones — the devtools
   * record them in tests.
   */
  constructor(from: Address = 'test@example.com', app?: Application) {
    this.#from = from;
    this.#app = app;
  }

  /**
   * Makes the next `times` sends fail with `error`: `send()`. The mail is still composed, the failure shows on the `mail.send`
   * channel, and nothing is recorded for a failed send. A queued mail is not delivered by the fake: test a failing job with `mail: 'real'`. See `docs/fakes.md#mail`.
   */
  failNext(error: Error = new Error('The fake mailer failed this send.'), times = 1): this {
    for (let i = 0; i < times; i++) this.#failures.push(error);
    return this;
  }

  /** Resolves with the composed mail and a made-up message id (`<fake-1@marmeon.test>`), unique per fake. */
  async send(mailable: Mailable): Promise<SentMail> {
    const message = await traceMail(this.#app, mailable.constructor.name, 'send', async () => {
      const composed = await compose(mailable, this.#from);
      this.#fail();
      return composed;
    });
    this.#sent.push({ mailable, message });
    return { ...message, messageId: this.#nextId() };
  }

  #fail(): void {
    const error = this.#failures.shift();
    if (error) throw error;
  }

  #nextId(): string {
    return `<fake-${++this.#ids}@marmeon.test>`;
  }

  async queue(mailable: Mailable, options: QueueMailOptions = {}): Promise<MailMessage> {
    const message = await traceMail(this.#app, mailable.constructor.name, 'queue', () => compose(mailable, this.#from));
    this.#queued.push({ mailable, message, options });
    return message;
  }

  /** The queued mails of a class (with their composed messages and where they were to go), optionally filtered. */
  queued<M extends Mailable>(
    Class: MailableClass<M>,
    filter: (mail: M, message: MailMessage, options: QueueMailOptions) => boolean = () => true,
  ): { mail: M; message: MailMessage; options: QueueMailOptions }[] {
    return this.#queued
      .filter((entry): entry is { mailable: M; message: MailMessage; options: QueueMailOptions } => entry.mailable instanceof Class)
      .filter((entry) => filter(entry.mailable, entry.message, entry.options))
      .map(({ mailable, message, options }) => ({ mail: mailable, message, options }));
  }

  assertQueued<M extends Mailable>(Class: MailableClass<M>, filter?: (mail: M, message: MailMessage, options: QueueMailOptions) => boolean): this {
    if (this.queued(Class, filter).length === 0) {
      const queued = this.#queued.map((entry) => `${entry.mailable.constructor.name} to ${entry.message.to.map((to) => to.address).join(', ')}`);
      const sent = this.sent(Class).length > 0 ? ` (${Class.name} was sent now, not queued — assertSent)` : '';
      throw new AssertionError({ message: `Expected a ${Class.name}${filter ? ' matching the filter' : ''} to be queued${sent}. Queued: ${queued.join('; ') || 'nothing'}.` });
    }
    return this;
  }

  assertQueuedCount<M extends Mailable>(Class: MailableClass<M>, count: number): this {
    const actual = this.queued(Class).length;
    if (actual !== count) throw new AssertionError({ message: `Expected ${count} queued × ${Class.name}, queued ${actual}.`, actual, expected: count });
    return this;
  }

  assertNotQueued<M extends Mailable>(Class: MailableClass<M>, filter?: (mail: M, message: MailMessage, options: QueueMailOptions) => boolean): this {
    if (this.queued(Class, filter).length > 0) throw new AssertionError({ message: `Expected no ${Class.name}${filter ? ' matching the filter' : ''} to be queued.` });
    return this;
  }

  assertNothingQueued(): this {
    if (this.#queued.length > 0) throw new AssertionError({ message: `Expected no queued mail, queued ${this.#queued.map((entry) => entry.mailable.constructor.name).join(', ')}.` });
    return this;
  }

  /** The sent mails of a class (with their composed messages), optionally filtered. */
  sent<M extends Mailable>(Class: MailableClass<M>, filter: (mail: M, message: MailMessage) => boolean = () => true): { mail: M; message: MailMessage }[] {
    return this.#sent
      .filter((entry): entry is { mailable: M; message: MailMessage } => entry.mailable instanceof Class)
      .filter((entry) => filter(entry.mailable, entry.message))
      .map(({ mailable, message }) => ({ mail: mailable, message }));
  }

  assertSent<M extends Mailable>(Class: MailableClass<M>, filter?: (mail: M, message: MailMessage) => boolean): this {
    if (this.sent(Class, filter).length === 0) {
      const sent = this.#sent.map((entry) => `${entry.mailable.constructor.name} to ${entry.message.to.map((to) => to.address).join(', ')}`);
      const queued = this.queued(Class).length > 0 ? ` (${Class.name} was queued, not sent now — assertQueued)` : '';
      throw new AssertionError({ message: `Expected a ${Class.name}${filter ? ' matching the filter' : ''} to be sent${queued}. Sent: ${sent.join('; ') || 'nothing'}.` });
    }
    return this;
  }

  assertSentCount<M extends Mailable>(Class: MailableClass<M>, count: number): this {
    const actual = this.sent(Class).length;
    if (actual !== count) throw new AssertionError({ message: `Expected ${count} × ${Class.name}, sent ${actual}.`, actual, expected: count });
    return this;
  }

  assertNotSent<M extends Mailable>(Class: MailableClass<M>, filter?: (mail: M, message: MailMessage) => boolean): this {
    if (this.sent(Class, filter).length > 0) throw new AssertionError({ message: `Expected no ${Class.name}${filter ? ' matching the filter' : ''} to be sent.` });
    return this;
  }

  assertNothingSent(): this {
    if (this.#sent.length > 0) throw new AssertionError({ message: `Expected no mail, sent ${this.#sent.map((entry) => entry.mailable.constructor.name).join(', ')}.` });
    return this;
  }
}
