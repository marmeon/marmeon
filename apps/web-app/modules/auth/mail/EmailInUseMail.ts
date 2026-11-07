import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { EmailInUseView } from './EmailInUseView.tsx';

/**
 * Private registration: someone asked to change the address of their account to this account's — instead of telling them
 * "taken", the owner learns it here. Nothing changed for anybody. In the owner's language.
 */
export class EmailInUseMail implements Mailable {
  readonly #user: User;
  readonly #t: Translator;

  constructor(user: User, t: Translator) {
    this.#user = user;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/EmailInUseMail`, development only). */
  static preview(context: MailPreviewContext): EmailInUseMail {
    const { user, t } = previewData(context);
    return new EmailInUseMail(user, t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get('auth.mail.email_in_use.subject') };
  }

  content() {
    return toMjml(EmailInUseView, { t: this.#t, user: this.#user });
  }
}
