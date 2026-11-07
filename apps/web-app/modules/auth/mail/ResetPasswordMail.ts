import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { ResetPasswordView } from './ResetPasswordView.tsx';

/**
 * The "forgot password" link — composed and queued by a job (SendPasswordResetLinkJob), so the answer does not tell
 * whether the address has an account. In the recipient's language (`t`): the account's, whoever asked for the link.
 */
export class ResetPasswordMail implements Mailable {
  readonly #user: User;
  readonly #url: string;
  readonly #minutes: number;
  readonly #t: Translator;

  constructor(user: User, url: string, minutes: number, t: Translator) {
    this.#user = user;
    this.#url = url;
    this.#minutes = minutes;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/ResetPasswordMail`, development only). */
  static preview(context: MailPreviewContext): ResetPasswordMail {
    const { user, url, t } = previewData(context);
    return new ResetPasswordMail(user, url('/reset-password?token=preview&email=ada%40example.com'), 60, t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get('auth.mail.reset.subject') };
  }

  content() {
    return toMjml(ResetPasswordView, { t: this.#t, user: this.#user, url: this.#url, minutes: this.#minutes });
  }
}
