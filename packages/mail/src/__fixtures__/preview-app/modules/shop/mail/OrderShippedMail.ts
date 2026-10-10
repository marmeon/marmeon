import { html, fromHtml, type Mailable, type MailPreviewContext } from '../../../../../index.ts';

/** A previewable mail: `static preview()` builds it from sample data. */
export class OrderShippedMail implements Mailable {
  readonly #name: string;
  readonly #locale: string;

  constructor(name: string, locale: string) {
    this.#name = name;
    this.#locale = locale;
  }

  static preview({ locale }: MailPreviewContext): OrderShippedMail {
    return new OrderShippedMail('Ada <script>', locale ?? 'en');
  }

  envelope() {
    return { to: { address: 'ada@example.com', name: 'Ada' }, subject: this.#locale === 'de' ? 'Deine Bestellung ist unterwegs' : 'Your order shipped' };
  }

  content() {
    return fromHtml(html`<p>Hello ${this.#name}</p><p><a href="${'https://shop.test/orders/1'}">Track it</a></p><script>alert(1)</script>`);
  }
}

/** Not previewable: no static preview(). */
export class InternalMail implements Mailable {
  envelope() {
    return { to: 'ops@example.com', subject: 'internal' };
  }
  content() {
    return { html: '<p>x</p>', text: 'x' };
  }
}
