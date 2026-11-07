import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import { recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { EmailChangedView } from './EmailChangedView.tsx';

/**
 * To the old address when the address changes — if it was not you, you learn about it. In the user's language. `name` is `null` where
 * the old address was not confirmed (`confirmedName`).
 */
export class EmailChangedMail implements Mailable {
  readonly #name: string | null;
  readonly #oldEmail: string;
  readonly #newEmail: string;
  readonly #t: Translator;

  constructor(name: string | null, oldEmail: string, newEmail: string, t: Translator) {
    this.#name = name;
    this.#oldEmail = oldEmail;
    this.#newEmail = newEmail;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/EmailChangedMail`, development only). */
  static preview(context: MailPreviewContext): EmailChangedMail {
    const { user, t } = previewData(context);
    return new EmailChangedMail(user.name, user.email, 'ada.lovelace@example.com', t);
  }

  envelope() {
    return { to: recipient(this.#oldEmail, this.#name), subject: this.#t.get('auth.mail.email_changed.subject') };
  }

  content() {
    return toMjml(EmailChangedView, { t: this.#t, name: this.#name, email: this.#newEmail });
  }
}
