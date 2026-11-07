import type { Translator } from '@marmeon/i18n';
import type { Mailable, MailPreviewContext } from '@marmeon/mail';
import { toMjml } from '@marmeon/react/mail';
import type { User } from '../users.ts';
import { confirmedName, recipient } from './greeting.ts';
import { previewData } from './preview-data.ts';
import { AccountExistsView } from './AccountExistsView.tsx';

/**
 * Private registration: someone signed up with the address of this account — instead of telling the form "taken", the
 * owner learns it here. In the user's language.
 */
export class AccountExistsMail implements Mailable {
  readonly #user: User;
  readonly #login: string;
  readonly #forgot: string;
  readonly #t: Translator;

  constructor(user: User, login: string, forgot: string, t: Translator) {
    this.#user = user;
    this.#login = login;
    this.#forgot = forgot;
    this.#t = t;
  }

  /** The preview (`/_marmeon/mail/auth/AccountExistsMail`, development only). */
  static preview(context: MailPreviewContext): AccountExistsMail {
    const { user, url, t } = previewData(context);
    return new AccountExistsMail(user, url('/login'), url('/forgot-password'), t);
  }

  envelope() {
    return { to: recipient(this.#user.email, confirmedName(this.#user)), subject: this.#t.get('auth.mail.account_exists.subject') };
  }

  content() {
    return toMjml(AccountExistsView, { t: this.#t, user: this.#user, login: this.#login, forgot: this.#forgot });
  }
}
