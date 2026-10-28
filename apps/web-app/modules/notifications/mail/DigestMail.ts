import { UrlSigner } from '@marmeon/http';
import { Translators, type Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import { AppConfig } from '../../../config/app.ts';

/**
 * A mail that can be left with one click: `List-Unsubscribe` holds the signed link, and `List-Unsubscribe-Post` tells the mail client it
 * may post to it (RFC 8058). The link never expires, since a mail is read months later. See docs/csrf.md#a-link-in-a-mail-that-posts.
 */
export class DigestMail implements Mailable {
  readonly #to: string;
  readonly #unsubscribe: string;
  readonly #t: Translator;

  constructor(to: string, unsubscribe: string, t: Translator) {
    this.#to = to;
    this.#unsubscribe = unsubscribe;
    this.#t = t;
  }

  /** The link a mail to `user` carries: absolute, signed, valid for good. */
  static unsubscribeUrl(signer: UrlSigner, app: AppConfig, user: string): string {
    return signer.foreverSignedRoute('notifications.unsubscribe', { user }, { base: app.url });
  }

  /** The preview (`/_marmeon/mail/notifications/DigestMail`, development only). */
  static preview({ make, locale }: MailPreviewContext): DigestMail {
    return new DigestMail('ada@example.com', DigestMail.unsubscribeUrl(make(UrlSigner), make(AppConfig), 'ada'), make(Translators).for(locale));
  }

  envelope() {
    return {
      to: this.#to,
      subject: this.#t.get('notifications.mail.digest.subject'),
      // Both headers: without `List-Unsubscribe-Post` a mail client opens the link in a browser instead of posting to it.
      headers: { 'List-Unsubscribe': `<${this.#unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    };
  }

  content() {
    const t = this.#t;
    return mjml`<mjml lang="${t.locale}">
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>${t.get('notifications.mail.digest.intro')}</mj-text>
        <mj-text><a href="${this.#unsubscribe}">${t.get('notifications.mail.digest.unsubscribe')}</a></mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
  }
}
