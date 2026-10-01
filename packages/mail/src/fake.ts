import { AssertionError } from 'node:assert';
import type { Address, Mailable, MailMessage } from './message.ts';
import { compose, type Mailer } from './mailer.ts';

type MailableClass<M extends Mailable> = abstract new (...args: any[]) => M;

/**
 * Records mail instead of sending it — `@bespokecore/testing` puts it in place of the `Mailer` (`app.mail`).
 * Every mail is still composed (envelope and content run), so a broken template fails the test.
 */
export class MailFake implements Mailer {
  readonly #from: Address;
  readonly #sent: { mailable: Mailable; message: MailMessage }[] = [];

  constructor(from: Address = 'test@example.com') {
    this.#from = from;
  }

  async send(mailable: Mailable): Promise<MailMessage> {
    const message = await compose(mailable, this.#from);
    this.#sent.push({ mailable, message });
    return message;
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
      throw new AssertionError({ message: `Expected a ${Class.name}${filter ? ' matching the filter' : ''} to be sent. Sent: ${sent.join('; ') || 'nothing'}.` });
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
