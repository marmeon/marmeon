import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';

/**
 * Private registration (E146): someone signed up with the address of this account — instead of telling the form "taken", the
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
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get('auth.mail.account_exists.subject') };
  }

  content() {
    const t = this.#t;
    return layout(t, {
      preview: t.get('auth.mail.account_exists.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get('auth.mail.account_exists.intro')}</mj-text>
        <mj-button href="${this.#login}">${t.get('auth.mail.account_exists.button')}</mj-button>
        <mj-text>${t.get('auth.mail.account_exists.forgot')} <a href="${this.#forgot}">${this.#forgot}</a></mj-text>
        <mj-text>${t.get('auth.mail.account_exists.outro')}</mj-text>`,
    });
  }
}
