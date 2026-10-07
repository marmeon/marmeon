import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';

/**
 * Private registration (E146): to the new address of a pending change — the link that makes it the account's (signed, for this
 * account and request, 60 minutes, while signed in). In the user's language.
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
    return { to: { address: this.#email, name: this.#user.name }, subject: this.#t.get('auth.mail.confirm_new_email.subject') };
  }

  content() {
    const t = this.#t;
    return layout(t, {
      preview: t.get('auth.mail.confirm_new_email.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get('auth.mail.confirm_new_email.intro', { email: this.#email })}</mj-text>
        <mj-button href="${this.#url}">${t.get('auth.mail.confirm_new_email.button')}</mj-button>
        <mj-text>${t.get('auth.mail.confirm_new_email.outro')}</mj-text>`,
    });
  }
}
