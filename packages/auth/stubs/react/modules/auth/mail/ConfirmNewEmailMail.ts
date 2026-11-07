import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { ConfirmNewEmailView } from './ConfirmNewEmailView.tsx';

/**
 * Private registration: to the new address of a pending change — the link that makes it the account's (signed, for this
 * account and request, 60 minutes, while signed in). In the user's language. Without the account's name: the address is not confirmed
 * yet (`confirmedName`).
 */
export class ConfirmNewEmailMail implements Mailable {
  readonly #user: User;
  readonly #email: string;
  readonly #url: string;
  readonly #t: Translator;

  constructor(user: User, email: string, url: string, t: Translator) {
    this.#user = user;
    this.#email = email;
    this.#url = url;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/ConfirmNewEmailMail`, development only). */
  static preview(context: MailPreviewContext): ConfirmNewEmailMail {
    const { user, url, t } = previewData(context);
    return new ConfirmNewEmailMail(user, 'ada.lovelace@example.com', url('/email/change/1/preview?expires=0&signature=preview'), t);
  }

  envelope() {
    return { to: recipient(this.#email, null), subject: this.#t.get('auth.mail.confirm_new_email.subject') };
  }

  content() {
    return toMjml(ConfirmNewEmailView, { t: this.#t, email: this.#email, url: this.#url });
  }
}
