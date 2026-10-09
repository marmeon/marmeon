import type { Translator } from '@marmeon/i18n';
import { mjml, type Mailable, type MailPreviewContext } from '@marmeon/mail';
import type { User } from '../users.ts';
import { layout } from './layout.ts';
import { previewData } from './preview-data.ts';

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
    return { to: { address: this.#user.email, name: this.#user.name }, subject: this.#t.get('auth.mail.email_in_use.subject') };
  }

  content() {
    const t = this.#t;
    return layout(t, {
      preview: t.get('auth.mail.email_in_use.preview'),
      body: mjml`
        <mj-text>${t.get('auth.mail.hello', { name: this.#user.name })}</mj-text>
        <mj-text>${t.get('auth.mail.email_in_use.intro')}</mj-text>
        <mj-text>${t.get('auth.mail.email_in_use.outro')}</mj-text>`,
    });
  }
}
