import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { LockoutView } from './LockoutView.tsx';

/**
 * To the owner when the account stopped taking passwords after too many failed sign-ins in a day. Who guessed is not known; the
 * owner's way back in is a password reset or a passkey. In the user's language.
 */
export class LockoutMail implements Mailable {
  readonly #user: User;
  readonly #forgot: string;
  readonly #login: string;
  readonly #t: Translator;

  constructor(user: User, forgot: string, login: string, t: Translator) {
    this.#user = user;
    this.#forgot = forgot;
    this.#login = login;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/LockoutMail`, development only). */
  static preview(context: MailPreviewContext): LockoutMail {
    const { user, url, t } = previewData(context);
    return new LockoutMail(user, url('/forgot-password'), url('/login'), t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get('auth.mail.lockout.subject') };
  }

  content() {
    return toMjml(LockoutView, { t: this.#t, user: this.#user, forgot: this.#forgot, login: this.#login });
  }
}
