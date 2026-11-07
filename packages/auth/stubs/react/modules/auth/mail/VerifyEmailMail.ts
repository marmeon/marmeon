import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { VerifyEmailView } from './VerifyEmailView.tsx';

/**
 * After registration and after a change of address: a signed link to confirm the address — in the user's language. Without the
 * account's name: the address is not confirmed yet (`confirmedName`).
 */
export class VerifyEmailMail implements Mailable {
  readonly #user: User;
  readonly #url: string;
  readonly #t: Translator;

  constructor(user: User, url: string, t: Translator) {
    this.#user = user;
    this.#url = url;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/VerifyEmailMail`, development only). */
  static preview(context: MailPreviewContext): VerifyEmailMail {
    const { user, url, t } = previewData(context);
    return new VerifyEmailMail(user, url('/email/verify/1/preview?expires=0&signature=preview'), t);
  }

  envelope() {
    return { to: recipient(this.#user.email, null), subject: this.#t.get('auth.mail.verify.subject') };
  }

  content() {
    return toMjml(VerifyEmailView, { t: this.#t, url: this.#url });
  }
}
