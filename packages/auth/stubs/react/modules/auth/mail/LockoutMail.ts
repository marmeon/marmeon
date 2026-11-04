import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import type { User } from '../users.ts';
import { confirmedName, greeting, recipient } from './greeting.ts';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';

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
    const t = this.#t;
    return layout(t, {
      preview: t.get('auth.mail.lockout.preview'),
      body: mjml`
        <mj-text>${greeting(t, confirmedName(this.#user))}</mj-text>
        <mj-text>${t.get('auth.mail.lockout.intro')}</mj-text>
        <mj-button href="${this.#forgot}">${t.get('auth.mail.lockout.button')}</mj-button>
        <mj-text>${t.get('auth.mail.lockout.passkey')} <a href="${this.#login}">${this.#login}</a></mj-text>
        <mj-text>${t.get('auth.mail.lockout.outro')}</mj-text>`,
    });
  }
}
